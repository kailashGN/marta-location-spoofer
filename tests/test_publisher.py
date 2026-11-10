"""The 1 Hz publisher: offsets (jump and drift), jitter, freeze, lost signal, keep-alive, and the log."""

import asyncio
import random
import unittest
from unittest import mock

from pydantic import ValidationError

from backend import server
from backend.geo import Point, haversine_m
from backend.spoof import (
    KEEPALIVE_NUDGE_M,
    LOG_SIZE,
    LOST_ACCURACY_M,
    Offset,
    SpoofError,
    SpoofSession,
    jitter_point,
)

ORIGIN = Point(33.7537, -84.3915)


class _FakeDriver:
    ios_version = None
    android_version = None
    strategy = "fake"
    transport = "fake"
    udid = "TEST"
    device_name = "Test"
    connected = True

    def __init__(self, platform="ios"):
        self.platform = platform
        self.sent = []
        self.frozen_calls = []

    async def set(self, lat, lon, accuracy=None):
        self.sent.append((lat, lon, accuracy))

    async def clear(self):
        self.sent.append("clear")

    async def freeze(self):
        self.frozen_calls.append("freeze")

    async def resume(self):
        self.frozen_calls.append("resume")

    async def disconnect(self):
        return None


def _session(platform="ios"):
    session = SpoofSession(rng=random.Random(7))
    session._driver = _FakeDriver(platform)
    return session


class OffsetTests(unittest.TestCase):
    def test_jump_is_immediate(self):
        o = Offset()
        o.retarget(600, 0, now=10)
        self.assertEqual(o.current(10), 600)
        self.assertFalse(o.ramping(10))

    def test_drift_interpolates_out_and_back(self):
        o = Offset()
        o.retarget(600, 60, now=0)
        self.assertAlmostEqual(o.current(30), 300)
        self.assertTrue(o.ramping(30))
        self.assertEqual(o.current(61), 600)
        o.retarget(0, 20, now=100)
        self.assertAlmostEqual(o.current(110), 300)
        self.assertEqual(o.current(121), 0)

    def test_switching_sides_crosses_the_route(self):
        o = Offset()
        o.retarget(-300, 0, now=0)
        o.retarget(300, 10, now=0)
        self.assertAlmostEqual(o.current(5), 0)


class JitterTests(unittest.TestCase):
    def test_bounded_by_three_sigma_and_seeded(self):
        a = [jitter_point(ORIGIN, 20, random.Random(1)) for _ in range(1)]
        b = [jitter_point(ORIGIN, 20, random.Random(1)) for _ in range(1)]
        self.assertEqual(a, b)
        rng = random.Random(3)
        for _ in range(500):
            self.assertLessEqual(haversine_m(ORIGIN, jitter_point(ORIGIN, 20, rng)), 60.01)

    def test_zero_jitter_is_identity(self):
        self.assertEqual(jitter_point(ORIGIN, 0, random.Random(1)), ORIGIN)


