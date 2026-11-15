// A gentle "check this line" at intake when a bar or behaviour line looks open-ended
// (#35, references/bar.md): a class of things named by its wording, with no last case,
// so each round the critic finds one more and the run loops (u1213: "every 'we notified …'
// message comes from the same call that sends the notice").
//
// The heuristic is narrow on purpose. "Every page in en and ar" or "every date query in the
// issue" names a set someone can list, and most lines with "every" or "all" are fine (the
// first, broad version flagged 14 of 158 real lines, nearly all fine). It flags only:
//   1. a quantifier (every, any, all, each) a few words before a quoted phrase:
//      "every 'we notified' message";
//   2. a quantifier a few words before a wording noun: message(s), claim(s), phrasing,
//      wording, mention(s), variant(s), way(s) of saying;
//   3. "catch" before every, all or any; "never … anywhere"; "any phrasing/wording/form";
//   4. a guarantee with no edge (#65): "no way to/for …" (also path, route, means) and
//      "nothing … unseen" (unnoticed, unreviewed, unchecked, unrecorded, unverified, slips,
//      escapes, gets past). A run's goal said "no way for an operator to approve on something
//      they did not see"; each round fixed the reported gap and the next critic found an
//      adjacent, older one.
// …unless the same clause (up to ; or .) names its closed list: "listed", "below", "these",
// "the following", "in the issue", "named in", an inventory, registry or manifest, or a file.
// It only notes; `--accept-open` silences it and is recorded. Pure.

const Q = '(?:every|any|all|each)';
const WORDING = '(?:messages?|claims?|phrasings?|wordings?|mentions?|variants?|ways? (?:of|to) (?:say|put|word))';
const OPEN = [
  { word: 'a class named by a quoted phrase', re: new RegExp(`\\b${Q}\\s+(?:[\\p{L}\\p{N}-]+\\s+){0,3}?[‘“'"]`, 'iu') },
  { word: 'a class named by its wording', re: new RegExp(`\\b${Q}\\s+(?:[\\p{L}\\p{N}'-]+\\s+){0,3}?${WORDING}\\b`, 'iu') },
  { word: 'catch every', re: /\bcatch(?:es|ing)?\s+(?:every|all|any)\b/i },
  { word: 'never … anywhere', re: /\bnever\b[^.;]*?\banywhere\b/i },
  { word: 'any phrasing', re: /\bany\s+(?:phrasing|wording|form|variant|language)\b/i },
  { word: 'no way to …', re: /\bno\s+(?:way|path|route|means)\s+(?:for|to)\b/i },
  { word: 'nothing … unseen', re: /\bnothing\b[^.;]*?\b(?:unseen|unnoticed|unreviewed|unchecked|unrecorded|unverified|slips|escapes|gets\s+(?:through|past))\b/i },
];
const CLOSED = /\b(?:listed|below|these|the following|in the issue|named in|inventory|registry|manifest|allow-?list)\b|\.(?:json|md|ya?ml|tsx?|jsx?|csv)\b/i;

// What makes the line look open-ended, or [] when it reads closed.
export function openWords(line) {
  const hits = [];
  for (const clause of String(line ?? '').split(/;|\.(?=\s|$)/)) {
    if (CLOSED.test(clause)) continue;
    for (const o of OPEN) if (o.re.test(clause) && !hits.includes(o.word)) hits.push(o.word);
  }
  return hits;
}

// One "check this line" note for every open line among `lines` ({ what, text }), or null.
export function openWarning(lines) {
  const open = lines.map((l) => ({ ...l, words: openWords(l.text) })).filter((l) => l.words.length);
  if (!open.length) return null;
  const each = open.map((l) => `${l.what} (${l.words.join(', ')})`).join('; ');
  return `check this line, it may be open-ended: ${each}. If it has no last case, state it as a closed list ("these six templates") or "every entry in <inventory>"; if it is fine, pass --accept-open (recorded). references/bar.md`;
}

// A behaviour is checked against a strict list (the perf plan, cause D: "never grants more than approved" failed
// five critic rounds, each a new loophole). Unlike the gentle note above, these words are refused in a behaviour
// (add --behaviour, behave, freeze) unless the line names its cases, or the lead passes --open "<why it can be
// met>", which is logged: never, any, all, cannot, only, always, every.
export const UNBOUNDED = ['never', 'any', 'all', 'cannot', 'only', 'always', 'every'];
const UNBOUNDED_RE = new RegExp(`(?<![\\p{L}\\p{N}_'-])(?:${UNBOUNDED.join('|')})(?![\\p{L}\\p{N}_'-])`, 'giu');
// Cases named: a closed-list word (listed, these, the following, …), a list after a colon ("in: A, B and C"), a
// bracketed list "(A, B, C)", or numbered items "1) … 2) …".
const LIST_AFTER_COLON = /:\s*[^,;:]+(?:,\s*[^,;:]+)+(?:,?\s+(?:and|or)\s+[^,;:]+)?|:\s*[^,;:]+\s+(?:and|or)\s+[^,;:]+/u;
const BRACKET_LIST = /\([^()]*,[^()]*\)/u;
const NUMBERED = /(?:^|\s)(?:\(?\d+\)|\d+\.)\s[\s\S]*?(?:^|\s)(?:\(?\d+\)|\d+\.)\s/u;

// The unbounded words in a line (lower case, once each), or [] when there are none or the line names its cases.
export function unboundedWords(line) {
  const t = String(line ?? '');
  const words = [...new Set([...t.matchAll(UNBOUNDED_RE)].map((m) => m[0].toLowerCase()))];
  if (!words.length) return [];
  if (CLOSED.test(t) || LIST_AFTER_COLON.test(t) || BRACKET_LIST.test(t) || NUMBERED.test(t)) return [];
  return words;
}

// The refusal for behaviour lines ({ what, text, open }) that read unbounded and carry no --open reason, or null.
export function unboundedRefusal(lines) {
  const bad = lines.filter((l) => !l.open).map((l) => ({ ...l, words: unboundedWords(l.text) })).filter((l) => l.words.length);
  if (!bad.length) return null;
  return `refused: ${bad.map((l) => `${l.what} reads open-ended (${l.words.join(', ')})`).join('; ')}. Name its cases as a list ("for these three: A, B and C") so a critic can check each, or pass --open "<why it can be met as written>" (logged)`;
}
