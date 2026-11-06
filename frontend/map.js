/* Map: pin, route drawn by leg, stop markers, and the on-course "ghost" while off course. */
(() => {
  'use strict';
  const LS = window.LS;
  const { state } = LS;

  const start = LS.store.get('view', { lat: 33.7537, lon: -84.3915, zoom: 13 }); // MARTA Five Points
  const map = L.map('map', { zoomControl: true, attributionControl: true, worldCopyJump: true })
    .setView([start.lat, start.lon], start.zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  map.on('moveend', () => { const c = map.getCenter(); LS.store.set('view', { lat: c.lat, lon: c.lng, zoom: map.getZoom() }); });

  const pinIcon = L.divIcon({ className: '', html: '<div class="pin"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
  const wpIcon = L.divIcon({ className: '', html: '<div class="wp"></div>', iconSize: [12, 12], iconAnchor: [6, 6] });
  const stopIcon = L.divIcon({ className: '', html: '<div class="stop-dot"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
  const endIcon = L.divIcon({ className: '', html: '<div class="end-dot"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
  const ghostIcon = L.divIcon({ className: '', html: '<div class="ghost"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });

  const routeLayer = L.layerGroup().addTo(map);
  const ghostLayer = L.layerGroup().addTo(map);
  let marker = null;
  let ghost = null;
  let ghostLine = null;
  let routeBounds = null;
  let drawnKey = null;

  function ensureMarker(lat, lon) {
    if (marker) { marker.setLatLng([lat, lon]); return; }
    marker = L.marker([lat, lon], { icon: pinIcon, draggable: true, autoPan: true, zIndexOffset: 1000 }).addTo(map);
    marker.on('dragstart', () => marker.getElement().querySelector('.pin').classList.add('dragging'));
    marker.on('drag', () => { const p = marker.getLatLng(); state.pin = { lat: p.lat, lon: p.lng }; LS.place && LS.place.syncFields(); });
    marker.on('dragend', () => { marker.getElement().querySelector('.pin').classList.remove('dragging'); const p = marker.getLatLng(); placePin(p.lat, p.lng); });
  }

  /** Move the draft pin (what Set Location would send). */
  function placePin(lat, lon, { pan = false } = {}) {
    state.pin = { lat, lon };
    ensureMarker(lat, lon);
    if (pan) map.flyTo([lat, lon], Math.max(map.getZoom(), 15), { duration: SpringUtil.reduceMotion() ? 0 : 0.8 });
    LS.place && LS.place.syncFields();
    LS.render();
  }

  map.on('click', (e) => {
    LS.device && LS.device.close();
    if (state.route.drawing) { LS.trip.addWaypoint(e.latlng.lat, e.latlng.lng); return; }
    placePin(e.latlng.lat, e.latlng.lng);
  });

  /**
   * Draw a route. ``runs`` = [{leg: 'rider'|'transit', start, end}] index ranges over ``points``;
   * without runs the whole path is one plain line.
   */
  function drawRoute(points, runs, { showWaypoints = false, fit = false } = {}) {
    routeLayer.clearLayers();
    routeBounds = null;
    if (!points || points.length < 1) return;
    const ll = points.map((p) => [p.lat, p.lon]);
    if (points.length >= 2) {
      if (runs && runs.length) {
        runs.forEach((r) => {
          const seg = ll.slice(r.start, r.end + 1);
          if (seg.length >= 2) L.polyline(seg, { className: r.leg === 'transit' ? 'route-transit' : 'route-walk', interactive: false }).addTo(routeLayer);
        });
        runs.slice(1).forEach((r) => L.marker(ll[r.start], { icon: stopIcon, interactive: false, title: 'Stop' }).addTo(routeLayer));
      } else {
        L.polyline(ll, { className: 'route-line', interactive: false }).addTo(routeLayer);
      }
      routeBounds = L.latLngBounds(ll);
    }
    if (showWaypoints && points.length <= 60) {
      points.forEach((p) => L.marker([p.lat, p.lon], { icon: wpIcon, interactive: false }).addTo(routeLayer));
    } else {
      L.marker(ll[0], { icon: wpIcon, interactive: false, title: 'Start' }).addTo(routeLayer);
      if (ll.length > 1) L.marker(ll[ll.length - 1], { icon: endIcon, interactive: false, title: 'Destination' }).addTo(routeLayer);
    }
    if (fit) fitRoute();
  }

  function fitRoute() {
    if (routeBounds) map.fitBounds(routeBounds, { padding: [56, 56], maxZoom: 16 });
  }

  function clearRoute() { routeLayer.clearLayers(); routeBounds = null; drawnKey = null; }

  /** Keep the map in step with the backend: active route, live pin, ghost. */
  function sync() {
    const st = state.status;
    const r = st && st.route;
    // Active route from the backend (also covers routes started over the HTTP API).
    if (r && r.points && r.points.length >= 2) {
      const a = r.points[0], b = r.points[r.points.length - 1];
      const key = `${r.points.length}:${a.lat},${a.lon}:${b.lat},${b.lon}:${r.total_m}`;
      if (key !== drawnKey) {
        drawnKey = key;
        drawRoute(r.points, r.legs, { fit: !state.route.gpx && !state.route.waypoints.length });
      }
    } else if (drawnKey && !(r)) {
      drawnKey = null;
      LS.trip && LS.trip.redrawPlan();
    }

    const live = LS.connected() && st.location;
    // A pin the user placed but hasn't sent yet wins; otherwise the marker shows what the phone gets.
    const draftPending = !r && state.pin && (!st || !st.base || LS.hav(state.pin, st.base) > 1);
    const following = live && !draftPending;
    if (following) ensureMarker(st.location.lat, st.location.lon);
    if (marker && marker.dragging) r ? marker.dragging.disable() : marker.dragging.enable();
    const pinEl = marker && marker.getElement() && marker.getElement().querySelector('.pin');
    if (pinEl) {
      pinEl.classList.toggle('live', !!live && !r);
      pinEl.classList.toggle('off', !!(st && st.offset && st.offset.current_m > 0));
      pinEl.classList.toggle('frozen', !!(st && st.gps && st.gps.mode !== 'normal'));
    }

    // Ghost: where the rider "really" is when the published fix is moved away from it.
    const showGhost = following && st.base && st.away_m != null && st.away_m > 3;
    if (showGhost) {
      const base = [st.base.lat, st.base.lon];
      const pub = [st.location.lat, st.location.lon];
      if (!ghost) {
        ghost = L.marker(base, { icon: ghostIcon, interactive: false }).addTo(ghostLayer);
        ghostLine = L.polyline([base, pub], { className: 'ghost-line', interactive: false }).addTo(ghostLayer);
      } else {
        ghost.setLatLng(base);
        ghostLine.setLatLngs([base, pub]);
      }
    } else if (ghost) {
      ghostLayer.clearLayers(); ghost = null; ghostLine = null;
    }
  }
  LS.onRender(sync);

  function removeMarker() {
    if (marker) { marker.remove(); marker = null; }
    ghostLayer.clearLayers(); ghost = null; ghostLine = null;
  }
  LS.map = { leaflet: map, placePin, drawRoute, fitRoute, clearRoute, ensureMarker, removeMarker };
})();
