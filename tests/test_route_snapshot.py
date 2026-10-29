"""Active routes expose their path so the map UI can draw a trip started from the phone."""

import asyncio
import unittest
from unittest.mock import AsyncMock

from backend.geo import Point
from backend.spoof import SpoofSession


class _FakeDriver:
    platform = "android"
    ios_version = None
    android_version = "16"
    strategy = "android"
    transport = "adb"
    udid = "TEST"
    device_name = "Test"
    connected = True

    async def set(self, lat: float, lon: float) -> None:
        return None

    async def clear(self) -> None:
        return None

    async def disconnect(self) -> None:
        return None


class RouteSnapshotTests(unittest.TestCase):
    def test_play_route_includes_path_points(self):
        session = SpoofSession()
        session._driver = _FakeDriver()
        session._set = AsyncMock()

        pts = [Point(33.75, -84.39), Point(33.76, -84.38), Point(33.77, -84.37)]

        async def run():
            snap = await session.play_route(pts, speed_mps=1.4, loop=False)
            await session.stop_route()
            return snap

        snap = asyncio.run(run())
        route = snap["route"]
        self.assertIsNotNone(route)
        self.assertEqual(route["points"], [
            {"lat": 33.75, "lon": -84.39},
            {"lat": 33.76, "lon": -84.38},
            {"lat": 33.77, "lon": -84.37},
        ])
        self.assertEqual(route["timing"], "speed")


if __name__ == "__main__":
    unittest.main()
