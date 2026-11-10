#!/usr/bin/env bash
# Location Spoofer: set up and start — author: kailash-hubspire
#
# Prints each setup step so a tester can see which one failed and share it.
# Every step is skipped quickly once it's done, so this is also the everyday launcher.
# Written for the bash 3.2 that ships with macOS.
#
# Python: macOS has no usable Python (Apple's is 3.9; playback needs 3.10+), so setup
# downloads uv (https://github.com/astral-sh/uv) and uses it to fetch Python into
# .tools/. Nothing is installed outside this folder and no admin password is needed.
#
# Dev overrides: LS_PYTHON (python to build .venv with), LS_UV_URL, LS_ADB_URL.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${LS_PORT:-8420}"
PY_VERSION="3.11"
TOTAL=5
STEP=0
STEP_NAME=""
LOG="$ROOT/logs/setup.log"
case "$(uname -m)" in arm64) UV_ARCH="aarch64" ;; *) UV_ARCH="x86_64" ;; esac
UV_URL="${LS_UV_URL:-https://github.com/astral-sh/uv/releases/latest/download/uv-$UV_ARCH-apple-darwin.tar.gz}"
ADB_URL="${LS_ADB_URL:-https://dl.google.com/android/repository/platform-tools-latest-darwin.zip}"

if [ -t 1 ]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""
fi

# Copy everything to logs/setup.log (fresh each run) while still showing it here.
mkdir -p "$ROOT/logs"
: > "$LOG"
exec 3>&1 4>&2
exec > >(tee -a "$LOG") 2>&1

