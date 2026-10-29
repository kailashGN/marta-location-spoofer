import unittest

from backend.geo import (
    Point,
    TimedPoint,
    gpx_playback_pauses,
    haversine_m,
    parse_gpx,
    parse_gpx_timed,
    resample,
    route_length_m,
    validate,
)


class GeoTests(unittest.TestCase):
    def test_validate_bounds(self):
        validate(0, 0); validate(90, 180); validate(-90, -180)
        for bad in [(91, 0), (0, 181), (-91, 0), (0, -181)]:
            with self.assertRaises(ValueError):
                validate(*bad)

    def test_haversine_known_distance(self):
        # Apple Park → Golden Gate Bridge ≈ 63.7 km
        d = haversine_m(Point(37.3349, -122.0090), Point(37.8199, -122.4783))
        self.assertAlmostEqual(d / 1000, 66.0, delta=3)

    def test_resample_keeps_endpoints_and_spacing(self):
        pts = [Point(37.0, -122.0), Point(37.01, -122.0)]  # ~1112 m due north
        out = resample(pts, speed_mps=10)
        self.assertEqual(out[0], pts[0]); self.assertEqual(out[-1], pts[-1])
        self.assertTrue(108 <= len(out) <= 114)
        gaps = [haversine_m(out[i], out[i + 1]) for i in range(len(out) - 2)]
        self.assertTrue(all(abs(g - 10) < 0.5 for g in gaps))

    def test_resample_rejects_bad_speed(self):
        with self.assertRaises(ValueError):
            resample([Point(0, 0), Point(1, 1)], 0)

    def test_route_length(self):
        self.assertEqual(route_length_m([Point(0, 0)]), 0)

    def test_parse_gpx_track_and_route(self):
        gpx = '''<?xml version="1.0"?><gpx version="1.1" creator="t">
        <trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.1" lon="2.1"/></trkseg></trk>
        <rte><rtept lat="3" lon="4"/></rte></gpx>'''
        self.assertEqual(parse_gpx(gpx), [Point(1, 2), Point(1.1, 2.1), Point(3, 4)])
        with self.assertRaises(ValueError):
            parse_gpx('<gpx version="1.1" creator="t"></gpx>')

    def test_gpx_playback_pauses_from_timestamps(self):
        gpx = """<?xml version="1.0"?><gpx version="1.1" creator="t">
        <trk><trkseg>
          <trkpt lat="1" lon="2"><time>2026-01-01T00:00:00Z</time></trkpt>
          <trkpt lat="1" lon="2"><time>2026-01-01T00:00:10Z</time></trkpt>
          <trkpt lat="1" lon="2"><time>2026-01-01T00:00:15Z</time></trkpt>
        </trkseg></trk></gpx>"""
        timed = parse_gpx_timed(gpx)
        pts, pauses, legs = gpx_playback_pauses(timed, time_scale=1)
        self.assertEqual(len(pts), 3)
        self.assertEqual(pauses, [10.0, 5.0])
        self.assertEqual(legs, [None, None, None])
        _, pauses5, _legs5 = gpx_playback_pauses(timed, time_scale=5)
        self.assertEqual(pauses5, [2.0, 1.0])

    def test_gpx_playback_requires_times(self):
        with self.assertRaises(ValueError):
            gpx_playback_pauses(
                [TimedPoint(0, 0, None), TimedPoint(1, 1, 1.0)],
                time_scale=1,
            )


if __name__ == "__main__":
    unittest.main()
