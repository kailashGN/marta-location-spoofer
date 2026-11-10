"""SpoofSession — one phone at a time, route playback, and live-trip test controls.

The phone connection itself lives in ``ios_driver`` or ``android_driver``. ``connected`` means that
driver is up, so an Android session does not need an iOS simulation object.

Two loops share the work:

* the **route runner** only moves the *base* (on-course) point along the route on its schedule;
* the **publisher** sends ``base → sideways offset → jitter`` to the phone once a second, and at
  once whenever anything changes. Offsets can ramp ("drift") and GPS can be frozen or made too
  inaccurate to use, independent of where the route is.
"""

from __future__ import annotations

import asyncio
import logging
import math
import random
import time
from collections import deque
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

from .geo import Point, bearing_deg, destination, haversine_m, paced_wait, resample, route_length_m, validate

log = logging.getLogger(__name__)

PUBLISH_INTERVAL_S = 1.0
# Sent with every fix while GPS is "lost": MARTA drops readings worse than 100 m.
LOST_ACCURACY_M = 150.0
# Republishing an unchanged point alternates this tiny nudge so the phone sees a fresh fix; it is
# far below MARTA's 3 m progress threshold and 50 m leg-match radius.
KEEPALIVE_NUDGE_M = 0.3
PACE_MIN, PACE_MAX = 0.25, 4.0
OFFSET_MAX_M = 5000.0
RAMP_MAX_S = 600.0
JITTER_MAX_M = 200.0
LOG_SIZE = 300
GPS_MODES = ("normal", "frozen", "lost")


class SpoofError(Exception):
    """User-facing failure with a short message and optional recovery steps."""

    def __init__(self, message: str, steps: Optional[list[str]] = None, code: str = "error") -> None:
        super().__init__(message)
        self.message = message
        self.steps = steps or []
        self.code = code


