"""Start walking now: walk to the first stop before leave-by, then wait there for the departure."""

import asyncio
import time
import unittest
from unittest.mock import AsyncMock

from backend.geo import Point, TimedPoint, align_gpx_to_now, walk_ahead
from backend.spoof import SpoofSession

NOW = 1_000_000.0
HOME = (33.7500, -84.3900)
MID = (33.7505, -84.3900)  # ~55 m north
STOP = (33.7510, -84.3900)  # ~110 m north
NEXT = (33.7600, -84.3900)


def _trip(lead_in_s: float = 600) -> list[TimedPoint]:
    """Start pressed at NOW, leave-by ``lead_in_s`` later; 60 s walk, 120 s early at the stop."""
    leave = NOW + lead_in_s
    return [
        TimedPoint(*HOME, NOW, "rider"),       # lead-in: stationary until leave-by
        TimedPoint(*HOME, leave, "rider"),
        TimedPoint(*MID, leave + 30, "rider"),
        TimedPoint(*STOP, leave + 60, "rider"),
        TimedPoint(*STOP, leave + 180, "transit"),  # boarding: the departure
        TimedPoint(*NEXT, leave + 480, "transit"),
    ]


class WalkAheadTests(unittest.TestCase):
    def _run(self, timed, now=NOW, scale=1.0):
        pts, pauses, legs, start = align_gpx_to_now(timed, scale, now)
        return walk_ahead(timed, pts, pauses, legs, start, scale, now), (pauses, start)

    def test_walks_now_and_holds_until_departure(self):
        (pauses, holds), (aligned, start) = self._run(_trip())
        self.assertEqual(start, 0)
        self.assertEqual(aligned[0], 600)  # before: stuck at home for the lead-in
        self.assertEqual(pauses[:2], [0.0, 30.0])  # lead-in dropped, walk keeps its pace
        self.assertEqual(holds, {3: 780.0})  # wait at the stop until the departure clock
        self.assertEqual(pauses[4], 300.0)  # the ride stays on the timetable

    def test_slow_crawl_before_leave_by_counts_as_a_wait(self):
        # Lead-in drawn as a 10 m creep over 10 minutes instead of a stationary point.
        timed = [TimedPoint(33.75, -84.39, NOW, "rider"),
                 TimedPoint(33.75009, -84.39, NOW + 600, "rider"),
                 TimedPoint(*STOP, NOW + 660, "rider"),
                 TimedPoint(*STOP, NOW + 900, "transit"),
                 TimedPoint(*NEXT, NOW + 1200, "transit")]
        (pauses, holds), _ = self._run(timed)
        self.assertLess(pauses[0], 10)  # ~10 m at walking pace, not 600 s
        self.assertEqual(holds, {2: 900.0})

    def test_time_scale_applies(self):
        (pauses, holds), _ = self._run(_trip(), scale=2.0)
        self.assertEqual(pauses[:2], [0.0, 15.0])
        self.assertEqual(holds, {3: 390.0})

    def test_mid_walk_keeps_aligned_first_gap(self):
        (pauses, holds), (aligned, start) = self._run(_trip(), now=NOW + 610)
        self.assertEqual(start, 1)
        self.assertEqual(pauses[1], aligned[1])  # 20 s left of the current gap
        self.assertEqual(holds, {3: 170.0})

    def test_rejects_trip_starting_on_transit(self):
        timed = [TimedPoint(*STOP, NOW, "transit"), TimedPoint(*NEXT, NOW + 60, "transit")]
        with self.assertRaises(ValueError):
            self._run(timed)

    def test_rejects_untagged_trip(self):
        timed = [TimedPoint(*HOME, NOW, None), TimedPoint(*STOP, NOW + 60, None)]
        with self.assertRaises(ValueError):
            self._run(timed)

    def test_walk_only_trip_has_no_hold(self):
        timed = [TimedPoint(*HOME, NOW, "rider"), TimedPoint(*HOME, NOW + 600, "rider"),
                 TimedPoint(*STOP, NOW + 660, "rider")]
        (pauses, holds), _ = self._run(timed)
        self.assertEqual(pauses, [0.0, 60.0])
        self.assertEqual(holds, {})


class _FakeDriver:
    platform = "ios"
    ios_version = "26.0"
    android_version = None
    strategy = "dvt"
    transport = "native"
    udid = "TEST"
    device_name = "Test"
    connected = True

    async def disconnect(self) -> None:
        return None


class WalkAheadPlaybackTests(unittest.TestCase):
    def test_reaches_stop_then_reports_hold(self):
        session = SpoofSession()
        session._driver = _FakeDriver()
        published = []

        async def record(lat, lon, accuracy=None):
            published.append((round(lat, 4), round(lon, 4)))
            session.current = Point(lat, lon)

        session._set = AsyncMock(side_effect=record)
        timed = _trip()
        now = time.time()
        shift = now - NOW
        timed = [TimedPoint(p.lat, p.lon, p.time_s + shift, p.leg) for p in timed]
        pts, pauses, legs, start = align_gpx_to_now(timed, 100.0, now)
        pauses, holds = walk_ahead(timed, pts, pauses, legs, start, 100.0, now)

        async def run():
            session._start_publisher()
            await session.play_route(pts, 1.4, gpx_pauses=pauses, legs=legs, start_index=start, holds=holds)
            await asyncio.sleep(1.0)  # 60 s walk at 100× = 0.6 s; departure is 7.8 s away
            snap = session.snapshot()
            await session.stop_route()
            await session._stop_publisher()
            return snap

        snap = asyncio.run(run())
        route = snap["route"]
        self.assertEqual(route["index"], 3)
        self.assertTrue(route["walk_ahead"])
        self.assertGreater(route["hold_s"], 6.5)
        self.assertLess(route["hold_s"], 8.0)
        # remaining_s was computed on arrival at the stop, a moment before this snapshot.
        self.assertAlmostEqual(route["remaining_s"], route["hold_s"] + 3.0, delta=0.6)
        self.assertIn(STOP, published)
        self.assertTrue(any("At the stop" in e["text"] for e in session.log))


if __name__ == "__main__":
    unittest.main()
