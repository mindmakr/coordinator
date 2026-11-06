// Keeping the reader's place on the live page. The page runs these functions'
// source (like timeline.mjs `matches`), so the tests check the same code.
// An anchor is found again by its key, never by its node: a live update may
// replace the very block the reader is looking at.

// items: the keyed elements in document order, as { key, top, bottom } (viewport px).
// The anchor is the first one that starts on screen (deepest wins, since a
// block starting above the fold is skipped for the rows inside it); else the
// first one still visible at all.
export function pickAnchor(items) {
  const hit = items.find((i) => i.bottom > 0 && i.top >= 0) ?? items.find((i) => i.bottom > 0);
  return hit ? { key: hit.key, top: hit.top } : null;
}

// How far to scroll so the anchor sits where it was: 0 when it is gone.
export function scrollDelta(anchor, items) {
  const now = anchor && items.find((i) => i.key === anchor.key);
  return now ? now.top - anchor.top : 0;
}
