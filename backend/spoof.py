"""SpoofSession — one phone at a time, plus route playback.

The phone connection itself lives in ``ios_driver`` or ``android_driver``. ``connected`` means that
driver is up, so an Android session does not need an iOS simulation object.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Optional

from pymobiledevice3.exceptions import (
    DeveloperModeIsNotEnabledError,
    InvalidServiceError,
    NotPairedError,
    PairingDialogResponsePendingError,
    PasswordRequiredError,
    StartServiceError,
    UserDeniedPairingError,
)

from .geo import Point, bearing_deg, destination, offset_sideways, paced_wait, resample, route_length_m, validate

log = logging.getLogger(__name__)


class SpoofError(Exception):
    """User-facing failure with a short message and optional recovery steps."""

    def __init__(self, message: str, steps: Optional[list[str]] = None, code: str = "error") -> None:
        super().__init__(message)
        self.message = message
        self.steps = steps or []
        self.code = code


@dataclass
class RouteState:
    total_m: float
    samples: int
    # Original path for the map UI (waypoints or GPX track), not the 1 Hz playback samples.
    points: list[Point] = field(default_factory=list)
    # Playback samples. Same as ``points`` for a GPX track.
    playback: list[Point] = field(default_factory=list)
    pauses: list[float] = field(default_factory=list)
    # ``rider``, ``transit``, or ``None`` (untagged — pace applies) per playback point.
    legs: list[str | None] = field(default_factory=list)
    index: int = 0
    paused: bool = False
    speed_mps: float = 1.4
    started_at: float = field(default_factory=time.monotonic)
    timing: str = "speed"  # "speed" | "gpx"
    duration_s: float | None = None
    remaining_s: float | None = None
    offset_side: str | None = None  # "left" | "right" | None
    offset_m: float = 100.0
    pace_factor: float = 1.0
    heading: float | None = None

    @property
    def progress(self) -> float:
        return 0.0 if self.samples <= 1 else self.index / (self.samples - 1)

    def leg_at(self, index: int) -> str:
        if index < 0 or index >= len(self.legs) or self.legs[index] != "transit":
            return "rider"
        return "transit"

    def wait_after(self, index: int) -> float:
        if index < 0 or index >= len(self.pauses):
            return 0.0
        return paced_wait(self.pauses[index], self.legs[index] if index < len(self.legs) else None, self.pace_factor)

    def remaining_after(self, index: int) -> float:
        return float(sum(self.wait_after(i) for i in range(index, len(self.pauses))))


class SpoofSession:
    def __init__(self) -> None:
        self.current: Optional[Point] = None
        self.route: Optional[RouteState] = None
        self.last_error: Optional[str] = None
        self._driver: Any = None
        self._route_task: Optional[asyncio.Task[None]] = None
        self._lock = asyncio.Lock()
        self._tick_lock = asyncio.Lock()

    @property
    def connected(self) -> bool:
        return self._driver is not None and bool(self._driver.connected)

    def snapshot(self) -> dict[str, Any]:
        route = None
        if self.route is not None:
            route = {
                "progress": self.route.progress,
                "index": self.route.index,
                "samples": self.route.samples,
                "total_m": self.route.total_m,
                "paused": self.route.paused,
                "speed_mps": self.route.speed_mps,
                "timing": self.route.timing,
                "duration_s": self.route.duration_s,
                "remaining_s": self.route.remaining_s,
                "elapsed_s": time.monotonic() - self.route.started_at,
                "points": [{"lat": p.lat, "lon": p.lon} for p in self.route.points],
                "offset_side": self.route.offset_side,
                "offset_m": self.route.offset_m,
                "pace_factor": self.route.pace_factor,
                "leg": self.route.leg_at(self.route.index),
            }
        driver = self._driver
        return {
            "connected": self.connected,
            "udid": None if driver is None else driver.udid,
            "device_name": None if driver is None else driver.device_name,
            "platform": None if driver is None else driver.platform,
            "ios_version": None if driver is None else driver.ios_version,
            "android_version": None if driver is None else driver.android_version,
            "strategy": None if driver is None else driver.strategy,
            "transport": None if driver is None else driver.transport,
            "location": None if self.current is None else {"lat": self.current.lat, "lon": self.current.lon},
            "route": route,
            "last_error": self.last_error,
        }

    async def connect(self, udid: str, pair_timeout: float = 30.0) -> dict[str, Any]:
        async with self._lock:
            if self.connected and self._driver is not None and self._driver.udid == udid:
                return self.snapshot()
            await self._teardown()
            try:
                await self._connect_locked(udid, pair_timeout)
            except SpoofError:
                await self._teardown()
                raise
            except Exception as exc:  # noqa: BLE001 — translate everything for the UI
                await self._teardown()
                raise self._translate(exc) from exc
            self.last_error = None
            return self.snapshot()

    async def _connect_locked(self, udid: str, pair_timeout: float) -> None:
        from .android_driver import AndroidDriver, serial_is_android
        from .ios_driver import IosDriver

        log.info("connecting to %s", udid)
        driver: Any
        if await serial_is_android(udid):
            driver = AndroidDriver()
        else:
            driver = IosDriver()
        try:
            await driver.connect(udid, pair_timeout)
        except Exception:
            await driver.disconnect()
            raise
        self._driver = driver

    async def disconnect(self) -> None:
        async with self._lock:
            await self._teardown()

    async def _teardown(self) -> None:
        await self._stop_route_task()
        self.route = None
        driver = self._driver
        self._driver = None
        if driver is not None:
            try:
                await driver.disconnect()
            except Exception as exc:  # noqa: BLE001
                log.debug("driver disconnect failed: %r", exc)
        self.current = None

    async def set_location(self, lat: float, lon: float) -> dict[str, Any]:
        validate(lat, lon)
        self._require_connected()
        await self._stop_route_task()
        self.route = None
        await self._set(lat, lon)
        return self.snapshot()

    async def _set(self, lat: float, lon: float) -> None:
        assert self._driver is not None
        try:
            await self._driver.set(lat, lon)
        except SpoofError as exc:
            self.last_error = exc.message
            raise
        except Exception as exc:  # noqa: BLE001
            self.last_error = str(exc)
            raise self._translate(exc) from exc
        self.current = Point(lat, lon)
        self.last_error = None

    async def clear_location(self) -> dict[str, Any]:
        self._require_connected()
        await self._stop_route_task()
        self.route = None
        assert self._driver is not None
        try:
            await self._driver.clear()
        except SpoofError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise self._translate(exc) from exc
        self.current = None
        return self.snapshot()

    async def play_route(
        self,
        points: list[Point],
        speed_mps: float,
        loop: bool = False,
        *,
        gpx_pauses: list[float] | None = None,
        legs: list[str | None] | None = None,
        start_index: int = 0,
    ) -> dict[str, Any]:
        self._require_connected()
        for p in points:
            validate(p.lat, p.lon)
        if len(points) < 2:
            raise SpoofError("A route needs at least two points", code="route")
        await self._stop_route_task()
        if gpx_pauses is not None:
            if len(gpx_pauses) != len(points) - 1:
                raise SpoofError("Internal route timing mismatch", code="route")
            if legs is not None and len(legs) != len(points):
                raise SpoofError("Internal route leg mismatch", code="route")
            samples = points
            timing = "gpx"
            duration_s = float(sum(gpx_pauses))
            sample_legs = list(legs) if legs is not None else [None] * len(samples)
        else:
            samples = resample(points, speed_mps, tick_s=1.0)
            gpx_pauses = [1.0] * (len(samples) - 1)
            timing = "speed"
            duration_s = float(len(samples) - 1)
            sample_legs = [None] * len(samples)
        start_index = max(0, min(start_index, len(samples) - 1))
        self.route = RouteState(
            total_m=route_length_m(points),
            samples=len(samples),
            points=list(points),
            playback=list(samples),
            pauses=list(gpx_pauses),
            legs=sample_legs,
            index=start_index,
            speed_mps=speed_mps,
            timing=timing,
            duration_s=duration_s,
            remaining_s=duration_s,
        )
        self.route.remaining_s = self.route.remaining_after(start_index)
        self._route_task = asyncio.create_task(self._run_route(loop, start_index))
        return self.snapshot()

    def _heading(self, index: int) -> float | None:
        route = self.route
        if route is None or not route.playback:
            return None
        samples = route.playback
        origin = samples[index]
        for j in range(index + 1, len(samples)):
            heading = bearing_deg(origin, samples[j])
            if heading is not None:
                route.heading = heading
                return heading
        for j in range(index - 1, -1, -1):
            heading = bearing_deg(samples[j], origin)
            if heading is not None:
                route.heading = heading
                return heading
        return route.heading

    async def _publish_index(self, index: int) -> None:
        route = self.route
        if route is None or not route.playback:
            return
        index = max(0, min(index, len(route.playback) - 1))
        origin = route.playback[index]
        published = origin
        if route.offset_side:
            heading = self._heading(index)
            if heading is not None:
                ahead = destination(origin, heading, 10)
                published = offset_sideways(origin, ahead, route.offset_m, route.offset_side)
        async with self._tick_lock:
            await self._set(published.lat, published.lon)

    async def _run_route(self, loop: bool, start_index: int = 0) -> None:
        try:
            begin = start_index
            while True:
                route = self.route
                if route is None:
                    return
                samples = route.playback
                for i in range(begin, len(samples)):
                    while self.route is not None and self.route.paused:
                        await asyncio.sleep(0.2)
                    if self.route is None:
                        return
                    self.route.index = i
                    self.route.remaining_s = self.route.remaining_after(i)
                    await self._publish_index(i)
                    if i < len(self.route.pauses):
                        await asyncio.sleep(self.route.wait_after(i))
                if not loop:
                    break
                begin = 0
                if self.route is not None:
                    self.route.remaining_s = self.route.remaining_after(0)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            self.last_error = f"Route stopped: {exc}"
            log.exception("route playback failed")
        finally:
            self._route_task = None

    async def pause_route(self, paused: bool) -> dict[str, Any]:
        if self.route is None:
            raise SpoofError("No route is playing", code="route")
        self.route.paused = paused
        return self.snapshot()

    async def set_offset(self, side: str, meters: float) -> dict[str, Any]:
        if self.route is None:
            raise SpoofError("No route is playing", code="route")
        if side not in ("left", "right", "none"):
            raise SpoofError("Offset side must be left, right, or none", code="route")
        self.route.offset_side = None if side == "none" else side
        self.route.offset_m = meters
        await self._publish_index(self.route.index)
        return self.snapshot()

    async def set_pace(self, factor: float) -> dict[str, Any]:
        if self.route is None:
            raise SpoofError("No route is playing", code="route")
        if factor not in (0.5, 1.0, 2.0):
            raise SpoofError("Pace must be 0.5, 1, or 2", code="route")
        self.route.pace_factor = factor
        self.route.remaining_s = self.route.remaining_after(self.route.index)
        return self.snapshot()

    async def stop_route(self) -> dict[str, Any]:
        await self._stop_route_task()
        self.route = None
        return self.snapshot()

    async def _stop_route_task(self) -> None:
        task = self._route_task
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._route_task = None

    async def mount_ddi(self, udid: str, pair_timeout: float = 30.0) -> dict[str, Any]:
        """Mount the Developer Disk Image for an iPhone. Android has no equivalent."""
        from .android_driver import serial_is_android
        from .ios_driver import mount_ddi

        if await serial_is_android(udid):
            raise SpoofError(
                "Prepare is only for an iPhone",
                ["Android phones do not use a Developer Disk Image. Press Connect instead."],
                code="android",
            )
        try:
            return await mount_ddi(udid, pair_timeout)
        except SpoofError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise self._translate(exc) from exc

    def _require_connected(self) -> None:
        if not self.connected:
            raise SpoofError("No phone connected", ["Press Connect first."], code="not_connected")

    @staticmethod
    def _translate(exc: Exception) -> SpoofError:
        if isinstance(exc, SpoofError):
            return exc
        if isinstance(exc, (PairingDialogResponsePendingError,)):
            return SpoofError("Waiting for “Trust This Computer”", ["Unlock the iPhone and tap Trust."], "trust")
        if isinstance(exc, UserDeniedPairingError):
            return SpoofError("Pairing was denied on the iPhone", ["Reconnect the cable and tap Trust."], "trust")
        if isinstance(exc, NotPairedError):
            return SpoofError("iPhone is not paired with this Mac", ["Unlock the iPhone and tap Trust."], "trust")
        if isinstance(exc, DeveloperModeIsNotEnabledError):
            return SpoofError("Developer Mode is off", ["Enable it in Settings → Privacy & Security."], "developer_mode")
        if isinstance(exc, PasswordRequiredError):
            return SpoofError("The iPhone is locked", ["Unlock the iPhone and try again."], "locked")
        if isinstance(exc, StartServiceError) and "InvalidService" in str(exc):
            return SpoofError(
                "Developer Disk Image is not mounted",
                ["Unlock the iPhone and press Prepare to mount it, then Connect again."],
                "ddi",
            )
        if isinstance(exc, InvalidServiceError):
            return SpoofError(
                "Developer Disk Image is not mounted",
                ["Unlock the iPhone and press Prepare to mount it, then Connect again."],
                "ddi",
            )
        if isinstance(exc, asyncio.TimeoutError):
            return SpoofError("The phone did not answer in time", ["Unlock it and try again."], "timeout")
        text = str(exc) or exc.__class__.__name__
        return SpoofError(text, code="error")
