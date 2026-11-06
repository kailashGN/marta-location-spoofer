import os
import unittest

from backend import demo_driver
from backend.geo import align_gpx_to_now, haversine_m, parse_gpx_timed, walk_ahead
from backend.sample_trip import PLATFORM_WAIT_S, sample_gpx, sample_points

NOW = 1_800_000_000.0


class SampleTripTest(unittest.TestCase):
    def test_times_climb_one_point_at_a_time(self):
        pts = sample_points(NOW)
        times = [t for _, t, _ in pts]
        self.assertEqual(times[0], NOW)
        self.assertEqual(times, sorted(times))
        self.assertEqual(len(times), len(set(times)))

    def test_legs_are_walk_ride_walk(self):
        legs = [leg for _, _, leg in sample_points(NOW)]
        runs = [legs[0]] + [b for a, b in zip(legs, legs[1:]) if a != b]
        self.assertEqual(runs, ["rider", "transit", "rider"])

    def test_walks_from_the_first_second_then_waits_at_the_platform(self):
        pts = sample_points(NOW)
        self.assertEqual(pts[1][1] - NOW, 1)
        self.assertGreater(haversine_m(pts[0][0], pts[1][0]), 1)
        board = next(i for i, (_, _, leg) in enumerate(pts) if leg == "transit")
        self.assertEqual(pts[board][1] - pts[board - 1][1], PLATFORM_WAIT_S)
        self.assertLess(haversine_m(pts[board][0], pts[board - 1][0]), 1)

    def test_walking_pace_is_realistic(self):
        pts = sample_points(NOW)
        for (a, ta, la), (b, tb, lb) in zip(pts, pts[1:]):
            if la == lb == "rider" and tb > ta:
                self.assertLess(haversine_m(a, b) / (tb - ta), 2.0)

    def test_parses_and_supports_start_walking_now(self):
        timed = parse_gpx_timed(sample_gpx(NOW))
        self.assertEqual(len(timed), len(sample_points(NOW)))
        points, pauses, legs, start = align_gpx_to_now(timed, 1.0, NOW + 5)
        waits, holds = walk_ahead(timed, points, pauses, legs, start, 1.0, NOW + 5)
        self.assertEqual(len(holds), 1)
        self.assertLessEqual(waits[start], 1.0)


class PracticeModeTest(unittest.TestCase):
    def setUp(self):
        self._env = os.environ.pop("LS_DEMO", None)

    def tearDown(self):
        demo_driver.set_practice(False)
        if self._env is not None:
            os.environ["LS_DEMO"] = self._env

    def test_toggle(self):
        self.assertFalse(demo_driver.demo_enabled())
        demo_driver.set_practice(True)
        self.assertTrue(demo_driver.demo_enabled())
        demo_driver.set_practice(False)
        self.assertFalse(demo_driver.demo_enabled())

    def test_env_still_works(self):
        os.environ["LS_DEMO"] = "1"
        try:
            self.assertTrue(demo_driver.demo_enabled())
        finally:
            del os.environ["LS_DEMO"]


if __name__ == "__main__":
    unittest.main()
