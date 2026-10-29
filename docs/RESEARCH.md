# Research — how iPhone location simulation works

Author: kailash-hubspire · Date: 2026-09-13 · Library: pymobiledevice3 11.12.4 (verified against library source)

## 1. Two wire protocols, picked by iOS version

### A. iOS ≤ 16.x — `com.apple.dt.simulatelocation`
- Plain lockdown *developer* service. Only exists once the **Developer Disk Image (DDI)** is mounted
  (`mounter auto-mount` → `DeveloperDiskImageMounter`, image type `Developer`).
- Wire format (big-endian, raw TCP over usbmuxd, SSL per lockdown):
  ```
  uint32 command      0 = start simulation, 1 = stop simulation
  uint32 len + bytes  latitude as ASCII decimal   (only for command 0)
  uint32 len + bytes  longitude as ASCII decimal  (only for command 0)
  ```
- Fresh connection per command. Simulated location persists until `stop` or reboot.
- Library class: `pymobiledevice3.services.simulate_location.DtSimulateLocation`.

### B. iOS ≥ 17.0 — DVT `LocationSimulation` over RemoteXPC / RSD
- Apple moved developer services to **CoreDevice**. Lockdown no longer exposes the service
  (`InvalidServiceError`). Must go through a **RemoteServiceDiscovery (RSD)** tunnel.
- Service: `com.apple.instruments.dtservicehub` (RSD name) → DTX channel
  `com.apple.instruments.server.services.LocationSimulation`
- Selectors: `simulateLocationWithLatitude:longitude:` (set) · `stopLocationSimulation` (clear).
- **The location resets as soon as the DTX channel closes**, so the CLI blocks on "press return".
  → Backend must keep one `DvtProvider` + `LocationSimulation` open for the session.
- Requires the **Personalized DDI** mounted (`PersonalizedImageMounter`, image type `Personalized`,
  fetched from Apple's DeveloperDiskImage repo, build `27A5228h` in this release).
- Library classes: `DvtProvider(rsd)`, `LocationSimulation(dvt)` (async context managers).

## 2. Getting an RSD on macOS without root
Three transports (from `cli_common.make_rsd_dependency`):

| transport | root | notes |
|---|---|---|
| **native** (`remote.native_tunnel.NativeRemotedTunnel`) | no | macOS only. Piggybacks Apple's `remoted` tunnel via `remotepairingd` XPC. Coexists with Xcode. Default on Darwin. |
| userspace (`remote.userspace_tunnel`) | no | Pure-Python PyTCP stack. iOS 17.4+ over USB. Address only visible in-process (fine for us). |
| tunneld / `start-tunnel` | **yes** | Creates utun kernel interface. Legacy; not needed here. |

Strategy: try native → fall back to userspace. Never require sudo.

## 3. Preconditions (device side)
1. **Developer Mode ON** (Settings → Privacy & Security → Developer Mode → restart). Query:
   `lockdown.get_developer_mode_status()`. Reveal toggle: `AmfiService.reveal_developer_mode_option_in_ui()`.
2. Device **paired & trusted** with this Mac (usbmux pairing record). Autopair prompts "Trust".
3. Device **unlocked** during DDI mount and tunnel establishment.
4. DDI mounted (`services.mobile_image_mounter.auto_mount(lockdown)` picks Developer vs Personalized).
5. USB cable recommended (Wi-Fi works for RSD on 17.0–17.3 only via RemotePairing).

## 4. Discovery
- `usbmux.list_devices()` → `MuxDevice(devid, serial, connection_type)`.
- `lockdown.create_using_usbmux(serial=…)` → `product_version`, `display_name`, `DeviceName`,
  `ProductType`, developer-mode status. Use `autopair=False` for polling so we never block on Trust.

## 5. Behaviour notes
- Apps re-read location on next CoreLocation update; Maps shows the new pin within ~1–2 s.
- Reboot, clearing, or (iOS 17+) closing the channel restores real GPS.
- GPX playback: `LocationSimulationBase.play_gpx_file()` walks trkpts, sleeps by timestamp deltas.
  We implement our own route player so the UI can pause / report progress.
- Known upstream issue #572: on iOS 17.0–17.3 DVT set is "unreliable" — retry once on failure.

## Sources
- https://github.com/doronz88/pymobiledevice3 (services/simulate_location.py, dvt/instruments/location_simulation.py, cli/cli_common.py, remote/native_tunnel.py)
- https://doronz88.github.io/pymobiledevice3/guides/ios17-tunnels/
- https://github.com/doronz88/pymobiledevice3/discussions/1463 (iOS 26 confirmed working)
- https://gist.github.com/lucasrod/52b8375d0b8a8212092c2440f0400fa3
- https://github.com/doronz88/pymobiledevice3/issues/572
- https://github.com/Schlaubischlump/LocationSimulator (prior art, iOS ≤ 16 only)
