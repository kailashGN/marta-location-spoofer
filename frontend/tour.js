/* First-run tour. It starts a practice trip first (demo phone + sample GPX) and walks a real run,
 * so every spotlight lands on something on screen. Replay from the ? button. */
(() => {
  'use strict';
  const LS = window.LS;
  const { $, esc } = LS;

  const shown = (el) => !!el && el.getClientRects().length > 0 && !el.closest('[hidden]');
  const firstShown = (...els) => els.find(shown) || null;
  const tripRunning = () => !!LS.activeRoute();
  const tryIt = (html) => `<p class="tour-try"><b>Try it:</b> ${html}</p>`;
  const note = (html) => `<p class="tour-note">${html}</p>`;

  // What the tour changed, so the last card can offer to undo it.
  const ctx = { priorDevice: null, practiceFailed: false };

  async function setUpPractice() {
    ctx.practiceFailed = false;
    const st = LS.state.status;
    if (!LS.practising()) {
      ctx.priorDevice = LS.connected() ? { udid: st.udid, name: st.device_name || 'your phone' } : null;
      const ok = await LS.device.startPractice();
      if (!ok) { ctx.practiceFailed = true; return true; } // carry on; steps fall back to notes
    }
    if (!tripRunning() && !LS.trip.hasPlan()) await LS.trip.loadSample();
    return true;
  }

  async function startTrip() {
    if (!LS.connected() || !LS.trip.hasPlan()) return true;
    await LS.trip.start();
    if (tripRunning()) return true;
    return { error: 'The trip didn’t start. Check the Trip tab for the reason, or press Next to keep going.' };
  }
  const canStart = () => LS.connected() && LS.trip.hasPlan() && !tripRunning();

  const STEPS = [
    {
      title: 'Welcome to Location Spoofer',
      body: () => {
        const st = LS.state.status;
        const real = LS.connected() && !LS.practising();
        let warn = '';
        if (real) {
          warn = note(`The tour switches to a demo phone${tripRunning() ? ' and stops the trip running now' : ''}. You can reconnect ${esc(st.device_name || 'your phone')} at the end.`);
        }
        return `<p>This tool moves a test phone’s GPS from your Mac, so you can test a MARTA live trip from your desk: walk it, go off course, lose GPS, arrive.</p>
          <p>The tour sets up a <b>practice trip</b> on a demo phone and runs it with you. Nothing is sent to a real phone. It takes about three minutes.</p>${warn}`;
      },
      next: () => (LS.practising() ? 'Start the tour' : 'Start with a practice trip'),
      busyLabel: 'Setting up the demo phone…',
      back: 'Not now',
      action: setUpPractice,
    },
    {
      section: 'Setup',
      title: () => (LS.practising() ? 'You’re on a demo phone' : 'Connect a phone'),
      before: () => LS.device.show(),
      target: () => $('device-pop'),
      body: () => `${LS.practising()
        ? '<p>The pill at the top now says <b>Practice</b>. It always shows what the phone is doing: connected, simulating, or running a trip.</p>'
        : '<p>The pill at the top always shows what the phone is doing: connected, simulating, or running a trip.</p>'}
        <p>For real testing, plug an iPhone or Android phone into this Mac with a USB cable, unlock it, and press <b>Connect</b>. Everything else works the same way.</p>
        ${ctx.practiceFailed ? note('Practice mode couldn’t start, so the next steps describe the parts instead of showing them. Try <b>Practice with a demo phone</b> here after the tour.') : ''}`,
    },
    {
      section: 'Setup',
      title: 'This is the trip',
      before: () => { LS.device.close(); LS.tabs.show('trip'); },
      target: () => (tripRunning() ? $('trip-live') : firstShown($('trip-summary'), $('dropzone'))),
      body: () => `<p>A trip comes from a <b>GPX file</b>: the route and timetable MARTA planned. The practice trip walks from the State Capitol, rides the train and walks to Midtown. The chips show each part: <b>Walk › Ride › Walk</b>.</p>
        <p>For a real test, start a trip in <b>MARTA Dev</b>, open the secret menu and tap <b>Download GPX</b>. AirDrop the file to this Mac and drop it on the Trip tab.</p>`,
    },
    {
      section: 'Setup',
      title: 'Choose how it plays',
      skip: tripRunning,
      before: () => LS.tabs.show('trip'),
      target: () => firstShown(document.querySelector('#trip-summary .options')),
      interactive: true,
      body: () => `<ul>
          <li><b>Follow GPX timestamps</b>: moves the pin on MARTA’s own timetable, including the wait at the stop.</li>
          <li><b>Start walking now</b>: if the trip leaves later, walk to the stop right away and wait there.</li>
          <li><b>Speed</b>: keep <b>1×</b> for anything about timing. The app runs on the real clock, so a faster replay can trigger alerts early.</li>
        </ul>
        <p>Each option has an <b>(i)</b> button that explains it.</p>
        ${shown($('trip-summary')) ? '' : note('These options show up once a GPX is loaded.')}`,
    },
    {
      section: 'Run a trip',
      title: 'Start the trip',
      skip: tripRunning,
      before: () => LS.tabs.show('trip'),
      target: () => firstShown($('btn-route-play')),
      body: () => (canStart()
        ? `<p>This button sends the trip to the phone. The pin starts walking right away.</p>
           <p>Press <b>Start trip</b> below and the tour presses it for you. Next time, this button is all you need.</p>`
        : `<p><b>Start trip</b> sends the trip to the phone and the pin starts moving.</p>
           ${note('It’s enabled once a phone (or the demo phone) is connected and a trip is loaded.')}`),
      next: () => (canStart() ? 'Start trip' : 'Next'),
      busyLabel: 'Starting…',
      action: () => (canStart() ? startTrip() : true),
    },
    {
      section: 'Run a trip',
      title: 'Watch the rider',
      before: () => LS.tabs.show('trip'),
      target: () => firstShown(document.querySelector('#trip-live .live-card')),
      interactive: true,
      body: () => `<p>This card shows what the rider is doing right now (walking, waiting at the stop, on the train, arrived), plus how far they’ve got and how long is left. The blue pin on the map moves along with them.</p>
        <p><b>Hold</b> keeps the rider in place while the clock runs (like someone stopping). <b>Stop trip</b> ends the run.</p>
        ${tripRunning() ? tryIt('press <b>Hold</b> and watch the pin stop, then <b>Resume</b>.') : note('This card replaces the setup once a trip is running.')}`,
    },
    {
      section: 'Test',
      title: 'Break things on purpose',
      before: () => LS.tabs.show(tripRunning() || !LS.simulating() ? 'trip' : 'place'),
      target: () => firstShown($('tools')),
      interactive: true,
      body: () => `<p>Most bugs show up when the rider does something unexpected. These tools fake that:</p>
        <ul>
          <li><b>Off course</b>: move away from the route, all at once or slowly.</li>
          <li><b>Pace</b>: walk slower or faster than planned.</li>
          <li><b>GPS signal</b>: freeze it, lose it, or make it jumpy.</li>
          <li><b>Activity log</b>: everything that happened, with times. Paste it into your bug report.</li>
        </ul>
        ${shown($('tools'))
          ? tryIt('open <b>Off course</b>, tap <b>1000</b> and press <b>Go off course</b>. That’s past MARTA’s 805 m limit, so the chip on the trip card turns red. <b>Back on course</b> undoes it.')
          : note('These tools appear under a running trip, and on the Place tab once a location is set.')}`,
    },
    {
      section: 'Test',
      title: 'Just need a location?',
      before: () => LS.tabs.show('place'),
      target: () => $('panel-place').querySelector('.card'),
      body: () => `<p>Not every check needs a trip. Search a place in the box at the top (or paste <b>lat, lon</b>), or click the map to drop the pin.</p>
        <p><b>Set Location</b> puts the phone there, and every app on it sees that location. <b>Stop Simulating</b> gives the phone its real GPS back.</p>
        <p>Good for checking the map, nearby stops, or the trip planner’s current location.</p>`,
    },
    {
      section: 'Help',
      title: 'Know the rules',
      before: () => LS.tabs.show('trip'),
      target: () => firstShown($('btn-rules')),
      body: () => `<p><b>MARTA rules</b> lists every limit the app uses, what you should see on the phone, and how to trigger it here. Two examples:</p>
        <ul>
          <li>Off course: more than 805 m from the route for 30 s.</li>
          <li>GPS lost: no update for 20 s.</li>
        </ul>
        <p>Not sure what a result should be? Check here before you file a bug.</p>`,
    },
    {
      section: 'Help',
      title: 'Follow a recipe',
      target: () => firstShown($('btn-scenarios')),
      body: () => `<p><b>Test scenarios</b> are step-by-step checks, each with the result to expect. <b>Set up</b> opens the right tool with the values already filled in.</p>
        <p>New to this? Start with <b>“Off course past 805 m”</b>. You can run it on the practice trip that’s going now.</p>`,
    },
    {
      title: 'You’re set',
      body: () => {
        if (LS.practising()) {
          return `<p>The practice trip is still running, so keep exploring. Nothing you do reaches a real phone.</p>
            <p>When you’re ready, end practice from the device pill and connect your test phone. Replay this tour any time from <b>?</b>.</p>`;
        }
        return `<p>Replay this tour any time from <b>?</b>.</p>
          ${LS.connected() ? '' : '<p>To try everything without a phone, start practice mode. It loads a sample trip from the State Capitol to Midtown.</p>'}`;
      },
      next: () => (LS.practising() ? 'Keep practising' : 'Done'),
      extra: () => {
        if (LS.practising() && ctx.priorDevice) {
          const d = ctx.priorDevice;
          return { label: `Reconnect ${d.name}`, run: () => LS.device.reconnect(d.udid) };
        }
        if (LS.practising()) return { label: 'End practice', run: () => LS.device.endPractice() };
        if (!LS.connected()) return { label: 'Try practice mode', run: () => LS.device.startPractice() };
        return null;
      },
    },
  ];
  const val = (v) => (typeof v === 'function' ? v() : v);
  const NUMBERED = STEPS.filter((s) => s.section).length;

  // ------------------------------------------------------------------ DOM
  const root = document.createElement('div');
  root.className = 'tour';
  root.hidden = true;
  root.innerHTML = `<div class="tour-block"></div><div class="tour-spot none"></div>
    <div class="tour-card material-solid" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <p class="tour-count" id="tour-count"></p>
      <h3 id="tour-title"></h3>
      <div class="tour-body" id="tour-body" aria-live="polite"></div>
      <p class="tour-note tour-error" id="tour-error" hidden></p>
      <div class="tour-foot">
        <div class="tour-dots" aria-hidden="true">${STEPS.map(() => '<span></span>').join('')}</div>
        <button class="btn btn-quiet btn-sm" id="tour-back" type="button"></button>
        <button class="btn btn-secondary btn-sm" id="tour-next" type="button"></button>
        <button class="btn btn-sm" id="tour-extra" type="button" hidden></button>
      </div>
    </div>`;
  $('app').appendChild(root);
  const block = root.querySelector('.tour-block');
  const spot = root.querySelector('.tour-spot');
  const card = root.querySelector('.tour-card');
  const dots = [...root.querySelectorAll('.tour-dots span')];

  let open = false;
  let index = 0;
  let raf = 0;
  let lastFocus = null;
  let token = 0;     // bumps on every render so a slow `before` can't place a stale step
  let busy = false;
  let target = null; // element currently spotlit
  const cardSpring = new Spring({ value: 0, response: 0.3, damping: 1, onUpdate: (v) => {
    card.style.opacity = String(v);
    card.style.scale = String(0.96 + 0.04 * v);
  } });

  function setBusy(on, label) {
    busy = on;
    card.classList.toggle('is-busy', on);
    ['tour-back', 'tour-next', 'tour-extra'].forEach((id) => { $(id).disabled = on; });
    $('tour-next').classList.toggle('busy', on);
    if (on && label) $('tour-next').setAttribute('aria-label', label);
    else $('tour-next').removeAttribute('aria-label');
    if (on && label) $('tour-error').hidden = true;
  }
  function showError(text) {
    $('tour-error').textContent = text;
    $('tour-error').hidden = !text;
  }

  async function render() {
    const my = ++token;
    const step = STEPS[index];
    setBusy(false);
    showError('');
    const pending = step.before && step.before();
    if (pending && typeof pending.then === 'function') {
      setBusy(true);
      try { await pending; } catch { /* the step falls back to its note */ }
      if (my !== token || !open) return;
      setBusy(false);
    }
    const n = STEPS.slice(0, index + 1).filter((s) => s.section).length;
    $('tour-count').textContent = step.section ? `${step.section} · Step ${n} of ${NUMBERED}` : '';
    $('tour-count').hidden = !step.section;
    $('tour-title').textContent = val(step.title);
    $('tour-body').innerHTML = step.body();
    $('tour-next').textContent = val(step.next) || 'Next';
    $('tour-back').textContent = val(step.back) || 'Back';
    const extra = step.extra && step.extra();
    $('tour-extra').hidden = !extra;
    $('tour-back').hidden = !!extra;
    const dotsEl = root.querySelector('.tour-dots');
    dotsEl.style.visibility = extra || !step.section ? 'hidden' : '';
    dotsEl.style.flex = extra ? '1 1 0' : '';
    dotsEl.style.minWidth = '0';
    $('tour-extra').classList.toggle('btn-primary', !!extra);
    $('tour-next').classList.toggle('btn-primary', !extra);
    $('tour-next').classList.toggle('btn-secondary', !!extra);
    if (extra) {
      $('tour-extra').textContent = extra.label;
      $('tour-extra').onclick = () => { close(true); extra.run(); };
    }
    dots.forEach((d, i) => d.classList.toggle('on', i === index));
    lastKey = '';
    // The layout may change after `before` (tab switch, popover); place on the next frame.
    requestAnimationFrame(() => {
      if (my !== token) return;
      reveal(step.target && step.target());
      place();
      $('tour-next').focus();
    });
  }

  /** Bring a target inside the controls sheet on screen: open the sheet (phone widths) and scroll to it. */
  function reveal(el) {
    if (!el || !shown(el) || !$('sheet').contains(el)) return;
    if (LS.sheet) LS.sheet.expand();
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  let lastKey = '';
  function place() {
    const step = STEPS[index];
    const el = step.target && step.target();
    target = el && shown(el) ? el : null;
    const W = window.innerWidth, H = window.innerHeight;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    let spotRect, x, y;
    if (target) {
      const r = target.getBoundingClientRect();
      const pad = 6;
      spotRect = { left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
      const gap = 16;
      const spaces = {
        below: H - (spotRect.top + spotRect.height) - gap,
        above: spotRect.top - gap,
        left: spotRect.left - gap,
        right: W - (spotRect.left + spotRect.width) - gap,
      };
      const order = r.left > W * 0.55 ? ['left', 'below', 'above', 'right'] : ['below', 'above', 'right', 'left'];
      const side = order.find((s) => (s === 'left' || s === 'right' ? spaces[s] >= cw : spaces[s] >= ch)) || 'center';
      if (side === 'below') { x = r.left + r.width / 2 - cw / 2; y = spotRect.top + spotRect.height + gap; }
      else if (side === 'above') { x = r.left + r.width / 2 - cw / 2; y = spotRect.top - gap - ch; }
      else if (side === 'left') { x = spotRect.left - gap - cw; y = r.top; }
      else if (side === 'right') { x = spotRect.left + spotRect.width + gap; y = r.top; }
      // No side fits (a tall target on a small screen): pin to the roomier edge so part of the target stays visible.
      else { x = (W - cw) / 2; y = spaces.above > spaces.below ? 16 : H - ch - 16; }
      spot.classList.remove('none');
    } else {
      spotRect = { left: W / 2, top: H / 2, width: 0, height: 0 };
      x = (W - cw) / 2; y = (H - ch) / 2;
      spot.classList.add('none');
    }
    x = Math.max(16, Math.min(W - cw - 16, x));
    y = Math.max(16, Math.min(H - ch - 16, y));
    const hole = !!(target && step.interactive);
    const key = [spotRect.left, spotRect.top, spotRect.width, spotRect.height, x, y, W, H].map(Math.round).join() + hole;
    if (key === lastKey) return;
    lastKey = key;
    Object.assign(spot.style, { left: `${spotRect.left}px`, top: `${spotRect.top}px`, width: `${spotRect.width}px`, height: `${spotRect.height}px` });
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
    // Interactive steps cut a hole in the click blocker so the spotlit controls can be used.
    const { left: l, top: t, width: w, height: h } = spotRect;
    block.style.clipPath = hole ? `path(evenodd, "M0 0H${W}V${H}H0Z M${l} ${t}h${w}v${h}h${-w}Z")` : '';
  }
  function track() { if (!open) return; place(); raf = requestAnimationFrame(track); }

  function start(at = 0) {
    if (LS.info.isOpen()) LS.info.hide();
    lastFocus = document.activeElement;
    index = at;
    lastKey = '';
    root.hidden = false;
    root.classList.add('instant');
    open = true;
    render();
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('instant')));
    cardSpring.onRest = null;
    cardSpring.to(1);
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(track);
  }
  /** `finished` is true when the user reached the last card; leaving earlier mentions practice is still on. */
  function close(finished = false) {
    if (!open) return;
    open = false;
    token++;
    setBusy(false);
    LS.store.set('tourSeen', true);
    cancelAnimationFrame(raf);
    LS.device.close();
    cardSpring.onRest = () => { if (!open) root.hidden = true; };
    cardSpring.to(0);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    if (!finished && index > 0 && LS.practising()) LS.toast('status', 'Practice mode is still on · end it from the device pill', 4000);
  }
  function go(delta) {
    let next = index + delta;
    while (next > 0 && next < STEPS.length - 1 && STEPS[next].skip && STEPS[next].skip()) next += delta;
    if (next < 0 || next >= STEPS.length) { close(next >= STEPS.length); return; }
    index = next;
    render();
  }
  async function onNext() {
    if (busy) return;
    const step = STEPS[index];
    if (step.action) {
      const my = token;
      setBusy(true, step.busyLabel || 'Working…');
      let res;
      try { res = await step.action(); } catch (e) { res = { error: e.message || 'Something went wrong' }; }
      if (!open || my !== token) return;
      setBusy(false);
      if (res && res.error) { showError(res.error); return; }
    }
    go(1);
  }

  $('tour-next').addEventListener('click', onNext);
  $('tour-back').addEventListener('click', () => { if (!busy) go(-1); });
  $('btn-tour').addEventListener('click', () => start(0));
  window.addEventListener('keydown', (e) => {
    if (!open) return;
    // Let typing and keys through to the controls of an interactive step (e.g. the off-course distance).
    const inTarget = STEPS[index].interactive && target && target.contains(e.target);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (inTarget) { /* leave it to the control */ }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); if (!busy) onNext(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); if (!busy) go(-1); }
    else if (e.key === 'Tab') {
      const f = [...card.querySelectorAll('button')].filter((b) => !b.hidden && !b.disabled);
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    } else if (!card.contains(e.target)) { e.stopPropagation(); }
  }, true);
  window.addEventListener('resize', () => { lastKey = ''; });

  LS.tour = { start, close, isOpen: () => open, seen: () => !!LS.store.get('tourSeen', false) };
})();
