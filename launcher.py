"""Entry point for the bundled macOS app (PyInstaller)."""

import multiprocessing
import os
import sys
from pathlib import Path


def _setup_logging_dir() -> None:
    if getattr(sys, "frozen", False):
        log_dir = Path.home() / "Library" / "Logs" / "Location Spoofer"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = open(log_dir / "app.log", "a", buffering=1)
        sys.stdout = sys.stderr = log_file


if __name__ == "__main__":
    multiprocessing.freeze_support()
    _setup_logging_dir()
    os.environ.setdefault("LS_LOG", "INFO")
    from backend.server import main

    main()
