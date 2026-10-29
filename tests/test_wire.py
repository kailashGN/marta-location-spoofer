"""Pin the wire formats we depend on so a pymobiledevice3 upgrade that changes them fails loudly."""
import struct
import unittest

from backend.device import ddi_image_type_for, strategy_for


class WireTests(unittest.TestCase):
    def test_strategy_boundaries(self):
        self.assertEqual(strategy_for("16.7.10"), "legacy")
        self.assertEqual(strategy_for("17.0"), "dvt")
        self.assertEqual(strategy_for("26.0"), "dvt")
        self.assertEqual(ddi_image_type_for("16.0"), "Developer")
        self.assertEqual(ddi_image_type_for("18.5"), "Personalized")

    def test_legacy_service_and_frame(self):
        from pymobiledevice3.services.simulate_location import DtSimulateLocation
        self.assertEqual(DtSimulateLocation.SERVICE_NAME, "com.apple.dt.simulatelocation")
        # start = 0, stop = 1, then >I-length-prefixed ASCII lat/lon
        lat, lon = b"37.3349", b"-122.009"
        frame = struct.pack(">I", 0) + struct.pack(">I", len(lat)) + lat + struct.pack(">I", len(lon)) + lon
        self.assertEqual(frame[:4], b"\x00\x00\x00\x00")
        self.assertEqual(struct.unpack(">I", frame[4:8])[0], 7)

    def test_dvt_channel_and_selectors(self):
        from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulationService
        self.assertEqual(LocationSimulationService.IDENTIFIER, "com.apple.instruments.server.services.LocationSimulation")
        import pathlib
        from pymobiledevice3.services.dvt.instruments import location_simulation
        src = pathlib.Path(location_simulation.__file__).read_text()
        self.assertIn("simulateLocationWithLatitude:longitude:", src)
        self.assertIn("stopLocationSimulation", src)


if __name__ == "__main__":
    unittest.main()
