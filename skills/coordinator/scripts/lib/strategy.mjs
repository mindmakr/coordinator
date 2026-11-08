// What to try when `next` says change-strategy (#65). The same cause twice in a
// concurrency or consistency gap ("gate checked outside lock", then the same on another
// writer) usually means the fix is being applied writer by writer: each round guards the
// path the critic named, and the next critic finds another path that writes around it.
// One run lost three rounds that way before a single locked writer fixed it. So for those
// causes the step carries a hint: one shared writer plus a guard test. Pure.

const CONCURRENCY = /\b(?:races?|racing|raced|locks?|locked|locking|unlocked|concurren(?:t|cy)|simultaneous(?:ly)?|atomic(?:ally)?|transactions?|transactional|writers?|double[- ]write|lost update|overwrit(?:e|es|ten)|duplicated?|idempoten(?:t|cy)|inconsisten(?:t|cy)|consistency|out of sync|drifts?|stale|mismatch(?:ed|es)?|diverg(?:e|es|ed|ent))\b/i;

export const SHARED_WRITER = 'the same concurrency or consistency cause came back: route every write of this state through one shared writer (one function, inside one lock or transaction), and add a guard test that fails when any other code path writes it, instead of patching the next writer the critic names';

// { hint } for a repeated concurrency or consistency cause, else {}. Rounds are the unit's
// last two (or any objects with cause and gap).
export function strategyHint(...rounds) {
  const text = rounds.map((r) => `${r?.cause ?? ''} ${r?.gap ?? ''}`).join(' ');
  return CONCURRENCY.test(text) ? { hint: SHARED_WRITER } : {};
}
