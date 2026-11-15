// What counts as the person approving a step only they may approve (today:
// `run.mjs extend`, more rounds for a unit or more time for the run). Two things must both hold:
//
// 1. It came from the person. Answers and notes carry `via`: "dashboard" (the
//    local `serve` page), "web" (the hosted service, or a comment command,
//    arriving by `pull`) or "cli" (`run.mjs answer` / `note --kind person`,
//    typed by the lead). A CLI entry counts only with `confirm`: the lead
//    pasted the person's own words (`answer … --by person --confirm "…"`,
//    `note --kind person --confirm`), which references/commands/run.md forbids
//    without them. Entries without `via` (older runs) do not count.
// 2. It says yes, unambiguously. An answer must be exactly the option the
//    question marked as approving (`ask … --approves <label>`), with no free
//    text. A note must say "approve" or "approved" and nothing that refuses,
//    hedges or asks: no, not, don't, never, refuse, reject, decline, wait,
//    maybe, unless, but, if, a condition (once, after, when, until), or a
//    question mark. A CLI answer's --confirm words pass the same check.
// Pure.

export const PERSON_SURFACES = ['dashboard', 'web'];
const APPROVE = /\bapproved?\b/i;
const DOUBT = /\b(no|not|don'?t|do not|never|refuse[ds]?|reject(ed)?|declined?|disapprove[ds]?|unapproved|wait|maybe|perhaps|unless|but|if|once|after|when|until)\b|n't\b|\?/i;

// Words that refuse, hedge or ask: a person's confirmed words with any of these never count as a clear pick.
export const doubtful = (t) => DOUBT.test(String(t ?? ''));
export const fromPerson = (e) => !!e && e.by !== 'lead' && (PERSON_SURFACES.includes(e.via) || (e.via === 'cli' && !!e.confirm));
export const noteApproves = (text) => APPROVE.test(String(text ?? '')) && !DOUBT.test(String(text ?? ''));

// Why a question's latest answer does not approve, or null when it does.
export function answerRefusal(q) {
  const a = q?.answer;
  if (!q.approves) return `${q.id} marks no option as approving (ask … --approves <label>)`;
  if (!a) return `${q.id} has no answer yet`;
  if (a.by !== 'person' || !fromPerson(a)) return `${q.id}'s answer was not given by the person on the dashboard or the web (a lead's \`answer\` counts only with --by person --confirm "<their words>")`;
  if (a.other || a.choices.length !== 1 || a.choices[0] !== q.approves) return `${q.id} was answered "${[...a.choices, ...(a.other ? [a.other] : [])].join(', ')}", not "${q.approves}"`;
  if (a.confirm && DOUBT.test(a.confirm)) return `${q.id}'s confirmed words do not clearly say yes: "${a.confirm.slice(0, 120)}" (no, not, but, if, once, after, when, until, maybe or a question)`;
  return null;
}

// Why a person's note does not approve, or null when it does.
export function noteRefusal(n) {
  if (!fromPerson(n)) return 'the note was not added by the person on the dashboard or the web (a lead\'s `note --kind person` counts only with --confirm, pasting their words)';
  if (!noteApproves(n.text)) return `the note does not clearly approve: it must say "approve" or "approved", with no no, not, but, if, maybe or question`;
  return null;
}

// Why a person's note does not clearly record their decision, or null when it does. For a step that
// records what the person already decided rather than asking leave (today: `run.mjs ship`, a unit merged
// on their word without a final verdict, #66): it must come from the person, as above, and carry no
// refusing, hedging or asking word; "approve" itself is not needed ("Yes, merge; rest as issues").
export function decisionRefusal(n) {
  if (!fromPerson(n)) return 'the note was not added by the person on the dashboard or the web (a lead\'s `note --kind person` counts only with --confirm, pasting their words)';
  if (!String(n.text ?? '').trim()) return 'the note is empty';
  if (DOUBT.test(String(n.text))) return `their words do not clearly say it: "${String(n.text).slice(0, 120)}" (no, not, but, if, once, after, when, until, maybe or a question)`;
  return null;
}

// How many rounds the person's own words name, or null when they name none: then an
// approval is for one round. Only 1-4 (a digit or a word) right before "round(s)" or
// "more" counts ("two more rounds", "3 rounds", "one more"); any other number ("PR 1234")
// is not a round count. A count tied to "more" wins over one given for context ("two more
// rounds; it used 3 rounds" is 2); counts that still differ name no single number: one round.
const NUMBERS = { one: 1, two: 2, three: 3, four: 4, single: 1 };
export function namedRounds(words) {
  const found = [...String(words ?? '').toLowerCase().matchAll(/\b([1-4]|one|two|three|four|single)\s+(more|rounds?)\b/g)].map((m) => ({ n: NUMBERS[m[1]] ?? +m[1], more: m[2] === 'more' }));
  const counts = new Set((found.some((f) => f.more) ? found.filter((f) => f.more) : found).map((f) => f.n));
  return counts.size === 1 ? [...counts][0] : null;
}

// How many minutes of run time the person's own words grant (`run.mjs extend <run>`), as
// { minutes, why }. An approval gate errs towards fewer minutes or a refusal, never more:
// - An amount is a number with its unit: "90 minutes", "45 more mins", "60-minute", "2 hours",
//   "1.5 hours", "1h", "90m", "1h30", "an hour", "another hour", "half an hour",
//   "an hour and a half", "one and a half hours", "1 hour 30 minutes", "thirty minutes".
// - A granted amount is tied to more, another, extra, additional, add, plus, longer,
//   extension or "extend … by" ("30 more minutes", "add 30 minutes", "a 60-minute extension").
//   When any amount is granted, only granted amounts count: a number given for context
//   ("the run is 45 minutes over", "a 120 minute budget") is not what was approved.
// - The amounts that count must all be the same, or nothing is granted: why names them.
// - A time it cannot read for sure ("a couple of hours", "1.33 hours", "1 hour 30") grants
//   nothing: why says so. No amount at all gives { minutes: null, why: null }.
// Pure.
const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const HR = String.raw`(?:hours?|hrs?)`;
const MN = String.raw`(?:minutes?|mins?)`;
const NUM = String.raw`(\d{1,5}(?:\.\d+)?|an?|another)`;
const GAP = String.raw`(?:\s*-\s*|\s+)`; // "60 minutes", "60-minute"
const MORE = String.raw`(?:(?:more|extra|additional)\s+)?`;
const THEN = String.raw`(?!\s*(?:and\s+)?\d)`; // "1 hour 30", "1h 30": minutes with no unit stay unread, never dropped
const AMOUNTS = [ // [pattern, minutes from the match]; longer forms first, so "an hour and a half" is not read as "an hour"
  [String.raw`\b${NUM}\s+and\s+a\s+half\s+${MORE}${HR}`, (m) => one(m[1]) * 60 + 30],
  [String.raw`\b${NUM}${GAP}${MORE}${HR}\s+and\s+a\s+half\b`, (m) => one(m[1]) * 60 + 30],
  [String.raw`\bhalf\s+(?:an?\s+)?${HR}`, () => 30],
  [String.raw`\b${NUM}${GAP}${MORE}${HR}\s+(?:and\s+)?(\d{1,2})${GAP}${MN}\b`, (m) => one(m[1]) * 60 + +m[2]],
  [String.raw`\b(\d{1,3})h(?:(\d{1,2})m?|\s+(\d{1,2})\s*(?:m|mins?|minutes?))\b`, (m) => +m[1] * 60 + +(m[2] ?? m[3])],
  [String.raw`\b${NUM}${GAP}${MORE}${HR}\b${THEN}`, (m) => one(m[1]) * 60],
  [String.raw`\b(\d{1,3}(?:\.\d+)?)h\b${THEN}`, (m) => +m[1] * 60],
  [String.raw`\b${NUM}${GAP}${MORE}${MN}\b`, (m) => one(m[1])],
  [String.raw`\b(\d{1,5})m\b`, (m) => +m[1]],
];
const one = (n) => (/^(?:an?|another)$/.test(n) ? 1 : +n);
const GRANT_IN = /\b(?:more|extra|additional|another)\b/;
const GRANT_BEFORE = /\b(?:add(?:s|ed|ing)?|another|extra|additional|plus|extend(?:s|ed|ing)?(?:\s+\w+){0,2}\s+by)\s+$/;
const GRANT_AFTER = /^\s*(?:more|extra|longer|extension)\b/;
const UNREAD = new RegExp(String.raw`\d\s*-?\s*(?:h|m|${HR}|${MN})\b|\bhalf\b|\b(?:couple|few|several|dozen|hundred|thousand)\b[^.;,]{0,20}?\b(?:${HR}|${MN})\b|\b(?:an?|another)\s+${MORE}${HR}\b`);
const WORDS = [
  [new RegExp(String.raw`\b(${Object.keys(TENS).join('|')})(?:[-\s](${SMALL.slice(1, 10).join('|')}))?\b`, 'g'), (_, a, b) => String(TENS[a] + (b ? SMALL.indexOf(b) : 0))],
  [new RegExp(String.raw`\b(${SMALL.slice(1).join('|')})\b`, 'g'), (w) => String(SMALL.indexOf(w))],
];

export function namedMinutes(words) {
  let t = WORDS.reduce((s, [re, to]) => s.replace(re, to), ` ${String(words ?? '').toLowerCase()} `);
  const found = [];
  for (const [re, value] of AMOUNTS) {
    t = t.replace(new RegExp(re, 'g'), (...m) => {
      const at = m.at(-2);
      const granted = GRANT_IN.test(m[0]) || GRANT_BEFORE.test(t.slice(0, at)) || GRANT_AFTER.test(t.slice(at + m[0].length));
      found.push({ text: m[0].trim(), minutes: value(m), granted });
      return ' '.repeat(m[0].length); // keeps the offsets of the amounts still to find
    });
  }
  const left = t.match(UNREAD);
  if (left) return { minutes: null, why: `they name a time that cannot be read for sure ("${left[0].trim()}")` };
  const odd = found.find((f) => !(f.minutes > 0) || Math.abs(f.minutes - Math.round(f.minutes)) > 1e-9);
  if (odd) return { minutes: null, why: `"${odd.text}" is not a whole number of minutes above 0` };
  if (!found.length) return { minutes: null, why: null };
  const counted = found.some((f) => f.granted) ? found.filter((f) => f.granted) : found;
  const amounts = [...new Set(counted.map((f) => Math.round(f.minutes)))].sort((a, b) => a - b);
  if (amounts.length > 1) return { minutes: null, why: `they name different amounts (${amounts.join(', ')} minutes)` };
  return { minutes: amounts[0], why: null };
}