@dataclass
class Offset:
    """Signed sideways offset in metres (positive = right of travel), optionally ramping."""

    from_m: float = 0.0
    to_m: float = 0.0
    start: float = 0.0
    ramp_s: float = 0.0

    def current(self, now: float | None = None) -> float:
        now = time.monotonic() if now is None else now
        if self.ramp_s <= 0 or now >= self.start + self.ramp_s:
            return self.to_m
        t = max(0.0, (now - self.start) / self.ramp_s)
        return self.from_m + (self.to_m - self.from_m) * t

    def ramping(self, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        return self.ramp_s > 0 and now < self.start + self.ramp_s and self.from_m != self.to_m

    def retarget(self, to_m: float, ramp_s: float, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        self.from_m = self.current(now)
        self.to_m = to_m
        self.start = now
        self.ramp_s = ramp_s


def side_of(signed_m: float) -> str | None:
    if signed_m > 0:
        return "right"
    if signed_m < 0:
        return "left"
    return None


def jitter_point(origin: Point, sigma_m: float, rng: random.Random) -> Point:
    """Random 2-D GPS noise: Rayleigh distance (σ per axis), clamped at 3σ, uniform bearing."""
    if sigma_m <= 0:
        return origin
    u = max(rng.random(), 1e-12)
    dist = min(sigma_m * math.sqrt(-2.0 * math.log(u)), 3.0 * sigma_m)
    return destination(origin, rng.uniform(0.0, 360.0), dist)


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
    pace_factor: float = 1.0
    heading: float | None = None
    finished: bool = False
    # Index → ``time.monotonic()`` deadline: the gap after that index lasts until the deadline,
    # not a fixed wait (waiting at a stop for a scheduled departure).
    deadlines: dict[int, float] = field(default_factory=dict)
    # Distance along ``playback`` up to each sample; GPX points are not evenly spaced.
    along_m: list[float] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.along_m and self.playback:
            total = 0.0
            self.along_m = [0.0]
            for a, b in zip(self.playback, self.playback[1:]):
                total += haversine_m(a, b)
                self.along_m.append(total)

    @property
    def travelled_m(self) -> float:
        if not self.along_m:
            return 0.0
        return self.along_m[max(0, min(self.index, len(self.along_m) - 1))]

    @property
    def progress(self) -> float:
        total = self.along_m[-1] if self.along_m else 0.0
        if total > 0:
            return self.travelled_m / total
        return 0.0 if self.samples <= 1 else self.index / (self.samples - 1)

    def leg_at(self, index: int) -> str:
        if index < 0 or index >= len(self.legs) or self.legs[index] != "transit":
            return "rider"
        return "transit"

    def wait_after(self, index: int) -> float:
        if index < 0 or index >= len(self.pauses):
            return 0.0
        deadline = self.deadlines.get(index)
        if deadline is not None:
            return max(0.0, deadline - time.monotonic())
        return paced_wait(self.pauses[index], self.legs[index] if index < len(self.legs) else None, self.pace_factor)

    def hold_remaining(self) -> float | None:
        """Seconds left waiting at the current point for a scheduled departure, else ``None``."""
        if self.finished or self.index not in self.deadlines:
            return None
        return self.wait_after(self.index)

    def remaining_after(self, index: int) -> float:
        total = 0.0
        for i in range(index, len(self.pauses)):
            deadline = self.deadlines.get(i)
            if deadline is not None:
                # Walking time before a deadline overlaps the wait for it.
                total = max(total, deadline - time.monotonic())
            else:
                total += self.wait_after(i)
        return float(total)


class SpoofSession:
    def __init__(self, rng: random.Random | None = None) -> None:
        self.current: Optional[Point] = None  # last point actually sent to the phone
        self.base: Optional[Point] = None  # static on-course point when no route is active
        self.route: Optional[RouteState] = None
        self.last_error: Optional[str] = None
        self.offset = Offset()
        self.gps_mode = "normal"
        self.jitter_m = 0.0
        self.log: deque[dict[str, Any]] = deque(maxlen=LOG_SIZE)
        self.log_seq = 0
        self._rng = rng or random.Random()
        self._sent_accuracy: Optional[float] = None
        # ``time.monotonic()`` of the first failed send in a row, or ``None`` while fixes get through.
        self._failing_since: Optional[float] = None
        self._driver: Any = None
        self._route_task: Optional[asyncio.Task[None]] = None
        self._publisher_task: Optional[asyncio.Task[None]] = None
        self._stopping = False
        self._wake = asyncio.Event()
        self._lock = asyncio.Lock()
        self._tick_lock = asyncio.Lock()

    # ------------------------------------------------------------------ state
    @property
    def connected(self) -> bool:
        return self._driver is not None and bool(self._driver.connected)

    @property
    def platform(self) -> Optional[str]:
        return None if self._driver is None else self._driver.platform

    def note(self, kind: str, text: str) -> None:
        """Append to the activity log (user actions, trip events, errors)."""
        self.log_seq += 1
        leg = None
        if self.route is not None and not self.route.finished and self.route.timing == "gpx":
            leg = self.route.leg_at(self.route.index)
        self.log.append({"seq": self.log_seq, "t": time.time(), "kind": kind, "text": text, "leg": leg})

    def clear_log(self) -> None:
        self.log.clear()
        self.log_seq += 1

    def base_point(self) -> Optional[Point]:
        if self.route is not None and self.route.playback:
            idx = max(0, min(self.route.index, len(self.route.playback) - 1))
            return self.route.playback[idx]
        return self.base

    def snapshot(self) -> dict[str, Any]:
        route = None
        if self.route is not None:
            route = {
                "progress": self.route.progress,
                "travelled_m": self.route.travelled_m,
                "index": self.route.index,
                "samples": self.route.samples,
                "total_m": self.route.total_m,
                "paused": self.route.paused,
                "finished": self.route.finished,
                "speed_mps": self.route.speed_mps,
                "timing": self.route.timing,
                "duration_s": self.route.duration_s,
                "remaining_s": self.route.remaining_s,
                "elapsed_s": time.monotonic() - self.route.started_at,
                "points": [{"lat": p.lat, "lon": p.lon} for p in self.route.points],
                "legs": self._leg_runs(),
                "pace_factor": self.route.pace_factor,
                "leg": self.route.leg_at(self.route.index),
                "walk_ahead": bool(self.route.deadlines),
                "hold_s": self.route.hold_remaining(),
                # Kept for v1 API clients.
                "offset_side": side_of(self.offset.to_m),
                "offset_m": abs(self.offset.to_m),
            }
        driver = self._driver
        base = self.base_point()
        now = time.monotonic()
        signed = self.offset.current(now)
        away = None
        if base is not None and self.current is not None:
            away = haversine_m(base, self.current)
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
            "base": None if base is None else {"lat": base.lat, "lon": base.lon},
            "offset": {
                "side": side_of(self.offset.to_m) or side_of(signed),
                "target_m": abs(self.offset.to_m),
                "current_m": abs(signed),
                "ramping": self.offset.ramping(now),
                "ramp_left_s": max(0.0, self.offset.start + self.offset.ramp_s - now) if self.offset.ramping(now) else 0.0,
            },
            "gps": {
                "mode": self.gps_mode,
                "jitter_m": self.jitter_m,
                "lost_supported": self.platform == "android",
            },
            "away_m": away,
            # Whether fixes are reaching the phone. While failing, the pin stays at the last fix sent.
            "link": {
                "ok": self._failing_since is None,
                "failing_s": None if self._failing_since is None else now - self._failing_since,
                "error": self.last_error if self._failing_since is not None else None,
            },
            "route": route,
            "log_seq": self.log_seq,
            "last_error": self.last_error,
        }

    def _leg_runs(self) -> list[dict[str, Any]]:
        """Contiguous runs of the same leg over ``points`` (GPX only), for drawing the map."""
        route = self.route
        if route is None or route.timing != "gpx" or len(route.legs) != len(route.points):
            return []
        runs: list[dict[str, Any]] = []
        for i in range(len(route.points)):
            leg = route.leg_at(i)
            if runs and runs[-1]["leg"] == leg:
                runs[-1]["end"] = i
            else:
                start = runs[-1]["end"] if runs else 0
                runs.append({"leg": leg, "start": start, "end": i})
        return runs

    # ------------------------------------------------------------------ connection
    async def connect(self, udid: str, pair_timeout: float = 30.0) -> dict[str, Any]:
        async with self._lock:
            if self.connected and self._driver is not None and self._driver.udid == udid:
                if await self._driver_alive():
                    return self.snapshot()
                self.note("device", "Connection was not answering · reconnecting")
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
            self._start_publisher()
            self.note("device", f"Connected to {self._driver.device_name or udid}")
            return self.snapshot()

    async def _connect_locked(self, udid: str, pair_timeout: float) -> None:
        from .android_driver import AndroidDriver, serial_is_android
        from .demo_driver import DEMO_UDID, DemoDriver, demo_enabled
        from .ios_driver import IosDriver

        log.info("connecting to %s", udid)
        driver: Any
        if udid == DEMO_UDID and demo_enabled():
            driver = DemoDriver()
        elif await serial_is_android(udid):
            driver = AndroidDriver()
        else:
            driver = IosDriver()
        try:
            await driver.connect(udid, pair_timeout)
        except Exception:
            await driver.disconnect()
            raise
        self._driver = driver

    async def _driver_alive(self) -> bool:
        ping = getattr(self._driver, "ping", None)
        if ping is None:
            return True
        try:
            await ping()
        except Exception as exc:  # noqa: BLE001
            log.info("driver ping failed: %r", exc)
            return False
        return True

    async def disconnect(self) -> None:
        async with self._lock:
            had = self._driver is not None
            await self._teardown()
            if had:
                self.note("device", "Disconnected · real GPS restored")

    async def _teardown(self) -> None:
        await self._stop_route_task()
        await self._stop_publisher()
        self.route = None
        driver = self._driver
        self._driver = None
        if driver is not None:
            try:
                await driver.disconnect()
            except Exception as exc:  # noqa: BLE001
                log.debug("driver disconnect failed: %r", exc)
        self.current = None
        self.base = None
        self.offset = Offset()
        self.gps_mode = "normal"
        self.jitter_m = 0.0
        self._sent_accuracy = None
        self._failing_since = None

    # ------------------------------------------------------------------ publisher
    def _start_publisher(self) -> None:
        if self._publisher_task is None or self._publisher_task.done():
            self._stopping = False
            self._publisher_task = asyncio.create_task(self._publisher_loop())

    async def _stop_publisher(self) -> None:
        task = self._publisher_task
        self._publisher_task = None
        if task is not None and not task.done():
            # wait_for (3.11) can swallow a cancel that races a set event, so also flag the stop.
            self._stopping = True
            self._wake.set()
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    def poke(self) -> None:
        """Ask the publisher to send now instead of at its next tick."""
        self._wake.set()

    async def _publisher_loop(self) -> None:
        last_error: Optional[str] = None
        while not self._stopping:
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=PUBLISH_INTERVAL_S)
            except asyncio.TimeoutError:
                pass
            self._wake.clear()
            if self._stopping:
                return
            try:
                await self.publish_now()
                last_error = None
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                message = getattr(exc, "message", None) or str(exc) or exc.__class__.__name__
                if message != last_error:
                    self.note("error", message)
                    log.warning("publish failed: %s", message)
                last_error = message

    def _heading(self) -> float:
        route = self.route
        if route is None or not route.playback:
            return 0.0  # static location: "right" is east, "left" is west
        samples = route.playback
        index = max(0, min(route.index, len(samples) - 1))
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
        return route.heading or 0.0

    def compose(self, base: Point) -> Point:
        """``base`` moved by the current sideways offset and jitter (no keep-alive)."""
        point = base
        signed = self.offset.current()
        if signed != 0:
            turn = 90.0 if signed > 0 else -90.0
            point = destination(base, (self._heading() + turn) % 360.0, abs(signed))
        return jitter_point(point, self.jitter_m, self._rng)

    async def publish_now(self) -> None:
        """Send the composed point once. Raises on device errors."""
        async with self._tick_lock:
            if not self.connected or self.gps_mode == "frozen":
                return
            base = self.base_point()
            if base is None:
                return
            point = self.compose(base)
            if self.current is not None and haversine_m(point, self.current) < 0.05:
                # Unchanged fix: nudge it sub-metre so the phone keeps getting fresh readings. The
                # next tick lands back on the true point, so the two alternate.
                point = destination(point, 90.0, KEEPALIVE_NUDGE_M)
            accuracy = LOST_ACCURACY_M if self.gps_mode == "lost" else None
            await self._set(point.lat, point.lon, accuracy)

    async def _set(self, lat: float, lon: float, accuracy: Optional[float] = None) -> None:
        assert self._driver is not None
        try:
            if accuracy is None and self._sent_accuracy is None:
                await self._driver.set(lat, lon)
            else:
                await self._driver.set(lat, lon, accuracy)
        except SpoofError as exc:
            self.last_error = exc.message
            self._mark_failing()
            raise
        except Exception as exc:  # noqa: BLE001
            self.last_error = str(exc)
            self._mark_failing()
            raise self._translate(exc) from exc
        self._sent_accuracy = accuracy
        self.current = Point(lat, lon)
        self.last_error = None
        if self._failing_since is not None:
            down = time.monotonic() - self._failing_since
            self._failing_since = None
            self.note("device", f"Connection restored after {_fmt_s(down)} · the phone is getting fixes again")

    def _mark_failing(self) -> None:
        if self._failing_since is None:
            self._failing_since = time.monotonic()

    # ------------------------------------------------------------------ static location
    async def set_location(self, lat: float, lon: float) -> dict[str, Any]:
        validate(lat, lon)
        self._require_connected()
        await self._stop_route_task()
        self.route = None
        self.base = Point(lat, lon)
        self.current = None
        await self.publish_now()
        self.note("location", f"Location set · {lat:.6f}, {lon:.6f}")
        return self.snapshot()

    async def clear_location(self) -> dict[str, Any]:
        self._require_connected()
        await self._stop_route_task()
        async with self._tick_lock:
            self.route = None
            self.base = None
            self.offset = Offset()
            assert self._driver is not None
            try:
                await self._driver.clear()
            except SpoofError:
                raise
            except Exception as exc:  # noqa: BLE001
                raise self._translate(exc) from exc
            self.current = None
            self._sent_accuracy = None
        self.note("location", "Stopped simulating · real GPS restored")
        return self.snapshot()

    # ------------------------------------------------------------------ route
    async def play_route(
        self,
        points: list[Point],
        speed_mps: float,
        loop: bool = False,
        *,
        gpx_pauses: list[float] | None = None,
        legs: list[str | None] | None = None,
        start_index: int = 0,
        holds: dict[int, float] | None = None,
        label: str | None = None,
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
        if holds and timing == "gpx":
            self.route.deadlines = {i: self.route.started_at + s for i, s in holds.items()}
        self.route.remaining_s = self.route.remaining_after(start_index)
        self.offset = Offset()  # every trip starts on course
        self.note("route", label or ("Trip started · GPX schedule" if timing == "gpx" else "Route started"))
        self._route_task = asyncio.create_task(self._run_route(loop, start_index))
        return self.snapshot()

    async def _run_route(self, loop: bool, start_index: int = 0) -> None:
        try:
            begin = start_index
            last_leg: Optional[str] = None
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
                    route = self.route
                    route.index = i
                    route.remaining_s = route.remaining_after(i)
                    leg = route.leg_at(i) if route.timing == "gpx" else None
                    if leg is not None and leg != last_leg:
                        if last_leg is not None:
                            self.note("trip", "Boarded · on the bus or train" if leg == "transit" else "Off the bus or train · walking")
                        last_leg = leg
                    self.poke()
                    if i < len(route.pauses):
                        if i in route.deadlines:
                            wait = route.wait_after(i)
                            if wait > 0:
                                self.note("trip", f"At the stop · waiting {_fmt_s(wait)} for the departure")
                        await asyncio.sleep(route.wait_after(i))
                if not loop:
                    break
                begin = 0
                if self.route is not None:
                    self.route.remaining_s = self.route.remaining_after(0)
            if self.route is not None:
                self.route.finished = True
                self.route.remaining_s = 0.0
                self.note("route", "Route finished · holding at the end")
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            self.last_error = f"Route stopped: {exc}"
            self.note("error", self.last_error)
            log.exception("route playback failed")
        finally:
            self._route_task = None

    async def pause_route(self, paused: bool) -> dict[str, Any]:
        if self.route is None:
            raise SpoofError("No route is playing", code="route")
        self.route.paused = paused
        self.note("hold", "Holding position" if paused else "Resumed")
        return self.snapshot()

    async def set_pace(self, factor: float) -> dict[str, Any]:
        if self.route is None:
            raise SpoofError("No route is playing", code="route")
        if not (PACE_MIN <= factor <= PACE_MAX) or math.isnan(factor):
            raise SpoofError(f"Pace must be between {PACE_MIN:g}× and {PACE_MAX:g}×", code="route")
        self.route.pace_factor = factor
        self.route.remaining_s = self.route.remaining_after(self.route.index)
        self.note("pace", f"Pace {factor:g}× on walking legs")
        return self.snapshot()

    async def stop_route(self) -> dict[str, Any]:
        await self._stop_route_task()
        if self.route is not None:
            self.base = self.base_point()  # stay where the route left off
            self.note("route", "Route stopped")
        self.route = None
        self.poke()
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

    # ------------------------------------------------------------------ test controls
    async def set_offset(self, side: str, meters: float, ramp_s: float = 0.0) -> dict[str, Any]:
        if side not in ("left", "right", "none"):
            raise SpoofError("Offset side must be left, right, or none", code="offset")
        if not (0 <= meters <= OFFSET_MAX_M) or math.isnan(meters):
            raise SpoofError(f"Offset must be between 0 and {OFFSET_MAX_M:g} m", code="offset")
        if not (0 <= ramp_s <= RAMP_MAX_S) or math.isnan(ramp_s):
            raise SpoofError(f"Drift time must be between 0 and {RAMP_MAX_S:g} s", code="offset")
        if self.base_point() is None:
            raise SpoofError("Set a location or start a route first", code="offset")
        target = 0.0 if side == "none" else (meters if side == "right" else -meters)
        self.offset.retarget(target, ramp_s)
        how = f" over {_fmt_s(ramp_s)}" if ramp_s > 0 else ""
        if side == "none":
            self.note("offset", f"Back on course{how}")
        else:
            self.note("offset", f"Off course · {meters:g} m {side}{how}")
        await self.publish_now()
        return self.snapshot()

    async def set_gps(self, mode: str, jitter_m: float) -> dict[str, Any]:
        self._require_connected()
        if mode not in GPS_MODES:
            raise SpoofError("GPS mode must be normal, frozen, or lost", code="gps")
        if not (0 <= jitter_m <= JITTER_MAX_M) or math.isnan(jitter_m):
            raise SpoofError(f"Jitter must be between 0 and {JITTER_MAX_M:g} m", code="gps")
        if mode == "lost" and self.platform != "android":
            raise SpoofError(
                "Lost signal works on Android only",
                [
                    "iOS location simulation only accepts a position, not its accuracy.",
                    "Use Frozen instead: it stops all updates, so MARTA reports GPS lost after 20 s.",
                ],
                code="gps_unsupported",
            )
        previous = self.gps_mode
        driver = self._driver
        if mode == "frozen" and previous != "frozen" and hasattr(driver, "freeze"):
            await driver.freeze()
        if mode != "frozen" and previous == "frozen" and hasattr(driver, "resume"):
            await driver.resume()
        self.gps_mode = mode
        if jitter_m != self.jitter_m:
            self.note("gps", f"Jitter ±{jitter_m:g} m" if jitter_m else "Jitter off")
        self.jitter_m = jitter_m
        if mode != previous:
            self.note("gps", {
                "normal": "GPS normal",
                "frozen": "GPS frozen · no updates sent",
                "lost": f"GPS lost signal · accuracy {LOST_ACCURACY_M:g} m (ignored by MARTA)",
            }[mode])
        await self.publish_now()
        return self.snapshot()

    # ------------------------------------------------------------------ misc
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


def _fmt_s(seconds: float) -> str:
    s = max(0, int(round(seconds)))
    m, s = divmod(s, 60)
    return f"{m} min {s} s" if m else f"{s} s"
