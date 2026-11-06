"""Pure geometry helpers and GPX parsing. No device I/O — unit-testable."""

from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Iterable

import gpxpy

EARTH_RADIUS_M = 6_371_000.0
WALK_SPEED_MPS = 1.4
# Slower than this between two GPX points counts as standing still.
HOLD_SPEED_MPS = 0.5


@dataclass(frozen=True)
class Point:
    lat: float
    lon: float


@dataclass(frozen=True)
class TimedPoint:
    lat: float
    lon: float
    """Unix epoch seconds from GPX ``<time>``, or ``None`` if absent."""

    time_s: float | None = None
    """``rider``, ``transit``, or ``None`` when the GPX has no ``<cmt>`` tag."""

    leg: str | None = None


def validate(lat: float, lon: float) -> None:
    if not (-90.0 <= lat <= 90.0):
        raise ValueError(f"latitude {lat} out of range [-90, 90]")
    if not (-180.0 <= lon <= 180.0):
        raise ValueError(f"longitude {lon} out of range [-180, 180]")
    if math.isnan(lat) or math.isnan(lon):
        raise ValueError("coordinates must be numbers")


def haversine_m(a: Point, b: Point) -> float:
    phi1, phi2 = math.radians(a.lat), math.radians(b.lat)
    dphi = phi2 - phi1
    dlmb = math.radians(b.lon - a.lon)
    h = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def interpolate(a: Point, b: Point, t: float) -> Point:
    """Linear interpolation — fine for the short legs a route player produces."""
    return Point(a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t)


