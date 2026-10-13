(() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = m => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
  function dist(a, b) {                       // haversine, metres
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  async function load(url) {
    const r = await fetch(url + '?t=' + Date.now());
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  }

  const map = L.map('map', { zoomControl: false }).setView([50.8785, 4.7015], 15);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  // ---------- optional historic layers (Digitaal Vlaanderen WMTS, Flanders only) ----------
  // The service offers a Web-Mercator tile matrix set ("GoogleMapsVL"), so plain XYZ addressing works.
  const histUrl = layer => 'https://geo.api.vlaanderen.be/HISTCART/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&LAYER=' + layer +
    '&STYLE=&FORMAT=image/png&TILEMATRIXSET=GoogleMapsVL&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';
  const credit = '&copy; <a href="https://www.vlaanderen.be/digitaal-vlaanderen">Digitaal Vlaanderen</a>';
  const HISTORIC = {
    ferraris:    { label: 'Ferraris map (1771–78)',      layer: L.tileLayer(histUrl('ferraris'),    { maxZoom: 19, attribution: 'Ferraris map ' + credit }) },
    vandermaelen:{ label: 'Vandermaelen map (1846–54)',  layer: L.tileLayer(histUrl('vandermaelen'), { maxZoom: 19, attribution: 'Vandermaelen map ' + credit }) }
  };

  const PREF = 'leuvenwalk.layers';
  let prefs = { historic: 'none', opacity: 75 };
  try {
    const saved = JSON.parse(localStorage.getItem(PREF) || '{}');
    if (saved.ferraris === true && !saved.historic) saved.historic = 'ferraris';   // older saved format
    prefs = { ...prefs, ...saved };
  } catch (e) {}
  if (prefs.historic !== 'none' && !HISTORIC[prefs.historic]) prefs.historic = 'none';
  const savePrefs = () => { try { localStorage.setItem(PREF, JSON.stringify({ historic: prefs.historic, opacity: prefs.opacity })); } catch (e) {} };

  document.querySelector('.fabs').insertAdjacentHTML('afterbegin', `
    <button id="layers-btn" class="fab" aria-label="Map layers" aria-expanded="false" title="Map layers">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/></svg>
    </button>`);
  document.body.insertAdjacentHTML('beforeend', `
    <div id="layers-panel" hidden>
      <strong>Historic map</strong>
      <label class="chk"><input type="radio" name="hist" value="none"> None</label>
      ${Object.entries(HISTORIC).map(([k, h]) => `<label class="chk"><input type="radio" name="hist" value="${k}"> ${h.label}</label>`).join('')}
      <label class="op">Opacity <input type="range" id="l-op" min="20" max="100" step="5"></label>
      <p>Covers Flanders only. Lower the opacity to see today's streets through the old map. <span style="opacity:.6">(app v5)</span></p>
    </div>`);

  // Core positioning is set inline so the panel is visible even if an older style.css is cached/deployed.
  Object.assign($('#layers-panel').style, {
    position: 'fixed', zIndex: '1000', top: 'calc(10px + env(safe-area-inset-top, 0px))', right: '64px',
    width: 'min(280px, calc(100vw - 150px))', background: '#fff', borderRadius: '12px',
    boxShadow: '0 2px 12px rgba(0,0,0,.35)', padding: '12px 14px', fontSize: '14px', boxSizing: 'border-box'
  });

  function applyLayers() {
    Object.entries(HISTORIC).forEach(([k, h]) => {
      if (k === prefs.historic) { h.layer.setOpacity(prefs.opacity / 100); h.layer.addTo(map); } else h.layer.remove();
    });
    document.querySelectorAll('input[name="hist"]').forEach(r => r.checked = r.value === prefs.historic);
    $('#l-op').value = prefs.opacity; $('#l-op').disabled = prefs.historic === 'none';
  }
  document.querySelectorAll('input[name="hist"]').forEach(r => r.onchange = () => { prefs.historic = r.value; savePrefs(); applyLayers(); });
  $('#l-op').oninput = e => { prefs.opacity = +e.target.value; const h = HISTORIC[prefs.historic]; if (h) h.layer.setOpacity(prefs.opacity / 100); };
  $('#l-op').onchange = savePrefs;
  $('#layers-btn').onclick = () => {
    const panel = $('#layers-panel'); panel.hidden = !panel.hidden;
    $('#layers-btn').setAttribute('aria-expanded', String(!panel.hidden));
  };
  map.on('click', () => { $('#layers-panel').hidden = true; $('#layers-btn').setAttribute('aria-expanded', 'false'); });
  applyLayers();

  let walk = { stops: [] }, photos = [], me = null, following = false, watchId = null;
  const photoMarkers = new Map(), stopMarkers = new Map(), seenNear = new Set();
  let meMarker = null, meCircle = null;

  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
  }

  // ---------- walk ----------
  function renderStops() {
    walk.stops.forEach((s, i) => {
      const m = L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: '', html: `<div class="stop-pin">${i + 1}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] })
      }).addTo(map).bindPopup(`<div class="pop"><h3>${esc(s.name)}</h3><p>${esc(s.text)}</p></div>`);
      stopMarkers.set(s.id, m);
    });
  }

  async function drawRoute() {
    let line = walk.stops.map(s => [s.lat, s.lng]), snapped = false, total = 0;
    try {   // snap to footpaths using the public OSM foot router; fall back to straight lines
      const coords = walk.stops.map(s => `${s.lng},${s.lat}`).join(';');
      const r = await fetch(`https://routing.openstreetmap.de/routed-foot/route/v1/foot/${coords}?overview=full&geometries=geojson`);
      const j = await r.json();
      if (j.code === 'Ok') {
        line = j.routes[0].geometry.coordinates.map(([x, y]) => [y, x]);
        total = j.routes[0].distance; snapped = true;
      }
    } catch (e) { /* offline or rate-limited: keep the straight line */ }
    if (!snapped) for (let i = 1; i < line.length; i++) total += dist(line[i - 1], line[i]);
    L.polyline(line, { color: '#fff', weight: 9, opacity: .9 }).addTo(map);
    const route = L.polyline(line, { color: '#14213d', weight: 5, dashArray: snapped ? null : '8 8' }).addTo(map);
    if (!me) map.fitBounds(route.getBounds().pad(0.15));
    $('#walk-meta').textContent = `${walk.stops.length} stops · ${fmt(total)}${snapped ? '' : ' (straight lines)'}`;
  }

  // ---------- photos ----------
  const photoIcon = (p, near) => L.divIcon({
    className: '', iconSize: [48, 48], iconAnchor: [24, 24],
    html: `<div class="photo-pin${near ? ' near' : ''}"><img src="${esc(p.file)}" alt="" loading="lazy"></div>`
  });
  function popupHtml(p) {
    const d = me ? `<small>${fmt(dist([me.lat, me.lng], [p.lat, p.lng]))} from you</small>` : '';
    return `<div class="pop"><img class="pop-img" src="${esc(p.file)}" alt="${esc(p.title)}" data-full="${esc(p.id)}">
      <h3>${esc(p.title || 'Photo')}</h3>${p.caption ? `<p>${esc(p.caption)}</p>` : ''}${d}
      <div><button class="pop-full" data-full="${esc(p.id)}">View full size</button></div></div>`;
  }
  function renderPhotos() {
    photoMarkers.forEach(m => m.remove()); photoMarkers.clear();
    photos.forEach(p => {
      const m = L.marker([p.lat, p.lng], { icon: photoIcon(p, false), zIndexOffset: 500 }).addTo(map);
      m.bindPopup(() => popupHtml(p), { className: 'photo-popup', maxWidth: 640, autoPanPadding: [12, 70] });
      photoMarkers.set(p.id, m);
    });
    $('#photo-count').textContent = photos.length;
  }

  // ---------- lists ----------
  function renderLists() {
    const here = me ? [me.lat, me.lng] : null;
    $('#panel-walk').innerHTML = walk.stops.map((s, i) => `
      <button class="stop-item" data-stop="${esc(s.id)}">
        <div class="n">${i + 1}</div>
        <div><strong>${esc(s.name)}</strong><span class="t">${esc(s.text)}</span></div>
        ${here ? `<div class="d">${fmt(dist(here, [s.lat, s.lng]))}</div>` : ''}
      </button>`).join('');

    const rad = +$('#radius').value;
    const rows = photos.map(p => ({ p, d: here ? dist(here, [p.lat, p.lng]) : null }));
    if (here) rows.sort((a, b) => a.d - b.d);
    $('#photo-list').innerHTML = rows.length ? rows.map(({ p, d }) => `
      <button class="pcard${d != null && d <= rad ? ' near' : ''}" data-photo="${esc(p.id)}">
        <img src="${esc(p.file)}" alt="" loading="lazy">
        <div><strong>${esc(p.title || 'Photo')}</strong>${d != null ? `<small>${fmt(d)} away</small>` : ''}</div>
      </button>`).join('')
      : '<p class="empty">No photos yet. Add some on the admin page.</p>';
  }

  function checkNearby() {
    if (!me) return;
    const rad = +$('#radius').value;
    photos.forEach(p => {
      const near = dist([me.lat, me.lng], [p.lat, p.lng]) <= rad;
      const m = photoMarkers.get(p.id);
      if (near && !seenNear.has(p.id)) {
        seenNear.add(p.id);
        m.setIcon(photoIcon(p, true));
        toast(`Photo nearby: ${p.title || 'Untitled'}`);
        if (navigator.vibrate) navigator.vibrate(120);
      } else if (!near && seenNear.has(p.id)) {
        seenNear.delete(p.id); m.setIcon(photoIcon(p, false));
      }
    });
  }

  // ---------- geolocation ----------
  function onPosition(pos) {
    me = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
    const ll = [me.lat, me.lng];
    if (!meMarker) {
      meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000, interactive: false }).addTo(map);
      meCircle = L.circle(ll, { radius: me.acc, color: '#1a73e8', weight: 1, fillOpacity: .1, interactive: false }).addTo(map);
      map.setView(ll, Math.max(map.getZoom(), 17));
      $('#follow').hidden = false;
    } else {
      meMarker.setLatLng(ll); meCircle.setLatLng(ll).setRadius(me.acc);
      if (following) map.panTo(ll);
    }
    checkNearby(); renderLists();
  }
  function onError(err) {
    toast({ 1: 'Location permission denied. Enable it in your browser settings.',
            2: 'Your position is not available right now.', 3: 'Locating timed out.' }[err.code] || err.message);
  }
  function startLocate() {
    if (!('geolocation' in navigator)) return toast('This browser has no geolocation support.');
    if (watchId != null) { if (me) map.setView([me.lat, me.lng], Math.max(map.getZoom(), 17)); return; }
    watchId = navigator.geolocation.watchPosition(onPosition, onError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }

  // ---------- UI wiring ----------
  $('#locate').onclick = startLocate;
  $('#follow').onclick = () => {
    following = !following; $('#follow').setAttribute('aria-pressed', following);
    if (following && me) map.panTo([me.lat, me.lng]);
  };
  map.on('dragstart', () => { following = false; $('#follow').setAttribute('aria-pressed', 'false'); });
  $('#radius').onchange = () => { seenNear.clear(); photos.forEach(p => photoMarkers.get(p.id)?.setIcon(photoIcon(p, false))); checkNearby(); renderLists(); };
  $('#handle').onclick = () => $('#sheet').classList.toggle('collapsed');
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    $('#panel-walk').hidden = b.dataset.p !== 'walk'; $('#panel-photos').hidden = b.dataset.p !== 'photos';
    $('#sheet').classList.remove('collapsed');
  });
  $('#sheet').addEventListener('click', e => {
    const s = e.target.closest('[data-stop]'), p = e.target.closest('[data-photo]');
    if (s) { const m = stopMarkers.get(s.dataset.stop); map.flyTo(m.getLatLng(), 18); m.openPopup(); $('#sheet').classList.add('collapsed'); }
    if (p) { const m = photoMarkers.get(p.dataset.photo); map.flyTo(m.getLatLng(), 19); m.openPopup(); $('#sheet').classList.add('collapsed'); }
  });

  // re-measure the popup once its image has loaded so it fits and stays on screen
  map.on('popupopen', e => {
    const img = e.popup.getElement()?.querySelector('.pop-img');
    if (img && !img.complete) img.addEventListener('load', () => e.popup.update(), { once: true });
  });

  // ---------- full-size viewer ----------
  // The viewer markup normally lives in index.html; create it here if it is missing
  // (for example when an older index.html is still deployed).
  if (!$('#lightbox')) {
    document.body.insertAdjacentHTML('beforeend', `
      <div id="lightbox" hidden role="dialog" aria-modal="true" aria-label="Full-size photo">
        <button id="lb-close" aria-label="Close photo">&times;</button>
        <div id="lb-scroll"><img id="lb-img" alt=""></div>
        <p id="lb-cap"></p>
      </div>`);
  }
  const lb = $('#lightbox'), lbImg = $('#lb-img'), lbScroll = $('#lb-scroll');
  function openLightbox(id) {
    const p = photos.find(x => x.id === id); if (!p) return;
    lbScroll.classList.remove('zoomed');
    lbImg.src = p.file; lbImg.alt = p.title || '';
    $('#lb-cap').textContent = [p.title, p.caption].filter(Boolean).join(' · ');
    lb.hidden = false; $('#lb-close').focus();
  }
  function closeLightbox() { lb.hidden = true; lbImg.removeAttribute('src'); }
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-full]');
    if (t && !lb.contains(t)) openLightbox(t.dataset.full);
  });
  lbImg.onclick = () => lbScroll.classList.toggle('zoomed');   // tap: fit screen <-> actual pixels
  $('#lb-close').onclick = closeLightbox;
  lbScroll.onclick = e => { if (e.target === lbScroll) closeLightbox(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !lb.hidden) closeLightbox(); });

  // ---------- start ----------
  (async () => {
    try { walk = await load('data/walk.json'); }
    catch (e) { toast('Could not load the walk data.'); console.error(e); return; }
    $('#walk-title').textContent = walk.title; document.title = walk.title;
    map.setView(walk.center, 15);
    renderStops();
    try { photos = await load('data/photos.json'); } catch (e) { console.warn(e); photos = []; }
    renderPhotos(); renderLists();
    drawRoute();
  })();
})();
