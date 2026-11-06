// Updates the live page in place: existing nodes are kept and changed only
// where the new HTML differs, so the browser's own scroll anchoring keeps the
// reader's place. Children match by key (data-a, else data-k), unkeyed ones by
// position and tag. The page runs this function's source; the tests run it
// against a small fake DOM.
//
// hooks: busy(form) → true to leave a form being filled alone; skipped() when
// one was; added(node) for each node inserted. `open` (a reader's toggle) and
// `hidden` (the timeline filter) belong to the page and are never removed.
export function morph(target, source, hooks) {
  const KEEP = { open: 1, hidden: 1 };
  const keyOf = (c) => (c.nodeType === 1 ? c.getAttribute('data-a') || c.getAttribute('data-k') : null);
  const same = (a, b) => a.nodeType === b.nodeType && (a.nodeType !== 1 || a.tagName === b.tagName);
  function node(a, b) {
    if (a.nodeType !== 1) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
    if (a.tagName === 'FORM' && hooks.busy(a)) { hooks.skipped(); return; }
    const h = a.getAttribute('data-h');
    if (h && h === b.getAttribute('data-h')) return; // the server says nothing in it changed
    for (const { name, value } of [...b.attributes]) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
    for (const { name } of [...a.attributes]) if (!b.hasAttribute(name) && !KEEP[name]) a.removeAttribute(name);
    kids(a, b);
  }
  function kids(a, b) {
    const olds = new Map();
    for (const c of a.childNodes) { const k = keyOf(c); if (k && !olds.has(k)) olds.set(k, c); }
    let cur = a.firstChild;
    for (const nc of [...b.childNodes]) {
      const k = keyOf(nc);
      let m = null;
      if (k) { m = olds.get(k) || null; if (m && !same(m, nc)) m = null; if (m) olds.delete(k); }
      else if (cur && !keyOf(cur) && same(cur, nc)) m = cur;
      if (m) { if (m === cur) cur = cur.nextSibling; else a.insertBefore(m, cur); node(m, nc); }
      else { a.insertBefore(nc, cur); hooks.added(nc); }
    }
    while (cur) {
      const next = cur.nextSibling;
      if (!(cur.nodeType === 1 && cur.tagName === 'FORM' && hooks.busy(cur))) a.removeChild(cur); else hooks.skipped();
      cur = next;
    }
  }
  kids(target, source);
}
