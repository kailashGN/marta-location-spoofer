"""Android adb parsing and the helper command protocol. No phone required."""

import asyncio
import unittest
from unittest import mock

from backend.android_adb import (
    BUNDLED_ADB,
    default_adb_candidates,
    find_adb,
    parse_adb_devices,
    parse_android_identity,
    parse_mock_granted,
    parse_package_installed,
    parse_version_code,
)
from backend import android_driver
from backend.android_driver import AndroidDriver
from backend.device import describe_android_device
from backend.spoof import SpoofError


DEVICES = """List of devices attached
RZCW70G9EPZ            device usb:1-1 product:a34xdxx model:SM_A346E device:a34x transport_id:14
ABCDEF                 unauthorized
OFFLINE1               offline

"""


class AdbParseTests(unittest.TestCase):
    def test_devices_including_unauthorized(self):
        rows = parse_adb_devices(DEVICES)
        self.assertEqual([r["serial"] for r in rows], ["RZCW70G9EPZ", "ABCDEF", "OFFLINE1"])
        self.assertEqual(rows[0]["state"], "device")
        self.assertEqual(rows[0]["model"], "SM_A346E")
        self.assertEqual(rows[0]["connection"], "USB")
        self.assertEqual(rows[1]["state"], "unauthorized")
        self.assertEqual(rows[2]["state"], "offline")

    def test_identity_and_package_fields(self):
        model, release, name = parse_android_identity("SM-A346E\n16\nDesk phone\n")
        self.assertEqual((model, release, name), ("SM-A346E", "16", "Desk phone"))
        self.assertEqual(parse_android_identity("Pixel\n14\nnull\n")[2], None)
        self.assertTrue(parse_package_installed("package:/data/app/com.locationspoofer.helper/base.apk\n"))
        self.assertFalse(parse_package_installed(""))
        self.assertEqual(parse_version_code("versionCode=1 minSdk=26 targetSdk=34"), 1)
        self.assertIsNone(parse_version_code("Unable to find package"))
        self.assertTrue(parse_mock_granted("MOCK_LOCATION: allow"))
        self.assertFalse(parse_mock_granted("MOCK_LOCATION: default"))

    def test_unauthorized_row_keeps_steps(self):
        info = describe_android_device({"serial": "ABCDEF", "state": "unauthorized", "connection": "USB"})
        self.assertEqual(info.platform, "android")
        self.assertFalse(info.paired)
        self.assertEqual(info.problem, "USB debugging not authorized")
        self.assertTrue(info.steps)

    def test_find_adb_prefers_path_and_reports_missing(self):
        self.assertEqual(find_adb(which=lambda _name: "/usr/bin/adb", extra=[]), "/usr/bin/adb")
        self.assertIsNone(find_adb(which=lambda _name: None, extra=[]))

    def test_find_adb_includes_the_copy_setup_downloads(self):
        self.assertIn(BUNDLED_ADB, default_adb_candidates())


class _Reader:
    def __init__(self, lines):
        self.lines = list(lines)

    async def readline(self):
        return self.lines.pop(0)


class _Writer:
    def __init__(self, fail=None):
        self.buf = b""
        self.fail = fail
        self.closed = False

    def write(self, data):
        if self.fail is not None:
            raise self.fail
        self.buf += data

    async def drain(self):
        return None

    def close(self):
        self.closed = True

    async def wait_closed(self):
        return None


class HelperProtocolTests(unittest.TestCase):
    def _driver(self, replies):
        driver = AndroidDriver()
        driver.udid = "emulator-5554"
        driver._active = True
        driver._local_port = 50000
        driver._reader = _Reader(replies)
        driver._writer = _Writer()
        return driver

    def test_set_clear_and_ping_frames(self):
        driver = self._driver([b"OK\n", b"OK\n", b"OK\n"])

        async def run():
            await driver._command("PING")
            await driver.set(33.7488, -84.388)
            await driver.clear()

        asyncio.run(run())
        self.assertEqual(driver._writer.buf, b"PING\nSET 33.7488 -84.388\nCLEAR\n")

    def test_accuracy_freeze_and_resume_frames(self):
        driver = self._driver([b"OK\n", b"OK\n", b"OK\n"])

        async def run():
            await driver.set(33.7488, -84.388, 150.0)
            await driver.freeze()
            await driver.resume()

        asyncio.run(run())
        self.assertEqual(driver._writer.buf, b"SET 33.7488 -84.388 150\nFREEZE\nRESUME\n")

    def test_old_helper_rejecting_accuracy_says_update(self):
        driver = self._driver([b"ERR expected SET <lat> <lon>\n"])
        with self.assertRaises(SpoofError) as caught:
            asyncio.run(driver.set(33.7, -84.4, 150.0))
        self.assertEqual(caught.exception.code, "android_helper")

    def test_mock_denial_is_a_spoof_error(self):
        driver = self._driver([
            b"ERR mock location is not granted. Select Location Spoofer Helper in Developer options.\n",
        ])
        with self.assertRaises(SpoofError) as caught:
            asyncio.run(driver.set(33.7, -84.4))
        self.assertEqual(caught.exception.code, "mock_location")
        self.assertIn("Developer options", " ".join(caught.exception.steps))



