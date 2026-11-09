/* (i) explanations for every tool, and the MARTA live trip rules sheet. One shared dialog. */
(() => {
  'use strict';
  const LS = window.LS;
  const { $ } = LS;

  // MARTA live trip rules, from marta-mobile-app constants/liveTrip.ts (LIVE_TRIP_CONFIG),
  // utils/liveTrip/* and the live trip cards and notifications. On-screen text is the English
  // fallback copy (translation/fallback/en); the CMS can override it. Each trip copies these
  // numbers at Start and keeps them until it ends.
  //
  // Each row: name, value (the number, shown as a pill), what (plain description), see (what
  // appears on the phone), more (optional "More detail" dropdown), test (how to trigger it from
  // here), setup (optional; opens the tool with values filled in, see LS.tools.preset).
  const q = (t) => `<q>${t}</q>`;
  const RULES = [
    {
      id: 'offcourse', title: 'Going off course', icon: 'offset', tint: 'orange', jump: 'Off course',
      intro: 'When the rider goes far from the planned route, MARTA tells them they may be lost and offers to replan.',
      rows: [
        {
          name: 'Off-course distance', value: '> 805 m (½ mile)',
          what: 'The rider counts as off course when they are more than 805 m from the route. MARTA measures to the nearest point on the leg they are on, or on any leg still ahead. Legs already finished don’t count, so walking back the way you came counts as off course.',
          more: `<ul>
            <li>The reading’s accuracy is taken off first. A reading 850 m away with ±50 m accuracy counts as 800 m, so it is not off course.</li>
            <li>On a curved route, another part of the route can be closer than the distance you set here. Use <b>1000 m</b> to be safe.</li>
          </ul>`,
          test: 'Off course 1000 m, Jump', setup: { tool: 'offset', m: 1000, side: 'right', move: 'jump' },
        },
        {
          name: 'Time before the card shows', value: '30 s',
          what: 'Going past 805 m once isn’t enough. The rider must stay more than 805 m away for 30 seconds in a row. If they come back sooner, nothing is shown and the count starts over the next time.',
          see: `A card under the trip header: ${q('It looks like you might have lost your way.')} with <b>Replan trip</b> and <b>✕</b>.`,
          more: `<ul>
            <li>The 30 s is counted with the time on each GPS reading, not the phone’s clock. If GPS stops (Frozen), the count pauses; it does not start over.</li>
            <li><b>Replan trip</b> opens the trip planner from where the rider is now to the same destination, leaving now. The live trip keeps running underneath.</li>
            <li>Replan trip is hidden if the trip has not had a single GPS reading yet.</li>
          </ul>`,
          test: 'Off course 1000 m, Jump, then wait 30 s', setup: { tool: 'offset', m: 1000, side: 'right', move: 'jump' },
        },
        {
          name: 'Back on course', value: '10 s',
          what: 'Once the rider is back within 805 m for 10 seconds in a row, MARTA treats them as on course again and the card closes by itself.',
          more: `<ul>
            <li>If you close the card with ✕, it stays closed while the rider is still off course.</li>
            <li>After they have been back on course for 10 s, going off course again shows the card again.</li>
          </ul>`,
          test: 'Back on course (or Drift back)',
        },
        {
          name: 'Same rule on every leg', value: 'walk · bus · train',
          what: 'The 805 m and 30 s rule is the same whether the rider is walking or on a bus or train. There are no separate limits per type of leg.',
          test: 'Off course 1000 m while the live panel says On the bus or train',
        },
        {
          name: 'Push notification', value: 'app in background',
          what: 'If MARTA is in the background (another app or the home screen is showing) when the 30 seconds are up, the phone gets a push notification. It is sent once each time the rider goes off course.',
          see: `Push: ${q('It looks like you might have lost your way.')} ${q('Open your trip to replan.')} Tapping it opens the live trip.`,
          more: `<ul>
            <li>If the rider went off course while MARTA was open, no push is sent, and putting the app in the background afterwards won’t send one. Put MARTA in the background <b>first</b>, then go off course.</li>
            <li>If the rider comes back for less than 10 s and then strays again, a second push can be sent.</li>
          </ul>`,
          test: 'Put MARTA in the background, then Off course 1000 m and wait 30 s',
        },
      ],
    },
    {
      id: 'progress', title: 'Following the route', icon: 'trip', tint: 'green', jump: 'Progress',
      intro: 'How MARTA works out where the rider is on the trip, and moves their progress along in the trip panel.',
      rows: [
        {
          name: 'Progress radius', value: '50 m',
          what: 'The trip panel only moves the rider’s progress forward while they are within 50 m of the route. Between 50 m and 805 m away, progress stops where it is and nothing is shown. The rider’s dot on the map still follows them.',
          more: '<p>Accuracy is taken off the distance first. This is why a 300 m or 700 m offset freezes progress without any card: the rider is too far to be placed on the route, but not far enough to be off course.</p>',
          test: 'Off course 300 m, Jump: progress stops, no card', setup: { tool: 'offset', m: 300, side: 'right', move: 'jump' },
        },
        {
          name: 'Moving to the next leg', value: '20 m into it',
          what: 'At the end of a leg, progress moves to the next leg once the rider is 20 m into it. Progress only goes forward: never back to an earlier leg, and never backwards along the current one.',
          more: `<ul>
            <li>If the rider is no longer within 50 m of the current leg but is within 50 m of a later one, progress jumps straight to that leg. Legs can be skipped this way.</li>
            <li>Where two legs overlap, for example where a walk ends at the stop the bus leaves from, the later leg only wins if it is more than 5 m closer.</li>
          </ul>`,
        },
        {
          name: 'Panel refresh', value: 'every 3 m',
          what: 'To save battery, the trip panel only redraws when the rider has moved 3 m or more, changed leg, or the arrival time has changed by a minute.',
        },
      ],
    },
    {
      id: 'gps', title: 'GPS signal', icon: 'gps', tint: 'blue', jump: 'GPS',
      intro: 'How MARTA handles weak or missing location readings from the phone.',
      rows: [
        {
          name: 'Weak readings are ignored', value: 'worse than 100 m',
          what: 'A reading the phone says is only accurate to more than 100 m is thrown away, as if it never arrived. A reading with no accuracy value is kept.',
          more: `<ul>
            <li>A reading timed at or before the previous one is also thrown away.</li>
            <li><b>Lost signal</b> (Android only) keeps sending readings at 150 m accuracy, so MARTA ignores them all. iOS can’t fake accuracy; use <b>Frozen</b> there.</li>
          </ul>`,
          test: 'GPS signal › Lost signal (Android)', setup: { tool: 'gps', mode: 'lost' },
        },
        {
          name: 'GPS lost', value: '20 s',
          what: 'If MARTA gets no usable reading for 20 seconds, it shows that GPS is lost. If no reading has arrived yet, the 20 s count starts when the rider taps Start. It clears as soon as a usable reading arrives.',
          see: `A card at the top of the trip panel: ${q('No GPS signal')}, then ${q('Lost just now')}, later ${q('Lost 2 min ago')}. It can’t be closed. The rider’s dot on the map turns grey.`,
          test: 'GPS signal › Frozen, wait 20 s, then Normal', setup: { tool: 'gps', mode: 'frozen' },
        },
        {
          name: 'Recent reading needed', value: 'from the last 20 s',
          what: 'Some decisions are only made with a reading from the last 20 seconds. While GPS is frozen they don’t happen.',
          more: `<p>These need a recent reading:</p><ul>
            <li>deciding the rider missed their bus or train;</li>
            <li>deciding the bus or train left with the rider on it;</li>
            <li>switching back to the original departure;</li>
            <li>ending the trip at the destination;</li>
            <li>clearing the “trip may not be possible” card.</li>
          </ul>`,
        },
        {
          name: 'How often the phone reports', value: 'every 1 s',
          what: 'While MARTA is open, it asks the phone for a high-accuracy reading every second. In the background it asks for an update each time the rider moves 10 m (Android also uses a 5 s interval).',
          more: `<ul>
            <li>Background tracking needs the <b>Always</b> location permission. It never runs for trips from the app’s built-in simulator.</li>
            <li>On Android, background tracking shows a ${q('Trip in progress')} notification.</li>
            <li>An Android phone that isn’t moving may get no background updates at all.</li>
            <li>If location tracking fails while the app is open, it is retried after 10 s.</li>
          </ul>`,
        },
        {
          name: 'Speed and direction', value: 'not used',
          what: 'No rule uses the rider’s speed. Direction only turns the arrow on the rider’s marker on the map.',
        },
      ],
    },
    {
      id: 'missed', title: 'Missing the bus or train', icon: 'clock', tint: 'red', jump: 'Missed ride',
      intro: 'When the rider can’t catch the planned bus or train, MARTA moves the trip to a later departure of the same route by itself.',
      rows: [
        {
          name: 'Missed at the stop', value: '150 m · 60 s late',
          what: 'If the rider is still at the boarding stop (within 150 m) more than 60 seconds after the bus or train was due to leave, MARTA decides they missed it and moves the trip to the next departure straight away.',
          see: `A card: ${q('Your trip is taking longer than expected.')} ${q('You’re now expected to arrive at 10:42.')} with <b>✕</b> only. The same text comes as a push if MARTA is in the background.`,
          more: `<ul>
            <li>Uses the live departure time when there is one, and applies to every bus or train on the trip, not just the first.</li>
            <li>Straight-line distance to the stop; accuracy is not taken off. Needs a recent reading.</li>
            <li>The new departure is the soonest one that hasn’t left, isn’t cancelled and keeps the same rides after it.</li>
            <li>Never happens if the ride is the last one of the day.</li>
            <li>The delay card shows again after each new move, even if it was closed.</li>
          </ul>`,
          test: 'Start walking now, then Hold at the stop until 60 s past departure',
        },
        {
          name: 'Can’t make it in time', value: '60 s late for 30 s',
          what: 'While the rider walks to the stop, MARTA estimates when they will get there. If that estimate stays more than 60 seconds after the departure for 30 seconds in a row, it moves the trip to a later departure the rider can still reach.',
          see: `The same ${q('Your trip is taking longer than expected.')} card.`,
          more: `<ul>
            <li>Doesn’t happen while off course, or without a recent reading.</li>
            <li>Doesn’t happen for a departure the rider picked themselves from the departure chips.</li>
            <li>Any reading that shows the rider back on time starts the 30 s over.</li>
            <li>The estimate is the walk’s planned time scaled to how much of the walk is left (1.4 m/s if the walk has no times). Before the walk’s planned start, if the rider has moved less than 20 m, the walk’s planned end time is used.</li>
          </ul>`,
          test: 'Pace 0.5× on the first walk (0.25× if there’s a lot of spare time)', setup: { tool: 'pace', p: 0.5 },
        },
        {
          name: 'Ride cancelled', value: 'straight away',
          what: 'If the planned bus or train is cancelled, the trip moves to a later departure at once, even with no GPS and even while off course.',
        },
        {
          name: 'No later departure', value: 'trip may not be possible',
          what: 'If the rider missed their ride and there is no later departure that works, MARTA tells them the trip may not be possible.',
          see: `A card: ${q('Your trip may not be possible as planned.')} ${q('We can no longer estimate when you’ll reach your destination. Try replanning your trip to see other options.')} with <b>Replan trip</b> and <b>✕</b>. The arrival time in the header reads ${q('Arrival time unavailable')} and the phone vibrates once. The same text comes as a push if MARTA is in the background.`,
          more: `<ul>
            <li>Clears by itself if a later departure turns up.</li>
            <li>Also clears if the missed ride turns out fine for 30 s, for example the train was late or the rider is already on it.</li>
            <li>While it shows, the leave-by and approaching reminders are cancelled.</li>
          </ul>`,
        },
        {
          name: 'Switching back', value: '150 m for 5 s',
          what: 'After MARTA moved the trip to a later departure, if the rider turns up at the stop in time for the original one (within 150 m for 5 seconds, and it hasn’t left yet), it switches back. The delay card goes away.',
          more: `<ul>
            <li>Only after an automatic move, never for a departure the rider picked themselves.</li>
            <li>Needs a recent reading. The original ride must not be cancelled, and there is no 60 s grace: once its departure time passes, it’s gone.</li>
          </ul>`,
        },
      ],
    },
    {
      id: 'boarding', title: 'Getting on the bus or train', icon: 'bus', tint: 'blue', jump: 'Boarding',
      intro: 'How MARTA decides the bus or train has left with the rider on board.',
      rows: [
        {
          name: 'Ride departed', value: '> 150 m from the stop',
          what: 'Once progress has moved onto the bus or train leg and a recent reading puts the rider more than 150 m from the boarding stop, MARTA treats the ride as departed with the rider on it.',
          see: `The ride shows ${q('Departed 10:15')}. Its other departure chips disappear, and chips that would change it are locked with ${q('This departure can’t be chosen for your trip in progress')}.`,
          test: 'Let the ride play from the stop with GPS Normal',
        },
        {
          name: 'Presumed departed', value: 'no GPS after departure',
          what: 'If there is no recent reading and the departure time has passed, MARTA assumes the rider got on.',
          more: '<p>If a recent reading later shows them still within 150 m of the stop 60 s after departure, it counts as a missed ride instead.</p>',
          test: 'Start walking now; at the stop, GPS Frozen before departure, Normal after', setup: { tool: 'gps', mode: 'frozen' },
        },
      ],
    },
    {
      id: 'arrival', title: 'Arriving and ending the trip', icon: 'flag', tint: 'green', jump: 'Arrival',
      intro: 'How MARTA asks the rider if they have arrived, and when it ends a trip by itself.',
      rows: [
        {
          name: '“Have you arrived?”', value: '50 · 40 · 30 · 20 · 10 m',
          what: 'As the rider gets close to the destination, MARTA asks if they have arrived. It asks first at 50 m, then again at 40, 30, 20 and 10 m if they keep tracking.',
          see: `A card: ${q('Looks like you’ve arrived')} with <b>End trip</b> (ends the trip, toast ${q('You’ve arrived')}) and <b>Keep tracking</b>. Keep tracking or ✕ shows ${q('Your trip keeps going. You’ll be asked again when you’re closer.')} In the app only, no push.`,
          more: '<p>Straight-line distance to the destination; accuracy is not taken off. Keep tracking skips any distances the rider is already inside: tapping it at 25 m means the next question comes at 20 m.</p>',
          test: 'Let the trip play to the end (the live panel says Arrived)',
        },
        {
          name: 'Asked again', value: 'after 2 min',
          what: 'If the rider is still within 50 m two minutes after Keep tracking, MARTA asks again, and keeps asking about every 2 minutes while they stay within 50 m.',
          more: '<p>The 2 minutes count from the last GPS reading before the tap, not the tap itself.</p>',
        },
        {
          name: 'Ends at the destination', value: '30 m for 5 min',
          what: 'If the rider stays within 30 m of the destination for 5 minutes, the trip ends by itself with the toast “You’ve arrived”. Stepping outside 30 m starts the 5 minutes over.',
          more: '<p>Needs a recent reading at the moment it ends.</p>',
          test: 'After Arrived, wait 5 min. Variation: Off course 50 m and back during the 5 min', setup: { tool: 'offset', m: 50, side: 'right', move: 'jump' },
        },
        {
          name: 'Ends after the arrival time', value: '60 min',
          what: 'If the trip is still running 60 minutes after its planned arrival time, it ends by itself with the toast “Your trip has ended”.',
          more: `<ul>
            <li>Uses the trip’s own arrival time (live if available), not the rider’s estimate.</li>
            <li>Quick test: secret menu › Live Trip Simulator › Short auto-end timings › <b>1 min past arrival</b>. It applies to trips started after you set it.</li>
          </ul>`,
        },
        {
          name: 'Ends after 6 hours', value: '6 h',
          what: 'Any trip still running 6 hours after Start ends by itself.',
          more: `<ul>
            <li>Quick test: the same secret menu row, <b>2 min after Start</b>. Only one short timing can be on at a time.</li>
            <li>If it ends in the background it ends silently. Opening the trip then shows ${q('Your trip has ended')} and leaves the screen.</li>
          </ul>`,
        },
      ],
    },
    {
      id: 'reminders', title: 'Reminders', icon: 'bell', tint: 'purple', jump: 'Reminders',
      intro: 'Push notifications only. Sent while MARTA is in the background and notifications are allowed.',
      rows: [
        {
          name: 'Time to leave', value: '3 min before',
          what: '3 minutes before the trip’s first leg starts (the “Leave by” time in the app), the phone gets a reminder. It is skipped if the rider has already covered 150 m or more of the first leg.',
          see: `Push: ${q('Time to leave')} ${q('Your trip starts in about 3 min')}`,
          test: 'Start a trip whose Leave by is more than 3 min away, without Start walking now, then put MARTA in the background',
        },
        {
          name: 'Approaching the end of a leg', value: '3 min before',
          what: '3 minutes before the leg the rider is on ends, the phone gets a heads-up. Once per leg.',
          see: `Bus or train: ${q('Your stop, Five Points, is in about 3 min')} ${q('Get ready to leave the vehicle.')}<br>Walk: ${q('Almost at Five Points')} ${q('You’re approaching the next part of your trip.')}<br>Last leg: ${q('Arriving at Home in about 3 min')} ${q('You’re almost there.')}`,
          more: `<ul>
            <li>For a bus or train, only after it has left the boarding stop.</li>
            <li>None while off course or while the “trip may not be possible” card shows.</li>
            <li>Walks shorter than 3 min are skipped, except the last leg. Bus and train legs are never skipped.</li>
          </ul>`,
          test: 'Start a trip and put MARTA in the background',
        },
      ],
    },
    {
      id: 'good', title: 'Good to know', icon: 'info', tint: 'grey', jump: 'Good to know',
      intro: 'Things that affect every test.',
      rows: [
        {
          name: 'When Start appears', value: 'from here, leaving now',
          what: 'The Start button only shows on trips planned from Current Location, leaving now. The secret menu toggle “Offer Start on any trip” shows it on every trip.',
        },
        {
          name: 'One card at a time', value: 'in order',
          what: 'Cards under the trip header take turns, in this order: “Have you arrived?”, off course, trip may not be possible, delay. The delay card waits until the others are gone.',
          more: '<p>Exception: the off-course card does not wait for the arrival question, so both can show at once.</p>',
        },
        {
          name: 'The app’s built-in simulator', value: 'turn it off',
          what: 'Trips run by MARTA’s own Live Trip Simulator (secret menu) send no push notifications and skip background tracking. To test with this tool, turn “Use the simulator” off.',
        },
      ],
    },
  ];

  const PRIMER = `<details class="primer">
      <summary>New to live trips? Start here</summary>
      <dl>
        <dt>Live trip</dt><dd>After planning a trip from Current Location, leaving now, the rider taps <b>Start</b>. MARTA then follows them on the map and shows a trip panel with their progress.</dd>
        <dt>Leg</dt><dd>One part of the trip: a walk, a bus ride or a train ride. A trip is a chain of legs.</dd>
        <dt>GPS reading</dt><dd>One location from the phone (also called a fix). This tool sends one every second.</dd>
        <dt>Accuracy</dt><dd>How sure the phone is about a reading, such as ±10 m. MARTA takes it off distances, giving the rider the benefit of the doubt.</dd>
        <dt>Card</dt><dd>A message box under the trip header, over the map. Most can be closed with ✕.</dd>
        <dt>Push notification</dt><dd>A system notification. Live trip pushes are only sent while MARTA is in the background and notifications are allowed. Tapping one opens the live trip.</dd>
        <dt>Secret menu</dt><dd>The developer menu in MARTA Dev builds: More tab, tap five times with two fingers.</dd>
      </dl>
    </details>`;

  // Set up buttons on rules and scenarios. Rebuilt each time the sheet opens.
  let setups = [];
  const setupBtn = (cfg) => `<button class="btn btn-secondary btn-sm scn-setup" type="button" data-setup="${setups.push(cfg) - 1}">Set up</button>`;
  const secHead = (s, title) => `<div class="sec-head">
      <span class="sec-icon st-${s.tint}" aria-hidden="true">${iconSvg(s.icon)}</span>
      <div><h4>${title}</h4>${s.intro ? `<p class="sec-intro">${s.intro}</p>` : ''}</div>
    </div>`;

  function rulesHtml() {
    return `<p class="info-lead">The checks MARTA runs while a rider is on a live trip: what the app does, what you’ll see on the phone, and how to trigger it from here. Numbers are the app’s defaults; a trip keeps the numbers it started with.</p>
      ${PRIMER}
      <input class="field-input info-search" id="rules-search" type="search" placeholder="Filter rules, e.g. 805, GPS, stop" aria-label="Filter rules">
      <nav class="sec-jump" aria-label="Jump to section">${RULES.map((s) => `<button type="button" class="chip-btn" data-jump="sec-${s.id}">${s.jump}</button>`).join('')}</nav>
      ${RULES.map((s) => `<section class="rule-sec" id="sec-${s.id}">
        ${secHead(s, s.title)}
        <div class="rule-group">
        ${s.rows.map((r) => `<div class="rule-row">
          <div class="rule-top"><span class="rule-name">${r.name}</span><span class="rule-val">${r.value}</span></div>
          <p class="rule-what">${r.what}</p>
          ${r.see ? `<div class="rule-see"><span>On the phone</span><p>${r.see}</p></div>` : ''}
          ${r.more ? `<details class="rule-more"><summary>More detail</summary><div class="rule-more-body">${r.more}</div></details>` : ''}
          ${r.test ? `<div class="rule-test"><p><b>How to test:</b> ${r.test}</p>${r.setup ? setupBtn(r.setup) : ''}</div>` : ''}
        </div>`).join('')}
        </div>
      </section>`).join('')}
      <p class="info-empty" id="rules-empty" hidden>No rules match.</p>
      <p class="info-foot">Source: marta-mobile-app <code>constants/liveTrip.ts</code>, <code>utils/liveTrip/</code> and the English text in <code>translation/fallback/en</code> (the CMS can change the wording).</p>`;
  }

  // Test recipes. `setup` opens the tool with the values filled in (see LS.tools.preset).
  const SCENARIOS = [
    {
      group: 'Off course', icon: 'offset', tint: 'orange',
      items: [
        {
          title: 'Off course past 805 m', rule: '> 805 m for 30 s',
          steps: ['During a walk, open <b>Off course</b>: 1000 m, Right, Jump.', 'Press <b>Go off course</b> and note the time.', 'After the card shows, press <b>Back on course</b>.'],
          expect: 'About 30 s after the jump, MARTA shows the card “It looks like you might have lost your way.” with Replan trip. It closes by itself about 10 s after you come back.',
          setup: { tool: 'offset', m: 1000, side: 'right', move: 'jump' },
        },
        {
          title: 'Inside the limit', rule: '700 m · no card',
          steps: ['Off course 700 m, Jump.', 'Wait at least 60 s.', 'Back on course.'],
          expect: 'No off-course card. Progress in the trip panel stops while you are more than 50 m from the route, then carries on when you come back.',
          setup: { tool: 'offset', m: 700, side: 'right', move: 'jump' },
        },
        {
          title: 'Short excursion', rule: 'timer resets',
          steps: ['Off course 1000 m, Jump.', 'After about 20 s, press Back on course.', 'Wait another 30 s.'],
          expect: 'No card. MARTA needs 30 s in a row past 805 m, and coming back starts the count over.',
          setup: { tool: 'offset', m: 1000, side: 'right', move: 'jump' },
        },
        {
          title: 'Gradual drift', rule: 'crossing time + 30 s',
          steps: ['Off course 1000 m, Drift over 60 s.', 'Press <b>Drift off course</b>. The readout shows the distance as it grows.'],
          expect: 'The pin passes 805 m at about 48 s, so the card shows at about 78 s.',
          setup: { tool: 'offset', m: 1000, side: 'right', move: 'drift', ramp: 60 },
        },
        {
          title: 'Off course on the bus or train', rule: 'same rule on every leg',
          steps: ['Wait until the live panel says <b>On the bus or train</b>.', 'Off course 1000 m, Jump.'],
          expect: 'The same card after about 30 s. Walks, buses and trains share one rule.',
          setup: { tool: 'offset', m: 1000, side: 'left', move: 'jump' },
        },
      ],
    },
    {
      group: 'Catching the ride', icon: 'clock', tint: 'red',
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
          expect: 'MARTA moves the trip to a later departure and shows “Your trip is taking longer than expected.” with the new arrival time. Stop the trip afterwards: the GPX still follows the original ride.',
          setup: { walkAhead: true },
        },
        {
          title: 'Can’t make it', rule: '+60 s for 30 s',
          steps: ['At 1×, during the first walk, set <b>Pace</b> to 0.5×.', 'If the walk has a lot of spare time, use 0.25×.'],
          expect: 'Once MARTA’s estimate of when you reach the stop is more than 60 s after departure for 30 s in a row, it moves to a later departure and shows the “taking longer than expected” card. It does not happen while off course.',
          setup: { tool: 'pace', p: 0.5 },
        },
        {
          title: 'Departure confirmed', rule: '> 150 m from the stop',
          steps: ['Let the ride play from the stop with GPS Normal.'],
          expect: 'Once the pin is more than 150 m from the boarding stop, MARTA treats the ride as departed: it shows “Departed” with the time, and the other departure chips disappear.',
          setup: null,
        },
        {
          title: 'Presumed departed', rule: 'no GPS · past departure',
          steps: ['Start with Start walking now and wait at the stop.', 'Before the departure, set <b>GPS signal</b> to Frozen.', 'Wait until past the departure, then go back to Normal.'],
          expect: 'With no recent GPS reading after the departure time, MARTA assumes you got on.',
          setup: { tool: 'gps', mode: 'frozen' },
        },
      ],
    },
    {
      group: 'GPS', icon: 'gps', tint: 'blue',
      items: [
        {
          title: 'GPS lost', rule: '20 s',
          steps: ['<b>GPS signal</b> › Frozen.', 'Wait 30 s, then Normal.'],
          expect: 'About 20 s after freezing, MARTA shows a “No GPS signal” card and the rider’s dot turns grey. It clears on the next reading, and the pin jumps to where the rider is now.',
          setup: { tool: 'gps', mode: 'frozen' },
        },
        {
          title: 'Lost signal (Android)', rule: 'accuracy > 100 m',
          steps: ['On an Android phone: GPS signal › Lost signal.', 'Wait 30 s, then Normal.'],
          expect: 'Readings keep arriving at 150 m accuracy and MARTA ignores them, so “No GPS signal” shows after about 20 s. On iOS use Frozen.',
          setup: { tool: 'gps', mode: 'lost' },
        },
        {
          title: 'Noisy GPS', rule: 'no false alarms',
          steps: ['GPS signal › Jitter 40 m.', 'Let the trip play for a few minutes.'],
          expect: 'The dot wobbles but there is no off-course card and progress keeps moving.',
          setup: { tool: 'gps', jitter: 40 },
        },
      ],
    },
    {
      group: 'Arrival and notifications', icon: 'flag', tint: 'green',
      items: [
        {
          title: 'Arrival prompt', rule: '50 · 40 · 30 · 20 · 10 m',
          steps: ['Let the trip play to the end (the live panel says <b>Arrived</b>).'],
          expect: 'Within 50 m, MARTA shows “Looks like you’ve arrived” with End trip and Keep tracking. Keep tracking skips the distances you are already inside; it asks again 2 min later if you are still within 50 m.',
          setup: null,
        },
        {
          title: 'Auto-end at the destination', rule: '30 m for 5 min',
          steps: ['After Arrived, leave the pin where it is for 5 min.', 'Variation: during the 5 min, Off course 50 m and back.'],
          expect: 'The trip ends by itself after 5 min within 30 m, with the toast “You’ve arrived”. Going outside 30 m starts the 5 min over.',
          setup: { tool: 'offset', m: 50, side: 'right', move: 'jump' },
        },
        {
          title: 'Leave-by reminder', rule: '3 min before',
          steps: ['Start a trip whose leave-by is more than 3 min away, without Start walking now.', 'Put MARTA in the background.'],
          expect: 'A “Time to leave” push 3 min before the trip’s first leg starts (the Leave by time). Walking early (150 m or more covered) skips it.',
          setup: null,
        },
        {
          title: 'Approaching notification', rule: '3 min before each leg ends',
          steps: ['Start a trip and put MARTA in the background.'],
          expect: 'A push 3 min before each leg ends, for example “Your stop, Five Points, is in about 3 min”. Walks under 3 min are skipped, except the last leg.',
          setup: null,
        },
      ],
    },
  ];
  function scenariosHtml() {
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
      <input class="field-input info-search" id="rules-search" type="search" placeholder="Filter, e.g. 1000, GPS, stop" aria-label="Filter scenarios">
      ${SCENARIOS.map((g) => `<section class="rule-sec">
        ${secHead(g, g.group)}
        <div class="rule-group">
        ${g.items.map((s) => `<div class="rule-row scn">
          <div class="rule-top"><span class="rule-name">${s.title}</span><span class="rule-val">${s.rule}</span></div>
          <ol>${s.steps.map((x) => `<li>${x}</li>`).join('')}</ol>
          <p class="scn-expect"><b>Expect:</b> ${s.expect}</p>
          ${s.setup ? setupBtn(s.setup) : ''}
        </div>`).join('')}
        </div>
      </section>`).join('')}
      <p class="info-empty" id="rules-empty" hidden>No scenarios match.</p>
      <p class="info-foot">Timings come from the MARTA rules. ${'<button class="btn btn-quiet btn-sm info-link" type="button" data-info="rules">See all MARTA rules ›</button>'}</p>`;
  }

  function runSetup(i) {
    const cfg = setups[i]; if (!cfg) return;
    hide();
    setTimeout(() => {
      if (cfg.walkAhead) { const el = LS.trip.setWalkAhead(true); if (el) requestAnimationFrame(() => LS.flash(el)); }
      else LS.tools.preset(cfg);
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
        <p class="info-note">MARTA’s “Time to leave” reminder fires 3 min before the trip’s first leg starts, only while you’ve covered under 150 m, so walking early can skip it.</p>`,
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
        <div class="info-box"><b>MARTA:</b> off course past <b>805 m</b> (½ mile) for <b>30 s</b> in a row; back on course after <b>10 s</b> within 805 m. Between 50 m and 805 m, progress in the trip panel stops but there’s no card.</div>
        <p class="info-note">Try: 700 m, no card · 1000 m, card after about 30 s · Drift 0 → 1000 m over 60 s crosses 805 m at about 48 s, so the card comes at about 78 s.</p>
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
        <div class="info-box"><b>MARTA:</b> if its estimate of when you reach the stop stays more than <b>60 s</b> after the departure for <b>30 s</b> in a row, it moves the trip to a later departure (“can’t make it”). Not while off course, and not for a departure picked from the departure chips.</div>
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
        <div class="info-box"><b>MARTA:</b> shows a “No GPS signal” card after <b>20 s</b> with no usable reading. Readings worse than <b>100 m</b> don’t count.</div>
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
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
    bus: 'M6 17V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v11H6ZM6 11h12M8 17v3M16 17v3M9 14h.01M15 14h.01',
    flag: 'M5 21V4h11l-2 4 2 4H5',
    bell: 'M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15L6 16ZM10 20.5a2 2 0 0 0 4 0',
    info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8h.01',
  };
  function iconSvg(name) {
    return `<svg viewBox="0 0 24 24"><path d="${ICONS[name] || ICONS.trip}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

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
    $('info-icon').innerHTML = iconSvg(t.icon);
    $('info-icon').className = `info-icon ii-${t.icon}`;
    setups = [];
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
  // Filter by words; a section title counts for all its rows. A match only inside a closed
  // "More detail" opens it (and closes it again when it stops matching).
  function filterRules(q) {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const has = (text) => words.every((w) => text.includes(w));
    let shown = 0;
    sheet.querySelectorAll('.rule-sec').forEach((sec) => {
      let any = false;
      const title = sec.querySelector('h4').textContent.toLowerCase();
      sec.querySelectorAll('.rule-row').forEach((row) => {
        const hit = has(`${title} ${row.textContent.toLowerCase()}`);
        row.hidden = !hit; any = any || hit;
        const more = row.querySelector('.rule-more');
        if (!more) return;
        const outside = [...row.children].filter((c) => c !== more).map((c) => c.textContent).join(' ').toLowerCase();
        const needOpen = hit && words.length > 0 && !has(`${title} ${outside}`);
        if (needOpen && !more.open) { more.open = true; more.dataset.auto = '1'; }
        else if (!needOpen && more.dataset.auto) { more.open = false; delete more.dataset.auto; }
      });
      sec.hidden = !any;
      if (any) shown++;
    });
    const jump = sheet.querySelector('.sec-jump');
    if (jump) jump.hidden = words.length > 0;
    const empty = $('rules-empty');
    if (empty) empty.hidden = shown > 0;
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
    const b = e.target.closest('[data-setup]');
    if (b) { runSetup(+b.dataset.setup); return; }
    const j = e.target.closest('[data-jump]');
    if (j) {
      const sec = $(j.dataset.jump);
      if (sec) sec.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
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
