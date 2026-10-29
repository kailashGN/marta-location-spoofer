#!/usr/bin/env bash
# Build the Android helper and copy the debug APK to android/helper.apk.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
HELPER="$ROOT/android/helper"
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > "$HELPER/local.properties"
cd "$HELPER"
./gradlew assembleDebug
cp -f "$HELPER/app/build/outputs/apk/debug/app-debug.apk" "$ROOT/android/helper.apk"
echo "→ $ROOT/android/helper.apk"
