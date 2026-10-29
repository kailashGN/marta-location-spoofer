#!/usr/bin/env bash
# Build dist/Location Spoofer.app with PyInstaller.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x .venv/bin/pyinstaller ] || .venv/bin/pip install -q pyinstaller
.venv/bin/pyinstaller --noconfirm --clean --log-level WARN --windowed \
  --name "Location Spoofer" \
  --icon packaging/icon.icns \
  --osx-bundle-identifier com.kailash-hubspire.martalocationspoofer \
  --add-data "frontend:frontend" \
  --collect-all pymobiledevice3 --collect-all developer_disk_image --collect-all pmd_pytcp \
  --collect-all apple_compress --collect-all pyimg4 --collect-all ipsw_parser \
  --copy-metadata pymobiledevice3 --copy-metadata apple_compress --copy-metadata pyimg4 --copy-metadata ipsw_parser --copy-metadata developer_disk_image \
  --collect-submodules uvicorn --collect-submodules fastapi --collect-submodules pydantic --collect-submodules anyio \
  --hidden-import backend.server \
  launcher.py
rm -f "dist/Location Spoofer.zip"
ditto -c -k --keepParent "dist/Location Spoofer.app" "dist/Location Spoofer.zip"
echo "→ dist/Location Spoofer.zip"
