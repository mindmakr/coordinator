// Keeping the reader's place on the live page: one mechanism, ours. The page
// turns the browser's own scroll anchoring off (it can pick a container that
// straddles the viewport top, whose top never moves) and runs these
// functions' source after every update, as the tests do.

// items: the keyed elements in document order, as { key, top, bottom, leaf }
// (viewport px; leaf = holds no keyed element). The anchor is the first leaf
// that is rendered and starts at or below the viewport top; else any keyed
// element that does; else the first one still on screen.
export function pickAnchor(items) {
  const shown = (i) => i.bottom > i.top; // collapsed or filtered out: zero height
  const hit = items.find((i) => i.leaf && shown(i) && i.top >= 0)
    ?? items.find((i) => shown(i) && i.top >= 0)
    ?? items.find((i) => shown(i) && i.bottom > 0);
  return hit ? { key: hit.key, top: hit.top } : null;
}

// How far to scroll so the anchor sits where it was: 0 when it is gone or moved under 1 px.
export function scrollDelta(anchor, items) {
  const now = anchor && items.find((i) => i.key === anchor.key);
  const d = now ? now.top - anchor.top : 0;
  return Math.abs(d) > 1 ? d : 0;
}