class PublishTests(unittest.TestCase):
    def test_static_offset_right_is_east_at_distance(self):
        session = _session()

        async def run():
            await session.set_location(ORIGIN.lat, ORIGIN.lon)
            return await session.set_offset("right", 450)

        snap = asyncio.run(run())
        lat, lon, _ = session._driver.sent[-1]
        self.assertAlmostEqual(haversine_m(ORIGIN, Point(lat, lon)), 450, delta=1)
        self.assertGreater(lon, ORIGIN.lon)
        self.assertEqual(snap["offset"], {"side": "right", "target_m": 450, "current_m": 450, "ramping": False, "ramp_left_s": 0.0})
        self.assertAlmostEqual(snap["away_m"], 450, delta=1)
        self.assertEqual(snap["base"], {"lat": ORIGIN.lat, "lon": ORIGIN.lon})

    def test_offset_needs_a_point(self):
        with self.assertRaises(SpoofError):
            asyncio.run(_session().set_offset("left", 100))

    def test_offset_range(self):
        session = _session()

        async def run():
            await session.set_location(ORIGIN.lat, ORIGIN.lon)
            await session.set_offset("left", 6000)

        with self.assertRaises(SpoofError):
            asyncio.run(run())

    def test_unchanged_point_alternates_keepalive_nudge(self):
        session = _session()

        async def run():
            await session.set_location(ORIGIN.lat, ORIGIN.lon)
            await session.publish_now()
            await session.publish_now()

        asyncio.run(run())
        pts = [Point(lat, lon) for lat, lon, _ in session._driver.sent]
        self.assertEqual(pts[0], ORIGIN)
        self.assertAlmostEqual(haversine_m(ORIGIN, pts[1]), KEEPALIVE_NUDGE_M, delta=0.01)
        self.assertEqual(pts[2], ORIGIN)

    def test_freeze_sends_nothing_and_resume_sends_again(self):
        session = _session("android")

        async def run():
            await session.set_location(ORIGIN.lat, ORIGIN.lon)
            await session.set_gps("frozen", 0)
            n = len(session._driver.sent)
            await session.publish_now()
            frozen_count = len(session._driver.sent) - n
            await session.set_gps("normal", 0)
            return frozen_count

        self.assertEqual(asyncio.run(run()), 0)
        self.assertEqual(session._driver.frozen_calls, ["freeze", "resume"])
        self.assertIsNone(session._driver.sent[-1][2])

    def test_lost_sends_bad_accuracy_on_android_only(self):
        android = _session("android")

        async def run(session):
            await session.set_location(ORIGIN.lat, ORIGIN.lon)
            return await session.set_gps("lost", 0)

        snap = asyncio.run(run(android))
        self.assertEqual(android._driver.sent[-1][2], LOST_ACCURACY_M)
        self.assertTrue(snap["gps"]["lost_supported"])
        with self.assertRaises(SpoofError) as caught:
            asyncio.run(run(_session("ios")))
        self.assertEqual(caught.exception.code, "gps_unsupported")

    def test_jitter_moves_the_point_within_bounds(self):
        session = _session()

        async def run():
            await session.set_location(ORIGIN.lat, ORIGIN.lon)
            await session.set_gps("normal", 30)
            for _ in range(20):
                await session.publish_now()

        asyncio.run(run())
        dists = [haversine_m(ORIGIN, Point(lat, lon)) for lat, lon, _ in session._driver.sent[1:]]
        self.assertTrue(all(d <= 90.5 for d in dists))
        self.assertGreater(max(dists), 5)

    def test_route_offset_is_sideways_to_travel(self):
        session = _session()
        north = [Point(33.70, -84.40), Point(33.80, -84.40)]

        async def run():
            session._start_publisher()
            await session.play_route(north, 1.4, gpx_pauses=[600.0], legs=["rider", "rider"])
            await session.set_offset("left", 600)
            await session.stop_route()
            await session._stop_publisher()

        asyncio.run(run())
        lat, lon, _ = session._driver.sent[-1]
        self.assertLess(lon, -84.40)  # left of northbound is west
        self.assertAlmostEqual(haversine_m(north[0], Point(lat, lon)), 600, delta=1)

    def test_new_route_starts_on_course(self):
        session = _session()

        async def run():
            await session.set_location(ORIGIN.lat, ORIGIN.lon)
            await session.set_offset("right", 300)
            snap = await session.play_route([ORIGIN, Point(33.76, -84.39)], 1.4)
            await session.stop_route()
            return snap

        self.assertEqual(asyncio.run(run())["offset"]["target_m"], 0)

    def test_stop_route_keeps_last_point_as_static_base(self):
        session = _session()
        pts = [ORIGIN, Point(33.76, -84.39)]

        async def run():
            await session.play_route(pts, 1.4)
            return await session.stop_route()

        snap = asyncio.run(run())
        self.assertIsNone(snap["route"])
        self.assertEqual(snap["base"], {"lat": ORIGIN.lat, "lon": ORIGIN.lon})


class LinkHealthTests(unittest.TestCase):
    def test_failed_sends_show_in_status_and_recovery_is_logged(self):
        session = _session("android")
        session.base = ORIGIN
        driver = session._driver
        real_set = driver.set

        async def broken(lat, lon, accuracy=None):
            raise SpoofError("Lost the connection to the phone", code="link")

        async def run():
            driver.set = broken
            with self.assertRaises(SpoofError):
                await session.publish_now()
            down = session.snapshot()
            driver.set = real_set
            await session.publish_now()
            return down, session.snapshot()

        down, up = asyncio.run(run())
        self.assertFalse(down["link"]["ok"])
        self.assertEqual(down["link"]["error"], "Lost the connection to the phone")
        self.assertIsNone(down["location"])  # the pin stays where the phone last was
        self.assertTrue(up["link"]["ok"])
        self.assertIsNone(up["link"]["error"])
        self.assertIn("Connection restored", session.log[-1]["text"])

    def test_connect_to_same_phone_reconnects_when_it_stops_answering(self):
        session = _session("android")
        connects = []

        async def dead_ping():
            raise SpoofError("Lost the connection to the phone", code="link")

        async def fake_connect(udid, pair_timeout):
            connects.append(udid)
            session._driver = _FakeDriver("android")

        async def run():
            session._driver.ping = dead_ping
            session._connect_locked = fake_connect
            await session.connect("TEST")
            await session.connect("TEST")  # healthy now: no second reconnect

        asyncio.run(run())
        self.assertEqual(connects, ["TEST"])


