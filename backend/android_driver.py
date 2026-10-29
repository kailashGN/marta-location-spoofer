"""Drive the on-phone helper over ``adb forward`` to 127.0.0.1:17321."""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

from .android_adb import (
    APK_PATH,
    DEVICE_PORT,
    HELPER_VERSION_CODE,
    PACKAGE,
    SERVICE,
    adb,
    find_adb,
    parse_adb_devices,
    parse_android_identity,
    parse_package_installed,
    parse_version_code,
    reply_is_mock_denied,
)
from .spoof import SpoofError

log = logging.getLogger(__name__)

_IDENTITY_SHELL = (
    "getprop ro.product.model; getprop ro.build.version.release; settings get global device_name"
)


class AndroidDriver:
    platform = "android"
    ios_version = None

    def __init__(self) -> None:
        self.udid: Optional[str] = None
        self.strategy: Optional[str] = None
        self.android_version: Optional[str] = None
        self.device_name: Optional[str] = None
        self.transport: Optional[str] = None
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._io_lock = asyncio.Lock()
        self._local_port: Optional[int] = None
        self._service_started = False

    @property
    def connected(self) -> bool:
        return self._writer is not None

    async def connect(self, udid: str, pair_timeout: float = 30.0) -> None:
        del pair_timeout  # iOS pairing timeout; Android uses the USB-debugging prompt instead.
        if find_adb() is None:
            raise _adb_missing()
        state = await _device_state(udid)
        if state is None:
            raise SpoofError(
                "That Android phone is not connected",
                ["Plug it in with a USB cable and press Rescan."],
                code="adb_missing",
            )
        if state == "unauthorized":
            raise SpoofError(
                "USB debugging is not authorized",
                ["Unlock the phone and tap Allow on the USB debugging prompt.", "Then press Connect again."],
                code="adb_unauthorized",
            )
        if state != "device":
            raise SpoofError(
                "The phone is offline",
                ["Unplug the cable, plug it back in, and unlock the phone.", "Then press Connect again."],
                code="adb_offline",
            )

        self.udid = udid
        self.strategy = "android"
        self.transport = "adb"
        self.device_name, self.android_version = await _identity(udid)
        await _ensure_helper(udid)
        code, _, err = await adb(
            "shell", "appops", "set", PACKAGE, "android:mock_location", "allow",
            serial=udid, timeout=10,
        )
        if code != 0:
            raise SpoofError(err.strip() or "Could not grant mock location", code="mock_location")

        code, _, err = await adb(
            "shell", "am", "start-foreground-service", "-n", SERVICE,
            serial=udid, timeout=15,
        )
        if code != 0:
            raise SpoofError(err.strip() or "Could not start the helper", code="android")
        self._service_started = True

        code, out, err = await adb("forward", f"tcp:0", f"tcp:{DEVICE_PORT}", serial=udid, timeout=10)
        if code != 0 or not out.strip():
            raise SpoofError(err.strip() or "Could not forward the helper port", code="android")
        self._local_port = int(out.strip().split()[-1])
        await self._open_and_ping()
        log.info("Android helper ready on %s via local port %s", udid, self._local_port)

    async def _open_and_ping(self) -> None:
        assert self._local_port is not None
        last: Optional[Exception] = None
        for _ in range(8):
            try:
                self._reader, self._writer = await asyncio.wait_for(
                    asyncio.open_connection("127.0.0.1", self._local_port),
                    timeout=2,
                )
                await self._command("PING")
                return
            except Exception as exc:  # noqa: BLE001 — the service may not be listening yet
                last = exc
                await self._close_socket()
                await asyncio.sleep(0.3)
        raise SpoofError(
            "The helper did not answer",
            ["Unlock the phone and press Connect again.", f"Details: {last!r}"],
            code="android",
        )

    async def set(self, lat: float, lon: float) -> None:
        await self._command(f"SET {lat} {lon}")

    async def clear(self) -> None:
        # CLEAR drops the test providers and leaves the socket open, so the next SET still works.
        # Disconnect force-stops the service, which is what removes the notification.
        await self._command("CLEAR")

    async def disconnect(self) -> None:
        if self._writer is not None:
            try:
                await self._command("CLEAR")
            except Exception as exc:  # noqa: BLE001
                log.debug("CLEAR during disconnect failed: %r", exc)
        await self._close_socket()
        serial = self.udid
        if self._service_started and serial:
            try:
                await adb("shell", "am", "force-stop", PACKAGE, serial=serial, timeout=10)
            except Exception as exc:  # noqa: BLE001
                log.debug("force-stop failed: %r", exc)
        self._service_started = False
        if self._local_port is not None and serial and find_adb() is not None:
            try:
                await adb("forward", "--remove", f"tcp:{self._local_port}", serial=serial, timeout=10)
            except Exception as exc:  # noqa: BLE001
                log.debug("forward remove failed: %r", exc)
        self._local_port = None
        self.transport = None

    async def _command(self, line: str) -> str:
        if self._writer is None or self._reader is None:
            raise SpoofError("The helper connection is closed", ["Press Connect again."], code="not_connected")
        async with self._io_lock:
            self._writer.write(f"{line}\n".encode())
            await self._writer.drain()
            try:
                raw = await asyncio.wait_for(self._reader.readline(), timeout=8)
            except asyncio.TimeoutError as exc:
                raise SpoofError(
                    "The helper did not answer in time",
                    ["Unlock the phone and press Connect again."],
                    code="timeout",
                ) from exc
        if not raw:
            raise SpoofError("The helper closed the connection", ["Press Connect again."], code="android")
        return _accept_reply(raw.decode(errors="replace").strip())

    async def _close_socket(self) -> None:
        writer = self._writer
        self._writer = None
        self._reader = None
        if writer is None:
            return
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass


