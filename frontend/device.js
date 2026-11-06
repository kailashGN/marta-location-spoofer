/* Device pill + popover: discovery, Connect / Prepare / Disconnect, Quit. */
(() => {
  'use strict';
  const LS = window.LS;
  const { $, state, api, esc } = LS;

  const pop = $('device-pop');
  const pill = $('device-pill');
  const popSpring = new Spring({ value: 0, response: 0.28, damping: 1, onUpdate: (v) => {
    pop.style.opacity = String(v);
    pop.style.transform = `scale(${0.94 + 0.06 * v}) translateY(${(1 - v) * -6}px)`;
  } });
  let open = false;

  function show() {
    if (open) return;
    open = true; pop.hidden = false; pill.setAttribute('aria-expanded', 'true');
    popSpring.onRest = null; popSpring.to(1);
  }
  function close() {
    if (!open) return;
    open = false; pill.setAttribute('aria-expanded', 'false');
    popSpring.onRest = () => { if (!open) pop.hidden = true; };
    popSpring.to(0);
  }
  pill.addEventListener('click', () => (open ? close() : show()));
  document.addEventListener('pointerdown', (e) => {
    if (open && !pop.contains(e.target) && !pill.contains(e.target) && !e.target.closest('.recover, .scrim, .tour')) close();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  const selectedDevice = () => state.devices.find((d) => d.udid === state.selected) || null;
  const phoneNoun = (platform) => (platform === 'android' ? 'Android' : 'iPhone');
  function strategyNote(strategy) {
    if (strategy === 'dvt') return 'iOS 17+ · developer tunnel';
    if (strategy === 'legacy') return 'iOS ≤ 16 · simulatelocation';
    if (strategy === 'android') return 'Android · mock location helper';
    return '';
  }

  async function refreshDevices() {
    try {
      const data = await api.get('/api/devices');
      state.devices = data.devices || [];
      state.adb = data.adb || null;
      if (!state.selected || !state.devices.some((d) => d.udid === state.selected)) state.selected = state.devices[0]?.udid || null;
    } catch { /* backend restarting; keep last list */ }
    LS.render();
  }

  function render() {
    const d = selectedDevice();
    const body = $('device-body');
    const st = state.status;
    const connected = LS.connected();
    const dot = $('device-dot'), label = $('device-label');
    const platform = connected ? st.platform : (d && d.platform);
    const noun = phoneNoun(platform);
    const practising = LS.practising();
    $('practice-box').hidden = connected && !practising;
    $('device-actions').hidden = practising;
    $('practice-text').textContent = practising
      ? 'Practice mode: the demo phone takes every command and sends nothing anywhere. The practice trip is on the Trip tab.'
      : 'No phone handy? Practise with a demo phone. Every tool works; nothing is sent anywhere.';
    $('btn-practice').textContent = practising ? 'End practice' : 'Practice with a demo phone';
    const adbMissing = state.adb && state.adb.message ? `<p class="problem">${esc(state.adb.message)}</p>` : '';

    // Pill
    if (connected) {
      const gps = st.gps && st.gps.mode !== 'normal';
      dot.className = 'dot ' + (gps ? 'dot-warn' : st.location ? 'dot-live' : 'dot-ok');
      const what = st.route ? 'Trip running' : st.location ? 'Simulating' : 'Connected';
      label.textContent = `${practising ? 'Practice' : st.device_name || noun} · ${what}`;
    } else if (d && d.problem) {
      dot.className = 'dot dot-warn'; label.textContent = d.problem;
    } else if (d) {
      dot.className = 'dot dot-idle'; label.textContent = `${d.name || noun} · Not connected`;
    } else {
      dot.className = 'dot dot-idle'; label.textContent = 'No phone';
    }

    // Popover body
    if (!d && !connected) {
      body.innerHTML = `<p class="muted">Plug in an iPhone or an Android phone with a USB cable. Unlock it and accept the prompt if asked.</p>${adbMissing}`;
      $('btn-connect').disabled = true; $('btn-connect').textContent = 'Connect';
      $('btn-connect').classList.add('btn-primary'); $('btn-connect').classList.remove('btn-secondary');
      $('btn-prepare').hidden = true;
      $('strategy-note').textContent = '';
      return;
    }
    const dev = d || {};
    const android = platform === 'android';
    const name = connected ? st.device_name : dev.name;
    const ver = android ? (connected ? st.android_version : dev.android_version) : (connected ? st.ios_version : dev.ios_version);
    const strategy = connected ? st.strategy : dev.strategy;
    const link = !connected
      ? (dev.connection || '—')
      : (android ? 'USB · adb' : (st.transport === 'usbmux' ? 'USB' : `USB · ${st.transport} tunnel`));
    const tick = (v) => v === true ? '<span class="tick tick-ok">✓</span>' : v === false ? '<span class="tick tick-no">!</span>' : '<span class="tick tick-unk">?</span>';
    const picker = state.devices.length > 1 && !connected;
    let html = picker ? '' : `<div class="device-name">${esc(name || noun)}${connected ? ' <span class="chip chip-ok">Connected</span>' : ''}</div>`;
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

    if (picker) {
      const sel = document.createElement('select'); sel.className = 'field-input'; sel.setAttribute('aria-label', 'Choose device');
      state.devices.forEach((x) => { const o = document.createElement('option'); o.value = x.udid; o.textContent = x.name || x.udid; o.selected = x.udid === state.selected; sel.appendChild(o); });
      sel.addEventListener('change', () => { state.selected = sel.value; LS.render(); });
      body.prepend(sel);
    }

    $('btn-prepare').hidden = connected || android || !(dev.paired && dev.developer_mode !== false && dev.ddi_mounted === false);
    $('btn-connect').disabled = !d && !connected;
    $('btn-connect').textContent = connected ? 'Disconnect' : 'Connect';
    $('btn-connect').classList.toggle('btn-primary', !connected);
    $('btn-connect').classList.toggle('btn-secondary', connected);
    $('strategy-note').textContent = strategyNote(strategy);
  }
  LS.onRender(render);

  async function doConnect() {
    if (LS.connected()) {
      await LS.busy($('btn-connect'), async () => {
        LS.applyStatus(await api.post('/api/disconnect'));
        LS.toast('status', 'Disconnected · real GPS restored');
      });
      return;
    }
    if (!state.selected) return;
    state.lastAction = doConnect;
    await LS.busy($('btn-connect'), async () => {
      const noun = phoneNoun(selectedDevice()?.platform);
      LS.toast('status', `Connecting… unlock the ${noun === 'Android' ? 'phone' : 'iPhone'} if it asks`);
      try {
        LS.applyStatus(await api.post('/api/connect', { udid: state.selected }));
        LS.toast('done', `Connected to ${state.status.device_name || noun}`);
        close();
      } catch (e) { LS.handleError(e, doConnect); await refreshDevices(); }
    });
  }
  async function doPrepare() {
    if (!state.selected) return;
    state.lastAction = doPrepare;
    await LS.busy($('btn-prepare'), async () => {
      LS.toast('status', 'Mounting Developer Disk Image… keep the iPhone unlocked', 6000);
      try {
        const r = await api.post('/api/mount', { udid: state.selected });
        LS.toast('done', r.already ? 'Already prepared' : 'iPhone prepared');
        await refreshDevices();
      } catch (e) { LS.handleError(e, doPrepare); }
    });
  }

  async function startPractice() {
    await LS.busy($('btn-practice'), async () => {
      try {
        if (LS.connected()) LS.applyStatus(await api.post('/api/disconnect'));
        await api.post('/api/demo', { enabled: true });
        await refreshDevices();
        state.selected = 'demo';
        LS.applyStatus(await api.post('/api/connect', { udid: 'demo' }));
        close();
        LS.toast('done', 'Practice mode · nothing is sent to a phone');
        if (!LS.activeRoute()) await LS.trip.loadSample();
      } catch (e) { LS.handleError(e); }
    });
  }
  async function endPractice() {
    await LS.busy($('btn-practice'), async () => {
      try {
        const r = await api.post('/api/demo', { enabled: false });
        LS.applyStatus(r.status);
        LS.trip.clearSample();
        LS.map.removeMarker();
        state.pin = null;
        $('lat').value = ''; $('lon').value = '';
        state.selected = null;
        await refreshDevices();
        LS.toast('status', 'Practice ended');
      } catch (e) { LS.handleError(e); }
    });
  }
  $('btn-practice').addEventListener('click', () => (LS.practising() ? endPractice() : startPractice()));
  $('btn-connect').addEventListener('click', doConnect);
  $('btn-prepare').addEventListener('click', doPrepare);
  $('btn-refresh').addEventListener('click', () => LS.busy($('btn-refresh'), refreshDevices));
  $('btn-quit').addEventListener('click', async () => {
    try { await api.post('/api/quit'); } catch {}
    document.body.innerHTML = '<div style="display:grid;place-items:center;height:100%;font:15px -apple-system,system-ui"><div style="text-align:center"><h2 style="margin:0 0 6px">Location Spoofer has quit</h2><p style="margin:0;color:#888">Real GPS restored. You can close this tab.</p></div></div>';
  });

  LS.device = { refresh: refreshDevices, show, close, isOpen: () => open, startPractice };
})();
