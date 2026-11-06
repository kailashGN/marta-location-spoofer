"""A pretend phone for practising and for working on the UI without a device.

Turned on from the UI (practice mode, ``POST /api/demo``) or at launch with ``LS_DEMO=1``.
It accepts every command and sends nothing anywhere. ``platform`` follows ``LS_DEMO_PLATFORM``
(``ios`` by default, or ``android`` to try the Android-only controls).
"""

from __future__ import annotations

import os
from typing import Any, Optional

DEMO_UDID = "demo"

_practice = False


def demo_enabled() -> bool:
    return _practice or os.environ.get("LS_DEMO") == "1"


def set_practice(enabled: bool) -> None:
    global _practice
    _practice = enabled


def demo_platform() -> str:
    return "android" if os.environ.get("LS_DEMO_PLATFORM") == "android" else "ios"


def demo_device() -> dict[str, Any]:
    android = demo_platform() == "android"
    return {
        "udid": DEMO_UDID,
        "connection": "Demo",
        "platform": demo_platform(),
        "paired": True,
        "name": "Demo phone",
        "model": "Demo",
        "ios_version": None if android else "26.0",
        "android_version": "15" if android else None,
        "build": None,
        "developer_mode": None if android else True,
        "ddi_mounted": None if android else True,
        "helper_installed": True if android else None,
        "mock_granted": True if android else None,
        "strategy": "android" if android else "dvt",
        "problem": None,
        "steps": [],
    }


class DemoDriver:
    def __init__(self) -> None:
        self.platform = demo_platform()
        android = self.platform == "android"
        self.udid: Optional[str] = None
        self.device_name = "Demo phone"
        self.ios_version = None if android else "26.0"
        self.android_version = "15" if android else None
        self.strategy = "android" if android else "dvt"
        self.transport = "demo"
        self.connected = False

    async def connect(self, udid: str, pair_timeout: float = 30.0) -> None:
        del pair_timeout
        self.udid = udid
        self.connected = True

    async def set(self, lat: float, lon: float, accuracy: Optional[float] = None) -> None:
        return None

    async def clear(self) -> None:
        return None

    async def freeze(self) -> None:
        return None

    async def resume(self) -> None:
        return None

    async def disconnect(self) -> None:
        self.connected = False
