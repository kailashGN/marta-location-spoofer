/* Test tools: off course (jump or drift), pace, GPS signal (frozen / lost / jitter), activity log. */
(() => {
  'use strict';
  const LS = window.LS;
  const { $, state, api, esc } = LS;
  const tools = $('tools');

  // ------------------------------------------------------------------ placement + accordion
  function place() {
    const r = LS.activeRoute();
    const slot = r ? $('tools-slot-trip') : LS.simulating() ? $('tools-slot-place') : null;
    tools.hidden = !slot;
    if (slot && tools.parentElement !== slot) slot.appendChild(tools);
    $('tool-pace').hidden = !r;
  }
  const details = [...tools.querySelectorAll('details.tool')];
  details.forEach((d) => d.addEventListener('toggle', () => {
    if (d.open) {
      details.forEach((o) => { if (o !== d) o.open = false; });
      LS.store.set('tool', d.id);
      requestAnimationFrame(() => { segs.forEach((s) => s.sync(false)); });
    } else if (LS.store.get('tool') === d.id) {
      LS.store.set('tool', null);
    }
  }));
  const openTool = LS.store.get('tool', 'tool-offset');
  if (openTool && $(openTool)) $(openTool).open = true;

  // ------------------------------------------------------------------ off course
  const OFF = LS.MARTA.OFF_COURSE_M;
  const prefs = LS.store.get('offset', { m: 1000, side: 'right', move: 'jump', ramp: 60 });
  $('off-m').value = prefs.m;
  $('off-ramp').value = prefs.ramp;
  const sideSeg = LS.seg($('off-side'), { onChange: (b) => { prefs.side = b.dataset.v; save(); } });
  const moveSeg = LS.seg($('off-move'), { onChange: (b) => { prefs.move = b.dataset.v; save(); LS.render(); } });
  sideSeg.selectBy('v', prefs.side, false);
  moveSeg.selectBy('v', prefs.move, false);
  function save() {
    prefs.m = clamp(parseFloat($('off-m').value), 0, 5000, 1000);
    prefs.ramp = clamp(parseFloat($('off-ramp').value), 1, 600, 60);
    LS.store.set('offset', prefs);
    renderPresets();
  }
  const clamp = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  function renderPresets() {
    $('off-presets').querySelectorAll('.preset').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.m === prefs.m)));
  }
  $('off-m').addEventListener('input', save);
  $('off-ramp').addEventListener('input', save);
  $('off-presets').addEventListener('click', (e) => {
    const b = e.target.closest('.preset'); if (!b) return;
    $('off-m').value = b.dataset.m; save();
  });
  renderPresets();

  async function goOff() {
    save();
    if (prefs.m <= 0) { LS.toast('warn', 'Enter a distance above 0 m'); return; }
    const ramp_s = prefs.move === 'drift' ? prefs.ramp : 0;
    await LS.busy($('btn-off-go'), async () => {
      try {
        LS.applyStatus(await api.post('/api/offset', { side: prefs.side, meters: prefs.m, ramp_s }));
        const from = LS.activeRoute() ? 'the route' : 'the pin';
        LS.toast('status', ramp_s ? `Drifting ${prefs.m} m ${prefs.side} over ${ramp_s} s` : `Moved ${prefs.m} m ${prefs.side} of ${from}`);
      } catch (e) { LS.handleError(e); }
    });
  }
  async function backOn() {
    save();
    const ramp_s = prefs.move === 'drift' ? prefs.ramp : 0;
    await LS.busy($('btn-off-back'), async () => {
      try {
        LS.applyStatus(await api.post('/api/offset', { side: 'none', meters: 0, ramp_s }));
        LS.toast('status', ramp_s ? `Drifting back over ${ramp_s} s` : 'Back on course');
      } catch (e) { LS.handleError(e); }
    });
  }
  $('btn-off-go').addEventListener('click', goOff);
  $('btn-off-back').addEventListener('click', backOn);

  function renderOffset(st) {
    const o = st.offset || {};
    $('off-ramp-wrap').hidden = prefs.move !== 'drift';
    $('btn-off-go').textContent = prefs.move === 'drift' ? 'Drift off course' : 'Go off course';
    $('btn-off-back').textContent = prefs.move === 'drift' ? 'Drift back' : 'Back on course';
    $('btn-off-back').disabled = !(o.current_m > 0 || o.ramping);
    const away = st.away_m != null ? Math.round(st.away_m) : null;
    let text = 'On course';
    let cls = '';
    if (o.ramping) {
      text = `Drifting · now ${Math.round(o.current_m)} m from the route · ${Math.ceil(o.ramp_left_s)} s to ${Math.round(o.target_m)} m`;
      cls = o.current_m > OFF ? 'bad' : 'warn';
    } else if (o.current_m > 0) {
      text = o.current_m > OFF
        ? `${Math.round(o.current_m)} m ${o.side} · past ${OFF} m, MARTA shows the off-course card after 30 s`
        : `${Math.round(o.current_m)} m ${o.side} · inside ${OFF} m, no off-course card`;
      cls = o.current_m > OFF ? 'bad' : 'warn';
    } else if (away && away > 3) {
      text = `On course · jitter puts the fix ${away} m away`;
    }
    $('off-readout').textContent = text;
    $('off-readout').className = `readout ${cls}`;
    $('tv-offset').textContent = o.ramping ? `Drifting ${Math.round(o.current_m)} m` : o.current_m > 0 ? `${Math.round(o.current_m)} m ${o.side}` : 'On course';
    $('tv-offset').className = `tool-value ${o.current_m > OFF ? 'bad' : o.current_m > 0 ? 'warn' : ''}`;
  }

  // ------------------------------------------------------------------ pace
  let paceEditing = false;
  const paceOut = (v) => { $('pace-out').textContent = LS.fmtX(v); };
  $('pace').addEventListener('pointerdown', () => { paceEditing = true; });
  $('pace').addEventListener('input', () => { paceEditing = true; paceOut(+$('pace').value); });
  $('pace').addEventListener('change', () => setPace(+$('pace').value));
  $('pace-presets').addEventListener('click', (e) => {
    const b = e.target.closest('.preset'); if (!b) return;
    $('pace').value = b.dataset.p; paceOut(+b.dataset.p); setPace(+b.dataset.p);
  });
  async function setPace(f) {
    try { LS.applyStatus(await api.post('/api/route/pace', { factor: f })); }
    catch (e) { LS.handleError(e); }
    finally { paceEditing = false; }
  }
  function renderPace(r) {
    if (!r) return;
    const f = r.pace_factor ?? 1;
    if (!paceEditing) { $('pace').value = f; paceOut(f); }
    $('pace-presets').querySelectorAll('.preset').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.p === f)));
    $('tv-pace').textContent = LS.fmtX(f);
    $('tv-pace').className = `tool-value ${f !== 1 ? 'warn' : ''}`;
    $('pace-rule').textContent = r.leg === 'transit' && r.timing === 'gpx'
      ? 'On the bus or train now: the ride keeps to the timetable. Pace applies from the next walk.'
      : 'Walking legs only. A slow walk triggers MARTA’s “can’t make it” switch after 30 s.';
  }

  // ------------------------------------------------------------------ GPS signal
  let gpsPending = false;
  const gpsSeg = LS.seg($('gps-mode'), { onChange: (b) => setGps(b.dataset.v, +$('jitter').value) });
  const jitterOut = (v) => { $('jitter-out').textContent = v ? `±${v} m` : 'Off'; };
  $('jitter').addEventListener('input', () => jitterOut(+$('jitter').value));
  $('jitter').addEventListener('change', () => setGps(gpsSeg.selected()?.dataset.v || 'normal', +$('jitter').value));
  async function setGps(mode, jitter_m) {
    gpsPending = true;
    try {
      LS.applyStatus(await api.post('/api/gps', { mode, jitter_m }));
      if (mode === 'frozen') LS.toast('warn', 'GPS frozen · MARTA reports GPS lost after 20 s');
      if (mode === 'lost') LS.toast('warn', 'Lost signal · MARTA reports GPS lost after 20 s');
    } catch (e) { LS.handleError(e); }
    finally { gpsPending = false; LS.render(); }
  }
  function renderGps(st) {
    const g = st.gps || { mode: 'normal', jitter_m: 0, lost_supported: false };
    const lostBtn = $('gps-mode').querySelector('[data-v="lost"]');
    lostBtn.disabled = !g.lost_supported;
    lostBtn.title = g.lost_supported ? 'Send fixes with 150 m accuracy, which MARTA ignores' : 'Android only: iOS can’t fake GPS accuracy';
    if (!gpsPending) {
      gpsSeg.selectBy('v', g.mode, false);
      if (document.activeElement !== $('jitter')) { $('jitter').value = g.jitter_m; jitterOut(g.jitter_m); }
    }
    $('gps-mode-hint').textContent = g.lost_supported
      ? 'Frozen sends no updates. Lost signal sends fixes MARTA ignores (accuracy 150 m).'
      : 'Frozen sends no updates. Lost signal needs Android: iOS can’t fake accuracy.';
    const label = { normal: 'Normal', frozen: 'Frozen', lost: 'Lost signal' }[g.mode];
    $('tv-gps').textContent = g.jitter_m ? `${label} · ±${g.jitter_m} m` : label;
    $('tv-gps').className = `tool-value ${g.mode !== 'normal' ? 'bad' : g.jitter_m ? 'warn' : ''}`;
  }

  // ------------------------------------------------------------------ activity log
  let logFetching = false;
  async function refreshLog() {
    if (logFetching) return;
    logFetching = true;
    try { const data = await api.get('/api/log'); state.log = data; renderLog(); }
    catch { /* try again on the next status change */ }
    finally { logFetching = false; }
  }
  const legLabel = (leg) => (leg === 'transit' ? 'ride' : leg === 'rider' ? 'walk' : '');
  function renderLog() {
    const entries = state.log.entries || [];
    $('tv-log').textContent = entries.length ? String(entries.length) : 'Empty';
    const ol = $('log-list');
    if (!entries.length) { ol.innerHTML = '<li class="log-empty">Actions and trip events show up here.</li>'; return; }
    ol.innerHTML = entries.slice().reverse().map((e) =>
      `<li class="log-${esc(e.kind)}"><time>${esc(LS.fmtClock(e.t))}</time><span>${esc(e.text)}</span>${e.leg ? `<em>${legLabel(e.leg)}</em>` : ''}</li>`).join('');
  }
  $('btn-log-copy').addEventListener('click', async () => {
    const text = (state.log.entries || []).map((e) => `${LS.fmtClock(e.t)}  ${e.leg ? `[${legLabel(e.leg)}] ` : ''}${e.text}`).join('\n');
    try { await navigator.clipboard.writeText(text || '(empty)'); LS.toast('done', 'Log copied'); }
    catch { LS.toast('error', 'Could not copy. Select the log text instead.'); }
  });
  $('btn-log-clear').addEventListener('click', async () => {
    try { state.log = await api.del('/api/log'); renderLog(); } catch (e) { LS.handleError(e); }
  });

  // ------------------------------------------------------------------ render
  function render() {
    place();
    const st = state.status;
    if (!st || tools.hidden) return;
    renderOffset(st);
    renderPace(st.route);
    renderGps(st);
    if (st.log_seq !== state.log.seq) refreshLog();
  }
  LS.onRender(render);
  const segs = [sideSeg, moveSeg, gpsSeg];
  renderLog();

  // ------------------------------------------------------------------ recipes: open a tool with values filled in
  /** Opens a tool for a test scenario. Fills Off course in; for Pace and GPS it points at the
   *  control to press, because those take effect the moment they change. */
  function preset(cfg) {
    place();
    if (tools.hidden) {
      LS.tabs.show(LS.activeRoute() ? 'trip' : 'place');
      LS.toast('warn', 'Start a trip (or set a location) first, then press Set up again', 4000);
      return null;
    }
    const d = $(`tool-${cfg.tool}`);
    if (!d || d.hidden) { LS.toast('warn', 'Pace needs a running trip'); return null; }
    let focus = d;
    if (cfg.tool === 'offset') {
      if (cfg.m != null) $('off-m').value = cfg.m;
      if (cfg.ramp != null) $('off-ramp').value = cfg.ramp;
      if (cfg.side) { prefs.side = cfg.side; sideSeg.selectBy('v', cfg.side, false); }
      if (cfg.move) { prefs.move = cfg.move; moveSeg.selectBy('v', cfg.move, false); }
      save();
      focus = $('btn-off-go');
    } else if (cfg.tool === 'pace' && cfg.p != null) {
      focus = $('pace-presets').querySelector(`[data-p="${cfg.p}"]`) || d;
    } else if (cfg.tool === 'gps' && cfg.mode) {
      focus = $('gps-mode').querySelector(`[data-v="${cfg.mode}"]`) || d;
    } else if (cfg.tool === 'gps' && cfg.jitter != null) {
      focus = $('jitter');
    }
    LS.tabs.show(LS.activeRoute() ? 'trip' : 'place');
    d.open = true;
    LS.render();
    requestAnimationFrame(() => {
      d.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      LS.flash(focus);
    });
    return focus;
  }
  LS.tools = { preset };

  // ------------------------------------------------------------------ keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((LS.info && LS.info.isOpen()) || (LS.tour && LS.tour.isOpen())) return;
    const t = e.target;
    if (t.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === ' ' && LS.activeRoute() && !t.closest('button, summary')) { e.preventDefault(); LS.trip.togglePause(); }
    if ((e.key === 'o' || e.key === 'O') && !tools.hidden) {
      const o = state.status.offset || {};
      (o.current_m > 0 || o.ramping) && o.target_m > 0 ? backOn() : goOff();
    }
  });
})();
