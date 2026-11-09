# Location Spoofer: testing a MARTA live trip

This guide shows how to test a MARTA live trip from your desk. You start a trip on the phone, export it as a GPX file, and play it back with Location Spoofer. The phone's GPS then follows the trip as if you were walking and riding it, and you can push the rider off course, slow them down, or cut the GPS signal to check how the app reacts.

**How it fits together:** the MARTA app and Location Spoofer never talk to each other. The trip moves from the phone to the Mac as a GPX file (AirDrop works). The Mac then controls the phone's GPS over the USB cable.

## Before you start

- A Mac on macOS 13 or newer, with Python 3.
- A test phone with a non-production MARTA build, connected to the Mac with a USB cable. Keep it unlocked, and tap **Trust** if it asks.
  - **iPhone:** turn on Developer Mode (Settings → Privacy & Security → Developer Mode).
  - **Android:** turn on USB debugging, and install `adb` on the Mac (`brew install android-platform-tools`).
- This repo cloned on the Mac:

  ```bash
  git clone https://github.com/kailashGN/marta-location-spoofer.git
  ```

---

## Part 1: On the phone

### Step 1. Get the MARTA app ready

1. In the MARTA app, open the **More** tab and tap five times with two fingers to open the secret menu.
2. Under **Mock Location**, tap **Use real location** (if it's not already using the real location).
3. Under **Live Trip Simulator**, turn **Use the simulator** off.

If the simulator stays on, the app ignores the phone's GPS, so Location Spoofer has no effect.

<!-- TODO: phone screenshot of the secret menu (Mock Location + Live Trip Simulator off)
![Secret menu with Live Trip Simulator off](images/phone-01-secret-menu.png)
-->

### Step 2. Start a live trip

Plan a trip from **Current Location** and tap **Start** on the itinerary.

> **Tip:** Start only shows for trips that begin at Current Location and leave now. To start any itinerary, turn on **Offer Start on any trip** in the secret menu.

<!-- TODO: phone screenshot of the itinerary with the Start button
![Itinerary with the Start button](images/phone-02-start-trip.png)
-->

### Step 3. Export the trip as a GPX file

While the trip is running, open the secret menu again. Under **Download live trip GPX**, tap **Download GPX** and send the file to the Mac (AirDrop, Drive, email).

Load the file into Location Spoofer soon after you download it. Its times follow the real timetable, so playback joins at the current time.

<!-- TODO: phone screenshot of the Download GPX section
![Download GPX in the secret menu](images/phone-03-download-gpx.png)
-->

---

## Part 2: In Location Spoofer (on the Mac)

> The screenshots below were taken with the built-in demo phone, so the device pill at the top right says **Practice**. With a real phone it shows the phone's name instead, for example **iPhone · Trip running**.

### Step 4. Open Location Spoofer

From the repo folder, run:

```bash
./scripts/run.sh
```

The first run sets everything up, then the page opens in your browser at `http://127.0.0.1:8420`. The first time, a short tour offers to walk you through a practice trip; take it, or press **Not now**.

Keep this Terminal window open for the whole test. Closing it stops the spoofing.

![Location Spoofer when it first opens](images/01-spoofer-home.png)

### Step 5. Connect the phone

1. Click the device pill at the top right to open the **Device** panel.
2. If more than one phone is plugged in, pick yours from the list.
3. **iPhone only:** if you see **Prepare**, press it once and wait for it to finish (the first time needs internet).
4. Press **Connect**.

The pill changes to **Connected** with a green dot.

![Device panel with the Connect button](images/02-connect-phone.png)

### Step 6. Load the GPX file

Open the **Trip** tab. Click **Load a GPX file** and choose the file from Step 3, or drag the file onto the box.

![Trip tab with the Load a GPX file box](images/03-load-gpx.png)

The trip summary appears. It shows the trip's distance and duration, its walk and ride legs, and when the rider needs to leave. The route is drawn on the map: walks are dotted, rides are solid blue.

![Trip summary after loading the GPX](images/04-trip-summary.png)

### Step 7. Choose how the trip plays, then start it

- **Follow GPX timestamps:** keep this on, so the trip follows the real timetable.
- **Start walking now:** turn this on if you don't want to wait for the leave-by time. The rider walks to the first stop straight away, waits there for the departure, then follows the timetable.
- **Speed:** keep **1×** for real-time testing. 2×, 5× and 10× play the trip faster.

Press **Start trip**. The button's label reflects your choices, for example **Start trip · walk now**.

![Playback options and the Start trip button](images/05-playback-options.png)

### Step 8. Watch the trip

The panel now shows what the rider is doing: **Walking**, **Waiting at the stop**, **On the bus or train** or **Arrived**. It also shows progress and time left. The blue dot on the map is the position being sent to the phone, about once a second.

- **Hold** keeps the rider in place, for example at a stop past the departure time to test a missed ride. Press **Resume** to carry on.
- **Stop trip** ends the playback.

The test tools sit underneath. One opens at a time.

![Live trip panel with the test tools underneath](images/06-live-trip.png)

### Step 9. Test the app's rules

#### Off course

Moves the rider away from the route.

1. Pick a distance (presets 100–1500 m), a side (**Left** or **Right**) and how to move: **Jump** moves at once, **Drift** moves gradually over the seconds you set.
2. Press **Go off course**. The orange dot on the map is where the phone now thinks it is; the dashed line leads back to the route.
3. Press **Back on course** to return.

MARTA shows its off-course card once the rider is more than **805 m** (½ mile) away for **30 s**. It clears after **10 s** back within 805 m.

![Off course tool with the rider 1000 m off the route](images/07-off-course.png)

#### Pace

Speeds up or slows down the rider on walking legs (0.25× to 4×). Rides stay on the timetable. A slow walk, at **0.5×** or lower, on the way to a stop triggers MARTA's "can't make it" switch after 30 s.

![Pace tool set to 0.5×](images/08-pace.png)

#### GPS signal

- **Frozen** stops sending positions. MARTA reports GPS lost after **20 s**.
- **Lost signal** (Android only) sends positions too inaccurate for MARTA to use.
- **Jitter** adds random noise of up to ±100 m, to check that noisy GPS doesn't trigger false off-course alerts.

Set it back to **Normal** when you're done.

![GPS signal tool set to Frozen](images/09-gps-signal.png)

#### Activity log

Lists everything you did and every trip event, with times. Press **Copy log** to paste it into a Jira ticket when you report a bug.

![Activity log](images/10-activity-log.png)

### Step 10 (optional). Use the built-in help

- **Test scenarios** in the top bar lists step-by-step checks, each with the result to expect. **Set up** opens the right tool with the values filled in.
- **MARTA rules** explains every live-trip rule in plain language: what the app does, what you see on the phone, and how to test it.
- The **i** buttons next to each tool explain what it does.

![Test scenarios](images/11-test-scenarios.png)

![MARTA live trip rules](images/12-marta-rules.png)

### Step 11. Finish

1. End the trip in the MARTA app.
2. In Location Spoofer, press **Stop trip**. The phone stays at the last position.

   ![Stop trip button](images/13-stop-trip.png)

3. Open the **Place** tab and press **Stop Simulating** to give the phone its real GPS back.

   ![Stop Simulating button on the Place tab](images/14-stop-simulating.png)

You can now close the Terminal window. To stop Location Spoofer completely, use **Quit** in the Device panel.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| The phone isn't listed | Unlock it, check the cable, tap **Trust** on the phone, then press **Rescan** in the Device panel. |
| "Developer Disk Image not mounted" (iPhone) | Keep the phone unlocked and press **Prepare**. The first time needs internet. |
| "Could not open a developer tunnel" (iPhone) | Use a USB cable rather than Wi-Fi, quit Xcode and Instruments, then press **Connect** again. |
| Start is greyed out with "This trip is already over" | The GPX is too old. Start a new trip in the app and download a fresh GPX. |
| The MARTA app ignores the fake location | Check that **Use the simulator** is off and **Use real location** is selected in the secret menu (Step 1), then force-quit and reopen the app. |
| Android: the mock location doesn't stick | In Developer options, choose **Location Spoofer Helper** as the mock-location app, then press **Connect** again. |

For more detail, see the main [README](../../README.md).
