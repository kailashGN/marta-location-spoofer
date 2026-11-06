/* First-run tour: a spotlight on each part of the UI with a short card. Replay from the ? button. */
(() => {
  'use strict';
  const LS = window.LS;
  const { $ } = LS;

  const shown = (el) => !!el && el.getClientRects().length > 0 && !el.closest('[hidden]');
  const firstShown = (...els) => els.find(shown) || null;
  const tripRunning = () => !!LS.activeRoute();

  const STEPS = [
    {
      title: 'Welcome to Location Spoofer',
      body: () => `<p>It moves your test phone’s GPS from this Mac, so you can take a MARTA live trip without leaving your desk: walk it, go off course, miss the train, lose GPS, arrive.</p>
        <p>This tour takes about two minutes. Replay it any time from the <b>?</b> button at the top.</p>`,
      next: 'Start the tour', back: 'Not now',
    },
    {
      title: 'Connect a phone',
      before: () => LS.device.show(),
      target: () => $('device-pop'),
      body: () => `<p>Plug the iPhone or Android phone into this Mac with a USB cable, then press <b>Connect</b>. The pill at the top always shows what the phone is doing.</p>
        <p>No phone handy? <b>Practice with a demo phone</b> works exactly the same and sends nothing anywhere.</p>`,
    },
    {
      title: 'Find a place',
      before: () => LS.device.close(),
      target: () => document.querySelector('.search'),
      body: () => '<p>Search for an address or paste <b>lat, lon</b>. You can also click anywhere on the map to drop the pin.</p>',
    },
    {
      title: 'Put the phone somewhere',
      before: () => LS.tabs.show('place'),
      target: () => $('panel-place').querySelector('.card'),
      body: () => `<p><b>Set Location</b> sends the pin to the phone, and every app on it sees that location. <b>Stop Simulating</b> gives the phone its real GPS back.</p>
        <p>Use this for checks that don’t need a trip, such as the map or the planner’s current location.</p>`,
    },
    {
      title: 'Replay a MARTA trip',
      before: () => LS.tabs.show('trip'),
      target: () => (tripRunning() ? $('trip-live') : firstShown($('trip-summary'), $('dropzone'))),
      body: () => `<ol>
          <li>Start the trip in MARTA Dev.</li>
          <li>Secret menu › <b>Download GPX</b>, and get the file onto this Mac (AirDrop works).</li>
          <li>Drop it here and press <b>Start trip</b>.</li>
        </ol>
        <p>The pin follows the trip’s own timetable: the walks, the wait at the stop and the ride.</p>
        ${LS.practising() ? '<p class="tour-note">In practice mode, <b>Load the practice trip</b> gives you a ready-made one.</p>' : ''}`,
    },
    {
      title: 'Choose how it plays',
      before: () => LS.tabs.show('trip'),
      target: () => (tripRunning() ? null : firstShown($('trip-summary'))),
      body: () => `<ul>
          <li><b>Start walking now</b>: walk to the first stop straight away and wait there, instead of standing still until the leave-by time.</li>
          <li><b>Speed</b>: keep <b>1×</b> for anything about timings. MARTA runs on the real clock.</li>
        </ul>
        ${shown($('trip-summary')) ? '' : '<p class="tour-note">These options appear once a GPX is loaded.</p>'}`,
    },
    {
      title: 'Watch the trip',
      before: () => LS.tabs.show('trip'),
      target: () => firstShown(document.querySelector('#trip-live .live-card')),
      body: () => `<p>Shows what the rider is doing: walking, waiting at the stop, on the bus or train, arrived. Chips flag anything you changed, such as off course or GPS frozen.</p>
        <p><b>Hold</b> (Space) keeps the rider in place while the trip clock runs. <b>Stop trip</b> ends the playback.</p>
        ${tripRunning() ? '' : '<p class="tour-note">This panel replaces the setup once a trip is running.</p>'}`,
    },
    {
      title: 'Break things on purpose',
      before: () => LS.tabs.show(tripRunning() || !LS.simulating() ? 'trip' : 'place'),
      target: () => firstShown($('tools')),
      body: () => `<ul>
          <li><b>Off course</b>: move any distance from the route, at once or gradually.</li>
          <li><b>Pace</b>: walk slower or faster than planned.</li>
          <li><b>GPS signal</b>: freeze it, lose it, or add noise.</li>
          <li><b>Activity log</b>: everything that happened, with times. Copy it into a ticket.</li>
        </ul>
        ${shown($('tools')) ? '' : '<p class="tour-note">These tools appear under a running trip, and under Place once a location is set.</p>'}`,
    },
    {
      title: 'Know the rules',
      target: () => $('btn-rules'),
      body: () => `<p>Every tool has an <b>(i)</b> button that explains how it works.</p>
        <p><b>MARTA rules</b> lists every threshold the app uses, such as off course past 500 m for 30 s or GPS lost after 20 s, with how to trigger each one here.</p>`,
    },
    {
      title: 'Follow a recipe',
      target: () => $('btn-scenarios'),
      body: () => `<p><b>Test scenarios</b> are step-by-step checks, each with the result to expect. <b>Set up</b> on a recipe opens the right tool with the values filled in.</p>
        <p>Start with “Off course past 500 m”.</p>`,
    },
    {
      title: 'You’re set',
      body: () => `<p>Replay this tour any time from <b>?</b>.</p>
        ${LS.connected() ? '' : '<p>To try everything without a phone, start practice mode now. It loads a sample trip from the State Capitol to Midtown.</p>'}`,
      next: 'Done',
      extra: () => (LS.connected() ? null : { label: 'Try practice mode', run: () => LS.device.startPractice() }),
    },
  ];

  // ------------------------------------------------------------------ DOM
  const root = document.createElement('div');
  root.className = 'tour';
  root.hidden = true;
  root.innerHTML = `<div class="tour-spot none"></div>
    <div class="tour-card material-solid" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <p class="tour-count" id="tour-count"></p>
      <h3 id="tour-title"></h3>
      <div class="tour-body" id="tour-body"></div>
      <div class="tour-foot">
        <div class="tour-dots" aria-hidden="true">${STEPS.map(() => '<span></span>').join('')}</div>
        <button class="btn btn-quiet btn-sm" id="tour-back" type="button"></button>
        <button class="btn btn-secondary btn-sm" id="tour-next" type="button"></button>
        <button class="btn btn-sm" id="tour-extra" type="button" hidden></button>
      </div>
    </div>`;
  $('app').appendChild(root);
  const spot = root.querySelector('.tour-spot');
  const card = root.querySelector('.tour-card');
  const dots = [...root.querySelectorAll('.tour-dots span')];

  let open = false;
  let index = 0;
  let raf = 0;
  let lastFocus = null;
  const cardSpring = new Spring({ value: 0, response: 0.3, damping: 1, onUpdate: (v) => {
    card.style.opacity = String(v);
    card.style.scale = String(0.96 + 0.04 * v);
  } });

  function render() {
    const step = STEPS[index];
    if (step.before) step.before();
    $('tour-count').textContent = index === 0 || index === STEPS.length - 1 ? '' : `${index} of ${STEPS.length - 2}`;
    $('tour-count').hidden = !$('tour-count').textContent;
    $('tour-title').textContent = step.title;
    $('tour-body').innerHTML = step.body();
    $('tour-next').textContent = step.next || 'Next';
    $('tour-back').textContent = step.back || 'Back';
    const extra = step.extra && step.extra();
    $('tour-extra').hidden = !extra;
    $('tour-back').hidden = !!extra;
    root.querySelector('.tour-dots').style.visibility = extra ? 'hidden' : '';
    root.querySelector('.tour-dots').style.flex = extra ? '1 1 0' : '';
    root.querySelector('.tour-dots').style.minWidth = '0';
    $('tour-extra').classList.toggle('btn-primary', !!extra);
    $('tour-next').classList.toggle('btn-primary', !extra);
    $('tour-next').classList.toggle('btn-secondary', !!extra);
    if (extra) { $('tour-extra').textContent = extra.label; $('tour-extra').onclick = () => { close(); extra.run(); }; }
    dots.forEach((d, i) => d.classList.toggle('on', i === index));
    // The layout may change after `before` (tab switch, popover); place on the next frame.
    requestAnimationFrame(() => { place(); $('tour-next').focus(); });
  }

  let lastKey = '';
  function place() {
    const step = STEPS[index];
    const el = step.target && step.target();
    const W = window.innerWidth, H = window.innerHeight;
    const cw = card.offsetWidth, ch = card.offsetHeight;
    let spotRect, x, y;
    if (el && shown(el)) {
      const r = el.getBoundingClientRect();
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
      else { x = (W - cw) / 2; y = (H - ch) / 2; }
      spot.classList.remove('none');
    } else {
      spotRect = { left: W / 2, top: H / 2, width: 0, height: 0 };
      x = (W - cw) / 2; y = (H - ch) / 2;
      spot.classList.add('none');
    }
    x = Math.max(16, Math.min(W - cw - 16, x));
    y = Math.max(16, Math.min(H - ch - 16, y));
    const key = [spotRect.left, spotRect.top, spotRect.width, spotRect.height, x, y].map(Math.round).join();
    if (key === lastKey) return;
    lastKey = key;
    Object.assign(spot.style, { left: `${spotRect.left}px`, top: `${spotRect.top}px`, width: `${spotRect.width}px`, height: `${spotRect.height}px` });
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
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
  function close() {
    if (!open) return;
    open = false;
    LS.store.set('tourSeen', true);
    cancelAnimationFrame(raf);
    LS.device.close();
    cardSpring.onRest = () => { if (!open) root.hidden = true; };
    cardSpring.to(0);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function go(delta) {
    const next = index + delta;
    if (next < 0 || next >= STEPS.length) { close(); return; }
    index = next;
    render();
  }

  $('tour-next').addEventListener('click', () => go(1));
  $('tour-back').addEventListener('click', () => go(-1));
  $('btn-tour').addEventListener('click', () => start(0));
  window.addEventListener('keydown', (e) => {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); go(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(-1); }
    else if (e.key === 'Tab') {
      const f = [...card.querySelectorAll('button')].filter((b) => !b.hidden);
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    } else if (!card.contains(e.target)) { e.stopPropagation(); }
  }, true);
  window.addEventListener('resize', () => { lastKey = ''; });

  LS.tour = { start, close, isOpen: () => open, seen: () => !!LS.store.get('tourSeen', false) };
})();