step() {
  STEP=$((STEP + 1))
  STEP_NAME="$1"
  printf '\n%s[%d/%d] %s%s\n' "$BOLD" "$STEP" "$TOTAL" "$STEP_NAME" "$RESET"
}
ok()   { printf '      %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '      %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
say()  { printf '      %s\n' "$1"; }

# A known problem with a plain-words fix: explain it and stop.
stop() {
  trap - ERR
  printf '\n%s✗ Step %d stopped: %s%s\n' "$RED" "$STEP" "$STEP_NAME" "$RESET"
  for line in "$@"; do printf '  %s\n' "$line"; done
  printf '\n'
  exit 1
}

# Anything else: say which step broke and who to tell.
on_error() {
  local code=$?
  trap - ERR
  printf '\n%s✗ Step %d failed: %s%s\n' "$RED" "$STEP" "$STEP_NAME" "$RESET"
  printf '  Take a screenshot of this window and send it to the dev team.\n'
  printf '  Please also attach the setup log, saved here:\n  %s\n\n' "$LOG"
  exit "$code"
}
trap on_error ERR
trap 'trap - ERR; printf "\n\nSetup stopped.\n"; exit 130' INT

printf '%sLocation Spoofer setup%s  (%s)\n' "$BOLD" "$RESET" "$(date '+%Y-%m-%d %H:%M')"

# ---------------------------------------------------------------------------
step "Checking your Mac"
MACOS="$(sw_vers -productVersion)"
if [ "${MACOS%%.*}" -lt 13 ]; then
  stop "This Mac has macOS $MACOS. Location Spoofer needs macOS 13 (Ventura) or newer." \
       "Update it in System Settings → General → Software Update, then try again."
fi
# A downloaded ZIP marks every file as "from the internet". Clear that once so
# macOS doesn't block the files setup runs or downloads later.
if xattr -p com.apple.quarantine "$ROOT/scripts/run.sh" >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$ROOT" 2>/dev/null || true
fi
ok "macOS $MACOS"

# ---------------------------------------------------------------------------
step "Getting Python (first time only)"
python_ok() { "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; }
python_version() { "$1" -c 'import platform; print(platform.python_version())'; }

# Download uv, then Python $PY_VERSION, all inside .tools/. Sets PY on success.
download_python() {
  export UV_PYTHON_INSTALL_DIR="$ROOT/.tools/python"
  export UV_CACHE_DIR="$ROOT/.tools/uv-cache" UV_PYTHON_PREFERENCE="only-managed"
  if [ ! -x .tools/uv/uv ]; then
    say "Downloading the Python installer (about 20 MB)…"
    rm -rf .tools/uv && mkdir -p .tools/uv || return 1
    curl -fL --progress-bar "$UV_URL" | tar -xz -C .tools/uv --strip-components 1 || return 1
  fi
  say "Downloading Python $PY_VERSION (about 20 MB)…"
  .tools/uv/uv python install --no-bin "$PY_VERSION" || return 1
  PY="$(.tools/uv/uv python find "$PY_VERSION")" || return 1
  python_ok "$PY"
}

# Fallback: a Python 3.10+ that's already on this Mac. Never calls /usr/bin/python3,
# which is Apple's 3.9 (or a placeholder that pops up an install window).
find_mac_python() {
  local name path
  for name in python3.13 python3.12 python3.11 python3.10 python3; do
    path="$(command -v "$name" || true)"
    if [ -n "$path" ] && [ "$path" != "/usr/bin/python3" ] && python_ok "$path"; then
      PY="$path"
      return 0
    fi
  done
  return 1
}

PY=""
if [ -x .venv/bin/python ] && python_ok .venv/bin/python; then
  PY=".venv/bin/python"
  ok "Python $(python_version "$PY") (already set up)"
elif [ -n "${LS_PYTHON:-}" ]; then
  python_ok "$LS_PYTHON" || stop "LS_PYTHON ($LS_PYTHON) must be Python 3.10 or newer."
  PY="$LS_PYTHON"
  ok "Python $(python_version "$PY") (from LS_PYTHON)"
elif download_python; then
  ok "Python $(python_version "$PY")"
elif find_mac_python; then
  warn "Couldn't download Python, so using the one already on this Mac."
  ok "Python $(python_version "$PY")"
else
  stop "Couldn't download Python." \
       "Check the internet connection and start Location Spoofer again." \
       "If it keeps failing, take a screenshot of this window and send it to the dev team," \
       "with the setup log saved here: $LOG"
fi

# ---------------------------------------------------------------------------
step "Preparing Location Spoofer (first time only)"
if [ "$PY" = ".venv/bin/python" ]; then
  ok "Already done"
else
  rm -rf .venv
  "$PY" -m venv .venv
  ok "Done"
fi

# ---------------------------------------------------------------------------
step "Installing the parts it needs"
WANT="$(shasum -a 256 requirements.txt | cut -d ' ' -f 1)"
HAVE="$(cat .venv/.requirements.sha 2>/dev/null || true)"
if [ "$WANT" = "$HAVE" ]; then
  ok "Already up to date"
else
  say "This needs internet and can take a few minutes the first time."
  .venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt
  echo "$WANT" > .venv/.requirements.sha
  ok "Done"
fi

# ---------------------------------------------------------------------------
step "Checking Android tools (adb)"
ADB="$(.venv/bin/python -c 'from backend.android_adb import find_adb; print(find_adb() or "")')"
if [ -n "$ADB" ]; then
  ok "Ready"
else
  say "Downloading Google's Android tools (about 15 MB)…"
  TMP="$(mktemp -d)"
  if curl -fL --progress-bar -o "$TMP/platform-tools.zip" "$ADB_URL" \
     && rm -rf .tools/platform-tools && mkdir -p .tools \
     && unzip -q "$TMP/platform-tools.zip" -d .tools \
     && [ -x .tools/platform-tools/adb ]; then
    ok "Downloaded"
  else
    warn "Couldn't download the Android tools."
    say "Android phones won't connect until this works. iPhones are fine."
    say "Check the internet connection and start Location Spoofer again."
  fi
  rm -rf "$TMP"
fi

# ---------------------------------------------------------------------------
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  printf '\n%sLocation Spoofer is already running%s in another Terminal window.\n' "$BOLD" "$RESET"
  printf 'Opening it in your browser. You can close this window.\n\n'
  open "http://127.0.0.1:$PORT"
  exit 0
fi

printf '\n%s✓ All set. Starting Location Spoofer…%s\n' "$GREEN" "$RESET"
printf 'It opens in your web browser. If it doesn'\''t, go to http://127.0.0.1:%s\n' "$PORT"
printf '%sKeep this window open while you test.%s Closing it stops Location Spoofer.\n\n' "$BOLD" "$RESET"

# Hand the terminal back (the log is for setup only) and start the server.
trap - ERR INT
exec 1>&3 2>&4 3>&- 4>&-
exec .venv/bin/python -m backend.server "$@"
