"""Miss a departure with Hold, then wait at the stop for a later one (MARTAOTG-1372)."""

import asyncio
import time
import unittest

from backend.geo import Point
from backend.spoof import SpoofError, SpoofSession

HOME = Point(33.7500, -84.3900)
STOP = Point(33.7510, -84.3900)
MID = Point(33.7550, -84.3900)
NEXT = Point(33.7600, -84.3900)

# HOME -walk-> STOP (boarding point) -ride-> MID -ride-> NEXT
POINTS = [HOME, STOP, STOP, MID, NEXT]
LEGS = ["rider", "rider", "transit", "transit", "transit"]


class _FakeDriver:
    platform = "ios"
    ios_version = "26.0"
    android_version = None
    strategy = "fake"
    transport = "fake"
    udid = "TEST"
    device_name = "Test"
    connected = True

    async def set(self, lat, lon, accuracy=None):
        return None

    async def disconnect(self):
        return None


def _session() -> SpoofSession:
    session = SpoofSession()
    session._driver = _FakeDriver()
    return session


async def _play(session, pauses, holds=None):
    await session.play_route(POINTS, 1.4, gpx_pauses=pauses, legs=LEGS, holds=holds)


class DepartLaterTests(unittest.TestCase):
    def test_held_rider_misses_the_train_then_boards_the_later_one(self):
        session = _session()

        async def run():
            await _play(session, [0.1, 0.4, 0.1, 0.1])
            await asyncio.sleep(0.25)  # at the stop
            await session.pause_route(True)
            await asyncio.sleep(0.8)  # departure was ~0.5 s in: missed
            missed = session.snapshot()["route"]
            snap = await session.depart_later(after_planned_s=2.0)  # next train ~1.7 s from now
            await asyncio.sleep(1.0)
            waiting = session.snapshot()["route"]
            await asyncio.sleep(1.2)
            boarded = session.snapshot()["route"]
            await session.stop_route()
            return missed, snap["route"], waiting, boarded

        missed, after, waiting, boarded = asyncio.run(run())
        self.assertEqual(missed["index"], 1)
        self.assertTrue(missed["boarding"])
        self.assertLess(missed["departs_at"], time.time())
        self.assertFalse(after["paused"])  # Hold released: boards on its own
        self.assertGreater(after["hold_s"], 1.4)
        self.assertEqual(waiting["index"], 1)  # still on the platform, not on the missed train
        self.assertGreaterEqual(boarded["index"], 2)
        self.assertTrue(any("Skipped the" in e["text"] for e in session.log))

    def test_hold_at_stop_keeps_rider_there_after_departure(self):
        session = _session()

        async def run():
            await _play(session, [0.1, 0.3, 0.1, 0.1])
            await asyncio.sleep(0.15)
            await session.pause_route(True)
            await asyncio.sleep(0.6)
            route = session.snapshot()["route"]
            await session.stop_route()
            return route

        self.assertEqual(asyncio.run(run())["index"], 1)

    def test_later_scheduled_departures_move_by_the_same_amount(self):
        session = _session()

        async def run():
            await _play(session, [0.1, 0.0, 0.1, 0.0], holds={1: 5.0, 3: 20.0})
            await asyncio.sleep(0.3)  # waiting at the stop for the 5 s departure
            route = session.route
            before = dict(route.deadlines)
            await session.depart_later(after_planned_s=600)
            after = dict(route.deadlines)
            await session.stop_route()
            return before, after

        before, after = asyncio.run(run())
        self.assertAlmostEqual(after[1] - before[1], 600, delta=0.01)
        self.assertAlmostEqual(after[3] - before[3], 600, delta=0.01)

    def test_clock_time_sets_the_departure(self):
        session = _session()

        async def run():
            await _play(session, [0.1, 0.0, 0.1, 0.0], holds={1: 5.0})
            await asyncio.sleep(0.3)
            snap = await session.depart_later(at_unix=time.time() + 120)
            await session.stop_route()
            return snap["route"]

        route = asyncio.run(run())
        self.assertAlmostEqual(route["hold_s"], 120, delta=1)
        self.assertAlmostEqual(route["departs_at"], time.time() + 120, delta=1)

    def test_rejects_a_time_that_has_passed(self):
        session = _session()

        async def run():
            await _play(session, [0.1, 5.0, 0.1, 0.1])
            await asyncio.sleep(0.3)
            try:
                await session.depart_later(at_unix=time.time() - 60)
            finally:
                await session.stop_route()

        with self.assertRaises(SpoofError):
            asyncio.run(run())

    def test_walk_ahead_flag_is_not_set_by_a_later_departure(self):
        session = _session()

        async def run():
            await _play(session, [0.1, 5.0, 0.1, 0.1])
            await asyncio.sleep(0.3)
            snap = await session.depart_later(after_planned_s=60)
            await session.stop_route()
            return snap["route"]

        self.assertFalse(asyncio.run(run())["walk_ahead"])


if __name__ == "__main__":
    unittest.main()
