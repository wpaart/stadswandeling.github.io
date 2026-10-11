(() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const KEY = 'leuvenwalk.admin';

  // ---------- settings ----------
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
  if (!cfg.owner && location.hostname.endsWith('.github.io')) {       // guess from the Pages URL
    cfg.owner = location.hostname.split('.')[0];
    cfg.repo = location.pathname.split('/')[1] || cfg.owner + '.github.io';
  }
  for (const k of ['owner', 'repo', 'branch', 'token']) if (cfg[k]) $('#' + k).value = cfg[k];
  const readCfg = () => ({ owner: $('#owner').value.trim(), repo: $('#repo').value.trim(), branch: $('#branch').value.trim() || 'main', token: $('#token').value.trim() });
  $('#save-cfg').onclick = () => { cfg = readCfg(); localStorage.setItem(KEY, JSON.stringify(cfg)); log('Settings saved in this browser.'); };
  $('#forget').onclick = () => { localStorage.removeItem(KEY); $('#token').value = ''; cfg.token = ''; log('Token removed.'); };

  const logEl = $('#log');
  function log(msg) { logEl.style.display = 'block'; logEl.textContent += msg + '\n'; logEl.scrollTop = logEl.scrollHeight; }

  // ---------- GitHub API ----------
  async function gh(path, opts = {}) {
    const c = readCfg();
    if (!c.owner || !c.repo || !c.token) throw new Error('Fill in user, repository and token first.');
    const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }
    });
    if (r.status === 404 && opts.allow404) return null;
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(body.message || r.statusText); e.status = r.status; throw e; }
    return body;
  }
  const bytesToB64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const textToB64 = t => bytesToB64(new TextEncoder().encode(t));
  const b64ToText = b => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\n/g, '')), c => c.charCodeAt(0)));
  const blobToB64 = blob => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result.split(',')[1]); f.onerror = rej; f.readAsDataURL(blob); });

  async function getFile(path) {
    const c = readCfg();
    const j = await gh(`contents/${path}?ref=${encodeURIComponent(c.branch)}`, { allow404: true });
    return j ? { sha: j.sha, text: j.content ? b64ToText(j.content) : '' } : null;
  }
  const putFile = (path, b64, message, sha) => gh(`contents/${path}`, {
    method: 'PUT', body: JSON.stringify({ message, content: b64, branch: readCfg().branch, ...(sha ? { sha } : {}) })
  });
  async function updatePhotosJson(mutate, message) {
    for (let i = 0; i < 3; i++) {
      const cur = await getFile('data/photos.json');
      let list = []; try { list = cur && cur.text.trim() ? JSON.parse(cur.text) : []; } catch (e) {}
      const next = mutate(list);
      try { await putFile('data/photos.json', textToB64(JSON.stringify(next, null, 2) + '\n'), message, cur && cur.sha); return next; }
      catch (e) { if (e.status !== 409 && e.status !== 422) throw e; }   // stale sha: re-read and retry
    }
    throw new Error('Could not update data/photos.json (conflict).');
  }

  // ---------- picker map ----------
  const map = L.map('pick-map').setView([50.8785, 4.7015], 15);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  map.on('click', e => {
    if (!active) return alert('Select a photo card first.');
    setPos(active, e.latlng.lat, e.latlng.lng, 'Placed on map');
  });

  // ---------- photo cards ----------
  const items = []; let active = null, counter = 0;

  async function addFiles(files) {
    for (const file of files) {
      const it = { id: ++counter, file, lat: null, lng: null, taken: null, marker: null };
      it.url = URL.createObjectURL(file);
      it.el = document.createElement('div'); it.el.className = 'card';
      it.el.innerHTML = `
        <img src="${it.url}" alt="">
        <div>
          <input type="text" class="t" placeholder="Title" value="${esc(file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '))}" aria-label="Title">
          <input type="text" class="c" placeholder="Caption (optional)" aria-label="Caption" style="margin-top:6px">
          <div class="status">Reading location…</div>
          <div class="row">
            <button class="ghost sel">Place on map</button>
            <button class="ghost here">Use my location</button>
            <button class="danger rm">Remove</button>
          </div>
        </div>`;
      it.el.querySelector('.sel').onclick = () => select(it);
      it.el.querySelector('.here').onclick = () => navigator.geolocation
        ? navigator.geolocation.getCurrentPosition(p => setPos(it, p.coords.latitude, p.coords.longitude, 'Set from your current location'), e => alert(e.message), { enableHighAccuracy: true })
        : alert('Geolocation is not available.');
      it.el.querySelector('.rm').onclick = () => { if (it.marker) it.marker.remove(); it.el.remove(); items.splice(items.indexOf(it), 1); if (active === it) active = null; refresh(); };
      it.el.addEventListener('click', e => { if (e.target.tagName === 'IMG') select(it); });
      $('#cards').appendChild(it.el); items.push(it);

      try {
        const gps = await exifr.gps(file);
        const meta = await exifr.parse(file, ['DateTimeOriginal']).catch(() => null);
        if (meta && meta.DateTimeOriginal) it.taken = new Date(meta.DateTimeOriginal).toISOString();
        if (gps && Number.isFinite(gps.latitude)) setPos(it, gps.latitude, gps.longitude, 'Location read from photo (EXIF)');
        else noGps(it);
      } catch (e) { noGps(it); }
    }
    refresh();
  }
  function noGps(it) { setStatus(it, 'No GPS in this photo. Select it and click the map.', true); select(it); }
  function setStatus(it, msg, bad) { const s = it.el.querySelector('.status'); s.textContent = msg; s.className = 'status ' + (bad ? 'bad' : 'ok'); }
  function select(it) {
    active = it; items.forEach(x => { x.el.classList.toggle('active', x === it); x.marker && x.marker.getElement()?.firstChild?.classList.toggle('active', x === it); });
    if (it.lat != null) map.flyTo([it.lat, it.lng], Math.max(map.getZoom(), 17));
    $('#pick-map').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function setPos(it, lat, lng, why) {
    it.lat = lat; it.lng = lng;
    setStatus(it, `${why}: ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
    const icon = L.divIcon({ className: '', html: `<div class="photo-dot">${items.indexOf(it) + 1}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
    if (!it.marker) {
      it.marker = L.marker([lat, lng], { icon, draggable: true }).addTo(map);
      it.marker.on('dragend', () => { const p = it.marker.getLatLng(); setPos(it, p.lat, p.lng, 'Moved'); });
      it.marker.on('click', () => select(it));
    } else it.marker.setLatLng([lat, lng]);
    if (items.length === 1 || active === it) map.setView([lat, lng], Math.max(map.getZoom(), 16));
    refresh();
  }
  function refresh() { $('#upload').disabled = !items.some(i => i.lat != null); }
  $('#files').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };

  // ---------- upload ----------
  async function toJpeg(file, max = 2400) {      // resize + re-encode; location is stored in photos.json
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
  }

  $('#upload').onclick = async () => {
    const ready = items.filter(i => i.lat != null);
    const btn = $('#upload'); btn.disabled = true; logEl.textContent = '';
    const done = [];
    try {
      for (const it of ready) {
        log(`Uploading ${it.file.name}…`);
        const id = Date.now().toString(36) + '-' + it.id;
        const path = `photos/${id}.jpg`;
        const blob = await toJpeg(it.file);
        await putFile(path, await blobToB64(blob), `Add photo ${id}`);
        done.push({ it, entry: {
          id, file: path, lat: +it.lat.toFixed(6), lng: +it.lng.toFixed(6),
          title: it.el.querySelector('.t').value.trim(), caption: it.el.querySelector('.c').value.trim(),
          taken: it.taken || undefined
        } });
      }
      if (done.length) {
        log('Updating data/photos.json…');
        await updatePhotosJson(list => list.concat(done.map(d => d.entry)), `Add ${done.length} photo(s) to the walk`);
      }
      log(`Done. ${done.length} photo(s) published. The live site updates in about a minute.`);
      done.forEach(({ it }) => { if (it.marker) it.marker.remove(); it.el.remove(); items.splice(items.indexOf(it), 1); });
      loadExisting();
    } catch (e) {
      log('Error: ' + e.message + (e.status === 401 || e.status === 403 ? ' (check the token and its Contents permission)' : ''));
      if (done.length) log(`${done.length} image file(s) were uploaded before the error but are not yet listed in photos.json.`);
    }
    refresh();
  };

  // ---------- existing photos ----------
  async function loadExisting() {
    const box = $('#existing');
    try {
      const cur = await getFile('data/photos.json');
      const list = cur && cur.text.trim() ? JSON.parse(cur.text) : [];
      box.innerHTML = list.length ? list.map(p => `
        <figure><img src="${esc(p.file)}?t=${Date.now()}" alt="">
          <figcaption><b>${esc(p.title || 'Photo')}</b><br><span class="hint">${p.lat}, ${p.lng}</span><br>
          <button class="danger" data-del="${esc(p.id)}" style="margin-top:6px;padding:4px 10px;font-size:13px">Delete</button></figcaption></figure>`).join('')
        : '<p class="hint">No photos published yet.</p>';
    } catch (e) { box.innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
  }
  $('#refresh').onclick = loadExisting;
  $('#existing').onclick = async e => {
    const id = e.target.dataset && e.target.dataset.del; if (!id) return;
    if (!confirm('Delete this photo from the repository?')) return;
    try {
      let removed = null;
      await updatePhotosJson(list => { removed = list.find(p => p.id === id); return list.filter(p => p.id !== id); }, `Remove photo ${id}`);
      if (removed) {
        const f = await getFile(removed.file);
        if (f) await gh(`contents/${removed.file}`, { method: 'DELETE', body: JSON.stringify({ message: `Delete ${removed.file}`, sha: f.sha, branch: readCfg().branch }) });
      }
      log('Photo deleted.'); loadExisting();
    } catch (err) { alert(err.message); }
  };
})();
