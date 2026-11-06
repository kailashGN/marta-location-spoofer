/* (i) explanations for every tool, and the MARTA live trip rules sheet. One shared dialog. */
(() => {
  'use strict';
  const LS = window.LS;
  const { $ } = LS;

  // MARTA live trip rules, from marta-mobile-app constants/liveTrip.ts (LIVE_TRIP_CONFIG) and
  // utils/liveTrip/*. Each trip copies these at Start and keeps them until it ends.
  const RULES = [
    {
      title: 'Off course',
      rows: [
        ['Off-course distance', '> 500 m', 'From the nearest point on the current or any later leg, minus the fix’s accuracy. Earlier legs don’t count.', 'Off course 600 m'],
        ['Time before the notice', '30 s', 'Continuously past 500 m, measured by fix timestamps.', 'Jump 600 m, wait 30 s'],
        ['Back on course', '10 s', 'Continuously within 500 m. Also reopens a dismissed notice.', 'Back on course'],
        ['Same rule on every leg', 'walk · bus · rail', 'No per-mode thresholds.', ''],
        ['Background notification', 'once per run', 'Sent only while the app is in the background, once per off-course spell.', ''],
      ],
    },
    {
      title: 'Progress along the route',
      rows: [
        ['Leg match radius', '50 m', 'Within 50 m (minus accuracy) the rider is placed on a leg. Between 50 and 500 m the progress dot stops, with no notice.', 'Off course 100–450 m'],
        ['Moving to the next leg', '20 m along it', 'Only forward; earlier legs are never matched again. Legs within 5 m of each other: the earlier one wins.', ''],
        ['Progress UI updates', '≥ 3 m', 'Or when the leg, row or ETA minute changes.', ''],
      ],
    },
    {
      title: 'GPS',
      rows: [
        ['Ignored fixes', 'accuracy > 100 m', 'Dropped completely. A fix with no accuracy is kept.', 'Lost signal (Android)'],
        ['GPS lost', '20 s', 'No usable fix for 20 s. Before the first fix, counted from Start. Clears on the next usable fix.', 'GPS signal: Frozen'],
        ['“Fresh” fix', '≤ 20 s old', 'Missed departure, station departure, switch back and auto-end all need a fresh fix.', ''],
        ['Foreground updates', 'every 1 s', 'High accuracy, any distance. Retries after 10 s if the watch fails.', ''],
        ['Background updates', 'every 10 m', 'Android also every 5 s.', ''],
        ['Speed and heading', 'not used', 'No rule reads speed. Heading only turns the map marker.', ''],
      ],
    },
    {
      title: 'Missed departure',
      rows: [
        ['Missed at the stop', '150 m · 60 s', 'Fresh fix within 150 m of the boarding stop, more than 60 s after departure. Moves to a later departure at once.', 'Hold at the stop past departure'],
        ['Can’t make it', '+60 s for 30 s', 'Projected arrival at the stop later than departure + 60 s, for 30 s. Not while off course.', 'Pace 0.5× on the walk'],
        ['Projection pace', 'planned walk', 'Remaining walk time scales with the walk left; 1.4 m/s if the walk has no times.', ''],
        ['Cancelled ride', 'immediate', 'Moves to a later departure without needing a fix.', ''],
        ['No later departure', 'Replan', 'Shows the “lost your way” notice with Replan.', ''],
        ['Switch back', '150 m · 5 s', 'Only after an automatic move: back at the stop and the original ride hasn’t left.', ''],
      ],
    },
    {
      title: 'Boarding and leaving the stop',
      rows: [
        ['Departed (confirmed)', '> 150 m', 'A fresh fix more than 150 m from the boarding stop.', 'Let the ride play'],
        ['Departed (presumed)', 'past departure', 'No fresh fix and the departure time has passed.', 'GPS Frozen at the stop'],
      ],
    },
    {
      title: 'Arrival and auto-end',
      rows: [
        ['Arrival prompt', '50 · 40 · 30 · 20 · 10 m', 'Asked at each radius in turn. “Keep tracking” skips the radii already inside.', 'Let the trip finish'],
        ['Asked again', '120 s', 'On the first fix 120 s after “Keep tracking”, if within 50 m.', ''],
        ['Auto-end at destination', '30 m for 5 min', 'Any fix outside 30 m restarts the 5 min.', 'Let the trip finish and wait'],
        ['Auto-end after arrival time', '60 min', 'After the itinerary’s own arrival time. Test setting: 1 min.', ''],
        ['Stale trip', '6 h', 'After Start. Test setting: 2 min.', ''],
      ],
    },
    {
      title: 'Notifications',
      rows: [
        ['Leave-by reminder', '3 min before', 'Before the first departure, while on the first leg with under 150 m covered.', ''],
        ['Approaching', '3 min before', 'Before each leg ends. Walks under 3 min are skipped, except the last leg.', ''],
      ],
    },
  ];

  function rulesHtml() {
    return `<p class="info-lead">What the MARTA app checks during a live trip, and how to trigger it from here. Numbers are the app’s defaults; each trip keeps the ones it started with.</p>
      <input class="field-input info-search" id="rules-search" type="search" placeholder="Filter rules, e.g. 500, GPS, stop" aria-label="Filter rules">
      ${RULES.map((s) => `<section class="rule-sec">
        <h4>${s.title}</h4>
        ${s.rows.map(([name, value, note, test]) => `<div class="rule-row">
          <div class="rule-top"><span class="rule-name">${name}</span><span class="rule-val">${value}</span></div>
          <p>${note}</p>
          ${test ? `<p class="rule-test">Test: ${test}</p>` : ''}
        </div>`).join('')}
      </section>`).join('')}
      <p class="info-foot">Source: marta-mobile-app <code>constants/liveTrip.ts</code> and <code>utils/liveTrip/</code>.</p>`;
  }

  // Test recipes. `setup` opens the tool with the values filled in (see LS.tools.preset).
  const SCENARIOS = [
    {
      group: 'Off course',
      items: [
        {
          title: 'Off course past 500 m', rule: '> 500 m for 30 s',
          steps: ['During a walk, open <b>Off course</b>: 600 m, Right, Jump.', 'Press <b>Go off course</b> and note the time.', 'After the notice shows, press <b>Back on course</b>.'],
          expect: 'The off-course notice shows about 30 s after the jump. It clears about 10 s after you come back.',
          setup: { tool: 'offset', m: 600, side: 'right', move: 'jump' },
        },
        {
          title: 'Inside the limit', rule: '450 m · no notice',
          steps: ['Off course 450 m, Jump.', 'Wait at least 60 s.', 'Back on course.'],
          expect: 'No off-course notice. The progress dot stops moving while you are more than 50 m away, then carries on.',
          setup: { tool: 'offset', m: 450, side: 'right', move: 'jump' },
        },
        {
          title: 'Short excursion', rule: 'timer resets',
          steps: ['Off course 600 m, Jump.', 'After about 20 s, press Back on course.', 'Wait another 30 s.'],
          expect: 'No notice. MARTA needs 30 s in a row past 500 m.',
          setup: { tool: 'offset', m: 600, side: 'right', move: 'jump' },
        },
        {
          title: 'Gradual drift', rule: 'crossing time + 30 s',
          steps: ['Off course 600 m, Drift over 60 s.', 'Press <b>Drift off course</b>. The readout shows the distance as it grows.'],
          expect: 'The pin passes 500 m at about 50 s, so the notice shows at about 80 s.',
          setup: { tool: 'offset', m: 600, side: 'right', move: 'drift', ramp: 60 },
        },
        {
          title: 'Off course on the bus or train', rule: 'same rule on every leg',
          steps: ['Wait until the live panel says <b>On the bus or train</b>.', 'Off course 600 m, Jump.'],
          expect: 'The same notice after about 30 s. There are no per-mode thresholds.',
          setup: { tool: 'offset', m: 600, side: 'left', move: 'jump' },
        },
      ],
    },
    {
      group: 'Catching the ride',
      items: [
        {
          title: 'Walk to the stop early', rule: 'Start walking now',
          steps: ['Load a GPX that starts with a walk; keep Speed at 1×.', 'Turn on <b>Start walking now</b>, then Start trip.'],
          expect: 'The pin walks now, then the live panel shows <b>Waiting at the stop</b> with a countdown. It boards at the scheduled departure, and MARTA does not report a missed ride.',
          setup: { walkAhead: true },
        },
        {
          title: 'Missed departure', rule: '150 m · 60 s',
          steps: ['Start with <b>Start walking now</b>, at 1×.', 'While <b>Waiting at the stop</b>, press <b>Hold</b>.', 'Stay held until more than 60 s past the departure.'],
          expect: 'MARTA moves the trip to a later departure. Stop the trip afterwards: the GPX still follows the original ride.',
          setup: { walkAhead: true },
        },
        {
          title: 'Can’t make it', rule: '+60 s for 30 s',
          steps: ['At 1×, during the first walk, set <b>Pace</b> to 0.5×.', 'If the walk has a lot of spare time, use 0.25×.'],
          expect: 'Once the projected arrival is more than 60 s after departure for 30 s, MARTA moves to a later departure. It does not happen while off course.',
          setup: { tool: 'pace', p: 0.5 },
        },
        {
          title: 'Departure confirmed', rule: '> 150 m from the stop',
          steps: ['Let the ride play from the stop with GPS Normal.'],
          expect: 'Once the pin is more than 150 m from the boarding stop, MARTA treats the ride as departed and moves on to it.',
          setup: null,
        },
        {
          title: 'Presumed departed', rule: 'no fresh fix · past departure',
          steps: ['Start with Start walking now and wait at the stop.', 'Before the departure, set <b>GPS signal</b> to Frozen.', 'Wait until past the departure, then go back to Normal.'],
          expect: 'With no fresh fix after the departure time, MARTA presumes you boarded.',
          setup: { tool: 'gps', mode: 'frozen' },
        },
      ],
    },
    {
      group: 'GPS',
      items: [
        {
          title: 'GPS lost', rule: '20 s',
          steps: ['<b>GPS signal</b> › Frozen.', 'Wait 30 s, then Normal.'],
          expect: 'MARTA reports GPS lost about 20 s after freezing. It clears on the next fix, and the pin jumps to where the rider is now.',
          setup: { tool: 'gps', mode: 'frozen' },
        },
        {
          title: 'Lost signal (Android)', rule: 'accuracy > 100 m',
          steps: ['On an Android phone: GPS signal › Lost signal.', 'Wait 30 s, then Normal.'],
          expect: 'Fixes keep arriving at 150 m accuracy and MARTA ignores them, so GPS lost shows after about 20 s. On iOS use Frozen.',
          setup: { tool: 'gps', mode: 'lost' },
        },
        {
          title: 'Noisy GPS', rule: 'no false alarms',
          steps: ['GPS signal › Jitter 40 m.', 'Let the trip play for a few minutes.'],
          expect: 'The dot wobbles but there is no off-course notice and progress keeps moving.',
          setup: { tool: 'gps', jitter: 40 },
        },
      ],
    },
    {
      group: 'Arrival and notifications',
      items: [
        {
          title: 'Arrival prompt', rule: '50 · 40 · 30 · 20 · 10 m',
          steps: ['Let the trip play to the end (the live panel says <b>Arrived</b>).'],
          expect: 'MARTA asks if you have arrived inside 50 m. “Keep tracking” skips the radii already inside; it asks again 120 s later if still within 50 m.',
          setup: null,
        },
        {
          title: 'Auto-end at the destination', rule: '30 m for 5 min',
          steps: ['After Arrived, leave the pin where it is for 5 min.', 'Variation: during the 5 min, Off course 50 m and back.'],
          expect: 'The trip ends by itself after 5 min within 30 m. Going outside 30 m restarts the 5 min.',
          setup: { tool: 'offset', m: 50, side: 'right', move: 'jump' },
        },
        {
          title: 'Leave-by reminder', rule: '3 min before',
          steps: ['Start a trip whose leave-by is more than 3 min away, without Start walking now.', 'Put MARTA in the background.'],
          expect: 'A reminder 3 min before the first departure. Walking early (more than 150 m covered) skips it.',
          setup: null,
        },
        {
          title: 'Approaching notification', rule: '3 min before each leg ends',
          steps: ['Start a trip and put MARTA in the background.'],
          expect: 'A notification 3 min before each leg ends. Walks under 3 min are skipped, except the last leg.',
          setup: null,
        },
      ],
    },
  ];
  const recipes = SCENARIOS.flatMap((g) => g.items);

  function scenariosHtml() {
    let n = 0;
    return `<p class="info-lead">Step-by-step checks for MARTA live trips, each with the result to expect. <b>Set up</b> opens the right tool with the values filled in.</p>
      <div class="info-box"><b>Before you start</b>
        <ol class="prereq">
          <li>Connect the phone (device pill, top right).</li>
          <li>In MARTA Dev, open the secret menu (More tab, tap five times with two fingers). Under Mock Location, tap <b>Use real location</b> if it isn’t already. Under Live Trip Simulator, turn <b>Use the simulator</b> off.</li>
          <li>Plan a trip and tap Start. Then secret menu › <b>Download GPX</b> and get the file onto this Mac (AirDrop works).</li>
          <li>Trip tab: drop the file in, keep Speed at <b>1×</b>, Start trip.</li>
          <li>Open <b>Activity log</b> and use Copy log when you file a ticket.</li>
        </ol>
      </div>
      <input class="field-input info-search" id="rules-search" type="search" placeholder="Filter, e.g. 600, GPS, stop" aria-label="Filter scenarios">
      ${SCENARIOS.map((g) => `<section class="rule-sec">
        <h4>${g.group}</h4>
        ${g.items.map((s) => { const i = n++; return `<div class="rule-row scn">
          <div class="rule-top"><span class="rule-name">${s.title}</span><span class="rule-val">${s.rule}</span></div>
          <ol>${s.steps.map((x) => `<li>${x}</li>`).join('')}</ol>
          <p class="scn-expect"><b>Expect:</b> ${s.expect}</p>
          ${s.setup ? `<button class="btn btn-secondary btn-sm scn-setup" type="button" data-recipe="${i}">Set up</button>` : ''}
        </div>`; }).join('')}
      </section>`).join('')}
      <p class="info-foot">Timings come from the MARTA rules. ${'<button class="btn btn-quiet btn-sm info-link" type="button" data-info="rules">See all MARTA rules ›</button>'}</p>`;
  }

  function runRecipe(i) {
    const s = recipes[i]; if (!s || !s.setup) return;
    hide();
    setTimeout(() => {
      if (s.setup.walkAhead) { const el = LS.trip.setWalkAhead(true); if (el) requestAnimationFrame(() => LS.flash(el)); }
      else LS.tools.preset(s.setup);
    }, 150);
  }

  const seeRules = '<button class="btn btn-quiet btn-sm info-link" type="button" data-info="rules">See all MARTA rules ›</button>';

  const TOPICS = {
    rules: { title: 'MARTA live trip rules', icon: 'rules', html: rulesHtml },
    scenarios: { title: 'Test scenarios', icon: 'check', html: scenariosHtml },
    place: {
      title: 'Location', icon: 'place',
      html: () => `<p>Puts the phone at one fixed point.</p>
        <ul>
          <li><b>Set Location</b> sends the pin to the phone. Every app sees it until you stop.</li>
          <li><b>Stop Simulating</b> hands the phone back to its real GPS.</li>
          <li>Once a location is set, <b>Off course</b> and <b>GPS signal</b> appear below it, so you can test them without a trip. On a fixed point, right is east and left is west.</li>
          <li>Setting a location while a trip runs stops the trip.</li>
        </ul>
        <p class="info-note">The fix is resent every second, with a 0.3 m nudge when nothing moves, so the phone keeps getting fresh readings.</p>`,
    },
    timestamps: {
      title: 'Follow GPX timestamps', icon: 'trip',
      html: () => `<p>Plays the trip on the times written in the GPX file, the same timetable MARTA planned.</p>
        <ul>
          <li>Playback <b>joins at the current time</b>: points already in the past are skipped.</li>
          <li>Waits in the file (before leave-by, at a stop) are real waits.</li>
          <li>If the whole trip is in the past, Start is disabled. Export a fresh GPX.</li>
          <li>Off: the path is played at a constant speed instead (Walk, Run, Bike or Drive).</li>
        </ul>`,
    },
    walkahead: {
      title: 'Start walking now', icon: 'walk',
      html: () => `<p>For trips that begin with a walk. Instead of standing still until the leave-by time, the pin:</p>
        <ol>
          <li>walks to the first stop <b>now</b>, at the walk’s own pace;</li>
          <li>waits at the stop until the bus or train’s <b>scheduled departure</b>;</li>
          <li>follows the timetable from there.</li>
        </ol>
        <p>The wait is tied to the real clock: a slower walk or a Hold uses up the wait, and the departure doesn’t move.</p>
        <p class="info-note">MARTA’s leave-by reminder fires 3 min before the first departure while you’ve covered under 150 m, so walking early can skip it.</p>`,
    },
    speed: {
      title: 'Speed', icon: 'trip',
      html: () => `<p>Plays the whole GPX timeline faster: walks, waits and rides.</p>
        <ul>
          <li><b>1×</b> is real time. Use it for anything about departures, missed rides or timings: MARTA runs on the real clock, so at 2× or more the pin reaches stops before the app expects.</li>
          <li><b>2× – 10×</b> are for checking the route, the map and leg changes quickly.</li>
          <li><b>More options › Custom speed</b> accepts 0.1× to 500×.</li>
        </ul>`,
    },
    moveas: {
      title: 'Move as', icon: 'trip',
      html: () => `<p>For a drawn route, or a GPX without times. The pin moves along the path at a constant speed:</p>
        <ul><li>Walk 1.4 m/s</li><li>Run 4.5 m/s</li><li>Bike 7 m/s</li><li>Drive 15 m/s</li></ul>
        <p class="info-note">There are no legs here, so the whole route counts as walking for Pace.</p>`,
    },
    live: {
      title: 'Live trip', icon: 'trip',
      html: () => `<p>What the simulated rider is doing right now.</p>
        <ul>
          <li><b>Walking</b>, <b>On the bus or train</b>: following the GPX.</li>
          <li><b>Waiting at the stop</b>: Start walking now got there early; the countdown is to the scheduled departure.</li>
          <li><b>Holding position</b>: you pressed Hold.</li>
          <li><b>Arrived</b>: the route finished; the pin stays at the destination (good for arrival prompts and auto-end).</li>
        </ul>
        <p><b>Hold</b> (Space) keeps the rider in place while the trip clock runs. The phone still gets fixes, unlike <b>GPS Frozen</b>. Hold at the stop past the departure to test a missed ride.</p>
        <p><b>Stop trip</b> ends playback and keeps the phone where the trip stopped. Use Stop Simulating on the Place tab to return to real GPS.</p>
        ${seeRules}`,
    },
    offset: {
      title: 'Off course', icon: 'offset',
      html: () => `<p>Moves the location the phone receives sideways from the route, while the trip keeps going underneath. The dashed ghost dot on the map shows where the rider really is.</p>
        <ul>
          <li><b>Distance</b>: anything from 0 to 5000 m.</li>
          <li><b>Side</b>: left or right of the direction of travel.</li>
          <li><b>Jump</b> moves there in one step. <b>Drift</b> moves there evenly over the time you set, so you can see when MARTA reacts.</li>
          <li><b>Back on course</b> returns the same way (jump or drift).</li>
          <li>The offset stays across legs until you come back. A new trip starts on course.</li>
        </ul>
        <div class="info-box"><b>MARTA:</b> off course past <b>500 m</b> for <b>30 s</b>; back after <b>10 s</b> within 500 m. Between 50 m and 500 m the progress dot stops but there’s no notice.</div>
        <p class="info-note">Try: 450 m, no notice · 600 m, notice after about 30 s · Drift 0 → 600 m over 60 s crosses 500 m at 50 s, so the notice comes at about 80 s.</p>
        ${seeRules}`,
    },
    pace: {
      title: 'Pace', icon: 'pace',
      html: () => `<p>Speeds up or slows down <b>walking</b> legs from now on. 0.5× takes twice as long; 2× takes half as long. Rides stay on the timetable.</p>
        <ul>
          <li>Slider: 0.25× to 4×, or tap a preset.</li>
          <li>On a ride, the new pace applies from the next walk.</li>
          <li>With Start walking now, a slower walk shortens the wait at the stop.</li>
        </ul>
        <div class="info-box"><b>MARTA:</b> if the projected arrival at the stop is later than departure + <b>60 s</b> for <b>30 s</b>, it moves the trip to a later departure (“can’t make it”).</div>
        ${seeRules}`,
    },
    gps: {
      title: 'GPS signal', icon: 'gps',
      html: () => `<ul>
          <li><b>Normal</b>: a fix every second.</li>
          <li><b>Frozen</b>: nothing is sent, so the phone gets no new readings. The trip clock keeps running; when you go back to Normal the pin jumps to where the rider is now.</li>
          <li><b>Lost signal</b> (Android only): fixes keep coming, but with 150 m accuracy, which MARTA throws away. iOS can’t fake accuracy, so use Frozen there.</li>
          <li><b>Jitter</b>: random noise each second. Most fixes land within the value you set, never further than 3×.</li>
        </ul>
        <div class="info-box"><b>MARTA:</b> GPS lost after <b>20 s</b> with no usable fix. Fixes worse than <b>100 m</b> don’t count.</div>
        <p class="info-note">Try: Frozen at the stop past departure tests the “presumed departed” path.</p>
        ${seeRules}`,
    },
    log: {
      title: 'Activity log', icon: 'log',
      html: () => `<p>Everything you did and everything the trip did, with the time and the leg it happened on.</p>
        <ul>
          <li>Your actions: connect, set location, start, hold, off course, pace, GPS.</li>
          <li>Trip events: boarded, off the bus or train, waiting at the stop, finished, errors.</li>
          <li><b>Copy log</b> copies plain text for a ticket. <b>Clear</b> empties it.</li>
          <li>Kept on the Mac (last 300 entries). It survives a page reload and resets when the spoofer restarts.</li>
        </ul>`,
    },
  };

  const ICONS = {
    check: 'M9 6h11M9 12h11M9 18h11M3.5 6 5 7.5 7.5 5M3.5 12 5 13.5 7.5 11M3.5 18 5 19.5 7.5 17',
    rules: 'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5v-15ZM5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3M9 7.5h6M9 11h4',
    place: 'M12 21s-6-5.5-6-10.5a6 6 0 0 1 12 0C18 15.5 12 21 12 21Zm0-8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
    trip: 'M5 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm14-8a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM7 16h6a3 3 0 0 0 0-6h-2a3 3 0 0 1 0-6h6',
    walk: 'M13 4.5a1.5 1.5 0 1 0 0-.01M10 21l2-6 2.5 2.5V21M8 12l2-4 3 1 2 3 2.5 1',
    offset: 'M6 20V4M12 12h8m-3-3 3 3-3 3',
    pace: 'M4 17a8 8 0 1 1 16 0M12 17l4-5',
    gps: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM12 2v3m0 14v3M2 12h3m14 0h3M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z',
    log: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  };

  const sheet = $('info');
  const scrim = $('info-scrim');
  let lastFocus = null;
  let open = false;
  const spring = new Spring({ value: 0, response: 0.3, damping: 1, onUpdate: (v) => {
    sheet.style.opacity = String(v);
    sheet.style.transform = `translate(-50%, -50%) scale(${0.95 + 0.05 * v})`;
  } });

  function show(key) {
    const t = TOPICS[key]; if (!t) return;
    lastFocus = open ? lastFocus : document.activeElement;
    $('info-title').textContent = t.title;
    $('info-icon').innerHTML = `<svg viewBox="0 0 24 24"><path d="${ICONS[t.icon] || ICONS.trip}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    $('info-icon').className = `info-icon ii-${t.icon}`;
    $('info-body').innerHTML = t.html();
    $('info-body').scrollTop = 0;
    sheet.classList.toggle('wide', key === 'rules' || key === 'scenarios');
    if (!open) {
      open = true;
      scrim.hidden = false; sheet.hidden = false;
      requestAnimationFrame(() => scrim.classList.add('show'));
      spring.onRest = null; spring.to(1);
    }
    const search = $('rules-search');
    if (search) {
      search.addEventListener('input', () => filterRules(search.value));
      if (matchMedia('(min-width: 900px)').matches) search.focus(); else $('info-close').focus();
    } else {
      $('info-close').focus();
    }
  }
  function hide() {
    if (!open) return;
    open = false;
    scrim.classList.remove('show');
    spring.onRest = () => { if (!open) { sheet.hidden = true; scrim.hidden = true; } };
    spring.to(0);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function filterRules(q) {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    sheet.querySelectorAll('.rule-sec').forEach((sec) => {
      let any = false;
      const title = sec.querySelector('h4').textContent.toLowerCase();
      sec.querySelectorAll('.rule-row').forEach((row) => {
        const text = `${title} ${row.textContent.toLowerCase()}`;
        const hit = words.every((w) => text.includes(w));
        row.hidden = !hit; any = any || hit;
      });
      sec.hidden = !any;
    });
  }

  // Any element with data-info opens its topic. Inside a <summary> or <label> the tap must not
  // also toggle the tool or the switch.
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-info]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    show(b.dataset.info);
  }, true);
  $('info-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-recipe]');
    if (b) runRecipe(+b.dataset.recipe);
  });
  $('info-close').addEventListener('click', hide);
  scrim.addEventListener('click', hide);
  document.addEventListener('keydown', (e) => {
    if (!open) return;
    if (e.key === 'Escape') { e.stopPropagation(); hide(); }
    if (e.key === 'Tab') {
      const f = [...sheet.querySelectorAll('button, input, [href]')].filter((x) => !x.hidden && x.offsetParent);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }, true);

  LS.info = { show, hide, isOpen: () => open };
})();