def _accept_reply(text: str) -> str:
    if text == "OK" or text.startswith("OK "):
        return text
    if text.startswith("ERR"):
        reason = text[3:].strip() or text
        if reply_is_mock_denied(reason):
            raise SpoofError(
                "Mock location is not granted",
                [
                    "On the phone open Developer options.",
                    "Select Location Spoofer Helper as the mock-location app.",
                    "Press Connect again.",
                ],
                code="mock_location",
            )
        raise SpoofError(reason, code="android")
    raise SpoofError(text or "Unexpected helper reply", code="android")


def _adb_missing() -> SpoofError:
    return SpoofError(
        "adb was not found",
        [
            "Install Android platform-tools, or run brew install android-platform-tools.",
            "Android Studio’s SDK at ~/Library/Android/sdk/platform-tools also works.",
        ],
        code="adb_missing",
    )


async def _device_state(serial: str) -> Optional[str]:
    code, out, _ = await adb("devices", "-l", timeout=5)
    if code != 0:
        return None
    for row in parse_adb_devices(out):
        if row["serial"] == serial:
            return row["state"]
    return None


async def _identity(serial: str) -> tuple[Optional[str], Optional[str]]:
    code, out, _ = await adb("shell", _IDENTITY_SHELL, serial=serial, timeout=8)
    if code != 0:
        return serial, None
    model, release, name = parse_android_identity(out)
    return name or model or serial, release


async def _ensure_helper(serial: str) -> None:
    if not APK_PATH.is_file():
        raise SpoofError(
            "The helper APK is missing",
            [f"Expected it at {APK_PATH}.", "Run scripts/build-helper.sh."],
            code="android",
        )
    code, out, _ = await adb("shell", "pm", "path", PACKAGE, serial=serial, timeout=10)
    installed = code == 0 and parse_package_installed(out)
    current: Optional[int] = None
    if installed:
        _, dump, _ = await adb("shell", "dumpsys", "package", PACKAGE, serial=serial, timeout=15)
        current = parse_version_code(dump)
    if installed and current is not None and current >= HELPER_VERSION_CODE:
        return
    log.info("installing helper on %s (installed=%s version=%s)", serial, installed, current)
    code, _, err = await adb("install", "-r", str(APK_PATH), serial=serial, timeout=90)
    if code != 0:
        raise SpoofError(err.strip() or "Could not install the helper", code="android")


async def serial_is_android(serial: str) -> bool:
    if find_adb() is None:
        return False
    try:
        return await _device_state(serial) is not None
    except Exception as exc:  # noqa: BLE001
        log.debug("adb devices failed: %r", exc)
        return False
