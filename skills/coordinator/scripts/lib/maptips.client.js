// Map panels on the live page (lib/maptips.mjs draws them; CSS shows one while
// its box is hovered or focused). This adds: the panel placed where it covers
// neither its box nor what the box lights up, tap to pin on touch (a second tap
// opens the unit), Tab from a box into its panel and out again, and Escape or a
// tap elsewhere to close. Listeners sit on the document, so boxes and panels
// swapped by a live patch keep working.
(() => {
  const BOX = '[aria-describedby^="tip-"]';
  const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const body = document.body;
  let touch = false; let pinned = null; let shown = null; let from = null; let hush = null; // hush: a box refocused by Escape stays quiet
  const tipOf = (box) => box && document.getElementById(box.getAttribute('aria-describedby'));
  const boxOf = (el) => el && el.closest && el.closest(BOX);

  // What a box lights: itself, the boxes it connects to (c<i>) and its edges (e<i> on the run maps, x<i> on the project map).
  function lit(box) {
    const id = box.getAttribute('aria-describedby'); const m = /^tip-([un])(\d+)$/.exec(id); if (!m) return [box];
    const root = box.closest('svg') || document;
    const sel = m[1] === 'u' ? `.c${m[2]}, .e${m[2]}` : `.c${m[2]}, .x${m[2]}`;
    return [box, ...root.querySelectorAll(sel)];
  }
  const overlap = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  // Tries beside the box, beside everything it lights, then the viewport's corners; keeps the spot that covers least of it.
  function place(box) {
    const tip = tipOf(box); if (!tip) return;
    shown = box;
    const vw = innerWidth; const vh = innerHeight; const g = 12;
    const w = Math.min(tip.offsetWidth || 340, vw - 16); const h = Math.min(tip.offsetHeight || 220, vh - 16);
    const rects = lit(box).map((el) => el.getBoundingClientRect()).filter((r) => r.width || r.height);
    const b = box.getBoundingClientRect();
    const u = rects.reduce((a, r) => ({ left: Math.min(a.left, r.left), top: Math.min(a.top, r.top), right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom) }), { left: b.left, top: b.top, right: b.right, bottom: b.bottom });
    const spots = [];
    for (const r of [b, u]) spots.push([r.right + g, r.top], [r.left - g - w, r.top], [r.left, r.bottom + g], [r.left, r.top - g - h]);
    spots.push([vw - w - 8, vh - h - 8], [8, vh - h - 8], [vw - w - 8, 8], [8, 8]);
    let best = null;
    for (const [x0, y0] of spots) {
      const x = Math.min(Math.max(8, x0), vw - w - 8); const y = Math.min(Math.max(8, y0), vh - h - 8);
      const r = { left: x, top: y, right: x + w, bottom: y + h };
      const cost = rects.reduce((n, l) => n + overlap(r, l), 0) * 4 + overlap(r, b) * 100 + Math.abs(x - x0) + Math.abs(y - y0);
      if (!best || cost < best.cost) best = { x, y, cost };
    }
    Object.assign(tip.style, { left: `${Math.round(best.x)}px`, top: `${Math.round(best.y)}px`, right: 'auto', bottom: 'auto' });
  }
  const placeSoon = (box) => { place(box); requestAnimationFrame(() => place(box)); };
  function unpin() { if (pinned) { const t = tipOf(pinned); if (t) t.classList.remove('pinned'); pinned.blur(); pinned = null; } }
  function close() { unpin(); body.dataset.tips = 'off'; }

  // Entering a box (not moving inside it) brings panels back after Escape.
  document.addEventListener('pointerover', (e) => {
    const box = boxOf(e.target); if (!box || box.contains(e.relatedTarget)) return;
    delete body.dataset.tips; placeSoon(box);
  });
  document.addEventListener('focusin', (e) => { const box = boxOf(e.target); if (!box) return; if (box === hush) { hush = null; return; } delete body.dataset.tips; placeSoon(box); });
  document.addEventListener('pointerdown', (e) => { touch = e.pointerType === 'touch' || e.pointerType === 'pen'; }, true);
  document.addEventListener('click', (e) => {
    const box = boxOf(e.target);
    if (box && touch && box !== pinned) {
      e.preventDefault(); unpin(); delete body.dataset.tips;
      const tip = tipOf(box); if (!tip) return;
      pinned = box; tip.classList.add('pinned'); box.focus({ preventScroll: true }); placeSoon(box);
      return;
    }
    if (!box && !(e.target.closest && e.target.closest('.tip'))) unpin();
  });

  // Keyboard: Tab from a box enters its panel; Tab past the panel's last link goes on from the box; Shift+Tab goes back.
  const inTip = (el) => el && el.closest && el.closest('.tip');
  const order = () => [...document.querySelectorAll(FOCUSABLE)].filter((el) => !inTip(el) && el.getClientRects().length);
  document.addEventListener('keydown', (e) => {
    const el = document.activeElement;
    if (e.key === 'Escape') {
      const tip = inTip(el);
      if (tip) { const back = from || document.querySelector(`[aria-describedby="${tip.id}"]`); close(); from = null; if (back) { hush = back; back.focus(); } return; }
      if (pinned || shown) close();
      return;
    }
    if (e.key !== 'Tab') return;
    const box = boxOf(el);
    if (box && !e.shiftKey && body.dataset.tips !== 'off') {
      const links = [...(tipOf(box)?.querySelectorAll(FOCUSABLE) ?? [])];
      if (links.length) { e.preventDefault(); from = box; links[0].focus(); }
      return;
    }
    const tip = inTip(el); if (!tip || !from) return;
    const links = [...tip.querySelectorAll(FOCUSABLE)];
    if (e.shiftKey && el === links[0]) { e.preventDefault(); from.focus(); }
    else if (!e.shiftKey && el === links.at(-1)) {
      e.preventDefault();
      const all = order(); const next = all[all.indexOf(from) + 1];
      const origin = from; from = null; (next || origin).focus();
    }
  });
  addEventListener('scroll', () => { const b = pinned || (body.dataset.tips !== 'off' && shown); if (b && b.isConnected) place(b); }, { passive: true, capture: true });

  // A mind map larger than its box opens on its first unit (the top of the ring), not on the bare goal.
  document.querySelectorAll('.map-scroll.mind').forEach((s) => {
    const first = s.querySelector('a.u'); if (!first || (s.scrollWidth <= s.clientWidth && s.scrollHeight <= s.clientHeight)) return;
    const c = s.getBoundingClientRect(); const r = first.getBoundingClientRect();
    s.scrollLeft += r.left + r.width / 2 - (c.left + c.width / 2); s.scrollTop += r.top - c.top - 16;
  });
})();
