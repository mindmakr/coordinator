// The memory of toggles and panels (details[data-d]), per page and browser: open or closed by
// key, stored only after the reader clicked a summary; one never touched keeps the state the page
// rendered it in. live.client.js runs it on the live page; on the hosted pages it is the page's
// only script beside the theme's (lib/parts.mjs). restoreOpen and rememberToggle are lib/ui.mjs's,
// served before it. Returns applyOpen(root), which restores the panels under root.
const panelMemory = (run, path) => {
  const openKey = `coordinator:${run}:open:${path}`;
  try { localStorage.removeItem(`coordinator:${run}:open`); } catch { /* no storage */ } // the old per-run key
  let saved = {};
  try { const v = localStorage.getItem(openKey); if (v !== null) saved = JSON.parse(v); } catch { /* no storage, or not JSON */ }
  const openMap = restoreOpen([], saved);
  const applyOpen = (root) => {
    if (root.nodeType !== 1 && root !== document) return;
    const all = [...root.querySelectorAll('details[data-d]')];
    if (root.matches && root.matches('details[data-d]')) all.push(root);
    restoreOpen(all, openMap);
  };
  // Only a click on a summary (the mouse, Enter or Space) is the reader's: the browser also fires
  // toggle for panels parsed open and for restoreOpen, and those must not be stored.
  const armed = new WeakSet();
  document.addEventListener('click', (e) => {
    const s = e.target && e.target.closest ? e.target.closest('summary') : null;
    if (s && s.parentElement && s.parentElement.dataset && s.parentElement.dataset.d) armed.add(s.parentElement);
  }, true);
  document.addEventListener('toggle', (e) => {
    if (!rememberToggle(openMap, e.target, armed)) return; // po: opened only for print
    try { localStorage.setItem(openKey, JSON.stringify(openMap)); } catch { /* private window: no memory */ }
  }, true);
  return applyOpen;
};
