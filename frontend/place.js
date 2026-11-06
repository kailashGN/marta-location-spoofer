/* Place tab: coordinates, Set / Stop Simulating, favourites, and the top-bar search. */
(() => {
  'use strict';
  const LS = window.LS;
  const { $, state, api, esc, fmt } = LS;

  function syncFields() {
    if (!state.pin) return;
    if (document.activeElement !== $('lat')) $('lat').value = fmt(state.pin.lat);
    if (document.activeElement !== $('lon')) $('lon').value = fmt(state.pin.lon);
    $('coord-error').hidden = true;
    $('lat').classList.remove('invalid'); $('lon').classList.remove('invalid');
  }

  function render() {
    const st = state.status;
    const connected = LS.connected();
    const r = LS.activeRoute();
    const simulating = connected && !!st.base;
    $('sim-chip').hidden = !simulating;
    $('sim-chip').textContent = r ? 'Trip running' : 'Simulating';
    $('btn-set').disabled = !connected || !state.pin;
    $('btn-clear').disabled = !simulating;
    $('btn-fav-add').disabled = !state.pin;
    let hint = 'Click the map or search to place the pin.';
    if (!connected) hint = 'Connect a phone first (tap the pill at the top).';
    else if (r) hint = 'A trip is running. Setting a location here stops it.';
    else if (simulating && state.pin && st.base && LS.hav(state.pin, st.base) > 1) hint = 'Pin moved · press Set Location to send it.';
    $('place-hint').textContent = hint;
  }
  LS.onRender(render);

  async function doSet() {
    if (!state.pin) return;
    if (LS.activeRoute() && !confirm('Stop the running trip and set this location?')) return;
    state.lastAction = doSet;
    await LS.busy($('btn-set'), async () => {
      try {
        LS.applyStatus(await api.post('/api/location', state.pin));
        LS.toast('done', `Location set · ${fmt(state.pin.lat)}, ${fmt(state.pin.lon)}`);
      } catch (e) { LS.handleError(e, doSet); }
    });
  }
  async function doClear() {
    await LS.busy($('btn-clear'), async () => {
      try { LS.applyStatus(await api.del('/api/location')); LS.toast('done', 'Stopped · real GPS restored'); }
      catch (e) { LS.handleError(e); }
    });
  }
  $('btn-set').addEventListener('click', doSet);
  $('btn-clear').addEventListener('click', doClear);

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
    $(id).addEventListener('input', () => { const c = readFields(); if (c) { state.pin = c; LS.map.ensureMarker(c.lat, c.lon); LS.render(); } });
    $(id).addEventListener('change', () => { const c = readFields(); if (c) LS.map.placePin(c.lat, c.lon, { pan: true }); });
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') { const c = readFields(); if (c) { LS.map.placePin(c.lat, c.lon, { pan: true }); doSet(); } } });
  });

  // Favourites
  function renderFavs() {
    const ul = $('fav-list'); ul.innerHTML = '';
    state.favs.forEach((f, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<div class="fav-main" role="button" tabindex="0"><div class="fav-name">${esc(f.name)}</div><div class="fav-coords">${fmt(f.lat)}, ${fmt(f.lon)}</div></div>
        <button class="icon-btn" title="Remove" aria-label="Remove ${esc(f.name)}"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>`;
      const go = () => LS.map.placePin(f.lat, f.lon, { pan: true });
      li.querySelector('.fav-main').addEventListener('click', go);
      li.querySelector('.fav-main').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      li.querySelector('.icon-btn').addEventListener('click', () => { state.favs.splice(i, 1); LS.store.set('favs', state.favs); renderFavs(); LS.toast('done', 'Removed favourite'); });
      ul.appendChild(li);
    });
  }
  $('btn-fav-add').addEventListener('click', () => {
    if (!state.pin) return;
    const name = prompt('Name this place', `${fmt(state.pin.lat)}, ${fmt(state.pin.lon)}`);
    if (!name) return;
    state.favs.unshift({ name, lat: state.pin.lat, lon: state.pin.lon });
    LS.store.set('favs', state.favs); renderFavs(); LS.toast('done', 'Saved to favourites');
  });

  // Search (Nominatim, debounced) + "lat, lon" paste
  const results = $('search-results');
  let searchTimer = 0, searchAbort = null, activeIdx = -1;
  const resultsSpring = new Spring({ value: 0, response: 0.3, damping: 1, onUpdate: (v) => { results.style.transform = `scaleY(${0.9 + 0.1 * v}) translateY(${(1 - v) * -6}px)`; results.style.opacity = String(v); } });
  function showResults(items) {
    results.innerHTML = ''; activeIdx = -1;
    if (!items.length) { hideResults(); return; }
    items.forEach((it) => {
      const li = document.createElement('li'); li.setAttribute('role', 'option');
      li.innerHTML = `${esc(it.title)}<small>${esc(it.subtitle || '')}</small>`;
      li.addEventListener('pointerdown', (e) => { e.preventDefault(); choose(it); });
      results.appendChild(li);
    });
    results.hidden = false; resultsSpring.onRest = null; resultsSpring.to(1);
  }
  function hideResults() { resultsSpring.onRest = () => { results.hidden = true; }; resultsSpring.to(0); }
  function choose(it) {
    LS.map.placePin(it.lat, it.lon, { pan: true });
    $('search').value = it.title; hideResults(); $('search').blur();
    if (!state.route.drawing) LS.tabs.show('place');
  }
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
      } catch (e) { if (e.name !== 'AbortError') LS.toast('warn', 'Search is unavailable offline'); }
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

  LS.place = { syncFields, renderFavs, doSet };
})();
