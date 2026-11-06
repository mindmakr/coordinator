// The live dashboard's only script (served with a per-response nonce; `matches`
// is prepended from lib/timeline.mjs). It listens to /events, swaps only the
// blocks whose hash changed, never a block holding a half-filled form, and
// keeps open toggles, scroll, theme and timeline filters per browser.
(() => {
  const body = document.body;
  const run = body.dataset.run; const path = body.dataset.path; const token = body.dataset.token;
  const app = document.getElementById('app');
  const key = (k) => `coordinator:${run}:${k}`;
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window: no memory */ } };

  // Theme: system, light or dark; the checked radio drives the CSS.
  const theme = load('coordinator:theme', 'system');
  const radio = document.getElementById(`theme-${theme}`);
  if (radio) radio.checked = true;
  document.querySelectorAll('input[name="theme"]').forEach((r) => r.addEventListener('change', () => save('coordinator:theme', r.value)));

  // Open toggles, by their data-d key, for every page of this run.
  const openSet = new Set(load(key('open'), []));
  const applyOpen = (root) => {
    if (root.nodeType !== 1 && root !== document) return;
    const all = [...root.querySelectorAll('details[data-d]')];
    if (root.matches && root.matches('details[data-d]')) all.push(root);
    all.forEach((d) => { d.open = openSet.has(d.dataset.d); });
  };
  document.addEventListener('toggle', (e) => {
    const d = e.target; if (!d.dataset || !d.dataset.d) return;
    if (d.open) openSet.add(d.dataset.d); else openSet.delete(d.dataset.d);
    save(key('open'), [...openSet]);
  }, true);

  // Timeline: search, kinds, units, range and sort, remembered per page.
  const tools = document.querySelector('form[data-tl]');
  const tlKey = key(`tl:${path}`);
  function readTools() {
    const f = new FormData(tools);
    return { q: f.get('q') || '', range: f.get('range') || 'all', sort: f.get('sort') || 'newest', kinds: f.getAll('kind'), units: f.getAll('unit') };
  }
  function applyTimeline() {
    const list = document.querySelector('[data-tl-list]');
    if (!tools || !list) return;
    const f = readTools(); const now = Date.now();
    const rows = [...list.querySelectorAll('li[data-at]')];
    let shown = 0;
    for (const li of rows) {
      const ok = matches({ at: li.dataset.at, badge: li.dataset.badge, unit: li.dataset.unit, label: '', who: '', text: li.textContent }, f, now);
      li.hidden = !ok; if (ok) shown++;
    }
    body.dataset.sort = f.sort; // CSS reverses the list: rows never move, so the scroll anchor holds
    const count = tools.querySelector('[data-tl-count]');
    if (count) count.textContent = `${shown} of ${rows.length} events`;
  }
  if (tools) {
    const s = load(tlKey, null);
    if (s) {
      tools.q.value = s.q || ''; tools.range.value = s.range || 'all'; tools.sort.value = s.sort || 'newest';
      tools.querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = (c.name === 'kind' ? s.kinds : s.units || []).includes(c.value); });
    }
    const changed = () => { save(tlKey, readTools()); applyTimeline(); };
    tools.addEventListener('input', changed); tools.addEventListener('change', changed);
    tools.addEventListener('submit', (e) => e.preventDefault());
  }

  // Show finished units (passed, stopped) or not: the checkbox drives the CSS; remembered here.
  const fin = document.getElementById('show-finished');
  if (fin) { fin.checked = load(key('finished'), true); fin.addEventListener('change', () => save(key('finished'), fin.checked)); }

  // Forms: typing in "Other" picks Other; a form being filled is never swapped.
  app.addEventListener('input', (e) => {
    const form = e.target.form; if (!form || form.matches('[data-tl]')) return;
    form.dataset.dirty = '1';
    if (e.target.name === 'other') { const o = form.querySelector('input[value="__other"]'); if (o) o.checked = true; }
  });
  const busy = (form) => !!form.dataset.dirty || form.contains(document.activeElement);

  // Scroll: restored after a reload, held steady across a patch.
  const scrollKey = key(`scroll:${path}`);
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  let t = 0;
  // Every keyed element (blocks, headings, cards, rows) with where it sits now.
  const places = () => [...app.querySelectorAll('[data-k],[data-a]')].map((el) => {
    const r = el.getBoundingClientRect();
    return { key: el.dataset.a ? `a:${el.dataset.a}` : `k:${el.dataset.k}`, top: r.top, bottom: r.bottom };
  });
  let restoring = true; // until the saved place is back, scrolling does not overwrite it
  addEventListener('scroll', () => {
    if (restoring) return;
    clearTimeout(t); t = setTimeout(() => save(scrollKey, { y: scrollY, anchor: pickAnchor(places()) }), 150);
  }, { passive: true });

  // Times: the viewer's locale and zone. Relative within 24 h, local date-time otherwise;
  // the full local time with its zone on hover. The datetime attribute stays ISO (filters read data-at).
  const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' });
  const short = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const rel = typeof Intl.RelativeTimeFormat === 'function' ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;
  function localTime(el) {
    const t = Date.parse(el.getAttribute('datetime')); if (Number.isNaN(t)) return;
    const s = Math.round((t - Date.now()) / 1000); const a = Math.abs(s);
    let text;
    if (!rel || a >= 86400) text = short.format(t);
    else if (a < 45) text = rel.format(0, 'second');
    else if (a < 3600) text = rel.format(Math.round(s / 60), 'minute');
    else text = rel.format(Math.round(s / 3600), 'hour');
    el.textContent = text; el.title = full.format(t);
  }
  const localTimes = (root) => root.querySelectorAll('time[datetime]').forEach(localTime);
  setInterval(() => localTimes(document), 30000);

  // In place: kept nodes keep the browser's own scroll anchoring working. Where the
  // browser has none, the keyed anchor (lib/anchor.mjs) corrects the scroll, after the filters ran.
  const nativeAnchor = !!(window.CSS && CSS.supports && CSS.supports('overflow-anchor', 'auto'));
  let pending = false; let latest = null;
  function patch(html) {
    latest = html; pending = false;
    const anchor = nativeAnchor ? null : pickAnchor(places());
    const tpl = document.createElement('template'); tpl.innerHTML = html;
    morph(app, tpl.content, { busy, skipped: () => { pending = true; }, added: applyOpen });
    localTimes(app);
    applyTimeline();
    const delta = anchor ? scrollDelta(anchor, places()) : 0;
    if (delta) scrollBy(0, delta);
  }
  document.addEventListener('focusout', () => setTimeout(() => { if (pending && latest) patch(latest); }, 0));

  // Live updates: Server-Sent Events, reconnect with backoff, a watchdog on the heartbeat.
  const badge = document.getElementById('live');
  const closed = body.dataset.closed === '1';
  const status = (state, text) => { if (badge && !closed) { badge.dataset.state = state; badge.textContent = text; } };
  let failures = 0;
  let delay = 1000; let es = null; let seen = 0;
  function connect() {
    status('connecting', 'Connecting…');
    es = new EventSource(`/events?t=${encodeURIComponent(token)}&p=${encodeURIComponent(path)}`);
    es.onopen = () => { delay = 1000; failures = 0; seen = Date.now(); status('live', 'Live'); };
    es.addEventListener('ping', () => { seen = Date.now(); });
    es.addEventListener('patch', (e) => { seen = Date.now(); status('live', 'Live'); try { patch(JSON.parse(e.data).html); } catch { /* bad frame: wait for the next */ } });
    es.onerror = () => retry();
  }
  function retry() {
    if (es) es.close();
    failures++;
    // After five tries in a row it says so plainly, and keeps trying every 30 s.
    if (failures > 5) status('disconnected', 'Disconnected · retrying'); else status('reconnecting', `Reconnecting in ${Math.round(delay / 1000)} s…`);
    setTimeout(connect, delay); delay = Math.min(delay * 2, 30000);
  }
  setInterval(() => { if (es && es.readyState === 1 && Date.now() - seen > 45000) retry(); }, 5000);

  applyOpen(document);
  localTimes(document);
  applyTimeline();
  // Restore once layout has settled (images and fonts), by the saved anchor's key, else the saved offset.
  const saved = load(scrollKey, null);
  const settle = () => new Promise((ok) => (document.readyState === 'complete' ? ok() : addEventListener('load', ok, { once: true })))
    .then(() => (document.fonts ? document.fonts.ready : null)).then(() => new Promise((ok) => requestAnimationFrame(ok)));
  settle().then(() => {
    const y = typeof saved === 'number' ? saved : saved && saved.y; // 0.5.0 before this stored a bare number
    if (y) scrollTo(0, y);
    const delta = saved && saved.anchor ? scrollDelta(saved.anchor, places()) : 0;
    if (delta) scrollBy(0, delta);
  }).finally(() => { restoring = false; });
  connect();
})();
