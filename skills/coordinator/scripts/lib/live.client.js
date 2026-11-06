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
  const applyOpen = (root) => root.querySelectorAll('details[data-d]').forEach((d) => { d.open = openSet.has(d.dataset.d); });
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
    rows.sort((a, b) => (f.sort === 'oldest' ? 1 : -1) * a.dataset.at.localeCompare(b.dataset.at)).forEach((li) => list.appendChild(li));
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

  // Forms: typing in "Other" picks Other; a form being filled is never swapped.
  app.addEventListener('input', (e) => {
    const form = e.target.form; if (!form || form.matches('[data-tl]')) return;
    form.dataset.dirty = '1';
    if (e.target.name === 'other') { const o = form.querySelector('input[value="__other"]'); if (o) o.checked = true; }
  });
  const busy = (el) => { const a = document.activeElement; return (a && a !== body && el.contains(a) && a.form) || el.querySelector('form[data-dirty]'); };

  // Scroll: restored after a reload, held steady across a patch.
  const scrollKey = key(`scroll:${path}`);
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  let t = 0;
  addEventListener('scroll', () => { clearTimeout(t); t = setTimeout(() => save(scrollKey, scrollY), 150); }, { passive: true });

  const keyed = (el) => [...el.children].filter((c) => c.dataset && c.dataset.k);
  let pending = null;
  function sync(oldParent, newParent) {
    const olds = new Map(keyed(oldParent).map((c) => [c.dataset.k, c]));
    const news = keyed(newParent);
    let after = null;
    for (const n of news) {
      const o = olds.get(n.dataset.k); olds.delete(n.dataset.k);
      if (!o) { const ref = after ? after.nextSibling : (keyed(oldParent)[0] || null); oldParent.insertBefore(n, ref); applyOpen(n); after = n; continue; }
      after = o;
      if (o.dataset.h === n.dataset.h) continue;
      if (busy(o)) { pending = true; continue; }
      const nested = keyed(n).length && keyed(n).length === n.children.length && keyed(o).length;
      if (nested) { sync(o, n); o.dataset.h = n.dataset.h; } else { o.replaceWith(n); applyOpen(n); after = n; }
    }
    for (const o of olds.values()) if (!busy(o)) o.remove();
  }
  let latest = null;
  function patch(html) {
    latest = html; pending = false;
    const anchor = keyed(app).find((c) => c.getBoundingClientRect().bottom > 0);
    const top = anchor ? anchor.getBoundingClientRect().top : 0;
    const tpl = document.createElement('template'); tpl.innerHTML = html;
    sync(app, tpl.content);
    if (anchor && anchor.isConnected) scrollBy(0, anchor.getBoundingClientRect().top - top);
    applyTimeline();
  }
  document.addEventListener('focusout', () => setTimeout(() => { if (pending && latest) patch(latest); }, 0));

  // Live updates: Server-Sent Events, reconnect with backoff, a watchdog on the heartbeat.
  const badge = document.getElementById('live');
  const status = (state, text) => { if (badge) { badge.dataset.state = state; badge.textContent = text; } };
  let delay = 1000; let es = null; let seen = 0;
  function connect() {
    status('connecting', 'Connecting…');
    es = new EventSource(`/events?t=${encodeURIComponent(token)}&p=${encodeURIComponent(path)}`);
    es.onopen = () => { delay = 1000; seen = Date.now(); status('live', 'Live'); };
    es.addEventListener('ping', () => { seen = Date.now(); });
    es.addEventListener('patch', (e) => { seen = Date.now(); status('live', 'Live'); try { patch(JSON.parse(e.data).html); } catch { /* bad frame: wait for the next */ } });
    es.onerror = () => retry();
  }
  function retry() {
    if (es) es.close();
    status('reconnecting', `Reconnecting in ${Math.round(delay / 1000)} s…`);
    setTimeout(connect, delay); delay = Math.min(delay * 2, 30000);
  }
  setInterval(() => { if (es && es.readyState === 1 && Date.now() - seen > 45000) retry(); }, 5000);

  applyOpen(document);
  applyTimeline();
  const y = load(scrollKey, 0);
  if (y) requestAnimationFrame(() => scrollTo(0, y));
  connect();
})();
