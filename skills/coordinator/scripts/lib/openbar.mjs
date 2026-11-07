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
//   3. "catch" before every, all or any; "never … anywhere"; "any phrasing/wording/form".
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
