<p align="center">
  <img src="packaging/icon-1024.png" width="128" alt="Location Spoofer icon">
</p>

<h1 align="center">Location Spoofer</h1>

<p align="center">
  Fake GPS on a physical iPhone or Android phone from your Mac. No jailbreak. No Xcode.<br>
  iOS uses Apple’s developer location simulation; Android uses a small USB-installed helper app.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/macOS-13%2B-black?style=flat-square&logo=apple" alt="macOS 13+">
  <img src="https://img.shields.io/badge/iOS-14%20%E2%80%93%2026-black?style=flat-square&logo=apple" alt="iOS 14 – 26">
  <img src="https://img.shields.io/badge/Android-8%2B-black?style=flat-square&logo=android" alt="Android 8+">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license"></a>
</p>

<p align="center">
  <img src="docs/screenshot-desktop.png" width="820" alt="Location Spoofer screenshot">
</p>

<details>
<summary>Table of contents</summary>

- [Features](#features)
- [Install](#install)
- [Requirements](#requirements)
- [Usage](#usage)
- [FAQ](#faq)
- [How it works](#how-it-works)
- [Testing MARTA live trips](#testing-marta-live-trips)
- [Build from source](#build-from-source)
- [License](#license)
- [Acknowledgements](#acknowledgements)

</details>

## Features

- **Teleport** – click the map, drag the pin, search a place, or paste `lat, lon`
- **Routes** – draw waypoints on the map or **Load GPX** and move along the path. Pause, loop, progress and ETA
- **Timed GPX** – for tracks with `<time>` on each point, **Follow GPX timestamps** replays OTP-style schedules in real time (optional **Time scale**, e.g. 5× faster). Playback **joins at the current clock** and skips points already in the past
- **Live trip testing** – while a route plays: **Hold position**, **100 m left/right** (off-course), **On course**, and **Slower / Normal / Faster** on walk/drive legs (`<cmt>rider</cmt>` in GPX). Pace and offset controls are disabled on transit legs
- **Map sync** – when a route starts (from the UI or the HTTP API), the full path appears on the map
- **Favourites** – one-click return to places you use often
- **iPhone (iOS 14 – 26)** – legacy usbmux service or iOS 17+ developer tunnel, no `sudo`. Nothing permanent installed on the phone
- **Android (8+)** – helper APK over USB (`adb`); mock location via test providers (`gps`, `network`, fused on API 31+)
- **Native feel** – light and dark mode, spring motion, works at phone widths too
- **Private by default** – runs on your Mac at `127.0.0.1:8420`. No accounts, no telemetry

## Install

Run from source (recommended for MARTA live-trip testing):

```bash
git clone https://github.com/kailashGN/marta-location-spoofer.git
cd marta-location-spoofer
./scripts/run.sh
```

Run it from the repo root as shown (or `./run.sh` from inside `scripts/`). A bare `run.sh` won't work, because the shell doesn't look for commands in the current folder.

The first run creates `.venv` and installs `requirements.txt` (needs Python 3 on the Mac), then opens the UI at `http://127.0.0.1:8420`.

To get a double-clickable **Location Spoofer.app** instead, see [Build from source](#build-from-source). Local builds are not notarized, so on first launch right-click the app and choose **Open**.

## Requirements

- macOS 13 Ventura or newer, Apple silicon or Intel
- **iPhone or iPad** on iOS / iPadOS 14 – 26, **or** an **Android phone** on Android 8 or newer, connected with a USB cable (physical devices are what this project targets; emulators are not the primary path)
- **iPhone:** Developer Mode enabled (Settings → Privacy & Security → Developer Mode)
- **Android:** USB debugging on, and `adb` on the Mac (`brew install android-platform-tools`, or Android Studio’s SDK at `~/Library/Android/sdk/platform-tools`)

Xcode is **not** required.

## Usage

<details open>
<summary><b>Start spoofing</b></summary>

1. Enable Developer Mode on the iPhone if you haven't yet (it restarts once).
2. Plug the phone into the Mac, unlock it, and tap **Trust** if asked.
3. Open Location Spoofer. It opens in your browser at `http://127.0.0.1:8420`.
4. **iPhone only:** if the sheet shows **Prepare**, press it once – this mounts Apple's Developer Disk Image (keep the phone unlocked).
5. Press **Connect** (pick the device if several are listed).
6. Click anywhere on the map and press **Set Location**.

Maps, Find My, and every other app now see the new location.

**Android:** skip **Prepare**. Turn on USB debugging, plug in, and press **Connect**. That installs **Location Spoofer Helper** and grants mock location when the system allows. If the phone still refuses, open Developer options, select **Location Spoofer Helper** as the mock-location app, and press **Connect** again.

</details>

<details>
<summary><b>Move along a route</b></summary>

1. Open the **Route** section.
2. Press **Draw Waypoints** and click along the map, or **Load GPX**.
3. **GPX with timestamps:** turn on **Follow GPX timestamps** (default when the file has `<time>` on each point). Set **Time scale** if you want faster-than-real-time replay. The pin starts at **now** and skips past points.
4. **GPX without timestamps** or a hand-drawn path: playback uses a fixed walk speed (1.4 m/s) between points.
5. Press **Start Route**. Progress and time remaining show live. Use **Stop Route**, **Hold position**, or **Stop Simulating** as needed.

While a timed live trip is playing, use **Trip test** controls to hold at a stop (missed departure), shift **100 m** off course, or change pace on rider legs.

</details>

<details>
<summary><b>Stop spoofing</b></summary>

Press **Stop Simulating** to return to the real GPS immediately, or **Disconnect** / **Quit**.
Rebooting the phone also restores the real location on iOS; on Android, disconnecting clears test providers.

</details>

## FAQ

**The location jumps back when I quit the app.**
Expected on iOS 17 and newer – Apple's location simulation only lives while the developer connection is open. Keep the app running while you need the fake location. On Android, disconnect or stop simulating to restore real GPS.

**An app still shows my real location.**
Force-quit that app and reopen it. Some apps cache the last fix for a few seconds. For MARTA live trips, turn off the in-app **Live Trip Simulator** in Secret settings so the app reads hardware GPS.

**"Developer Disk Image not mounted" keeps appearing.**
Unlock the phone, press **Prepare**, and wait for the toast. The first time needs internet to download the image from Apple.

**"Could not open a developer tunnel".**
Use a USB cable rather than Wi-Fi, make sure the phone is unlocked, quit Xcode or Instruments if they're open, then press **Connect** again.

**Android mock location does not stick.**
Confirm **Location Spoofer Helper** is the selected mock-location app in Developer options, then **Connect** again. Revoke and re-grant mock location if the system previously denied it.

**Does this work over Wi-Fi?**
No. The phone stays connected by USB, and the web UI only listens on `127.0.0.1`, so nothing else on your network can reach it.

**Is it safe?**
On iOS it uses the same mechanism Xcode uses for *Debug → Simulate Location*. On Android it uses the standard mock-location test-provider API. Nothing is permanently modified on either device. Some apps forbid location spoofing in their terms of service – use responsibly, and only on devices you own.

## How it works

The iPhone exposes a developer-only location-simulation service once Developer Mode is on and the Developer Disk Image is mounted. Location Spoofer talks to it directly:

| iOS | Service | Transport |
|---|---|---|
| 14 – 16 | `com.apple.dt.simulatelocation` | usbmuxd |
| 17 – 26 | DVT `LocationSimulation` | RemoteXPC tunnel via macOS `remoted` (no root) |

Android has no equivalent developer service. A small helper app ([`android/helper`](android/helper), APK at `android/helper.apk`) is installed once over USB and selected as the mock-location app. The Mac pushes coordinates through `adb forward` to `127.0.0.1:17321` on the device. `gps`, `network`, and fused providers follow those fixes. Disconnect or **Stop Simulating** removes them so the real GPS returns.

`scripts/build-helper.sh` rebuilds the APK when the helper changes.

A Python **FastAPI** service does the device work. iPhones go through [pymobiledevice3](https://github.com/doronz88/pymobiledevice3); Android phones go through `adb` and the helper. The interface is a local web page. Protocol notes and sources live in [`docs/RESEARCH.md`](docs/RESEARCH.md).

**HTTP API:** the web UI drives the server over a local HTTP API. `POST /api/route/gpx` accepts GPX JSON (`use_gpx_times`, `time_scale`, …). Timed playback calls `align_gpx_to_now` so late uploads start at the current instant. Trip controls: `POST /api/route/pause`, `/api/route/offset`, `/api/route/pace`, `DELETE /api/route`.

## Testing MARTA live trips

To test a real live trip on a phone without travelling, download the trip's GPX from the MARTA app and play it back here. The MARTA app never talks to Location Spoofer: you move the file across by hand.

1. Connect the phone (see [Usage](#usage)). Keep the spoofer running for the whole test.
2. In a non-production MARTA build, open the Secret menu (**More** tab, then 5 taps with two fingers) and make sure **Live Trip Simulator** is **OFF**. Otherwise the app ignores real GPS.
3. Plan a trip and press **Start**.
4. In the Secret menu, tap **Download GPX** (shown only while a trip is active), and send the file to the Mac (AirDrop, Drive, email…).
5. In **Route**, press **Load GPX** and pick the file. Make sure **Follow GPX timestamps** is **ON** and **Time scale** is `1`, then press **Start Route**.
6. Use the **Trip test** controls to hold at a stop, go 100 m off course, or change walking pace.
7. When you're done, end the trip in the app, then press **Stop Route** or **Stop Simulating** to get the real GPS back.

Load the GPX soon after downloading it. Its times are the real timetable, so playback joins at the current time and skips points already in the past. If the whole trip is already over, nothing plays: start a new trip and download a fresh GPX. If the phone doesn't move at first, the first bus or train probably hasn't left yet.

## Build from source

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt pyinstaller
.venv/bin/python -m unittest discover -s tests          # run the tests
scripts/build-helper.sh                                  # Android helper APK → android/helper.apk
scripts/build-app.sh                                     # produces dist/Location Spoofer.app (+ .zip)
```

`scripts/build-helper.sh` is only needed when the helper source changes (a prebuilt `android/helper.apk` is committed). It uses Android Studio's bundled JDK and `~/Library/Android/sdk` by default; override with `JAVA_HOME` / `ANDROID_HOME`.

Signing and notarizing a release (`scripts/notarize.sh`) needs a Developer ID certificate and an App Store Connect API key; it's optional for internal use.

```
backend/    FastAPI server, device discovery, iOS and Android drivers, geometry, spoof session
frontend/ index.html · app.css · app.js · spring.js  (no build step)
android/  helper app that injects mock fixes, plus the committed debug APK
packaging/ app icon
docs/     research notes, design rules
scripts/  run.sh, build-helper.sh, build-app.sh, notarize.sh
tests/    unit tests
```

Environment: `LS_HOST` (default `127.0.0.1`), `LS_PORT` (default `8420`), `LS_LOG` (default `INFO`), `LS_NO_BROWSER=1` (don't open the browser on start).

## License

[MIT](LICENSE)

## Acknowledgements

- [pymobiledevice3](https://github.com/doronz88/pymobiledevice3) – the pure-Python iDevice toolkit this is built on
- [LocationSimulator](https://github.com/Schlaubischlump/LocationSimulator) – prior art for iOS ≤ 16
- [Leaflet](https://leafletjs.com) and [OpenStreetMap](https://www.openstreetmap.org) contributors
