"""iPhone location simulation. Behavior matches the previous in-session implementation.

* ``legacy`` (iOS < 17): ``com.apple.dt.simulatelocation``. Stateless — a fresh connection per
  command, and the simulated fix persists on the device.
* ``dvt`` (iOS ≥ 17): DVT ``LocationSimulation`` over an RSD tunnel. The fix lives only while the
  DTX channel is open, so the driver keeps it until ``disconnect()``.
"""

from __future__ import annotations

import asyncio
import logging
import platform
from typing import Any, Optional

from packaging.version import Version
from pymobiledevice3.exceptions import DeveloperModeIsNotEnabledError, PyMobileDevice3Exception
from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.services.mobile_image_mounter import auto_mount

from .device import ddi_image_type_for, strategy_for
from .spoof import SpoofError

log = logging.getLogger(__name__)


class IosDriver:
    platform = "ios"
    android_version = None

    def __init__(self) -> None:
        self.udid: Optional[str] = None
        self.strategy: Optional[str] = None
        self.ios_version: Optional[str] = None
        self.device_name: Optional[str] = None
        self.transport: Optional[str] = None
        self._lockdown: Any = None
        self._tunnel: Any = None
        self._rsd: Any = None
        self._dvt: Any = None
        self._sim: Any = None

    @property
    def connected(self) -> bool:
        return self._sim is not None

    async def connect(self, udid: str, pair_timeout: float = 30.0) -> None:
        log.info("connecting to iPhone %s", udid)
        self._lockdown = await create_using_usbmux(serial=udid, autopair=True, pair_timeout=pair_timeout)
        short = self._lockdown.short_info
        self.udid = udid
        self.device_name = short.get("DeviceName")
        self.ios_version = short.get("ProductVersion") or self._lockdown.product_version
        self.strategy = strategy_for(self.ios_version)

        if not await self._developer_mode_ok():
            raise SpoofError(
                "Developer Mode is off",
                ["On the iPhone open Settings → Privacy & Security → Developer Mode.",
                 "Turn it on, let the iPhone restart, unlock it, then press Connect again."],
                code="developer_mode",
            )

        if self.strategy == "legacy":
            from pymobiledevice3.services.simulate_location import DtSimulateLocation

            self._sim = DtSimulateLocation(self._lockdown)
            self.transport = "usbmux"
            # Probe the service now so a missing DDI fails at Connect time, not at first Set.
            await self._lockdown.get_service_connection_attributes(DtSimulateLocation.SERVICE_NAME)
            return

        from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
        from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation

        self._rsd = await self._open_rsd(udid)
        self._dvt = DvtProvider(self._rsd)
        await self._dvt.connect()
        self._sim = LocationSimulation(self._dvt)
        await self._sim.connect()
        log.info("DVT LocationSimulation channel open (%s)", self.transport)

    async def _developer_mode_ok(self) -> bool:
        assert self._lockdown is not None
        if Version(self.ios_version or "0") < Version("16.0"):
            return True
        try:
            return await self._lockdown.get_developer_mode_status()
        except PyMobileDevice3Exception:
            return True

    async def _open_rsd(self, udid: str) -> Any:
        errors: list[str] = []
        if platform.system() == "Darwin":
            try:
                from pymobiledevice3.remote.native_tunnel import NativeRemotedTunnel

                tunnel = NativeRemotedTunnel(serial=udid)
                rsd = await asyncio.wait_for(tunnel.aopen(), timeout=45)
                self._tunnel = tunnel
                self.transport = "native"
                return rsd
            except Exception as exc:  # noqa: BLE001
                errors.append(f"native: {exc!r}")
                log.warning("native remoted tunnel failed, trying userspace: %r", exc)
        try:
            from pymobiledevice3.remote.userspace_tunnel import UserspaceRsdTunnel

            tunnel = UserspaceRsdTunnel(serial=udid)
            rsd = await asyncio.wait_for(tunnel.aopen(), timeout=60)
            self._tunnel = tunnel
            self.transport = "userspace"
            return rsd
        except Exception as exc:  # noqa: BLE001
            errors.append(f"userspace: {exc!r}")
        raise SpoofError(
            "Could not open a developer tunnel to the iPhone",
            ["Make sure the iPhone is unlocked and connected over USB.",
             "If Xcode is open, close it and try again.",
             "Details: " + " | ".join(errors)],
            code="tunnel",
        )

    async def set(self, lat: float, lon: float) -> None:
        assert self._sim is not None
        try:
            await self._sim.set(lat, lon)
        except Exception as exc:  # noqa: BLE001
            # Upstream issue #572: first DVT call on 17.0–17.3 can fail once. Retry a single time.
            log.warning("set failed once (%r), retrying", exc)
            await self._sim.set(lat, lon)

    async def clear(self) -> None:
        assert self._sim is not None
        await self._sim.clear()

    async def disconnect(self) -> None:
        for name in ("_sim", "_dvt", "_rsd", "_tunnel", "_lockdown"):
            obj = getattr(self, name)
            if obj is None:
                continue
            try:
                if name == "_sim" and self.strategy == "legacy":
                    pass  # stateless — nothing to close
                elif name == "_tunnel":
                    await obj.aclose()
                else:
                    await obj.close()
            except Exception as exc:  # noqa: BLE001
                log.debug("close %s failed: %r", name, exc)
            setattr(self, name, None)
        self.transport = None


async def mount_ddi(udid: str, pair_timeout: float = 30.0) -> dict[str, Any]:
    """Mount the Developer Disk Image (classic or personalized) for one iPhone."""
    lockdown = await create_using_usbmux(serial=udid, autopair=True, pair_timeout=pair_timeout)
    try:
        version = lockdown.product_version
        image_type = ddi_image_type_for(version)
        from pymobiledevice3.exceptions import AlreadyMountedError
        from pymobiledevice3.services.mobile_image_mounter import MobileImageMounterService

        mounter = MobileImageMounterService(lockdown)
        try:
            if await mounter.is_image_mounted(image_type):
                return {"mounted": True, "image_type": image_type, "already": True}
        finally:
            await mounter.close()
        try:
            await auto_mount(lockdown)
        except AlreadyMountedError:
            pass
        except DeveloperModeIsNotEnabledError as exc:
            raise SpoofError(
                "Developer Mode is off",
                ["Enable Developer Mode on the iPhone, restart it, unlock it, then try again."],
                code="developer_mode",
            ) from exc
        return {"mounted": True, "image_type": image_type, "already": False}
    finally:
        await lockdown.close()
