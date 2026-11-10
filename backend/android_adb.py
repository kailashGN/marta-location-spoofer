"""adb lookup and output parsers. No device is contacted from the parsers."""

from __future__ import annotations

import asyncio
import os
import re
import shutil
from pathlib import Path
from typing import Callable, Optional

PACKAGE = "com.locationspoofer.helper"
HELPER_VERSION_CODE = 2
DEVICE_PORT = 17321
SERVICE = "com.locationspoofer.helper/.SimulateService"
APK_PATH = Path(__file__).resolve().parent.parent / "android" / "helper.apk"
BUNDLED_ADB = Path(__file__).resolve().parent.parent / ".tools" / "platform-tools" / "adb"
"""Where ``scripts/run.sh`` puts Google's platform-tools when the Mac has no adb."""

_MOCK_DENIED = "mock location is not granted"


def default_adb_candidates() -> list[Path]:
    candidates: list[Path] = []
    for key in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        root = os.environ.get(key)
        if root:
            candidates.append(Path(root) / "platform-tools" / "adb")
    candidates.append(Path.home() / "Library/Android/sdk/platform-tools/adb")
    candidates.append(BUNDLED_ADB)
    return candidates


def find_adb(
    which: Callable[[str], Optional[str]] = shutil.which,
    extra: Optional[list[Path]] = None,
) -> Optional[str]:
    """PATH, then ANDROID_HOME, then Android Studio's SDK, then the copy setup downloaded."""
    found = which("adb")
    if found:
        return found
    for path in default_adb_candidates() if extra is None else extra:
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
    return None


def parse_adb_devices(text: str) -> list[dict[str, Optional[str]]]:
    rows: list[dict[str, Optional[str]]] = []
    for raw in text.replace("\r", "").splitlines():
        line = raw.strip()
        if not line or line.startswith("List of devices"):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        props: dict[str, str] = {}
        for token in parts[2:]:
            if ":" in token:
                key, value = token.split(":", 1)
                props[key] = value
        connection = "USB" if "usb" in props else "Network"
        rows.append({
            "serial": parts[0],
            "state": parts[1],
            "model": props.get("model"),
            "product": props.get("product"),
            "connection": connection,
        })
    return rows


def parse_android_identity(text: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """Three lines: model, release, device name. From one ``adb shell`` command."""
    lines = [ln.strip() for ln in text.replace("\r", "").splitlines() if ln.strip()]
    model = lines[0] if len(lines) > 0 else None
    release = lines[1] if len(lines) > 1 else None
    name = lines[2] if len(lines) > 2 else None
    if name in (None, "", "null"):
        name = None
    return model, release, name


def parse_version_code(text: str) -> Optional[int]:
    match = re.search(r"versionCode=(\d+)", text)
    return int(match.group(1)) if match else None


def parse_package_installed(text: str) -> bool:
    return "package:" in text


def parse_mock_granted(text: str) -> bool:
    return re.search(r"MOCK_LOCATION:\s*allow", text) is not None


def reply_is_mock_denied(reason: str) -> bool:
    return _MOCK_DENIED in reason


async def adb(*args: str, serial: Optional[str] = None, timeout: float = 10) -> tuple[int, str, str]:
    binary = find_adb()
    if binary is None:
        raise FileNotFoundError("adb")
    cmd = [binary]
    if serial:
        cmd.extend(["-s", serial])
    cmd.extend(args)
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise
    return proc.returncode or 0, stdout.decode(errors="replace"), stderr.decode(errors="replace")
