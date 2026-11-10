/* Location Spoofer — shared core: namespace, API, state, formatting, feedback. Author: kailash-hubspire
 * Every other script hangs off window.LS. Load order: spring → core → map → device → place → trip → tools → info → tour → app.
 */
(() => {
  'use strict';
  const LS = (window.LS = window.LS || {});
  const $ = (LS.$ = (id) => document.getElementById(id));

  // MARTA's off-course distance (marta-mobile-app LIVE_TRIP_CONFIG.OFF_COURSE_METERS, half a mile).
  LS.MARTA = { OFF_COURSE_M: 805 };

  // Theme: follows the system unless ?theme=light|dark was given (remembered per browser).
  (() => {
    const q = new URLSearchParams(location.search).get('theme');
    let t = q; if (q === 'system') { try { localStorage.removeItem('ls.theme'); } catch {} t = null; }
    if (q && q !== 'system') { try { localStorage.setItem('ls.theme', q); } catch {} }
    if (!t) { try { t = localStorage.getItem('ls.theme'); } catch {} }
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  })();

  // ------------------------------------------------------------------ API
  LS.api = {
    async call(method, path, body) {
      const res = await fetch(path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = typeof data.detail === 'string' ? data.detail : data.detail?.[0]?.msg;
        const err = new Error(data.error || detail || res.statusText);
        err.steps = data.steps || [];
        err.code = data.code || 'error';
        throw err;
      }
      return data;
    },
    get: (p) => LS.api.call('GET', p),
    post: (p, b) => LS.api.call('POST', p, b || {}),
    del: (p) => LS.api.call('DELETE', p),
  };

  // ------------------------------------------------------------------ state
  LS.store = {
    get(key, fallback) { try { const v = localStorage.getItem(`ls.${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(`ls.${key}`, JSON.stringify(value)); } catch {} },
  };

  LS.state = {
    devices: [],
    adb: null,          // {available, message} from /api/devices
    selected: null,     // udid
    status: null,       // backend snapshot (/api/status)
    pin: null,          // {lat, lon} draft pin
    tab: 'place',
    route: {
      drawing: false,
      waypoints: [],    // [{lat, lon}]
      gpx: null,        // {name, text, hasTimes, startsWalking, legs: [{leg, start, end, seconds}], firstMove, end}
      speed: 1.4,       // m/s for untimed routes
      scale: 1,         // time scale for timed GPX
    },
    log: { seq: -1, entries: [] },
    lastAction: null,
    favs: LS.store.get('favs', []),
  };

  // ------------------------------------------------------------------ format
  LS.fmt = (n) => Number(n).toFixed(6);
  LS.fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 1 : 2)} km` : `${Math.round(m)} m`);
  LS.fmtTime = (s) => {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    if (h) return `${h} h ${m} min`;
    return m ? `${m} min ${r} s` : `${r} s`;
  };
  LS.fmtMin = (s) => { const m = Math.round(s / 60); return m < 1 ? '<1 min' : m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
  LS.fmtClock = (epochS) => new Date(epochS * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  LS.fmtX = (f) => `${Number(f).toFixed(2).replace(/\.?0+$/, '')}×`;
  LS.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  LS.hav = (a, b) => {
    const R = 6371000, r = Math.PI / 180, dp = (b.lat - a.lat) * r, dl = (b.lon - a.lon) * r;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  LS.routeLength = (pts) => { let d = 0; for (let i = 1; i < pts.length; i++) d += LS.hav(pts[i - 1], pts[i]); return d; };

  // Derived status helpers
  LS.connected = () => !!(LS.state.status && LS.state.status.connected);
  LS.activeRoute = () => (LS.state.status && LS.state.status.route) || null;
  LS.practising = () => LS.connected() && LS.state.status.udid === 'demo';
  LS.simulating = () => LS.connected() && !!LS.state.status.base;

  // ------------------------------------------------------------------ render registry
  const renderers = [];
  LS.onRender = (fn) => renderers.push(fn);
  let queued = false;
  LS.render = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; renderers.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } }); });
  };

  // ------------------------------------------------------------------ toasts (spring in/out)
  LS.toast = (kind, text, ms = 2600) => {
    const el = document.createElement('div');
    el.className = `toast ${kind}`; el.textContent = text;
    $('toasts').appendChild(el);
    const s = new Spring({ value: -24, response: 0.35, damping: 1, onUpdate: (v) => { el.style.transform = `translateY(${v}px)`; el.style.opacity = String(Math.max(0, 1 + v / 24)); } });
    s.to(0);
    setTimeout(() => { s.to(-24, { response: 0.3 }); s.onRest = () => el.remove(); }, ms);
  };

  /** Draw the eye to a control a guide just pointed at. */
  LS.flash = (el) => {
    if (!el) return;
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 2400);
  };

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

  LS.handleError = (err, retry) => {
    if (err.steps && err.steps.length) recover.show(err.message, err.steps, retry);
    else LS.toast('error', err.message || 'Something went wrong');
  };

  /** Apply a backend snapshot returned by an action. */
  LS.applyStatus = (st) => { if (st && typeof st === 'object' && 'connected' in st) LS.state.status = st; LS.render(); };

  // ------------------------------------------------------------------ buttons: press feedback + busy state
  document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.btn, .preset'); if (!b) return;
    b.classList.add('pressed');
    const up = () => { b.classList.remove('pressed'); ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => b.removeEventListener(t, up)); };
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => b.addEventListener(t, up));
  });
  LS.busy = async (btn, fn) => {
    btn.classList.add('busy'); btn.disabled = true;
    try { return await fn(); } finally { btn.classList.remove('busy'); btn.disabled = false; LS.render(); }
  };

  // ------------------------------------------------------------------ segmented control with a spring thumb
  /**
   * Wire a `.seg` element. Items carry `data-*` values; the selected one has aria-checked (or
   * aria-selected for tabs). `onChange(item)` runs on pointer-down, per the design rules.
   */
  LS.seg = (root, { onChange, attr = 'aria-checked' } = {}) => {
    const items = [...root.querySelectorAll('.seg-item')];
    const thumb = root.querySelector('.seg-thumb');
    const spring = new Spring({ value: 0, response: 0.3, damping: 1, onUpdate: (v) => { thumb.style.transform = `translateX(${v}px)`; } });
    const api = {
      items,
      selected: () => items.find((b) => b.getAttribute(attr) === 'true') || null,
      sync(animate = true) {
        const sel = api.selected();
        thumb.style.opacity = sel ? '1' : '0';
        if (!sel || !root.offsetWidth) return;
        thumb.style.width = `${sel.offsetWidth}px`;
        const x = sel.offsetLeft - 2;
        animate ? spring.to(x) : spring.set(x);
      },
      select(item, animate = true) {
        items.forEach((x) => x.setAttribute(attr, String(x === item)));
        api.sync(animate);
      },
      clear() {
        items.forEach((x) => x.setAttribute(attr, 'false'));
        api.sync(false);
      },
      selectBy(key, value, animate = true) {
        const item = items.find((b) => b.dataset[key] === String(value));
        if (item && item !== api.selected()) api.select(item, animate);
        else if (item) api.sync(false);
        return item;
      },
    };
    items.forEach((b) => b.addEventListener('pointerdown', (e) => {
      if (b.disabled || e.button > 0) return;
      api.select(b);
      onChange && onChange(b);
    }));
    items.forEach((b) => b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!b.disabled) { api.select(b); onChange && onChange(b); } }
    }));
    new ResizeObserver(() => api.sync(false)).observe(root);
    requestAnimationFrame(() => api.sync(false));
    return api;
  };
})();
