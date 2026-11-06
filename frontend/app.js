/* Location Spoofer 2 — boot, polling, and the phone-width bottom sheet. Author: kailash-hubspire */
(() => {
  'use strict';
  const LS = window.LS;
  const { $, state, api } = LS;

  async function refreshStatus() {
    try { state.status = await api.get('/api/status'); } catch { state.status = null; }
    LS.render();
  }

  // ------------------------------------------------------------------ bottom sheet drag (phone widths)
  (function sheetGestures() {
    const sheet = $('sheet'); const grabber = $('grabber');
    const mq = matchMedia('(max-width: 899px)');
    let collapsedY = 0;
    const spring = new Spring({ value: 0, response: 0.3, damping: 0.8, onUpdate: (v) => { sheet.style.transform = `translateY(${v}px)`; } });
    const tracker = new SpringUtil.VelocityTracker();
    let expanded = true, startY = 0, startVal = 0, dragging = false;

    // Collapsed, the sheet peeks the grabber, the tabs and the top of the first card.
    function measure() { collapsedY = Math.max(0, sheet.offsetHeight - 196); }
    if (mq.matches) requestAnimationFrame(() => { measure(); expanded = false; spring.set(collapsedY); });
    function apply(toExpanded, velocity = 0) {
      expanded = toExpanded; sheet.classList.toggle('expanded', expanded);
      spring.to(expanded ? 0 : collapsedY, { velocity, damping: Math.abs(velocity) > 200 ? 0.8 : 1 });
    }
    function onDown(e) {
      if (!mq.matches) return;
      if (e.target.closest('button, input, select, a, summary, label') && !grabber.contains(e.target)) return;
      if (expanded && sheet.scrollTop > 0 && !grabber.contains(e.target)) return;
      measure(); spring.stop(); tracker.reset();
      dragging = true; startY = e.clientY; startVal = spring.value;
      sheet.setPointerCapture(e.pointerId);
      tracker.push(e.clientY);
    }
    function onMove(e) {
      if (!dragging) return;
      let y = startVal + (e.clientY - startY);
      if (y < 0) y = SpringUtil.rubberband(y, sheet.offsetHeight);
      if (y > collapsedY) y = collapsedY + SpringUtil.rubberband(y - collapsedY, sheet.offsetHeight);
      spring.set(y); tracker.push(e.clientY);
    }
    function onUp() {
      if (!dragging) return; dragging = false;
      const v = tracker.velocity;
      const projected = spring.value + SpringUtil.project(v);
      apply(Math.abs(v) > 300 ? v < 0 : projected < collapsedY / 2, v);
    }
    // Content changes height (tabs, live panel, tools), so keep the collapsed peek the same size.
    new ResizeObserver(() => {
      if (!mq.matches || expanded || dragging) return;
      measure(); spring.set(collapsedY);
    }).observe(sheet);
    sheet.addEventListener('pointerdown', onDown);
    sheet.addEventListener('pointermove', onMove);
    sheet.addEventListener('pointerup', onUp);
    sheet.addEventListener('pointercancel', onUp);
    grabber.addEventListener('click', () => { measure(); apply(!expanded); });
    $('tabs').addEventListener('pointerdown', () => { if (mq.matches && !expanded) { measure(); apply(true); } });
    mq.addEventListener('change', () => { if (!mq.matches) { spring.set(0); expanded = true; } });
  })();

  // ------------------------------------------------------------------ boot
  async function boot() {
    try { const m = await api.get('/api/meta'); $('version').textContent = `v${m.version} · ${m.author}`; } catch {}
    LS.place.renderFavs();
    await LS.device.refresh();
    await refreshStatus();
    const st = state.status;
    if (st && st.location) LS.map.ensureMarker(st.location.lat, st.location.lon);
    if (st && st.base && !st.route) { state.pin = { ...st.base }; LS.place.syncFields(); LS.map.leaflet.setView([st.base.lat, st.base.lon], Math.max(LS.map.leaflet.getZoom(), 14)); }
    if (!LS.tour.seen()) LS.tour.start();
    else if (!LS.connected()) LS.device.show();
    setInterval(refreshStatus, 1000);
    setInterval(() => { if (!LS.connected()) LS.device.refresh(); }, 4000);
  }
  boot();
})();
