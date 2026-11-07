// The evidence viewer on the live page (lib/evview.mjs draws the overlays; CSS
// shows the one the URL hash names, so a reload reopens it). This adds: focus
// moved in and kept inside, Escape and Close returning focus to what opened it,
// arrow keys and swipe for Previous / Next in the order of the list it was
// opened from (hidden timeline rows skipped, the timeline's sort followed), and
// a stored log's text. Listeners sit on the document, so a live patch keeps them.
(() => {
  const ITEM = '[data-evv-item]';
  // The shade (aria-hidden, tabindex -1) closes on a click only; it is never in the Tab order.
  const FOCUSABLE = 'a[href]:not([tabindex="-1"]):not([aria-hidden="true"]), input, button, select, textarea, [tabindex="0"]';
  let shown = null; let from = null; let list = null; // the open overlay, what opened it, and its list
  // Which list it was opened from, by its block key, so a reload counts the same way.
  const LIST = `coordinator:${document.body.dataset.run}:evlist:${document.body.dataset.path}`;
  const listKey = (l) => { const b = l && l.closest('[data-k]'); return b ? b.dataset.k : ''; };
  const remember = (id, l) => { try { sessionStorage.setItem(LIST, JSON.stringify({ id, k: listKey(l) })); } catch { /* storage blocked */ } };
  function recall(id) {
    try {
      const m = JSON.parse(sessionStorage.getItem(LIST) || 'null');
      const block = m && m.k && document.querySelector(`[data-k="${CSS.escape(m.k)}"]`);
      const l = block && (block.matches('[data-ev-list]') ? block : block.querySelector('[data-ev-list]'));
      return m && m.id === id ? l : null;
    } catch { return null; }
  }
  const idOf = (a) => { try { return decodeURIComponent(a.hash.slice(1)); } catch { return ''; } };
  function current() {
    let id = '';
    try { id = decodeURIComponent(location.hash.slice(1)); } catch { return null; }
    const el = id && document.getElementById(id);
    return el && el.matches(ITEM) ? el : null;
  }
  // A row hidden by the filter, a closed toggle or a hidden finished card has no box.
  const seen = (a) => a.getClientRects().length > 0;

  // The ids in the order the reader sees them: the list it was opened from, else the timeline, else the page.
  function order(id) {
    const has = (root) => [...root.querySelectorAll('a[data-ev-open]')].some((a) => idOf(a) === id);
    if (!(list && list.isConnected)) list = recall(id);
    let scope = list && list.isConnected && has(list) ? list : null;
    // Opened from the hash alone: the timeline first (where most links are), then the first list that shows it.
    const lists = [...document.querySelectorAll('[data-ev-list]')].sort((a, b) => b.matches('[data-tl-list]') - a.matches('[data-tl-list]'));
    if (!scope) scope = lists.find((l) => has(l) && [...l.querySelectorAll('a[data-ev-open]')].some((a) => idOf(a) === id && seen(a))) || null;
    const links = [...(scope || document).querySelectorAll('a[data-ev-open]')].filter(seen);
    if (scope && scope.matches('[data-tl-list]') && document.body.dataset.sort === 'oldest') links.reverse(); // CSS reverses that list
    const ids = [];
    for (const a of links) { const x = idOf(a); if (x && !ids.includes(x) && document.getElementById(x)) ids.push(x); }
    return ids;
  }
  function point(a, id) {
    if (!a) return;
    if (id) { a.href = `#${encodeURIComponent(id)}`; a.removeAttribute('aria-disabled'); } else { a.removeAttribute('href'); a.setAttribute('aria-disabled', 'true'); }
  }
  function setup(el) {
    const ids = order(el.id); const i = ids.indexOf(el.id);
    if (i >= 0) remember(el.id, list);
    if (i >= 0) { // otherwise the page's own order stays
      point(el.querySelector('[data-evv="prev"]'), ids[i - 1]); point(el.querySelector('[data-evv="next"]'), ids[i + 1]);
      const n = el.querySelector('.evv-n'); if (n) n.textContent = `${i + 1} of ${ids.length}`;
    }
    const pre = el.querySelector('pre[data-src]');
    if (pre && !pre.dataset.done) {
      pre.dataset.done = '1';
      fetch(pre.dataset.src, { cache: 'no-store' })
        .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
        .then((t) => { pre.textContent = t; }, (s) => { pre.textContent = s === 404 ? 'Missing: the stored copy is gone.' : 'Could not load the file; use Open in new tab.'; });
    }
  }
  function sync() {
    const el = current();
    if (el && el === shown) { setup(el); return; }
    shown = el;
    if (el) {
      setup(el);
      const close = el.querySelector('[data-evv="close"]');
      if (close) close.focus({ preventScroll: true });
    } else if (from && from.isConnected) { from.focus({ preventScroll: true }); from = null; }
  }
  // Closing leaves no hash behind: '#_' clears :target, then the URL is cleaned without a navigation.
  function close() {
    location.replace('#_');
    try { history.replaceState(history.state, '', location.pathname + location.search); } catch { /* the hash stays */ }
    sync();
  }
  // Previous / Next replace the entry: Back leaves the viewer instead of walking every image.
  function step(rel) {
    const a = shown && shown.querySelector(`[data-evv="${rel}"]`);
    if (a && a.hasAttribute('href')) location.replace(a.href);
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a');
    if (!a) return;
    if (a.matches('[data-ev-open]')) { from = a; list = a.closest('[data-ev-list]'); remember(idOf(a), list); return; } // the hash change opens it
    if (!a.closest(ITEM)) return;
    const rel = a.dataset.evv;
    if (rel === 'prev' || rel === 'next') { e.preventDefault(); step(rel); } else if (rel === 'close' || a.classList.contains('evv-shade')) { e.preventDefault(); close(); }
  });
  document.addEventListener('keydown', (e) => {
    if (!shown || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); step(e.key === 'ArrowLeft' ? 'prev' : 'next'); return; }
    if (e.key !== 'Tab') return;
    const f = [...shown.querySelectorAll(FOCUSABLE)].filter((x) => x.getClientRects().length || x.matches('.evv-z'));
    if (!f.length) return;
    const first = f[0]; const last = f[f.length - 1];
    if (!shown.contains(document.activeElement)) { e.preventDefault(); first.focus(); } else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  // Swipe left or right on a phone (fit to width only: at actual size a swipe scrolls).
  let sx = null; let sy = 0;
  document.addEventListener('pointerdown', (e) => {
    sx = null;
    if (!shown || e.pointerType === 'mouse' || !e.target.closest('.evv-scroll')) return;
    sx = e.clientX; sy = e.clientY;
  }, true);
  document.addEventListener('pointerup', (e) => {
    if (sx === null || !shown) return;
    const dx = e.clientX - sx; const dy = e.clientY - sy; sx = null;
    const z = shown.querySelector('.evv-z');
    if (z && z.checked) return;
    if (Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) step(dx < 0 ? 'next' : 'prev');
  }, true);
  addEventListener('hashchange', sync);
  document.addEventListener('coordinator:patched', () => { if (shown && !shown.isConnected) shown = null; sync(); });
  sync();
  // A reload that reopens the viewer: Close keeps focus once the page has settled (the live script restores scroll on load).
  addEventListener('load', () => requestAnimationFrame(() => {
    const close = shown && shown.querySelector('[data-evv="close"]');
    if (close && !shown.contains(document.activeElement)) close.focus({ preventScroll: true });
  }), { once: true });
})();