class ReconnectTests(unittest.TestCase):
    """A dropped ``adb forward`` or restarted helper must not leave the phone silently frozen."""

    def _driver(self, writer, reader_lines=()):
        driver = AndroidDriver()
        driver.udid = "emulator-5554"
        driver._active = True
        driver._local_port = 50000
        driver._reader = _Reader(reader_lines)
        driver._writer = writer
        return driver

    def _patch(self, driver, state="device", fresh=None, ping_ok=True):
        """Fake adb and the socket so a reconnect hands the driver ``fresh`` (a new writer)."""
        calls = []

        async def fake_adb(*args, serial=None, timeout=10):
            calls.append(args)
            if args[:1] == ("devices",):
                return 0, f"List of devices attached\n{serial or 'emulator-5554'}\t{state}\n", ""
            if args[:2] == ("forward", "tcp:0"):
                return 0, "50001\n", ""
            return 0, "", ""

        async def fake_open():
            if not ping_ok:
                raise android_driver.SpoofError("The helper did not answer", code="android")
            driver._reader = _Reader([b"OK\n"] * 4)
            driver._writer = fresh

        return calls, mock.patch.object(android_driver, "adb", fake_adb), mock.patch.object(driver, "_open_and_ping", fake_open)

    def test_broken_pipe_rebuilds_the_link_and_resends(self):
        dead = _Writer(fail=BrokenPipeError(32, "Broken pipe"))
        fresh = _Writer()
        driver = self._driver(dead)
        calls, p_adb, p_open = self._patch(driver, fresh=fresh)
        with p_adb, p_open:
            asyncio.run(driver.set(33.75, -84.39))
        self.assertTrue(dead.closed)
        self.assertEqual(fresh.buf, b"SET 33.75 -84.39\n")
        self.assertIn(("forward", "--remove", "tcp:50000"), calls)
        self.assertIn(("shell", "am", "start-foreground-service", "-n", android_driver.SERVICE), calls)
        self.assertEqual(driver._local_port, 50001)
        self.assertTrue(driver.connected)

    def test_helper_closing_the_socket_rebuilds_the_link(self):
        fresh = _Writer()
        driver = self._driver(_Writer(), reader_lines=[b""])
        _, p_adb, p_open = self._patch(driver, fresh=fresh)
        with p_adb, p_open:
            asyncio.run(driver.set(33.75, -84.39))
        self.assertEqual(fresh.buf, b"SET 33.75 -84.39\n")

    def test_unplugged_phone_is_a_link_error_and_backs_off(self):
        driver = self._driver(_Writer(fail=ConnectionResetError("Connection lost")))
        calls, p_adb, p_open = self._patch(driver, state="offline")
        with p_adb, p_open:
            with self.assertRaises(SpoofError) as first:
                asyncio.run(driver.set(33.75, -84.39))
            with self.assertRaises(SpoofError) as second:
                asyncio.run(driver.set(33.75, -84.39))
        self.assertEqual(first.exception.code, "link")
        self.assertEqual(second.exception.code, "link")
        # The second send is inside the back-off window: no second round of adb calls.
        self.assertEqual(sum(1 for c in calls if c[:1] == ("devices",)), 1)
        self.assertTrue(driver.connected)  # still our phone; it reconnects once it's back

    def test_disconnect_does_not_reconnect(self):
        driver = self._driver(_Writer(fail=BrokenPipeError(32, "Broken pipe")))
        calls, p_adb, p_open = self._patch(driver, fresh=_Writer())
        with p_adb, p_open:
            asyncio.run(driver.disconnect())
        self.assertFalse(driver.connected)
        self.assertNotIn(("devices", "-l"), calls)


if __name__ == "__main__":
    unittest.main()
