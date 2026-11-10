"""Drive the on-phone helper over ``adb forward`` to 127.0.0.1:17321."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

from .android_adb import (
    APK_PATH,
    DEVICE_PORT,
    HELPER_VERSION_CODE,
    PACKAGE,
    SERVICE,
    adb,
    find_adb,
    parse_adb_devices,
    parse_android_identity,
    parse_package_installed,
    parse_version_code,
    reply_is_mock_denied,
)
from .spoof import SpoofError

log = logging.getLogger(__name__)

# A dropped link is rebuilt at most this often, so a 1 Hz publisher doesn't hammer adb while the phone
# is unplugged.
RECONNECT_BACKOFF_S = 2.0
# What a dead socket looks like: adb dropped the forward, the helper restarted, or the cable came out.
_LINK_ERRORS = (ConnectionError, OSError, asyncio.IncompleteReadError)

_IDENTITY_SHELL = (
    "getprop ro.product.model; getprop ro.build.version.release; settings get global device_name"
)


class AndroidDriver:
    platform = "android"
    ios_version = None

    def __init__(self) -> None:
        self.udid: Optional[str] = None
        self.strategy: Optional[str] = None
        self.android_version: Optional[str] = None
        self.device_name: Optional[str] = None
        self.transport: Optional[str] = None
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._io_lock = asyncio.Lock()
        self._local_port: Optional[int] = None
        self._service_started = False
        # True from a successful connect until disconnect, even while the socket is being rebuilt.
        self._active = False
        self._reconnect_lock = asyncio.Lock()
        self._retry_at = 0.0

    @property
    def connected(self) -> bool:
        return self._active

    async def connect(self, udid: str, pair_timeout: float = 30.0) -> None:
        del pair_timeout  # iOS pairing timeout; Android uses the USB-debugging prompt instead.
        if find_adb() is None:
            raise _adb_missing()
        state = await _device_state(udid)
        if state is None:
            raise SpoofError(
                "That Android phone is not connected",
                ["Plug it in with a USB cable and press Rescan."],
                code="adb_missing",
            )
        if state == "unauthorized":
            raise SpoofError(
                "USB debugging is not authorized",
                ["Unlock the phone and tap Allow on the USB debugging prompt.", "Then press Connect again."],
                code="adb_unauthorized",
            )
        if state != "device":
            raise SpoofError(
                "The phone is offline",
                ["Unplug the cable, plug it back in, and unlock the phone.", "Then press Connect again."],
                code="adb_offline",
            )

        self.udid = udid
        self.strategy = "android"
        self.transport = "adb"
        self.device_name, self.android_version = await _identity(udid)
        await _ensure_helper(udid)
        await self._start_service()
        await self._forward()
        await self._open_and_ping()
        self._active = True
        log.info("Android helper ready on %s via local port %s", udid, self._local_port)

    async def _start_service(self) -> None:
        """Grant mock location and start the helper. Both are no-ops when already done."""
        assert self.udid is not None
        code, _, err = await adb(
            "shell", "appops", "set", PACKAGE, "android:mock_location", "allow",
            serial=self.udid, timeout=10,
        )
        if code != 0:
            raise SpoofError(err.strip() or "Could not grant mock location", code="mock_location")

        code, _, err = await adb(
            "shell", "am", "start-foreground-service", "-n", SERVICE,
            serial=self.udid, timeout=15,
        )
        if code != 0:
            raise SpoofError(err.strip() or "Could not start the helper", code="android")
        self._service_started = True

    async def _forward(self) -> None:
        """(Re)create the ``adb forward`` to the helper, dropping the old one if there was one."""
        assert self.udid is not None
        if self._local_port is not None:
            await adb("forward", "--remove", f"tcp:{self._local_port}", serial=self.udid, timeout=10)
            self._local_port = None
        code, out, err = await adb("forward", "tcp:0", f"tcp:{DEVICE_PORT}", serial=self.udid, timeout=10)
        if code != 0 or not out.strip():
            raise SpoofError(err.strip() or "Could not forward the helper port", code="android")
        self._local_port = int(out.strip().split()[-1])

    async def _reconnect(self) -> None:
        """Rebuild a dropped link: the phone must still be there; restart the helper and the forward."""
        async with self._reconnect_lock:
            if self._writer is not None or not self._active:
                return  # another caller already rebuilt it, or we are disconnecting
            now = time.monotonic()
            if now < self._retry_at:
                raise _link_lost()
            self._retry_at = now + RECONNECT_BACKOFF_S
            assert self.udid is not None
            state = await _device_state(self.udid)
            if state != "device":
                raise _link_lost(state)
            await self._start_service()
            await self._forward()
            await self._open_and_ping()
            self._retry_at = 0.0
            log.info("Android helper link rebuilt on %s via local port %s", self.udid, self._local_port)

    async def _open_and_ping(self) -> None:
        assert self._local_port is not None
        last: Optional[Exception] = None
        for _ in range(8):
            try:
                self._reader, self._writer = await asyncio.wait_for(
                    asyncio.open_connection("127.0.0.1", self._local_port),
                    timeout=2,
                )
                await self._exchange("PING")
                return
            except Exception as exc:  # noqa: BLE001 — the service may not be listening yet
                last = exc
                await self._close_socket()
                await asyncio.sleep(0.3)
        raise SpoofError(
            "The helper did not answer",
            ["Unlock the phone and press Connect again.", f"Details: {last!r}"],
            code="android",
        )

    async def ping(self) -> None:
        await self._command("PING")

    async def set(self, lat: float, lon: float, accuracy: Optional[float] = None) -> None:
        if accuracy is None:
            await self._command(f"SET {lat} {lon}")
            return
        try:
            await self._command(f"SET {lat} {lon} {accuracy:g}")
        except SpoofError as exc:
            if "expected SET" in exc.message:
                raise _helper_outdated() from exc
            raise

    async def freeze(self) -> None:
        """Stop the helper re-sending the last fix, so the phone gets no updates at all."""
        try:
            await self._command("FREEZE")
        except SpoofError as exc:
            if "unknown command" in exc.message:
                raise _helper_outdated() from exc
            raise

    async def resume(self) -> None:
        try:
            await self._command("RESUME")
        except SpoofError as exc:
            if "unknown command" not in exc.message:
                raise

    async def clear(self) -> None:
        # CLEAR drops the test providers and leaves the socket open, so the next SET still works.
        # Disconnect force-stops the service, which is what removes the notification.
        await self._command("CLEAR")

    async def disconnect(self) -> None:
        self._active = False
        if self._writer is not None:
            try:
                await self._exchange("CLEAR")
            except Exception as exc:  # noqa: BLE001
                log.debug("CLEAR during disconnect failed: %r", exc)
        await self._close_socket()
        serial = self.udid
        if self._service_started and serial:
            try:
                await adb("shell", "am", "force-stop", PACKAGE, serial=serial, timeout=10)
            except Exception as exc:  # noqa: BLE001
                log.debug("force-stop failed: %r", exc)
        self._service_started = False
        if self._local_port is not None and serial and find_adb() is not None:
            try:
                await adb("forward", "--remove", f"tcp:{self._local_port}", serial=serial, timeout=10)
            except Exception as exc:  # noqa: BLE001
                log.debug("forward remove failed: %r", exc)
        self._local_port = None
        self.transport = None

    async def _command(self, line: str) -> str:
        """Send one command. If the link has dropped, rebuild it and send once more."""
        if not self._active:
            raise SpoofError("The helper connection is closed", ["Press Connect again."], code="not_connected")
        if self._writer is not None:
            try:
                return await self._exchange(line)
            except _LinkDown as exc:
                log.warning("helper link dropped (%s); reconnecting", exc)
        await self._reconnect()
        try:
            return await self._exchange(line)
        except _LinkDown as exc:
            raise _link_lost() from exc

    async def _exchange(self, line: str) -> str:
        """One request/reply on the open socket. A dead socket is closed and raises ``_LinkDown``."""
        if self._writer is None or self._reader is None:
            raise _LinkDown("no socket")
        async with self._io_lock:
            writer, reader = self._writer, self._reader
            if writer is None or reader is None:
                raise _LinkDown("no socket")
            try:
                writer.write(f"{line}\n".encode())
                await writer.drain()
                raw = await asyncio.wait_for(reader.readline(), timeout=8)
            except asyncio.TimeoutError as exc:
                # A late reply would pair with the next command, so start over on a fresh socket.
                await self._close_socket()
                raise _LinkDown("no reply in 8 s") from exc
            except _LINK_ERRORS as exc:
                await self._close_socket()
                raise _LinkDown(repr(exc)) from exc
            if not raw:
                await self._close_socket()
                raise _LinkDown("helper closed the connection")
        return _accept_reply(raw.decode(errors="replace").strip())

    async def _close_socket(self) -> None:
        writer = self._writer
        self._writer = None
        self._reader = None
        if writer is None:
            return
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:  # noqa: BLE001
            pass


def _accept_reply(text: str) -> str:
    if text == "OK" or text.startswith("OK "):
        return text
    if text.startswith("ERR"):
        reason = text[3:].strip() or text
        if reply_is_mock_denied(reason):
            raise SpoofError(
                "Mock location is not granted",
                [
                    "On the phone open Developer options.",
                    "Select Location Spoofer Helper as the mock-location app.",
                    "Press Connect again.",
                ],
                code="mock_location",
            )
        raise SpoofError(reason, code="android")
    raise SpoofError(text or "Unexpected helper reply", code="android")


class _LinkDown(Exception):
    """The socket to the helper is gone; ``_command`` rebuilds it."""


def _link_lost(state: Optional[str] = None) -> SpoofError:
    if state is None:
        return SpoofError(
            "Lost the connection to the phone",
            ["Trying again every few seconds.", "If it keeps failing, press Disconnect, then Connect."],
            code="link",
        )
    if state == "unauthorized":
        steps = ["Unlock the phone and tap Allow on the USB debugging prompt."]
    else:
        steps = ["Check the USB cable and unlock the phone.", "It reconnects by itself once the phone is back."]
    return SpoofError("The phone is not reachable over adb", steps, code="link")


def _helper_outdated() -> SpoofError:
    return SpoofError(
        "The helper on the phone is out of date",
        ["Press Disconnect, then Connect: that installs the current helper."],
        code="android_helper",
    )


def _adb_missing() -> SpoofError:
    return SpoofError(
        "adb was not found",
        [
            "Quit Location Spoofer and start it again: setup downloads the Android tools.",
            "If setup warned that the download failed, check the internet connection and start it again.",
        ],
        code="adb_missing",
    )


async def _device_state(serial: str) -> Optional[str]:
    code, out, _ = await adb("devices", "-l", timeout=5)
    if code != 0:
        return None
    for row in parse_adb_devices(out):
        if row["serial"] == serial:
            return row["state"]
    return None


async def _identity(serial: str) -> tuple[Optional[str], Optional[str]]:
    code, out, _ = await adb("shell", _IDENTITY_SHELL, serial=serial, timeout=8)
    if code != 0:
        return serial, None
    model, release, name = parse_android_identity(out)
    return name or model or serial, release


async def _ensure_helper(serial: str) -> None:
    if not APK_PATH.is_file():
        raise SpoofError(
            "The helper APK is missing",
            [f"Expected it at {APK_PATH}.", "Run scripts/build-helper.sh."],
            code="android",
        )
    code, out, _ = await adb("shell", "pm", "path", PACKAGE, serial=serial, timeout=10)
    installed = code == 0 and parse_package_installed(out)
    current: Optional[int] = None
    if installed:
        _, dump, _ = await adb("shell", "dumpsys", "package", PACKAGE, serial=serial, timeout=15)
        current = parse_version_code(dump)
    if installed and current is not None and current >= HELPER_VERSION_CODE:
        return
    log.info("installing helper on %s (installed=%s version=%s)", serial, installed, current)
    code, _, err = await adb("install", "-r", str(APK_PATH), serial=serial, timeout=90)
    if code != 0:
        raise SpoofError(err.strip() or "Could not install the helper", code="android")


async def serial_is_android(serial: str) -> bool:
    if find_adb() is None:
        return False
    try:
        return await _device_state(serial) is not None
    except Exception as exc:  # noqa: BLE001
        log.debug("adb devices failed: %r", exc)
        return False
