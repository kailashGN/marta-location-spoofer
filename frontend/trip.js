/* Tabs + Trip tab: load or draw a route, summary, options, Start; live status while it runs. */
(() => {
  'use strict';
  const LS = window.LS;
  const { $, state, api, esc } = LS;
  const R = state.route;

  // ------------------------------------------------------------------ tabs
  const tabSeg = LS.seg($('tabs'), {
    attr: 'aria-selected',
    onChange: (b) => show(b.id === 'tab-trip' ? 'trip' : 'place'),
  });
  function show(name) {
    state.tab = name;
    tabSeg.select(name === 'trip' ? $('tab-trip') : $('tab-place'));
    $('panel-place').hidden = name !== 'place';
    $('panel-trip').hidden = name !== 'trip';
    LS.store.set('tab', name);
    LS.render();
  }
  LS.tabs = { show };
  show(LS.store.get('tab', 'place'));

  // ------------------------------------------------------------------ GPX parsing (browser side, for the summary)
  function parseGpx(text, name) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('That file is not valid GPX');
    const nodes = [...doc.querySelectorAll('trkpt, rtept')];
    const pts = nodes.map((n) => ({ lat: +n.getAttribute('lat'), lon: +n.getAttribute('lon') }));
    if (pts.length < 2) throw new Error('GPX has fewer than two points');
    const times = nodes.map((n) => { const t = n.querySelector('time'); return t ? Date.parse(t.textContent.trim()) / 1000 : NaN; });
    const hasTimes = times.every((t) => Number.isFinite(t));
    const tags = nodes.map((n) => { const c = n.querySelector('cmt'); const v = c && c.textContent.trim(); return v === 'rider' || v === 'transit' ? v : null; });
    const tagged = tags.some((t) => t);

    // Runs of the same leg, sharing boundary points so the drawn line is continuous.
    const runs = [];
    if (tagged) {
      tags.forEach((leg, i) => {
        const l = leg === 'transit' ? 'transit' : 'rider';
        if (runs.length && runs[runs.length - 1].leg === l) runs[runs.length - 1].end = i;
        else runs.push({ leg: l, start: runs.length ? runs[runs.length - 1].end : 0, end: i });
      });
    }
    runs.forEach((r) => {
      let moving = 0, metres = 0;
      for (let i = r.start; i < r.end; i++) {
        const d = LS.hav(pts[i], pts[i + 1]);
        metres += d;
        const dt = hasTimes ? Math.max(0, times[i + 1] - times[i]) : 0;
        if (hasTimes && (r.leg === 'transit' || (d > 1 && d / (dt || 1) >= 0.5))) moving += dt;
      }
      r.seconds = moving; r.metres = metres;
    });

    let firstMove = null;
    if (hasTimes) {
      // First real walking step; a crawl under 0.5 m/s is the wait before leave-by.
      for (let i = 0; i < pts.length - 1; i++) {
        const d = LS.hav(pts[i], pts[i + 1]), dt = times[i + 1] - times[i];
        if (d > 1 && (dt <= 0 || d / dt >= 0.5)) { firstMove = times[i]; break; }
      }
    }
    return {
      name: name || 'Trip',
      text,
      pts,
      hasTimes,
      runs,
      startsWalking: tags[0] === 'rider',
      first: hasTimes ? times[0] : null,
      firstMove,
      end: hasTimes ? times[times.length - 1] : null,
      length: LS.routeLength(pts),
    };
  }

  async function loadFile(file) {
    if (!file) return;
    await loadText(await file.text(), file.name);
  }
  async function loadText(text, fileName) {
    try {
      const gpx = parseGpx(text, fileName.replace(/\.gpx$/i, ''));
      R.gpx = gpx;
      R.waypoints = gpx.pts;
      R.drawing = false;
      $('route-gpx-times').checked = gpx.hasTimes;
      $('route-walk-ahead').checked = false;
      LS.map.drawRoute(gpx.pts, gpx.runs, { fit: true });
      show('trip');
      LS.toast('done', `Loaded ${fileName}${gpx.hasTimes ? ' · timestamps detected' : ''}`);
    } catch (err) { LS.toast('error', err.message); }
  }
  async function loadSample() {
    try {
      const res = await fetch('/api/demo/sample.gpx');
      if (!res.ok) throw new Error('Could not load the practice trip');
      await loadText(await res.text(), 'Practice trip');
      R.gpx.sample = true;
      $('route-walk-ahead').checked = false;
      LS.render();
    } catch (e) { LS.toast('error', e.message); }
  }
  $('btn-sample').addEventListener('click', loadSample);
  $('gpx-file').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });

  // Drag a .gpx anywhere onto the window.
  const dz = $('dropzone');
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; dz.classList.add('over'); if (!LS.activeRoute()) show('trip'); });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dz.classList.remove('over'); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; dz.classList.remove('over');
    if (LS.activeRoute()) { LS.toast('warn', 'Stop the running trip before loading another'); return; }
    loadFile(e.dataTransfer.files[0]);
  });

  // ------------------------------------------------------------------ drawing
  function setDrawing(on) {
    R.drawing = on;
    $('map').classList.toggle('route-mode', on);
    $('btn-route-mode').setAttribute('aria-pressed', String(on));
    if (on) {
      if (R.gpx) { R.gpx = null; R.waypoints = []; }
      show('trip');
    }
    redrawPlan();
    LS.render();
  }
  function addWaypoint(lat, lon) {
    R.gpx = null;
    R.waypoints.push({ lat, lon });
    redrawPlan();
    LS.render();
  }
  function clearPlan() {
    R.gpx = null; R.waypoints = []; R.drawing = false;
    $('map').classList.remove('route-mode');
    $('btn-route-mode').setAttribute('aria-pressed', 'false');
    LS.map.clearRoute();
    LS.render();
  }
  function redrawPlan() {
    if (LS.activeRoute()) return;
    if (R.gpx) LS.map.drawRoute(R.gpx.pts, R.gpx.runs);
    else LS.map.drawRoute(R.waypoints, null, { showWaypoints: true });
  }
  $('btn-route-mode').addEventListener('click', () => setDrawing(!R.drawing));
  $('btn-draw-done').addEventListener('click', () => setDrawing(false));
  $('btn-draw-undo').addEventListener('click', () => { R.waypoints.pop(); redrawPlan(); LS.render(); });
  $('btn-route-clear').addEventListener('click', clearPlan);

  // ------------------------------------------------------------------ options
  const scaleSeg = LS.seg($('scale-seg'), {
    onChange: (b) => { R.scale = parseFloat(b.dataset.scale); $('route-time-scale').value = R.scale; LS.render(); },
  });
  const speedSeg = LS.seg($('speed-seg'), {
    onChange: (b) => { R.speed = parseFloat(b.dataset.speed); LS.render(); },
  });
  $('route-time-scale').addEventListener('input', () => {
    const v = Math.max(0.1, Math.min(500, parseFloat($('route-time-scale').value) || 1));
    R.scale = v;
    if (!scaleSeg.selectBy('scale', v)) scaleSeg.clear();
    LS.render();
  });
  $('route-gpx-times').addEventListener('change', () => LS.render());
  $('route-walk-ahead').addEventListener('change', () => LS.render());

  const useTimes = () => !!(R.gpx && R.gpx.hasTimes && $('route-gpx-times').checked);
  const useWalkAhead = () => useTimes() && R.gpx.startsWalking && $('route-walk-ahead').checked;

  function setWalkAhead(on) {
    if (LS.activeRoute()) { LS.toast('warn', 'Stop the running trip, then set this up before Start'); return false; }
    if (!(R.gpx && R.gpx.startsWalking && useTimes())) { LS.toast('warn', 'Load a GPX that starts with a walk first'); show('trip'); return false; }
    $('route-walk-ahead').checked = on;
    show('trip');
    LS.render();
    return $('opt-walk-wrap');
  }

  function startStatus(g) {
    if (!g || !g.hasTimes) return { text: '', over: false };
    const now = Date.now() / 1000;
    if (now > g.end) return { text: 'This trip is already over. Export a new one, or turn off timestamps.', over: true };
    const leave = g.firstMove ?? g.first;
    if (leave > now) {
      const wait = `Leave-by in ${LS.fmtMin(leave - now)}`;
      if (!g.startsWalking) return { text: wait, over: false };
      return { text: useWalkAhead() ? `${wait} · you’ll walk now and wait at the stop` : `${wait} · turn on Start walking now to go early`, over: false };
    }
    return { text: `In progress · started ${LS.fmtMin(now - leave)} ago · playback joins at the current time`, over: false };
  }

  function renderSetup() {
    const g = R.gpx;
    const hasPlan = R.waypoints.length >= 2;
    $('trip-drawing').hidden = !R.drawing;
    $('draw-count').textContent = `${R.waypoints.length} point${R.waypoints.length === 1 ? '' : 's'}`;
    $('dropzone').hidden = R.drawing || hasPlan;
    $('btn-route-mode').hidden = R.drawing || hasPlan;
    $('btn-sample').hidden = R.drawing || hasPlan || !LS.practising();
    $('trip-summary').hidden = R.drawing || !hasPlan;

    if (hasPlan && !R.drawing) {
      $('sum-name').textContent = g ? g.name : 'Drawn route';
      const dur = g && g.hasTimes ? ` · ${LS.fmtMin(g.end - (g.firstMove ?? g.first))}` : '';
      $('sum-meta').textContent = `${LS.fmtDist(g ? g.length : LS.routeLength(R.waypoints))}${dur}${g ? '' : ` · ${R.waypoints.length} points`}`;
      $('sum-legs').innerHTML = g && g.runs.length
        ? g.runs.map((r) => `<span class="leg-chip ${r.leg}">${r.leg === 'transit' ? 'Ride' : 'Walk'} ${r.seconds ? LS.fmtMin(r.seconds) : LS.fmtDist(r.metres)}</span>`).join('<span class="leg-sep" aria-hidden="true">›</span>')
        : '';
      $('sum-legs').hidden = !(g && g.runs.length);
      const s = startStatus(g);
      $('sum-start').textContent = useTimes() ? s.text : '';
      $('sum-start').classList.toggle('warn-text', useTimes() && s.over);

      $('opt-times-wrap').hidden = !(g && g.hasTimes);
      $('opt-walk-wrap').hidden = !(useTimes() && g.startsWalking);
      $('opt-scale-wrap').hidden = !useTimes();
      $('opt-custom-wrap').hidden = !useTimes();
      $('opt-mode-wrap').hidden = useTimes();
      if (!$('opt-scale-wrap').hidden) scaleSeg.sync(false);
      if (!$('opt-mode-wrap').hidden) speedSeg.sync(false);
    }

    const btn = $('btn-route-play');
    btn.hidden = R.drawing;
    const over = useTimes() && startStatus(g).over;
    btn.disabled = !LS.connected() || !hasPlan || over;
    btn.textContent = !LS.connected() ? 'Connect a phone to start'
      : !hasPlan ? 'Load or draw a route'
      : useWalkAhead() ? 'Start trip · walk now'
      : useTimes() && R.scale !== 1 ? `Start trip · ${LS.fmtX(R.scale)}` : 'Start trip';
  }

  async function start() {
    if (R.waypoints.length < 2) return;
    state.lastAction = start;
    await LS.busy($('btn-route-play'), async () => {
      try {
        const loop = $('route-loop').checked;
        let st;
        if (R.gpx && R.gpx.sample) {
          // Re-time the practice trip so it starts walking the moment Start is pressed.
          const res = await fetch('/api/demo/sample.gpx');
          if (res.ok) R.gpx.text = await res.text();
        }
        if (useTimes()) {
          st = await api.post('/api/route/gpx', {
            gpx: R.gpx.text, speed_mps: R.speed, loop, use_gpx_times: true,
            time_scale: R.scale, walk_ahead: useWalkAhead(),
          });
        } else if (R.gpx) {
          st = await api.post('/api/route/gpx', { gpx: R.gpx.text, speed_mps: R.speed, loop, use_gpx_times: false });
        } else {
          st = await api.post('/api/route', { points: R.waypoints, speed_mps: R.speed, loop });
        }
        R.started = { at: Date.now() / 1000, scale: useTimes() ? R.scale : 1, speed: R.speed, loop };
        LS.applyStatus(st);
        LS.toast('status', useWalkAhead() ? 'Trip started · walking to the stop now' : 'Trip started');
      } catch (e) { LS.handleError(e, start); }
    });
  }
  $('btn-route-play').addEventListener('click', start);

  // ------------------------------------------------------------------ live
  const ICONS = {
    walk: '<svg viewBox="0 0 24 24"><circle cx="13" cy="4.5" r="2" fill="currentColor"/><path d="M10 21l2-6 2.5 2.5V21M8 12l2-4 3 1 2 3 2.5 1M10 8l-1.5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    ride: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5 10h14M8.5 20l1.5-3m5.5 3-1.5-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="9" cy="13.5" r="1" fill="currentColor"/><circle cx="15" cy="13.5" r="1" fill="currentColor"/></svg>',
    wait: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 8v4l3 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    hold: '<svg viewBox="0 0 24 24"><rect x="7" y="6" width="3.5" height="12" rx="1" fill="currentColor"/><rect x="13.5" y="6" width="3.5" height="12" rx="1" fill="currentColor"/></svg>',
    done: '<svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    move: '<svg viewBox="0 0 24 24"><path d="M12 3l6 16-6-4-6 4z" fill="currentColor"/></svg>',
  };

  /** Seconds until the schedule's first walking step, while the pin still waits at the start; else null. */
  function leaveIn(r) {
    const g = R.gpx, s = R.started;
    if (!g || !s || !g.startsWalking || g.firstMove == null) return null;
    if (r.timing !== 'gpx' || r.walk_ahead || r.finished || r.leg !== 'rider') return null;
    const now = Date.now() / 1000;
    const left = (g.firstMove - s.at) / s.scale - (now - s.at);
    return left > 5 ? left : null;
  }

  // Mid-trip version of the setup toggle: restart the same trip, walking to the stop now.
  async function walkNow() {
    const r = LS.activeRoute();
    if (!r || !R.gpx || !R.started || leaveIn(r) == null) return;
    await LS.busy($('btn-walk-now'), async () => {
      try {
        const st = await api.post('/api/route/gpx', {
          gpx: R.gpx.text, speed_mps: R.started.speed, loop: R.started.loop, use_gpx_times: true,
          time_scale: R.started.scale, walk_ahead: true,
        });
        $('route-walk-ahead').checked = true;
        LS.applyStatus(st);
        LS.toast('status', 'Walking to the stop now');
      } catch (e) { LS.handleError(e); }
    });
  }
  $('btn-walk-now').addEventListener('click', walkNow);

  function renderLive() {
    const st = state.status;
    const r = LS.activeRoute();
    if (!r) return;
    const waitLeave = leaveIn(r);
    $('btn-walk-now').hidden = waitLeave == null;
    let icon = 'move', title = 'Moving', sub = '', tone = '';
    if (r.finished) { icon = 'done'; title = 'Arrived'; sub = 'Route finished · holding at the destination'; tone = 'ok'; }
    else if (r.paused) { icon = 'hold'; title = 'Holding position'; sub = 'The trip clock keeps running'; tone = 'warn'; }
    else if (waitLeave != null) { icon = 'wait'; title = 'Waiting to leave'; sub = `Leave-by in ${LS.fmtTime(waitLeave)} · or start walking now`; }
    else if (r.hold_s != null) { icon = 'wait'; title = 'Waiting at the stop'; sub = `Departs in ${LS.fmtTime(r.hold_s)}`; }
    else if (r.timing === 'gpx' && r.leg === 'transit') { icon = 'ride'; title = 'On the bus or train'; sub = 'Following the timetable'; }
    else if (r.timing === 'gpx') { icon = 'walk'; title = 'Walking'; sub = r.pace_factor !== 1 ? `Pace ${LS.fmtX(r.pace_factor)}` : 'Following the GPX schedule'; }
    else { title = 'Moving'; sub = `${LS.fmtDist(r.speed_mps * 60)} per minute`; }
    $('live-icon').innerHTML = ICONS[icon];
    $('live-icon').className = `leg-icon ${tone}`;
    $('live-title').textContent = title;
    $('live-sub').textContent = sub;

    const chips = [];
    const o = st.offset;
    if (o && (o.current_m > 0 || o.ramping)) {
      const side = o.side ? ` ${o.side}` : '';
      chips.push(o.ramping
        ? `<span class="chip chip-warn">Drifting · ${Math.round(o.current_m)} → ${Math.round(o.target_m)} m${side}</span>`
        : `<span class="chip ${o.current_m > LS.MARTA.OFF_COURSE_M ? 'chip-bad' : 'chip-warn'}">Off course · ${Math.round(o.current_m)} m${side}</span>`);
    }
    if (st.link && !st.link.ok) chips.push(`<span class="chip chip-bad" title="${LS.esc(st.link.error)}">Phone not getting updates · retrying</span>`);
    if (st.gps && st.gps.mode === 'frozen') chips.push('<span class="chip chip-bad">GPS frozen</span>');
    if (st.gps && st.gps.mode === 'lost') chips.push('<span class="chip chip-bad">Lost signal</span>');
    if (st.gps && st.gps.jitter_m > 0) chips.push(`<span class="chip chip-warn">Jitter ±${st.gps.jitter_m} m</span>`);
    if (r.walk_ahead && !r.finished) chips.push('<span class="chip">Walked ahead</span>');
    $('live-chips').innerHTML = chips.join('');
    $('live-chips').hidden = !chips.length;

    $('route-bar').style.width = `${Math.round(r.progress * 100)}%`;
    $('route-text').textContent = `${LS.fmtDist(r.travelled_m ?? r.progress * r.total_m)} of ${LS.fmtDist(r.total_m)}`;
    const remaining = r.timing === 'gpx' && r.remaining_s != null ? r.remaining_s : (1 - r.progress) * r.total_m / r.speed_mps;
    $('route-eta').textContent = r.finished ? 'Done' : `${LS.fmtTime(remaining)} left`;
    $('btn-route-pause').textContent = r.paused ? 'Resume' : 'Hold';
    $('btn-route-pause').setAttribute('aria-pressed', String(!!r.paused));
    $('btn-route-pause').disabled = !!r.finished;
  }

  let hadRoute = false;
  function render() {
    const r = LS.activeRoute();
    if (r && !hadRoute) show('trip');
    if (!r && hadRoute) redrawPlan();
    hadRoute = !!r;
    $('trip-setup').hidden = !!r;
    $('trip-live').hidden = !r;
    $('trip-dot').hidden = !r || state.tab === 'trip';
    if (r) renderLive(); else renderSetup();
  }
  LS.onRender(render);

  async function togglePause() {
    const r = LS.activeRoute(); if (!r || r.finished) return;
    try { LS.applyStatus(await api.post('/api/route/pause', { paused: !r.paused })); } catch (e) { LS.handleError(e); }
  }
  async function stop() {
    try { LS.applyStatus(await api.del('/api/route')); LS.toast('done', 'Trip stopped · holding the last position'); } catch (e) { LS.handleError(e); }
  }
  $('btn-route-pause').addEventListener('click', togglePause);
  $('btn-route-stop').addEventListener('click', stop);

  /** Practice is over: drop the practice trip so it doesn't stay on screen. */
  function clearSample() {
    if (R.gpx && R.gpx.sample) clearPlan();
  }
  LS.trip = { addWaypoint, redrawPlan, togglePause, show, loadSample, setWalkAhead, clearSample, start, hasPlan: () => R.waypoints.length >= 2 };
})();
