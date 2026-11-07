// Walking a map on the live page (lib/mapnav.mjs draws the graph into
// data-node, data-from and data-to; CSS does hover). This adds: click, tap,
// Enter or Space selects a node and keeps it and its children lit; arrows walk
// to a child, a sibling or back up; a breadcrumb and a children list; a menu
// (right-click, long-press, Menu key or Shift+F10) to open the node, open it in
// a new tab, step into its children or copy a link; Focus hides the rest; Find
// selects by id or title. The selection lives in the URL hash (shareable) and
// sessionStorage, and comes back after a reload and after every live patch.
(() => {
  const body = document.body;
  const pre = `coordinator:${body.dataset.run}:${body.dataset.path}:`;
  const get = (k) => { try { return JSON.parse(sessionStorage.getItem(pre + k)); } catch { return null; } };
  const put = (k, v) => { try { sessionStorage.setItem(pre + k, JSON.stringify(v)); } catch { /* storage blocked */ } };
  const svgOf = (name) => [...document.querySelectorAll('svg[data-nav]')].find((s) => s.dataset.nav === name) || null;
  const nodes = (svg) => [...svg.querySelectorAll('[data-node]')];
  const nodeEl = (svg, key) => nodes(svg).find((n) => n.dataset.node === key) || null;
  const lines = (svg) => [...svg.querySelectorAll('.eg[data-from]')];
  const uniq = (a) => [...new Set(a)];
  const kidsOf = (svg, key) => uniq(lines(svg).filter((e) => e.dataset.from === key).map((e) => e.dataset.to)).filter((k) => nodeEl(svg, k));
  const parentsOf = (svg, key) => uniq(lines(svg).filter((e) => e.dataset.to === key).map((e) => e.dataset.from));
  const roots = (svg) => nodes(svg).map((n) => n.dataset.node).filter((k) => !parentsOf(svg, k).length);
  // A path from a root down to key, by first parents (the graph may join; loops stop).
  function rootPath(svg, key) {
    const path = [key];
    for (let k = key; ;) { const p = parentsOf(svg, k)[0]; if (!p || path.includes(p)) break; path.unshift(p); k = p; }
    return path;
  }
  const nameOf = (el) => el.dataset.name || el.dataset.node;
  const safeHref = (el) => {
    const h = el && el.getAttribute('href'); if (!h) return null;
    try { const u = new URL(h, location.href); return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null; } catch { return null; }
  };
  const OPEN = { unit: 'Open unit', issue: 'Open issue', pr: 'Open PR', 'follow-up': 'Open follow-up', goal: 'Open the dashboard' };
  const h = (tag, attrs, text) => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v); if (text !== undefined) el.textContent = text; return el; };

  let sel = null; // { map, path: [key…] }
  let focusMode = get('focus') || {};
  let lastPanel = null; // what had focus in a panel, to give it back after a patch

  // ---- state in and out: hash first (shared links), then this tab's storage.
  function fromHash() {
    const m = /^#sel=([^/]+)\/(.+)$/.exec(location.hash); if (!m) return null;
    try { return { map: decodeURIComponent(m[1]), path: m[2].split('/').map(decodeURIComponent) }; } catch { return null; }
  }
  const hashOf = (s) => `#sel=${encodeURIComponent(s.map)}/${s.path.map(encodeURIComponent).join('/')}`;
  function save() {
    put('sel', sel);
    const base = `${location.pathname}${location.search}`;
    try {
      if (sel) history.replaceState(history.state, '', base + hashOf(sel));
      else if (/^#sel=/.test(location.hash)) history.replaceState(history.state, '', base);
    } catch { /* sandboxed */ }
  }

  // ---- drawing the selection: classes the morph resets, so this runs after every patch too.
  function apply() {
    for (const svg of document.querySelectorAll('svg[data-nav]')) {
      svg.removeAttribute('data-sel'); svg.removeAttribute('data-focus');
      svg.querySelectorAll('.lit, .sel').forEach((el) => el.classList.remove('lit', 'sel'));
      svg.querySelectorAll('[aria-current]').forEach((el) => el.removeAttribute('aria-current'));
      const tools = document.querySelector(`[data-nav-tools="${svg.dataset.nav}"]`);
      const focus = tools && tools.querySelector('[data-nav-focus]');
      if (focus) focus.checked = !!focusMode[svg.dataset.nav];
    }
    if (sel) {
      const svg = svgOf(sel.map);
      // A live update may have removed nodes: keep the part of the path still drawn.
      const path = svg ? sel.path.filter((k) => nodeEl(svg, k)) : [];
      sel = path.length ? { map: sel.map, path } : null;
    }
    document.querySelectorAll('[data-nav-panel]').forEach((p) => { if (!sel || p.closest('[data-nav-tools]').dataset.navTools !== sel.map) { p.hidden = true; p.textContent = ''; } });
    if (!sel) return;
    const svg = svgOf(sel.map); const key = sel.path.at(-1); const el = nodeEl(svg, key);
    svg.setAttribute('data-sel', ''); if (focusMode[sel.map]) svg.setAttribute('data-focus', '');
    el.classList.add('sel', 'lit'); el.setAttribute('aria-current', 'true');
    for (const k of kidsOf(svg, key)) nodeEl(svg, k).classList.add('lit');
    for (const e of svg.querySelectorAll('[data-from]')) if (e.dataset.from === key) e.classList.add('lit'); // lines and their drawn copies
    delete body.dataset.tips;
    panel(svg, el);
  }

  function panel(svg, el) {
    const tools = document.querySelector(`[data-nav-tools="${sel.map}"]`); if (!tools) return;
    const box = tools.querySelector('[data-nav-panel]'); box.textContent = ''; box.hidden = false;
    const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Path to the selected node' }); const ol = h('ol');
    sel.path.forEach((k, i) => {
      const n = nodeEl(svg, k); const li = h('li'); if (i === sel.path.length - 1) li.setAttribute('aria-current', 'location');
      li.append(h('button', { type: 'button', 'data-crumb': String(i) }, nameOf(n))); ol.append(li);
    });
    crumbs.append(ol); box.append(crumbs);
    const said = el.getAttribute('aria-label') || ''; const about = said.startsWith(`${nameOf(el)}: `) ? said.slice(nameOf(el).length + 2) : said;
    const head = h('p'); head.append(h('b', {}, nameOf(el)), document.createTextNode(' '), h('span', { class: 'cause' }, about)); box.append(head);
    const acts = h('div', { class: 'nav-acts' });
    const href = safeHref(el);
    if (href) { const a = h('a', { class: 'cta', href, 'data-act': 'open' }, OPEN[el.dataset.kind] || 'Open'); if (el.getAttribute('target') === '_blank') { a.target = '_blank'; a.rel = 'noopener noreferrer'; } acts.append(a); }
    acts.append(h('button', { type: 'button', 'data-act': 'menu', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, 'More…'));
    if (sel.path.length > 1 || parentsOf(svg, sel.path[0]).length) acts.append(h('button', { type: 'button', 'data-act': 'up' }, '← Up to parent'));
    acts.append(h('button', { type: 'button', 'data-act': 'clear' }, 'Clear selection'));
    box.append(acts);
    const kids = kidsOf(svg, sel.path.at(-1));
    box.append(h('p', { class: 'cause' }, kids.length ? `Children (${kids.length}), one level down:` : 'No children: nothing hangs below this one.'));
    if (kids.length) {
      const ul = h('ul', { class: 'kids', 'aria-label': `Children of ${nameOf(el)}` });
      kids.forEach((k) => { const li = h('li'); li.append(h('button', { type: 'button', 'data-kid': k }, nameOf(nodeEl(svg, k)))); ul.append(li); });
      box.append(ul);
    }
    box.append(h('p', { class: 'cause', 'data-nav-said': '' }));
    if (lastPanel && (document.activeElement === body || !document.activeElement)) {
      const back = [...box.querySelectorAll('button, a')].find((b) => b.getAttribute('data-act') === lastPanel || b.getAttribute('data-kid') === lastPanel);
      if (back) back.focus({ preventScroll: true });
    }
  }
  const say = (t) => { const s = document.querySelector('[data-nav-said]'); if (s) s.textContent = t; };

  // ---- moving the selection
  function select(map, path, focus = true) {
    sel = path && path.length ? { map, path } : null;
    apply(); save();
    if (sel && focus) { const el = nodeEl(svgOf(map), path.at(-1)); if (el && el.focus) el.focus(); }
  }
  const clear = () => { const was = sel && nodeEl(svgOf(sel.map), sel.path.at(-1)); select(null, null); if (was && was.focus) was.focus({ preventScroll: true }); };
  // Clicked or keyed node: again clears; a child of the selection goes one deeper; on the path goes back to it.
  function pick(svg, key) {
    const map = svg.dataset.nav;
    if (sel && sel.map === map) {
      if (sel.path.at(-1) === key) return clear();
      const at = sel.path.indexOf(key); if (at >= 0) return select(map, sel.path.slice(0, at + 1));
      if (kidsOf(svg, sel.path.at(-1)).includes(key)) return select(map, [...sel.path, key]);
    }
    select(map, rootPath(svg, key));
  }
  function step(dir) {
    if (!sel) return; const svg = svgOf(sel.map); const key = sel.path.at(-1);
    if (dir === 'in') { const k = kidsOf(svg, key)[0]; if (k) select(sel.map, [...sel.path, k]); else say('No children below this one.'); return; }
    if (dir === 'out') { const path = sel.path.length > 1 ? sel.path.slice(0, -1) : rootPath(svg, key).slice(0, -1); if (path.length) select(sel.map, path); else say('This is the top.'); return; }
    const parent = sel.path.length > 1 ? sel.path.at(-2) : null;
    const sibs = parent ? kidsOf(svg, parent) : roots(svg);
    const i = sibs.indexOf(key); const next = sibs[(i + (dir === 'next' ? 1 : -1) + sibs.length) % sibs.length];
    if (next && next !== key) select(sel.map, [...sel.path.slice(0, -1), next]);
  }

  // ---- the menu
  const menu = h('div', { class: 'nmenu', role: 'menu', 'aria-label': 'Node menu', hidden: '' });
  body.append(menu); // outside #app, so a live patch never removes it
  let menuFrom = null;
  function openMenu(svg, el, x, y, from) {
    if (!sel || sel.map !== svg.dataset.nav || sel.path.at(-1) !== el.dataset.node) pick(svg, el.dataset.node);
    if (!sel) select(svg.dataset.nav, rootPath(svg, el.dataset.node), false);
    menu.textContent = '';
    const href = safeHref(el); const kids = kidsOf(svg, el.dataset.node);
    const item = (act, text, ok = true) => { const b = h('button', { type: 'button', role: 'menuitem', 'data-m': act, tabindex: '-1' }, text); if (!ok) b.setAttribute('aria-disabled', 'true'); menu.append(b); };
    item('open', OPEN[el.dataset.kind] || 'Open', !!href); item('tab', 'Open in new tab', !!href);
    item('kids', kids.length ? `Select children (${kids.length})` : 'Select children (none)', kids.length > 0); item('copy', 'Copy link');
    menu.hidden = false; menuFrom = from || el;
    const w = menu.offsetWidth || 220; const hh = menu.offsetHeight || 160;
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`; menu.style.top = `${Math.max(8, Math.min(y, innerHeight - hh - 8))}px`;
    document.querySelectorAll('[data-act="menu"]').forEach((b) => b.setAttribute('aria-expanded', 'true'));
    menu.querySelector('[role=menuitem]').focus();
  }
  function closeMenu(back = true) {
    if (menu.hidden) return; menu.hidden = true;
    document.querySelectorAll('[data-act="menu"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    if (back && menuFrom && menuFrom.isConnected) menuFrom.focus({ preventScroll: true }); menuFrom = null;
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* no clipboard permission: the old way */ }
    const t = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;opacity:0' }); t.value = text; body.append(t); t.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; } t.remove(); return ok;
  }
  function act(what) {
    if (!sel) return; const svg = svgOf(sel.map); const el = nodeEl(svg, sel.path.at(-1)); const href = safeHref(el);
    if (what === 'open' && href) { if (el.getAttribute('target') === '_blank') open(href, '_blank', 'noopener,noreferrer'); else location.href = href; }
    else if (what === 'tab' && href) open(href, '_blank', 'noopener,noreferrer');
    else if (what === 'kids') step('in');
    else if (what === 'copy') copy(location.href).then((ok) => say(ok ? 'Link to this selection copied.' : `Copy failed: the link is ${location.href}`));
  }
  menu.addEventListener('click', (e) => { const b = e.target.closest('[data-m]'); if (!b || b.getAttribute('aria-disabled')) return; const m = b.dataset.m; closeMenu(m !== 'kids'); act(m); });
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('[role=menuitem]')]; const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); items[e.key === 'Home' ? 0 : items.length - 1].focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeMenu(); }
    else if (e.key === 'Tab') closeMenu(false);
  });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(false); }, true);

  // ---- pointer: click selects (modifier clicks still open links); long-press opens the menu.
  const navNode = (t) => t && t.closest && t.closest('svg[data-nav] [data-node]');
  const navLine = (t) => t && t.closest && t.closest('svg[data-nav] :is(.eg, .hit)'); // the focusable line or its pointer target
  let press = 0; let pressAt = null; let longDone = false; let touched = false;
  document.addEventListener('pointerdown', (e) => {
    longDone = false; clearTimeout(press); touched = e.pointerType !== 'mouse';
    const el = navNode(e.target); if (!el || e.pointerType === 'mouse') return;
    pressAt = [e.clientX, e.clientY];
    press = setTimeout(() => { longDone = true; openMenu(el.closest('svg'), el, pressAt[0], pressAt[1]); }, 550);
  });
  document.addEventListener('pointermove', (e) => { if (pressAt && Math.hypot(e.clientX - pressAt[0], e.clientY - pressAt[1]) > 10) clearTimeout(press); });
  document.addEventListener('pointerup', () => clearTimeout(press)); document.addEventListener('pointercancel', () => clearTimeout(press));
  document.addEventListener('contextmenu', (e) => {
    const el = navNode(e.target); if (!el) return;
    e.preventDefault(); clearTimeout(press); if (longDone) return; longDone = true;
    openMenu(el.closest('svg'), el, e.clientX, e.clientY);
    setTimeout(() => { longDone = false; }, 600);
  });
  document.addEventListener('click', (e) => {
    const el = navNode(e.target); const line = !el && navLine(e.target);
    if (!el && !line) return;
    if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // a new tab or window: the browser's own
    e.preventDefault();
    if (longDone) { longDone = false; return; }
    const svg = (el || line).closest('svg');
    if (el) pick(svg, el.dataset.node);
    else select(svg.dataset.nav, [...rootPath(svg, line.dataset.from), line.dataset.to]); // a line selects its end, by way of its start
    if (touched) body.dataset.tips = 'off'; // on a phone the selection panel says it all; the stats panel would cover the children
  });

  // ---- keys on a node or line; and the panels' buttons
  document.addEventListener('keydown', (e) => {
    if (!menu.hidden) return;
    const t = document.activeElement; const el = navNode(t); const line = !el && navLine(t);
    const mine = el || line || t === body || !t || (t.closest && t.closest('[data-nav-tools], .tip'));
    if (e.key === 'Escape' && sel && mine) { clear(); return; }
    if (!el && !line) return;
    const svg = (el || line).closest('svg');
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault(); const target = el || nodeEl(svg, line.dataset.to); const r = target.getBoundingClientRect();
      openMenu(svg, target, r.left + 8, r.bottom + 4, target); return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (el) pick(svg, el.dataset.node); else select(svg.dataset.nav, [...rootPath(svg, line.dataset.from), line.dataset.to]);
      return;
    }
    const dir = { ArrowRight: 'in', ArrowLeft: 'out', ArrowDown: 'next', ArrowUp: 'prev' }[e.key];
    if (!dir || !el) return;
    e.preventDefault();
    if (!sel || sel.map !== svg.dataset.nav || sel.path.at(-1) !== el.dataset.node) { pick(svg, el.dataset.node); return; } // first key selects
    step(dir);
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-nav-panel] button, [data-nav-panel] a'); if (!b) return;
    if (b.dataset.crumb !== undefined) { select(sel.map, sel.path.slice(0, Number(b.dataset.crumb) + 1)); return; }
    if (b.dataset.kid) { select(sel.map, [...sel.path, b.dataset.kid]); return; }
    const a = b.dataset.act;
    if (a === 'clear') clear();
    else if (a === 'up') step('out');
    else if (a === 'menu') { const svg = svgOf(sel.map); const r = b.getBoundingClientRect(); openMenu(svg, nodeEl(svg, sel.path.at(-1)), r.left, r.bottom + 4, b); }
  });
  document.addEventListener('focusin', (e) => {
    const b = e.target.closest && e.target.closest('[data-nav-panel] [data-act], [data-nav-panel] [data-kid]');
    lastPanel = b ? (b.dataset.act || b.dataset.kid) : null;
  });

  // ---- Focus and Find, per map, remembered for this tab
  document.addEventListener('change', (e) => {
    const f = e.target.closest && e.target.closest('[data-nav-focus]'); if (!f) return;
    focusMode[f.closest('[data-nav-tools]').dataset.navTools] = f.checked; put('focus', focusMode); apply();
  });
  const matchesOf = (svg, q) => {
    const s = q.trim().toLowerCase(); if (!s) return [];
    const all = nodes(svg); const exact = all.filter((n) => nameOf(n).toLowerCase() === s);
    return [...exact, ...all.filter((n) => !exact.includes(n) && `${nameOf(n)} ${n.getAttribute('aria-label') || ''}`.toLowerCase().includes(s))];
  };
  function find(input, go) {
    const map = input.closest('[data-nav-tools]').dataset.navTools; const svg = svgOf(map); if (!svg) return;
    const found = matchesOf(svg, input.value); const count = input.closest('[data-nav-tools]').querySelector('[data-nav-count]');
    if (count) count.textContent = input.value.trim() ? `${found.length} ${found.length === 1 ? 'match' : 'matches'}${found.length ? ' · Enter selects the first' : ''}` : '';
    const finds = get('find') || {}; finds[map] = input.value; put('find', finds);
    if (go && found[0]) select(map, rootPath(svg, found[0].dataset.node));
  }
  document.addEventListener('input', (e) => { if (e.target.matches && e.target.matches('[data-nav-find]')) find(e.target, false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches && e.target.matches('[data-nav-find]')) { e.preventDefault(); find(e.target, true); } });

  // ---- scroll inside each map box, kept for this tab
  const boxes = () => [...document.querySelectorAll('.map-scroll')];
  let st = 0;
  document.addEventListener('scroll', (e) => {
    if (!e.target.classList || !e.target.classList.contains('map-scroll')) return;
    clearTimeout(st); st = setTimeout(() => put('mapscroll', boxes().map((b) => [b.scrollLeft, b.scrollTop])), 150);
  }, { capture: true, passive: true });

  // ---- start: the saved state comes back, and again after every live patch
  const finds = get('find') || {};
  document.querySelectorAll('[data-nav-find]').forEach((i) => { const m = i.closest('[data-nav-tools]').dataset.navTools; if (finds[m]) { i.value = finds[m]; find(i, false); } });
  sel = fromHash() || get('sel');
  apply(); if (sel) save();
  const sc = get('mapscroll');
  if (Array.isArray(sc)) requestAnimationFrame(() => boxes().forEach((b, i) => { if (sc[i]) { b.scrollLeft = sc[i][0]; b.scrollTop = sc[i][1]; } }));
  document.addEventListener('coordinator:patched', () => { apply(); });
  addEventListener('hashchange', () => { const s = fromHash(); if (s) { sel = s; apply(); put('sel', sel); } });
})();