class PublisherSurvivalTests(unittest.TestCase):
    """A walking trip must keep reaching the phone, not only when a button is pressed."""

    def test_cancelled_future_inside_the_driver_does_not_stop_the_publisher(self):
        session = _session()
        session.base = ORIGIN
        driver = session._driver
        real_set = driver.set
        calls = {"n": 0}

        async def flaky(lat, lon, accuracy=None):
            calls["n"] += 1
            if calls["n"] == 1:
                raise asyncio.CancelledError()  # e.g. a DTX reply future cancelled under us
            await real_set(lat, lon, accuracy)

        async def run():
            driver.set = flaky
            session._start_publisher()
            await asyncio.sleep(2.3)
            alive = not session._publisher_task.done()
            await session._stop_publisher()
            return alive

        self.assertTrue(asyncio.run(run()))
        self.assertGreaterEqual(len(driver.sent), 1)
        self.assertTrue(any("cancelled a location update" in e["text"] for e in session.log))

    def test_status_watchdog_restarts_a_dead_publisher(self):
        session = _session()
        session.base = ORIGIN

        async def run():
            async def die():
                raise RuntimeError("boom")
            session._publisher_task = asyncio.create_task(die())
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            session.ensure_publisher()
            await asyncio.sleep(1.2)
            alive = not session._publisher_task.done()
            await session._stop_publisher()
            return alive

        self.assertTrue(asyncio.run(run()))
        self.assertTrue(session._driver.sent)
        self.assertIn("RuntimeError('boom')", " ".join(e["text"] for e in session.log))

    def test_no_restart_after_disconnect(self):
        session = _session()
        session._driver.connected = False
        session.ensure_publisher()
        self.assertIsNone(session._publisher_task)

    def test_hung_send_times_out_instead_of_holding_every_later_send(self):
        session = _session()
        session.base = ORIGIN

        async def hang(lat, lon, accuracy=None):
            await asyncio.sleep(3600)

        async def run():
            session._driver.set = hang
            with mock.patch("backend.spoof.SET_TIMEOUT_S", 0.05):
                with self.assertRaises(SpoofError):
                    await session.publish_now()
            return session.snapshot()

        snap = asyncio.run(run())
        self.assertFalse(snap["link"]["ok"])


class LogTests(unittest.TestCase):
    def test_actions_are_logged_and_capped(self):
        session = _session()

        async def run():
            await session.set_location(ORIGIN.lat, ORIGIN.lon)
            await session.set_offset("right", 500, 30)
            await session.set_gps("frozen", 0)

        asyncio.run(run())
        texts = [e["text"] for e in session.log]
        self.assertIn("Off course · 500 m right over 30 s", texts)
        self.assertIn("GPS frozen · no updates sent", texts)
        for i in range(LOG_SIZE + 10):
            session.note("x", str(i))
        self.assertEqual(len(session.log), LOG_SIZE)
        seq = session.log_seq
        session.clear_log()
        self.assertEqual(len(session.log), 0)
        self.assertGreater(session.log_seq, seq)


class ApiValidationTests(unittest.TestCase):
    def _bad(self, model, **data):
        with self.assertRaises(ValidationError):
            model(**data)

    def test_offset_pace_and_gps_bounds(self):
        self._bad(server.OffsetBody, side="up", meters=10)
        self._bad(server.OffsetBody, side="left", meters=5001)
        self._bad(server.OffsetBody, side="left", meters=10, ramp_s=601)
        self._bad(server.PaceBody, factor=0.2)
        self._bad(server.PaceBody, factor=4.5)
        self._bad(server.GpsBody, mode="bad")
        self._bad(server.GpsBody, mode="normal", jitter_m=201)
        ok = server.OffsetBody(side="right", meters=450, ramp_s=30)
        self.assertEqual((ok.meters, ok.ramp_s), (450, 30))
        self.assertEqual(server.PaceBody(factor=1.5).factor, 1.5)

    def test_routes_registered(self):
        paths = {(r.path, m) for r in server.app.routes for m in getattr(r, "methods", ())}
        for path, method in [("/api/gps", "POST"), ("/api/log", "GET"), ("/api/log", "DELETE"),
                             ("/api/offset", "POST"), ("/api/route/offset", "POST")]:
            self.assertIn((path, method), paths)


if __name__ == "__main__":
    unittest.main()
