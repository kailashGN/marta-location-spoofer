"""A ready-made practice trip in downtown Atlanta, timed from the moment it is requested.

Same shape as the GPX that MARTA's secret menu exports (one point a second, ``<cmt>rider</cmt>`` on
walks and ``<cmt>transit</cmt>`` on rides), so every Trip option works on it:

- a walk, starting the moment the trip is requested, from the State Capitol to Five Points station;
- spare time at the platform before the train leaves, so *Pace* can make the rider miss it;
- a Red/Gold line ride north to Midtown, stopping at each station;
- a walk to 14th Street.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Optional

from .geo import Point, haversine_m, interpolate

WALK_MPS = 1.3
PLATFORM_WAIT_S = 120
TRAIN_MPS = 10.0
STATION_DWELL_S = 20

WALK_TO_STATION = [
    Point(33.74896, -84.38797),  # Georgia State Capitol
    Point(33.75020, -84.38800),
    Point(33.75190, -84.38900),
    Point(33.75330, -84.39050),
    Point(33.75390, -84.39160),  # Five Points station
]
TRAIN = [
    Point(33.75390, -84.39160),  # Five Points
    Point(33.75970, -84.38750),  # Peachtree Center
    Point(33.76640, -84.38740),  # Civic Center
    Point(33.77160, -84.38700),  # North Avenue
    Point(33.78100, -84.38640),  # Midtown
]
WALK_TO_DEST = [
    Point(33.78100, -84.38640),  # Midtown station
    Point(33.78150, -84.38380),
    Point(33.78670, -84.38380),  # 14th Street
]


def _iso(t: float) -> str:
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _travel(path: list[Point], speed: float, t: float, leg: str, out: list[tuple[Point, float, str]], dwell_s: float = 0) -> float:
    """Append one point a second along ``path``; return the clock at the end."""
    for i, (a, b) in enumerate(zip(path, path[1:])):
        seconds = max(1, round(haversine_m(a, b) / speed))
        for s in range(1, seconds + 1):
            out.append((interpolate(a, b, s / seconds), t + s, leg))
        t += seconds
        if dwell_s and i < len(path) - 2:
            for s in range(1, int(dwell_s) + 1):
                out.append((b, t + s, leg))
            t += dwell_s
    return t


def sample_points(now: Optional[float] = None) -> list[tuple[Point, float, str]]:
    now = float(round(time.time() if now is None else now))
    pts: list[tuple[Point, float, str]] = [(WALK_TO_STATION[0], now, "rider")]
    t = _travel(WALK_TO_STATION, WALK_MPS, now, "rider", pts)
    pts.append((TRAIN[0], t + PLATFORM_WAIT_S, "transit"))
    t = _travel(TRAIN, TRAIN_MPS, t + PLATFORM_WAIT_S, "transit", pts, STATION_DWELL_S)
    _travel(WALK_TO_DEST, WALK_MPS, t, "rider", pts)
    return pts


def sample_gpx(now: Optional[float] = None) -> str:
    pts = sample_points(now)
    rows = "\n".join(
        f'    <trkpt lat="{p.lat:.7f}" lon="{p.lon:.7f}"><time>{_iso(t)}</time><cmt>{leg}</cmt></trkpt>'
        for p, t, leg in pts
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Location Spoofer sample trip" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Practice trip</name><time>{_iso(pts[0][1])}</time></metadata>
  <trk><name>Practice trip</name><trkseg>
{rows}
  </trkseg></trk>
</gpx>
"""
