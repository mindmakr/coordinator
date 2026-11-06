// Map panels on the live page (lib/maptips.mjs draws them; CSS shows one while
// its box is hovered or focused). This adds: the panel beside its box on wide
// screens (a bottom sheet on narrow ones), tap to pin on touch (a second tap
// opens the unit), Escape or a tap elsewhere to close. Listeners sit on the
// document, so boxes and panels swapped by a live patch keep working.
(() => {
  const BOX = '[aria-describedby^="tip-"]';
  const body = document.body;
  let touch = false; let pinned = null; let shown = null;
  const tipOf = (box) => box && document.getElementById(box.getAttribute('aria-describedby'));
  function place(box) {
    const tip = tipOf(box); if (!tip) return;
    shown = box;
    if (innerWidth < 640) { tip.style.left = tip.style.top = tip.style.right = tip.style.bottom = ''; return; }
    const r = box.getBoundingClientRect(); const w = tip.offsetWidth || 340; const h = tip.offsetHeight || 200;
    const left = r.right + 12 + w <= innerWidth - 8 ? r.right + 12 : Math.max(8, r.left - 12 - w);
    const top = Math.min(Math.max(8, r.top), Math.max(8, innerHeight - h - 8));
    Object.assign(tip.style, { left: `${Math.round(left)}px`, top: `${Math.round(top)}px`, right: 'auto', bottom: 'auto' });
  }
  function unpin() { if (pinned) { const t = tipOf(pinned); if (t) t.classList.remove('pinned'); pinned.blur(); pinned = null; } }
  // Entering a box (not moving inside it) brings panels back after Escape.
  document.addEventListener('pointerover', (e) => {
    const box = e.target.closest && e.target.closest(BOX); if (!box || box.contains(e.relatedTarget)) return;
    delete body.dataset.tips; place(box); requestAnimationFrame(() => place(box));
  });
  document.addEventListener('focusin', (e) => { const box = e.target.closest && e.target.closest(BOX); if (box) { delete body.dataset.tips; place(box); requestAnimationFrame(() => place(box)); } });
  document.addEventListener('pointerdown', (e) => { touch = e.pointerType === 'touch' || e.pointerType === 'pen'; }, true);
  document.addEventListener('click', (e) => {
    const box = e.target.closest && e.target.closest(BOX);
    if (box && touch && box !== pinned) {
      e.preventDefault(); unpin(); delete body.dataset.tips;
      const tip = tipOf(box); if (!tip) return;
      pinned = box; tip.classList.add('pinned'); box.focus({ preventScroll: true }); place(box);
      return;
    }
    if (!box && !(e.target.closest && e.target.closest('.tip'))) unpin();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || (!pinned && !shown)) return;
    unpin(); body.dataset.tips = 'off';
  });
  addEventListener('scroll', () => { if (pinned) place(pinned); else if (shown && body.dataset.tips !== 'off') place(shown); }, { passive: true, capture: true });
})();
