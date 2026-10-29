#!/usr/bin/env bash
# Listen on all interfaces so a physical iPhone can POST GPX (MARTA dev integration).
set -euo pipefail
export LS_HOST="${LS_HOST:-0.0.0.0}"
exec "$(dirname "$0")/run.sh" "$@"
