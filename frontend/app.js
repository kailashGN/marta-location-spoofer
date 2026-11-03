/* Location Spoofer — front end. Author: kailash-hubspire
 * Talks to the local FastAPI backend; all motion driven by Spring (see spring.js).
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // Theme: follows the system unless ?theme=light|dark was given (remembered per browser).
  (() => {
    const q = new URLSearchParams(location.search).get('theme');
    let t = q; if (q === 'system') { try { localStorage.removeItem('ls.theme'); } catch {} t = null; }
    if (q && q !== 'system') { try { localStorage.setItem('ls.theme', q); } catch {} }
    if (!t) { try { t = localStorage.getItem('ls.theme'); } catch {} }
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  })();
  const api = {
    async call(method, path, body) {
      const res = await fetch(path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || data.detail?.[0]?.msg || res.statusText);
        err.steps = data.steps || [];
        err.code = data.code || 'error';
        throw err;
      }
      return data;
    },
    get: (p) => api.call('GET', p),
    post: (p, b) => api.call('POST', p, b || {}),
    del: (p) => api.call('DELETE', p),
  };

  // ------------------------------------------------------------------ state
  const state = {
    devices: [],
    adb: null,            // {available, message} from /api/devices
    selected: null,       // udid
    status: null,         // backend snapshot
    pin: null,            // {lat, lon} of the draft pin
    routeMode: false,
    waypoints: [],        // [{lat, lon}]
    gpxRaw: null,         // loaded GPX text when route came from a file
    gpxHasTimes: false,
    routeSyncedKey: null, // last active-route path drawn from /api/status
    speed: 1.4,
    lastAction: null,     // for "Try Again"
    favs: loadFavs(),
  };

  const fmt = (n) => Number(n).toFixed(6);
  const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
  const fmtTime = (s) => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return m ? `${m} min ${s % 60} s` : `${s} s`; };

  function loadFavs() {
    try { return JSON.parse(localStorage.getItem('ls.favs') || '[]'); } catch { return []; }
  }
  function saveFavs() { try { localStorage.setItem('ls.favs', JSON.stringify(state.favs)); } catch {} }

  // ------------------------------------------------------------------ map
  const map = L.map('map', { zoomControl: true, attributionControl: true, worldCopyJump: true })
    .setView([37.3349, -122.0090], 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const pinIcon = L.divIcon({ className: '', html: '<div class="pin"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
  const wpIcon = L.divIcon({ className: '', html: '<div class="wp"></div>', iconSize: [12, 12], iconAnchor: [6, 6] });
  let marker = null;
  const routeLayer = L.layerGroup().addTo(map);
  let routeLine = null;

  function placePin(lat, lon, { pan = false } = {}) {
    state.pin = { lat, lon };
    if (!marker) {
      marker = L.marker([lat, lon], { icon: pinIcon, draggable: true, autoPan: true }).addTo(map);
      marker.on('dragstart', () => marker.getElement().querySelector('.pin').classList.add('dragging'));
      marker.on('drag', () => { const p = marker.getLatLng(); state.pin = { lat: p.lat, lon: p.lng }; syncCoordFields(); });
      marker.on('dragend', () => { marker.getElement().querySelector('.pin').classList.remove('dragging'); const p = marker.getLatLng(); placePin(p.lat, p.lng); });
    } else {
      marker.setLatLng([lat, lon]);
    }
    if (pan) map.flyTo([lat, lon], Math.max(map.getZoom(), 14), { duration: SpringUtil.reduceMotion() ? 0 : 0.8 });
    syncCoordFields();
    render();
  }

  function syncCoordFields() {
    if (!state.pin) return;
    if (document.activeElement !== $('lat')) $('lat').value = fmt(state.pin.lat);
    if (document.activeElement !== $('lon')) $('lon').value = fmt(state.pin.lon);
    $('coord-error').hidden = true;
    $('lat').classList.remove('invalid'); $('lon').classList.remove('invalid');
  }

  map.on('click', (e) => {
    if (state.routeMode) { addWaypoint(e.latlng.lat, e.latlng.lng); return; }
    placePin(e.latlng.lat, e.latlng.lng);
  });

  // Route drawing
  function addWaypoint(lat, lon) {
    state.gpxRaw = null;
    state.gpxHasTimes = false;
    state.waypoints.push({ lat, lon });
    L.marker([lat, lon], { icon: wpIcon, interactive: false }).addTo(routeLayer);
    drawRouteLine();
    render();
  }
  function drawRouteLine() {
    if (routeLine) { routeLine.remove(); routeLine = null; }
    if (state.waypoints.length >= 2) {
      routeLine = L.polyline(state.waypoints.map((p) => [p.lat, p.lon]), { className: 'route-line', interactive: false }).addTo(routeLayer);
    }
  }
  function clearRoute() {
    state.waypoints = [];
    state.gpxRaw = null;
    state.gpxHasTimes = false;
    state.routeSyncedKey = null;
    routeLayer.clearLayers();
    routeLine = null;
    render();
  }

  function routePathKey(r) {
    if (!r || !Array.isArray(r.points) || r.points.length < 2) return null;
    const a = r.points[0];
    const b = r.points[r.points.length - 1];
    return `${r.samples}:${r.total_m}:${r.points.length}:${a.lat},${a.lon}:${b.lat},${b.lon}`;
  }

  function sameWaypointPath(local, remote) {
    if (!remote || local.length !== remote.length) return false;
    for (let i = 0; i < local.length; i++) {
      if (Math.abs(local[i].lat - remote[i].lat) > 1e-7 || Math.abs(local[i].lon - remote[i].lon) > 1e-7) {
        return false;
      }
    }
    return true;
  }

  /** Draw the active route from status (e.g. a route started from another tab or the HTTP API). */
  function syncActiveRouteOnMap(st) {
    const r = st && st.route;
    const key = routePathKey(r);
    if (!key) {
      state.routeSyncedKey = null;
      return;
    }
    if (key === state.routeSyncedKey) return;
    state.routeSyncedKey = key;
    if (sameWaypointPath(state.waypoints, r.points)) return;

    state.waypoints = r.points.map((p) => ({ lat: p.lat, lon: p.lon }));
    state.gpxRaw = null;
    state.gpxHasTimes = r.timing === 'gpx';
    routeLayer.clearLayers();
    routeLine = null;
    // Dense GPX tracks: line + endpoints only. Hand-drawn routes keep every waypoint pin.
    if (state.waypoints.length <= 40) {
      state.waypoints.forEach((p) => {
        L.marker([p.lat, p.lon], { icon: wpIcon, interactive: false }).addTo(routeLayer);
      });
    } else {
      const first = state.waypoints[0];
      const last = state.waypoints[state.waypoints.length - 1];
      L.marker([first.lat, first.lon], { icon: wpIcon, interactive: false }).addTo(routeLayer);
      L.marker([last.lat, last.lon], { icon: wpIcon, interactive: false }).addTo(routeLayer);
    }
    drawRouteLine();
    if (routeLine) {
      map.fitBounds(routeLine.getBounds(), { padding: [48, 48], maxZoom: 15 });
    }
    const head = st.location || state.waypoints[0];
    if (head) placePin(head.lat, head.lon);
  }

  function useGpxTimes() {
    return state.gpxRaw && state.gpxHasTimes && $('route-gpx-times').checked;
  }

  function syncRouteTimingUi() {
    const show = state.gpxHasTimes;
    $('route-gpx-times-wrap').hidden = !show;
    $('route-time-scale-wrap').hidden = !show || !useGpxTimes();
    $('route-speed-seg').hidden = true;
  }
  function setRouteMode(on) {
    state.routeMode = on;
    $('map').classList.toggle('route-mode', on);
    $('btn-route-mode').setAttribute('aria-pressed', String(on));
    $('btn-route-mode').textContent = on ? 'Done Drawing' : 'Draw Waypoints';
    if (on) $('route-card').open = true;
  }

  // ------------------------------------------------------------------ toasts (spring in/out)
  function toast(kind, text, ms = 2600) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`; el.textContent = text;
    $('toasts').appendChild(el);
    const s = new Spring({ value: -24, response: 0.35, damping: 1, onUpdate: (v) => { el.style.transform = `translateY(${v}px)`; el.style.opacity = String(Math.max(0, 1 + v / 24)); } });
    s.to(0);
    setTimeout(() => { s.to(-24, { response: 0.3 }); s.onRest = () => el.remove(); }, ms);
  }

  // ------------------------------------------------------------------ recovery dialog
  const recover = {
    spring: new Spring({ value: 0, response: 0.32, damping: 1, onUpdate: (v) => {
      const el = $('recover'); el.style.transform = `translate(-50%, -50%) scale(${0.94 + 0.06 * v})`; el.style.opacity = String(v);
    } }),
    show(title, steps, retry) {
      $('recover-title').textContent = title;
      $('recover-steps').innerHTML = '';
      steps.forEach((s) => { const li = document.createElement('li'); li.textContent = s; $('recover-steps').appendChild(li); });
      $('recover-retry').hidden = !retry;
      recover.retry = retry;
      $('scrim').hidden = false; $('recover').hidden = false;
      requestAnimationFrame(() => $('scrim').classList.add('show'));
      recover.spring.onRest = null; recover.spring.to(1);
      $('recover-close').focus();
    },
    hide() {
      $('scrim').classList.remove('show');
      recover.spring.onRest = () => { $('recover').hidden = true; $('scrim').hidden = true; };
      recover.spring.to(0);
    },
  };
  $('recover-close').addEventListener('click', recover.hide);
  $('scrim').addEventListener('click', recover.hide);
  $('recover-retry').addEventListener('click', () => { recover.hide(); recover.retry && recover.retry(); });

  function handleError(err, retry) {
    if (err.steps && err.steps.length) recover.show(err.message, err.steps, retry);
    else toast('error', err.message || 'Something went wrong');
  }

  // ------------------------------------------------------------------ buttons: press feedback + busy state
  document.querySelectorAll('.btn').forEach((b) => {
    b.addEventListener('pointerdown', () => b.classList.add('pressed'));
    const up = () => b.classList.remove('pressed');
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('pointerleave', up);
  });
  async function busy(btn, fn) {
    btn.classList.add('busy'); btn.disabled = true;
    try { return await fn(); } finally { btn.classList.remove('busy'); btn.disabled = false; render(); }
  }

  // ------------------------------------------------------------------ devices
  async function refreshDevices() {
    try {
      const data = await api.get('/api/devices');
      state.devices = data.devices || [];
      state.adb = data.adb || null;
      if (!state.selected || !state.devices.some((d) => d.udid === state.selected)) state.selected = state.devices[0]?.udid || null;
    } catch (e) { /* backend restarting; keep last list */ }
    render();
  }
  async function refreshStatus() {
    try { state.status = await api.get('/api/status'); } catch { state.status = null; }
    syncActiveRouteOnMap(state.status);
    render();
  }

  function selectedDevice() { return state.devices.find((d) => d.udid === state.selected) || null; }

  function phoneNoun(platform) { return platform === 'android' ? 'Android' : 'iPhone'; }

  function strategyNote(strategy) {
    if (strategy === 'dvt') return 'iOS 17+ · DVT LocationSimulation';
    if (strategy === 'legacy') return 'iOS ≤ 16 · com.apple.dt.simulatelocation';
    if (strategy === 'android') return 'Android · mock location';
    return '';
  }

  function renderDevice() {
    const d = selectedDevice();
    const body = $('device-body');
    const st = state.status;
    const connected = !!(st && st.connected);
    const dot = $('device-dot'), label = $('device-label');
    const platform = connected ? st.platform : (d && d.platform);
    const noun = phoneNoun(platform);
    const adbMissing = state.adb && state.adb.message
      ? `<p class="problem">${esc(state.adb.message)}</p>` : '';

    if (!d && !connected) {
      body.innerHTML = `<p class="muted">Plug in an iPhone or an Android phone with a USB cable. Unlock it and accept the prompt if asked.</p>${adbMissing}`;
      dot.className = 'dot dot-idle'; label.textContent = 'No phone';
      $('btn-connect').disabled = true; $('btn-connect').textContent = 'Connect';
      $('btn-prepare').hidden = true;
      return;
    }
    if (connected) {
      dot.className = 'dot ' + (st.location ? 'dot-live' : 'dot-ok');
      label.textContent = `${st.device_name || noun} · ${st.location ? 'Simulating' : 'Connected'}`;
    } else if (d && d.problem) {
      dot.className = 'dot dot-warn'; label.textContent = d.problem;
    } else {
      dot.className = 'dot dot-idle'; label.textContent = d ? (d.name || noun) : noun;
    }

    const dev = d || {};
    const name = connected ? st.device_name : dev.name;
    const android = platform === 'android';
    const ver = android
      ? (connected ? st.android_version : dev.android_version)
      : (connected ? st.ios_version : dev.ios_version);
    const strategy = connected ? st.strategy : dev.strategy;
    const link = !connected
      ? (dev.connection || '—')
      : (android ? 'USB · adb' : (st.transport === 'usbmux' ? 'USB' : `USB · ${st.transport} tunnel`));
    const tick = (v) => v === true ? '<span class="tick tick-ok">✓</span>' : v === false ? '<span class="tick tick-no">!</span>' : '<span class="tick tick-unk">?</span>';
    let html = `<div class="device-name">${esc(name || noun)}</div>`;
    html += `<dl class="kv"><dt>${android ? 'Android' : 'iOS'}</dt><dd>${esc(ver || '—')}</dd><dt>Model</dt><dd>${esc(dev.model || '—')}</dd><dt>Link</dt><dd>${esc(link)}</dd></dl>`;
    if (!connected && android) {
      html += `<ul class="status-list">
        <li>${tick(dev.paired)} USB debugging</li>
        <li>${tick(dev.helper_installed)} Helper installed</li>
        <li>${tick(dev.mock_granted)} Mock location granted</li></ul>`;
      if (dev.problem) html += `<p class="problem">${esc(dev.problem)}</p>`;
    } else if (!connected) {
      html += `<ul class="status-list">
        <li>${tick(dev.paired)} Paired with this Mac</li>
        <li>${tick(dev.developer_mode)} Developer Mode</li>
        <li>${tick(dev.ddi_mounted)} Developer Disk Image mounted</li></ul>`;
      if (dev.problem) html += `<p class="problem">${esc(dev.problem)}</p>`;
    }
    html += adbMissing;
    body.innerHTML = html;

    if (state.devices.length > 1 && !connected) {
      const sel = document.createElement('select'); sel.className = 'field-input'; sel.setAttribute('aria-label', 'Choose device');
      state.devices.forEach((x) => { const o = document.createElement('option'); o.value = x.udid; o.textContent = x.name || x.udid; o.selected = x.udid === state.selected; sel.appendChild(o); });
      sel.addEventListener('change', () => { state.selected = sel.value; render(); });
      body.prepend(sel);
    }

    $('btn-prepare').hidden = connected || android || !(dev.paired && dev.developer_mode !== false && dev.ddi_mounted === false);
    $('btn-connect').disabled = !d && !connected;
    $('btn-connect').textContent = connected ? 'Disconnect' : 'Connect';
    $('btn-connect').classList.toggle('btn-primary', !connected);
    $('btn-connect').classList.toggle('btn-secondary', connected);
    $('strategy-note').textContent = strategyNote(strategy);
  }

  function renderLocation() {
    const st = state.status; const connected = !!(st && st.connected);
    const simulating = connected && !!st.location;
    $('sim-chip').hidden = !simulating;
    $('btn-set').disabled = !connected || !state.pin;
    $('btn-clear').disabled = !simulating;
    $('btn-fav-add').disabled = !state.pin;
    if (marker) marker.getElement()?.querySelector('.pin')?.classList.toggle('live', simulating && !st.route);

    // Route
    const r = st && st.route;
    if (r) $('route-card').open = true;
    $('route-progress').hidden = !r;
    $('trip-test').hidden = !r;
    $('btn-route-play').hidden = !!r;
    $('btn-route-stop').hidden = !r;
    syncRouteTimingUi();
    $('btn-route-play').disabled = !connected || state.waypoints.length < 2;
    const mode = useGpxTimes() ? 'GPX times' : fmtDist(routeLength(state.waypoints));
    $('btn-route-play').textContent = state.waypoints.length < 2 ? 'Add two or more waypoints' : `Start Route · ${mode}`;
    if (r) {
      $('route-bar').style.width = `${Math.round(r.progress * 100)}%`;
      $('route-text').textContent = `${fmtDist(r.progress * r.total_m)} of ${fmtDist(r.total_m)}${r.paused ? ' · paused' : ''}`;
      const remaining = r.timing === 'gpx' && r.remaining_s != null
        ? r.remaining_s
        : (1 - r.progress) * r.total_m / r.speed_mps;
      const suffix = r.timing === 'gpx' ? ' · GPX schedule' : '';
      $('route-eta').textContent = `${fmtTime(remaining)} left${suffix}`;
      $('btn-route-pause').textContent = r.paused ? 'Resume' : 'Hold position';
      const transit = r.leg === 'transit';
      $('btn-pace-slow').disabled = transit;
      $('btn-pace-normal').disabled = transit;
      $('btn-pace-fast').disabled = transit;
      $('trip-pace-hint').textContent = transit
        ? 'On the bus or train — pace stays on the timetable.'
        : 'Slower, normal, or faster on this walk or drive.';
      $('btn-offset-left').setAttribute('aria-pressed', String(r.offset_side === 'left'));
      $('btn-offset-right').setAttribute('aria-pressed', String(r.offset_side === 'right'));
      const factor = r.pace_factor;
      $('btn-pace-slow').setAttribute('aria-pressed', String(factor === 0.5));
      $('btn-pace-normal').setAttribute('aria-pressed', String(factor === 1 || factor == null));
      $('btn-pace-fast').setAttribute('aria-pressed', String(factor === 2));
      if (st.location) {
        if (marker) marker.setLatLng([st.location.lat, st.location.lon]);
        else placePin(st.location.lat, st.location.lon);
      }
    }
  }

  function renderFavs() {
    const ul = $('fav-list'); ul.innerHTML = '';
    state.favs.forEach((f, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<div class="fav-main" role="button" tabindex="0"><div class="fav-name">${esc(f.name)}</div><div class="fav-coords">${fmt(f.lat)}, ${fmt(f.lon)}</div></div>
        <button class="icon-btn" title="Remove" aria-label="Remove ${esc(f.name)}"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>`;
      li.querySelector('.fav-main').addEventListener('click', () => placePin(f.lat, f.lon, { pan: true }));
      li.querySelector('.fav-main').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); placePin(f.lat, f.lon, { pan: true }); } });
      li.querySelector('.icon-btn').addEventListener('click', () => { state.favs.splice(i, 1); saveFavs(); renderFavs(); toast('done', 'Removed favourite'); });
      ul.appendChild(li);
    });
  }

  function render() {
    syncActiveRouteOnMap(state.status);
    renderDevice();
    renderLocation();
  }

  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function routeLength(pts) {
    let d = 0; for (let i = 1; i < pts.length; i++) d += hav(pts[i - 1], pts[i]); return d;
  }
  function hav(a, b) {
    const R = 6371000, r = Math.PI / 180, dp = (b.lat - a.lat) * r, dl = (b.lon - a.lon) * r;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // ------------------------------------------------------------------ actions
  async function doConnect() {
    const st = state.status;
    if (st && st.connected) {
      await busy($('btn-connect'), async () => { state.status = await api.post('/api/disconnect'); toast('status', 'Disconnected · real GPS restored'); });
      return;
    }
    if (!state.selected) return;
    state.lastAction = doConnect;
    await busy($('btn-connect'), async () => {
      const noun = phoneNoun(selectedDevice()?.platform);
      toast('status', `Connecting… unlock the ${noun === 'Android' ? 'phone' : 'iPhone'} if it asks`);
      try {
        state.status = await api.post('/api/connect', { udid: state.selected });
        toast('done', `Connected to ${state.status.device_name || (noun === 'Android' ? 'Android phone' : 'iPhone')}`);
      } catch (e) { handleError(e, doConnect); await refreshDevices(); }
    });
  }
  async function doPrepare() {
    if (!state.selected) return;
    state.lastAction = doPrepare;
    await busy($('btn-prepare'), async () => {
      toast('status', 'Mounting Developer Disk Image… keep the iPhone unlocked', 6000);
      try {
        const r = await api.post('/api/mount', { udid: state.selected });
        toast('done', r.already ? 'Already prepared' : 'iPhone prepared');
        await refreshDevices();
      } catch (e) { handleError(e, doPrepare); }
    });
  }
  async function doSet() {
    if (!state.pin) return;
    state.lastAction = doSet;
    await busy($('btn-set'), async () => {
      try {
        state.status = await api.post('/api/location', state.pin);
        toast('done', `Location set · ${fmt(state.pin.lat)}, ${fmt(state.pin.lon)}`);
      } catch (e) { handleError(e, doSet); }
    });
  }
  async function doClear() {
    await busy($('btn-clear'), async () => {
      try { state.status = await api.del('/api/location'); toast('done', 'Stopped · real GPS restored'); }
      catch (e) { handleError(e); }
    });
  }
  async function doRoutePlay() {
    if (state.waypoints.length < 2) return;
    state.lastAction = doRoutePlay;
    await busy($('btn-route-play'), async () => {
      try {
        const loop = $('route-loop').checked;
        if (useGpxTimes()) {
          const time_scale = Math.max(0.1, Math.min(500, parseFloat($('route-time-scale').value) || 1));
          state.status = await api.post('/api/route/gpx', {
            gpx: state.gpxRaw,
            speed_mps: state.speed,
            loop,
            use_gpx_times: true,
            time_scale,
          });
        } else if (state.gpxRaw) {
          state.status = await api.post('/api/route/gpx', {
            gpx: state.gpxRaw,
            speed_mps: state.speed,
            loop,
            use_gpx_times: false,
          });
        } else {
          state.status = await api.post('/api/route', { points: state.waypoints, speed_mps: state.speed, loop });
        }
        if (!marker) placePin(state.waypoints[0].lat, state.waypoints[0].lon);
        setRouteMode(false);
        toast('status', useGpxTimes() ? 'Route started (GPX times)' : 'Route started');
      } catch (e) { handleError(e, doRoutePlay); }
    });
  }
  async function doRoutePause() {
    const r = state.status && state.status.route; if (!r) return;
    try { state.status = await api.post('/api/route/pause', { paused: !r.paused }); render(); } catch (e) { handleError(e); }
  }
  async function doOffset(side) {
    try {
      state.status = await api.post('/api/route/offset', { side, meters: 100 });
      render();
    } catch (e) { handleError(e); }
  }
  async function doPace(factor) {
    try {
      state.status = await api.post('/api/route/pace', { factor });
      render();
    } catch (e) { handleError(e); }
  }
  async function doRouteStop() {
    try { state.status = await api.del('/api/route'); toast('done', 'Route stopped'); render(); } catch (e) { handleError(e); }
  }

  $('btn-connect').addEventListener('click', doConnect);
  $('btn-prepare').addEventListener('click', doPrepare);
  $('btn-refresh').addEventListener('click', () => busy($('btn-refresh'), refreshDevices));
  $('btn-set').addEventListener('click', doSet);
  $('btn-clear').addEventListener('click', doClear);
  $('btn-route-play').addEventListener('click', doRoutePlay);
  $('btn-route-pause').addEventListener('click', doRoutePause);
  $('btn-route-stop').addEventListener('click', doRouteStop);
  $('btn-offset-left').addEventListener('click', () => doOffset('left'));
  $('btn-offset-right').addEventListener('click', () => doOffset('right'));
  $('btn-offset-clear').addEventListener('click', () => doOffset('none'));
  $('btn-pace-slow').addEventListener('click', () => doPace(0.5));
  $('btn-pace-normal').addEventListener('click', () => doPace(1));
  $('btn-pace-fast').addEventListener('click', () => doPace(2));
  $('btn-route-mode').addEventListener('click', () => setRouteMode(!state.routeMode));
  $('btn-route-clear').addEventListener('click', clearRoute);
  $('btn-quit').addEventListener('click', async () => {
    try { await api.post('/api/quit'); } catch {}
    document.body.innerHTML = '<div style="display:grid;place-items:center;height:100%;font:15px -apple-system,system-ui"><div style="text-align:center"><h2 style="margin:0 0 6px">Location Spoofer has quit</h2><p style="margin:0;color:#888">Real GPS restored. You can close this tab.</p></div></div>';
  });
  $('btn-fav-add').addEventListener('click', () => {
    if (!state.pin) return;
    const name = prompt('Name this place', `${fmt(state.pin.lat)}, ${fmt(state.pin.lon)}`);
    if (!name) return;
    state.favs.unshift({ name, lat: state.pin.lat, lon: state.pin.lon }); saveFavs(); renderFavs(); toast('done', 'Saved to favourites');
  });
  $('gpx-file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const text = await f.text();
    try {
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      const nodes = [...doc.querySelectorAll('trkpt, rtept')];
      const pts = nodes.map((n) => ({ lat: +n.getAttribute('lat'), lon: +n.getAttribute('lon') }));
      if (pts.length < 2) throw new Error('GPX has fewer than two points');
      clearRoute();
      state.gpxRaw = text;
      state.gpxHasTimes = nodes.length > 0 && nodes.every((n) => n.querySelector('time'));
      pts.forEach((p) => {
        state.waypoints.push(p);
        L.marker([p.lat, p.lon], { icon: wpIcon, interactive: false }).addTo(routeLayer);
      });
      drawRouteLine();
      syncRouteTimingUi();
      map.fitBounds(pts.map((p) => [p.lat, p.lon]), { padding: [40, 40] });
      const timing = state.gpxHasTimes ? ' · timestamps detected' : '';
      toast('done', `Loaded ${pts.length} points from ${f.name}${timing}`);
      render();
    } catch (err) { toast('error', err.message); }
    e.target.value = '';
  });
  $('route-gpx-times').addEventListener('change', () => { syncRouteTimingUi(); render(); });
  $('route-time-scale').addEventListener('input', () => render());

  // Coordinate fields: inline validation, Enter = set
  function readFields() {
    const lat = parseFloat($('lat').value), lon = parseFloat($('lon').value);
    const bad = [];
    if (!(lat >= -90 && lat <= 90)) bad.push('lat');
    if (!(lon >= -180 && lon <= 180)) bad.push('lon');
    $('lat').classList.toggle('invalid', bad.includes('lat'));
    $('lon').classList.toggle('invalid', bad.includes('lon'));
    const err = $('coord-error');
    if (bad.length) { err.textContent = bad.includes('lat') ? 'Latitude must be between −90 and 90.' : 'Longitude must be between −180 and 180.'; err.hidden = false; return null; }
    err.hidden = true; return { lat, lon };
  }
  ['lat', 'lon'].forEach((id) => {
    $(id).addEventListener('input', () => { const c = readFields(); if (c) { state.pin = c; if (marker) marker.setLatLng([c.lat, c.lon]); else placePin(c.lat, c.lon); render(); } });
    $(id).addEventListener('change', () => { const c = readFields(); if (c) placePin(c.lat, c.lon, { pan: true }); });
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { const c = readFields(); if (c) { placePin(c.lat, c.lon, { pan: true }); doSet(); } } });
  });

  // ------------------------------------------------------------------ search (Nominatim, debounced) + "lat, lon" paste
  const results = $('search-results');
  let searchTimer = 0, searchAbort = null, activeIdx = -1;
  const resultsSpring = new Spring({ value: 0, response: 0.3, damping: 1, onUpdate: (v) => { results.style.transform = `scaleY(${0.9 + 0.1 * v}) translateY(${(1 - v) * -6}px)`; results.style.opacity = String(v); } });
  function showResults(items) {
    results.innerHTML = ''; activeIdx = -1;
    if (!items.length) { hideResults(); return; }
    items.forEach((it, i) => {
      const li = document.createElement('li'); li.setAttribute('role', 'option');
      li.innerHTML = `${esc(it.title)}<small>${esc(it.subtitle || '')}</small>`;
      li.addEventListener('pointerdown', (e) => { e.preventDefault(); choose(it); });
      results.appendChild(li);
    });
    results.hidden = false; resultsSpring.onRest = null; resultsSpring.to(1);
  }
  function hideResults() { resultsSpring.onRest = () => { results.hidden = true; }; resultsSpring.to(0); }
  function choose(it) { placePin(it.lat, it.lon, { pan: true }); $('search').value = it.title; hideResults(); $('search').blur(); }
  $('search').addEventListener('input', () => {
    const q = $('search').value.trim();
    clearTimeout(searchTimer);
    const m = q.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
    if (m) { showResults([{ title: `Go to ${m[1]}, ${m[2]}`, subtitle: 'Coordinates', lat: +m[1], lon: +m[2] }]); return; }
    if (q.length < 3) { hideResults(); return; }
    searchTimer = setTimeout(async () => {
      if (searchAbort) searchAbort.abort();
      searchAbort = new AbortController();
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`, { signal: searchAbort.signal, headers: { 'accept-language': navigator.language } });
        const items = (await res.json()).map((r) => { const [t, ...rest] = r.display_name.split(', '); return { title: t, subtitle: rest.join(', '), lat: +r.lat, lon: +r.lon }; });
        showResults(items);
      } catch (e) { if (e.name !== 'AbortError') toast('warn', 'Search is unavailable offline'); }
    }, 320);
  });
  $('search').addEventListener('keydown', (e) => {
    const items = [...results.querySelectorAll('li')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); if (!items.length) return;
      activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.setAttribute('aria-selected', String(i === activeIdx)));
    } else if (e.key === 'Enter') {
      if (items.length) items[Math.max(0, activeIdx)].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    } else if (e.key === 'Escape') { hideResults(); $('search').blur(); }
  });
  $('search').addEventListener('blur', () => setTimeout(hideResults, 120));

  // ------------------------------------------------------------------ segmented speed control (sliding thumb spring)
  const seg = document.querySelector('.seg'); const thumb = seg.querySelector('.seg-thumb');
  const segItems = [...seg.querySelectorAll('.seg-item')];
  const thumbSpring = new Spring({ value: 0, response: 0.3, damping: 1, onUpdate: (v) => { thumb.style.transform = `translateX(${v}px)`; } });
  function moveThumb(i, animate = true) {
    const w = segItems[0].getBoundingClientRect().width + 0.5;
    animate ? thumbSpring.to(i * w) : thumbSpring.set(i * w);
  }
  segItems.forEach((b, i) => b.addEventListener('pointerdown', () => {
    segItems.forEach((x) => x.setAttribute('aria-checked', 'false')); b.setAttribute('aria-checked', 'true');
    state.speed = parseFloat(b.dataset.speed); moveThumb(i); render();
  }));
  window.addEventListener('resize', () => moveThumb(segItems.findIndex((b) => b.getAttribute('aria-checked') === 'true'), false));
  $('route-card').addEventListener('toggle', () => requestAnimationFrame(() => moveThumb(segItems.findIndex((b) => b.getAttribute('aria-checked') === 'true'), false)));

  // ------------------------------------------------------------------ bottom sheet drag (phone widths): 1:1 tracking, velocity handoff, projection, rubber-band
  (function sheetGestures() {
    const sheet = $('sheet'); const grabber = $('grabber');
    const mq = matchMedia('(max-width: 899px)');
    let collapsedY = 0; // px of translateY when collapsed (peek shows the device card)
    const spring = new Spring({ value: 0, response: 0.3, damping: 0.8, onUpdate: (v) => { sheet.style.transform = `translateY(${v}px)`; } });
    const tracker = new SpringUtil.VelocityTracker();
    let expanded = true, startY = 0, startVal = 0, dragging = false;

    function measure() { collapsedY = Math.max(0, sheet.offsetHeight - 212); }
    // Phones start with the sheet collapsed so the map is the first thing you see.
    if (mq.matches) requestAnimationFrame(() => { measure(); expanded = false; spring.set(collapsedY); });
    function apply(toExpanded, velocity = 0) {
      expanded = toExpanded; sheet.classList.toggle('expanded', expanded);
      spring.to(expanded ? 0 : collapsedY, { velocity, damping: Math.abs(velocity) > 200 ? 0.8 : 1 });
    }
    function onDown(e) {
      if (!mq.matches) return;
      if (e.target.closest('button, input, select, a, details > summary') && e.target !== grabber && !grabber.contains(e.target)) return;
      // Allow scrolling inside an expanded sheet unless grabbing at the grabber or sheet is at top.
      if (expanded && sheet.scrollTop > 0 && !grabber.contains(e.target)) return;
      measure(); spring.stop(); tracker.reset();
      dragging = true; startY = e.clientY; startVal = spring.value;
      sheet.setPointerCapture(e.pointerId);
      tracker.push(e.clientY);
    }
    function onMove(e) {
      if (!dragging) return;
      let y = startVal + (e.clientY - startY);
      if (y < 0) y = SpringUtil.rubberband(y, sheet.offsetHeight);         // resist above fully open
      if (y > collapsedY) y = collapsedY + SpringUtil.rubberband(y - collapsedY, sheet.offsetHeight); // resist below collapsed
      spring.set(y); tracker.push(e.clientY);
    }
    function onUp(e) {
      if (!dragging) return; dragging = false;
      const v = tracker.velocity;
      const projected = spring.value + SpringUtil.project(v);
      // Decide by velocity sign when fast; else nearest snap point of the projection.
      const toExpanded = Math.abs(v) > 300 ? v < 0 : projected < collapsedY / 2;
      apply(toExpanded, v);
    }
    sheet.addEventListener('pointerdown', onDown);
    sheet.addEventListener('pointermove', onMove);
    sheet.addEventListener('pointerup', onUp);
    sheet.addEventListener('pointercancel', onUp);
    grabber.addEventListener('click', () => { measure(); apply(!expanded); });
    mq.addEventListener('change', () => { if (!mq.matches) { spring.set(0); expanded = true; } });
  })();

  // ------------------------------------------------------------------ boot
  async function boot() {
    try { const m = await api.get('/api/meta'); $('version').textContent = `v${m.version}`; } catch {}
    renderFavs();
    moveThumb(0, false);
    await refreshDevices(); await refreshStatus();
    if (state.status && state.status.location) placePin(state.status.location.lat, state.status.location.lon, { pan: true });
    setInterval(refreshStatus, 1500);
    setInterval(() => { if (!(state.status && state.status.connected)) refreshDevices(); }, 4000);
  }
  boot();
})();
