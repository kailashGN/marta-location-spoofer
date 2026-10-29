#!/usr/bin/env bash
# Location Spoofer launcher — author: kailash-hubspire
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -x .venv/bin/python ]; then
  echo "→ creating virtualenv"
  python3 -m venv .venv
  .venv/bin/pip install -q --upgrade pip
  .venv/bin/pip install -q -r requirements.txt
fi
exec .venv/bin/python -m backend.server "$@"
