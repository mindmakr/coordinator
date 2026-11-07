// Warns at intake when a bar or behaviour line reads open-ended (#35, references/bar.md):
// "catch every X", "any message that …", "never … anywhere". Such a line has no last case,
// so each round the critic finds a new one and the run loops.
//
// The heuristic, kept short on purpose (it only warns; `--accept-open` silences it):
// 1. An open word: every, all, any (followed later by "that", "which" or "who"), catch,
//    or "never" followed later by "anywhere".
// 2. No closed list in the same line: a colon, or brackets, followed by a list; "these",
//    "the following", "listed", a number before a noun ("six templates", "3 routes"),
//    or an inventory (inventory, registry, file, list, table, manifest, the committed keys).
// Pure.

const OPEN = [
  { word: 'every', re: /\bevery\b/i },
  { word: 'all', re: /\ball\b(?!\s+(?:tests?|checks?|suites?)\s+pass)/i },
  { word: 'any … that', re: /\bany\b[^.;]*?\b(?:that|which|who)\b/i },
  { word: 'catch', re: /\bcatch(?:es|ing)?\b/i },
  { word: 'never … anywhere', re: /\bnever\b[^.;]*?\banywhere\b/i },
];
const NUMBER = '(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|both)';
const CLOSED = [
  /:\s*\S[^.]*,/, // "these cases: a, b, c"
  /\([^)]*,[^)]*\)/, // "(a, b, c)"
  /\bthese\b|\bthe following\b|\blisted\b/i,
  new RegExp(`\\b${NUMBER}\\s+(?:[\\p{L}-]+\\s+){0,2}?[\\p{L}-]+s\\b`, 'iu'), // "six templates", "3 named routes"
  /\b(?:inventory|registry|manifest|allow-?list|committed keys|in (?:this|the) (?:file|list|table))\b/i,
];

// The open words a line uses, or [] when it reads closed (or names its closed list).
export function openWords(line) {
  const s = String(line ?? '');
  const hits = OPEN.filter((o) => o.re.test(s)).map((o) => o.word);
  if (!hits.length || CLOSED.some((re) => re.test(s))) return [];
  return hits;
}

// One warning for every open line among `lines` ({ what, text }), or null.
export function openWarning(lines) {
  const open = lines.map((l) => ({ ...l, words: openWords(l.text) })).filter((l) => l.words.length);
  if (!open.length) return null;
  const each = open.map((l) => `${l.what} reads open-ended (${l.words.join(', ')})`).join('; ');
  return `${each}: state it as a closed list ("these six templates") or "every entry in <inventory>", or pass --accept-open to keep it (recorded); references/bar.md`;
}
