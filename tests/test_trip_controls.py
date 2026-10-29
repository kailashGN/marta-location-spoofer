"""Leg tags, sideways offset, and pace that leaves a transit gap alone."""

import unittest
from datetime import datetime, timezone

from backend.geo import Point, TimedPoint, gpx_playback_pauses, haversine_m, offset_sideways, paced_wait, parse_gpx_timed


def _gpx(points: list[tuple[float, float, str, str | None]]) -> str:
    rows = []
    for lat, lon, stamp, leg in points:
        cmt = f"<cmt>{leg}</cmt>" if leg else ""
        rows.append(f'<trkpt lat="{lat}" lon="{lon}"><time>{stamp}</time>{cmt}</trkpt>')
    body = "\n".join(rows)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><trkseg>
{body}
  </trkseg></trk>
</gpx>"""


class TripControlTests(unittest.TestCase):
    def test_cmt_round_trip(self):
        text = _gpx([
            (33.75, -84.39, "2026-10-01T13:11:00Z", "transit"),
            (33.76, -84.39, "2026-10-01T13:11:10Z", "rider"),
            (33.77, -84.39, "2026-10-01T13:11:20Z", None),
        ])
        timed = parse_gpx_timed(text)
        self.assertEqual([p.leg for p in timed], ["transit", "rider", None])
        _points, pauses, legs = gpx_playback_pauses(timed, time_scale=1)
        self.assertEqual(pauses, [10.0, 10.0])
        self.assertEqual(legs, ["transit", "rider", None])

    def test_right_of_northbound_is_east(self):
        origin = Point(33.7, -84.4)
        north = Point(33.8, -84.4)
        shifted = offset_sideways(origin, north, 100, "right")
        self.assertAlmostEqual(haversine_m(origin, shifted), 100, delta=1)
        self.assertGreater(shifted.lon, origin.lon)
        self.assertAlmostEqual(shifted.lat, origin.lat, delta=0.001)

    def test_pace_skips_transit_gaps(self):
        self.assertEqual(paced_wait(10, "rider", 2), 5)
        self.assertEqual(paced_wait(10, None, 2), 5)
        self.assertEqual(paced_wait(10, "transit", 2), 10)
        self.assertEqual(paced_wait(10, "rider", 0.5), 20)

    def test_timed_point_keeps_leg(self):
        point = TimedPoint(1, 2, datetime(2026, 10, 1, tzinfo=timezone.utc).timestamp(), "transit")
        self.assertEqual(point.leg, "transit")


if __name__ == "__main__":
    unittest.main()