def route_length_m(points: Iterable[Point]) -> float:
    pts = list(points)
    return sum(haversine_m(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def resample(points: list[Point], speed_mps: float, tick_s: float = 1.0) -> list[Point]:
    """Turn a polyline into evenly spaced samples, one per tick at the given speed.

    The first and last points are always included so the route starts and ends exactly where the
    user asked.
    """
    if speed_mps <= 0:
        raise ValueError("speed must be positive")
    if len(points) < 2:
        return list(points)
    step = speed_mps * tick_s
    out: list[Point] = [points[0]]
    carry = 0.0  # distance already covered inside the current leg when the last sample was emitted
    for i in range(len(points) - 1):
        a, b = points[i], points[i + 1]
        leg = haversine_m(a, b)
        if leg == 0:
            continue
        pos = step - carry
        while pos < leg:
            out.append(interpolate(a, b, pos / leg))
            pos += step
        carry = leg - (pos - step)
    if out[-1] != points[-1]:
        out.append(points[-1])
    return out


def _gpx_points(gpx: gpxpy.GPX) -> list[gpxpy.GPXTrackPoint | gpxpy.GPXRoutePoint | gpxpy.GPXWaypoint]:
    raw: list[gpxpy.GPXTrackPoint | gpxpy.GPXRoutePoint | gpxpy.GPXWaypoint] = []
    for track in gpx.tracks:
        for seg in track.segments:
            raw.extend(seg.points)
    for route in gpx.routes:
        raw.extend(route.points)
    if not raw:
        raw.extend(gpx.waypoints)
    if not raw:
        raise ValueError("GPX contains no track, route or waypoint points")
    return raw


def parse_gpx(text: str) -> list[Point]:
    return [Point(p.latitude, p.longitude) for p in _gpx_points(gpxpy.parse(text))]


def _leg_tag(point: gpxpy.GPXTrackPoint | gpxpy.GPXRoutePoint | gpxpy.GPXWaypoint) -> str | None:
    comment = getattr(point, "comment", None)
    if comment in ("rider", "transit"):
        return comment
    return None


def parse_gpx_timed(text: str) -> list[TimedPoint]:
    out: list[TimedPoint] = []
    for p in _gpx_points(gpxpy.parse(text)):
        time_s = p.time.timestamp() if p.time is not None else None
        out.append(TimedPoint(p.latitude, p.longitude, time_s, _leg_tag(p)))
    return out


def bearing_deg(origin: Point, toward: Point) -> float | None:
    """Degrees clockwise from north, or ``None`` when the points are the same place."""
    if haversine_m(origin, toward) < 1.0:
        return None
    lat1, lat2 = math.radians(origin.lat), math.radians(toward.lat)
    dlon = math.radians(toward.lon - origin.lon)
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def destination(origin: Point, bearing: float, meters: float) -> Point:
    ang = meters / EARTH_RADIUS_M
    br = math.radians(bearing)
    lat1 = math.radians(origin.lat)
    lon1 = math.radians(origin.lon)
    lat2 = math.asin(math.sin(lat1) * math.cos(ang) + math.cos(lat1) * math.sin(ang) * math.cos(br))
    lon2 = lon1 + math.atan2(
        math.sin(br) * math.sin(ang) * math.cos(lat1),
        math.cos(ang) - math.sin(lat1) * math.sin(lat2),
    )
    return Point(math.degrees(lat2), math.degrees(lon2))


def offset_sideways(origin: Point, toward: Point, meters: float, side: str) -> Point:
    """Shift ``origin`` left or right of the direction toward ``toward``."""
    if side not in ("left", "right") or meters == 0:
        return origin
    heading = bearing_deg(origin, toward)
    if heading is None:
        return origin
    turn = 90.0 if side == "right" else -90.0
    return destination(origin, (heading + turn) % 360.0, meters)


def paced_wait(base_s: float, leg: str | None, factor: float) -> float:
    """Speed up or slow down a rider gap. A transit gap stays on the timetable."""
    if factor <= 0:
        raise ValueError("pace factor must be positive")
    if leg == "transit":
        return base_s
    return base_s / factor


def gpx_playback_pauses(
    timed: list[TimedPoint], time_scale: float = 1.0
) -> tuple[list[Point], list[float], list[str | None]]:
    """Build playback from GPX timestamps.

    Returns points, ``pauses[i]`` = seconds to wait after point ``i`` before point ``i+1``,
    and ``legs[i]`` = ``rider``, ``transit``, or ``None`` when the point has no tag.
    ``time_scale`` > 1 finishes faster (5 = five times faster). Live pace is applied later,
    and only on rider gaps.
    """
    if time_scale <= 0:
        raise ValueError("time_scale must be positive")
    if len(timed) < 2:
        raise ValueError("GPX timed playback needs at least two points")
    if any(p.time_s is None for p in timed):
        raise ValueError("GPX timed playback requires a <time> on every track point")
    points = [Point(p.lat, p.lon) for p in timed]
    pauses: list[float] = []
    for i in range(len(timed) - 1):
        delta = timed[i + 1].time_s - timed[i].time_s  # type: ignore[operator]
        if delta < 0:
            delta = 0.0
        pauses.append(delta / time_scale)
    return points, pauses, [p.leg for p in timed]


def align_gpx_to_now(
    timed: list[TimedPoint], time_scale: float = 1.0, now: float | None = None
) -> tuple[list[Point], list[float], list[str | None], int]:
    """Join a timed track at the current clock.

    Returns the full path, waits, leg tags, and the index to start at. Points already in the past
    are not replayed. The first wait is whatever remains until the next timestamp.
    """
    if now is None:
        now = time.time()
    points, pauses, legs = gpx_playback_pauses(timed, time_scale)
    times = [p.time_s for p in timed]
    if any(t is None for t in times):
        raise ValueError("GPX timed playback requires a <time> on every track point")
    last = times[-1]
    assert last is not None
    if now > last:
        raise ValueError("This GPX trip is already over")
    start = 0
    for i, stamp in enumerate(times):
        assert stamp is not None
        if stamp <= now:
            start = i
        else:
            break
    if start < len(pauses):
        nxt = times[start + 1]
        assert nxt is not None
        pauses[start] = max(0.0, (nxt - now) / time_scale)
    return points, pauses, legs, start


def walk_ahead(
    timed: list[TimedPoint],
    points: list[Point],
    pauses: list[float],
    legs: list[str | None],
    start: int,
    time_scale: float = 1.0,
    now: float | None = None,
) -> tuple[list[float], dict[int, float]]:
    """Walk to the first boarding stop now instead of waiting for the leave-by time.

    Takes the output of :func:`align_gpx_to_now`. The walking stretch before the first ``transit``
    point plays at once, at its own pace, with stationary holds (the wait before leave-by, an early
    arrival at the stop) dropped. The pin then waits at the stop until the boarding point's own
    timestamp, so the ride itself stays on the timetable.

    Returns the new waits and ``holds``: index → seconds from now (scaled) until the gap after
    that index may end. The player waits until that wall-clock deadline rather than a fixed
    duration, so a slower walk eats into the wait instead of delaying the bus.
    """
    if now is None:
        now = time.time()
    if legs[start] != "rider":
        raise ValueError(
            "Start walking now only works when the trip begins with a walk "
            "(the next GPX point must be tagged <cmt>rider</cmt>)"
        )
    board = next((i for i in range(start + 1, len(points)) if legs[i] == "transit"), None)
    walk_end = len(pauses) if board is None else board - 1
    out = list(pauses)
    for i in range(start, walk_end):
        dist = haversine_m(points[i], points[i + 1])
        a, b = timed[i].time_s, timed[i + 1].time_s
        assert a is not None and b is not None
        gap = max(0.0, b - a)
        if dist < 1.0:
            out[i] = 0.0
        elif gap > 0 and dist / gap < HOLD_SPEED_MPS:
            # A crawl this slow is a wait (before leave-by, or early at the stop), not walking.
            out[i] = dist / WALK_SPEED_MPS / time_scale
        elif i != start:
            out[i] = gap / time_scale
    holds: dict[int, float] = {}
    if board is not None:
        departs = timed[board].time_s
        assert departs is not None
        holds[board - 1] = max(0.0, (departs - now) / time_scale)
    return out, holds
