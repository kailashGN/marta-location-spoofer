"""Device discovery and readiness checks.

iPhones are inspected over lockdownd (no tunnel, no Developer Disk Image), so polling never blocks
on the "Trust This Computer?" dialog. Android phones are listed through ``adb``. A stuck ``adb``
cannot block the iPhone list: that scan has its own timeout.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict, dataclass, field
from typing import Any, Optional

from packaging.version import Version
from pymobiledevice3 import usbmux
from pymobiledevice3.exceptions import (
    ConnectionFailedToUsbmuxdError,
    InvalidServiceError,
    NotPairedError,
    PairingError,
    PasswordRequiredError,
    PyMobileDevice3Exception,
)
from pymobiledevice3.lockdown import UsbmuxLockdownClient, create_using_usbmux
from pymobiledevice3.services.mobile_image_mounter import MobileImageMounterService

from .android_adb import (
    PACKAGE,
    adb,
    find_adb,
    parse_adb_devices,
    parse_android_identity,
    parse_mock_granted,
    parse_package_installed,
)

log = logging.getLogger(__name__)

MODERN_MIN_VERSION = Version("17.0")


@dataclass
class DeviceInfo:
    udid: str
    connection: str  # "USB" | "Network"
    platform: str = "ios"  # "ios" | "android"
    paired: bool = False
    name: Optional[str] = None
    model: Optional[str] = None
    ios_version: Optional[str] = None
    android_version: Optional[str] = None
    build: Optional[str] = None
    developer_mode: Optional[bool] = None
    ddi_mounted: Optional[bool] = None
    helper_installed: Optional[bool] = None
    mock_granted: Optional[bool] = None
    strategy: Optional[str] = None  # "legacy" | "dvt" | "android"
    problem: Optional[str] = None  # human readable blocker, if any
    steps: list[str] = field(default_factory=list)  # what the user must do next

    def to_dict(self) -> dict:
        return asdict(self)


def strategy_for(version: str) -> str:
    return "dvt" if Version(version) >= MODERN_MIN_VERSION else "legacy"


def ddi_image_type_for(version: str) -> str:
    return "Personalized" if Version(version) >= MODERN_MIN_VERSION else "Developer"


async def list_mux_devices() -> list[usbmux.MuxDevice]:
    try:
        devices = await usbmux.list_devices()
    except ConnectionFailedToUsbmuxdError:
        log.warning("usbmuxd not reachable — is a device plugged in?")
        return []
    # Prefer USB entries; drop duplicate Network entries for the same serial.
    seen: dict[str, usbmux.MuxDevice] = {}
    for dev in devices:
        current = seen.get(dev.serial)
        if current is None or (dev.is_usb and not current.is_usb):
            seen[dev.serial] = dev
    return list(seen.values())


async def inspect_device(mux: usbmux.MuxDevice) -> DeviceInfo:
    """Fill a DeviceInfo without ever blocking on a pairing dialog."""
    info = DeviceInfo(udid=mux.serial, connection=mux.connection_type)
    lockdown: Optional[UsbmuxLockdownClient] = None
    try:
        lockdown = await create_using_usbmux(
            serial=mux.serial, autopair=False, connection_type=mux.connection_type
        )
        info.paired = True
    except (NotPairedError, PairingError, PasswordRequiredError) as exc:
        info.paired = False
        info.problem = "Not paired"
        info.steps = [
            "Unlock the iPhone.",
            "Tap “Trust” on the iPhone when prompted, then press Connect here.",
        ]
        log.debug("device %s not paired: %r", mux.serial, exc)
        return info
    except PyMobileDevice3Exception as exc:
        info.problem = f"Lockdown error: {exc}"
        return info

    try:
        short = lockdown.short_info
        info.name = short.get("DeviceName")
        info.model = short.get("ProductType")
        info.ios_version = short.get("ProductVersion")
        info.build = short.get("BuildVersion")
        if info.ios_version:
            info.strategy = strategy_for(info.ios_version)
        try:
            info.developer_mode = await lockdown.get_developer_mode_status()
        except PyMobileDevice3Exception:
            # iOS < 16 has no Developer Mode switch; treat as enabled.
            info.developer_mode = True if info.ios_version and Version(info.ios_version) < Version("16.0") else None

        if info.ios_version:
            try:
                mounter = MobileImageMounterService(lockdown)
                info.ddi_mounted = await mounter.is_image_mounted(ddi_image_type_for(info.ios_version))
                await mounter.close()
            except (InvalidServiceError, PyMobileDevice3Exception) as exc:
                log.debug("mounter check failed for %s: %r", mux.serial, exc)
                info.ddi_mounted = None

        if info.developer_mode is False:
            info.problem = "Developer Mode is off"
            info.steps = [
                "On the iPhone open Settings → Privacy & Security → Developer Mode.",
                "Turn it on and let the iPhone restart, then unlock it.",
            ]
        elif info.ddi_mounted is False:
            info.problem = "Developer Disk Image not mounted"
            info.steps = ["Unlock the iPhone, then press Prepare here to mount it."]
    finally:
        if lockdown is not None:
            await lockdown.close()
    return info


def describe_android_device(
    row: dict[str, Optional[str]],
    identity: Optional[tuple[Optional[str], Optional[str], Optional[str]]] = None,
    helper_installed: Optional[bool] = None,
    mock_granted: Optional[bool] = None,
) -> DeviceInfo:
    """Build one Android row from parsed ``adb`` output. ``paired`` means USB debugging is authorized."""
    state = row.get("state") or ""
    model = row.get("model")
    release = None
    name = None
    if identity is not None:
        model = identity[0] or model
        release = identity[1]
        name = identity[2]
    info = DeviceInfo(
        udid=row.get("serial") or "",
        connection=row.get("connection") or "USB",
        platform="android",
        paired=state == "device",
        name=name or model or row.get("serial"),
        model=model,
        android_version=release,
        strategy="android",
        helper_installed=helper_installed,
        mock_granted=mock_granted,
    )
    if state == "unauthorized":
        info.problem = "USB debugging not authorized"
        info.steps = [
            "Unlock the phone and tap Allow on the USB debugging prompt.",
            "Then press Rescan.",
        ]
    elif state == "offline":
        info.problem = "Phone is offline"
        info.steps = ["Unplug the cable, plug it back in, unlock the phone, and press Rescan."]
    elif state != "device":
        info.problem = f"adb state: {state}"
    return info


async def _discover_ios() -> list[DeviceInfo]:
    muxes = await list_mux_devices()
    if not muxes:
        return []
    return list(await asyncio.gather(*(inspect_device(m) for m in muxes)))


async def _inspect_android(row: dict[str, Optional[str]]) -> DeviceInfo:
    if row.get("state") != "device":
        return describe_android_device(row)
    serial = row.get("serial") or ""
    identity = None
    helper = None
    granted = None
    try:
        code, out, _ = await adb(
            "shell",
            "getprop ro.product.model; getprop ro.build.version.release; settings get global device_name",
            serial=serial,
            timeout=5,
        )
        if code == 0:
            identity = parse_android_identity(out)
        code, out, _ = await adb("shell", "pm", "path", PACKAGE, serial=serial, timeout=5)
        helper = code == 0 and parse_package_installed(out)
        code, out, _ = await adb("shell", "appops", "get", PACKAGE, "android:mock_location", serial=serial, timeout=5)
        granted = code == 0 and parse_mock_granted(out)
    except Exception as exc:  # noqa: BLE001
        log.debug("android inspect %s failed: %r", serial, exc)
    return describe_android_device(row, identity, helper, granted)


async def _discover_android() -> tuple[list[DeviceInfo], dict[str, Any]]:
    if find_adb() is None:
        return [], {
            "available": False,
            "message": "adb was not found. Install Android platform-tools (brew install android-platform-tools), or use Android Studio’s SDK.",
        }
    try:
        code, out, err = await adb("devices", "-l", timeout=4)
    except Exception as exc:  # noqa: BLE001
        log.warning("adb devices failed: %r", exc)
        return [], {"available": True, "message": "adb did not answer."}
    if code != 0:
        log.warning("adb devices failed: %s", err.strip())
        return [], {"available": True, "message": "adb did not answer."}
    rows = parse_adb_devices(out)
    if not rows:
        return [], {"available": True, "message": None}
    devices = list(await asyncio.gather(*(_inspect_android(row) for row in rows)))
    return devices, {"available": True, "message": None}


async def discover() -> tuple[list[DeviceInfo], dict[str, Any]]:
    """iPhones plus Android phones, and whether ``adb`` itself is usable."""
    ios_task = asyncio.create_task(_discover_ios())
    android_task = asyncio.create_task(_discover_android())
    ios = await ios_task
    try:
        android, adb_status = await asyncio.wait_for(android_task, timeout=6)
    except asyncio.TimeoutError:
        log.warning("adb discovery timed out")
        android, adb_status = [], {"available": True, "message": "adb timed out."}
    return ios + android, adb_status
