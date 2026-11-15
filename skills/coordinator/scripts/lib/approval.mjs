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

// Run time is granted only as the amount stored on the question (`ask … --approves <label>
// --grant-minutes N`), never read from free text. The text around it (the question, its header, every
// option, the person's confirmed words) may repeat N, in digits or words ("60", "sixty"), and name no
// other amount: why it does not, or null. Refused, never read: any other number in any digits ("30",
// ".5", "1,5", "30-45", "３０", "٣٠", "½") or words ("one", "thirty"); the words half, halves, quarter(s),
// third(s), couple, few, several, dozen(s), hundred(s), thousand(s), million(s), double, twice, triple;
// a time unit other than minutes (hour(s), hr(s), second(s), sec(s), day(s), week(s), and a number
// followed by h, s, d or w: "1h", "90s"); "a minute" or "another minute"; and a total ("extend it to
// 60 minutes", "in total"). The text is NFKC-normalized first, so fullwidth "６０" reads as 60; digits
// it leaves outside 0-9 (Arabic-Indic, Devanagari, …) are refused even when they mean N. Pure.
const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const AMOUNT = new RegExp([
  String.raw`(?:\p{N}+(?:[.,]\p{N}+)*|[.,]\p{N}+)\s*[hsdw]\b`, // 1h, 1.5 h, 90s, 2d, 1w
  String.raw`\p{N}+(?:[.,]\p{N}+)*|[.,]\p{N}+`, // 60, 1,5, .5, ٣٠
  String.raw`\b(?:an?|another|one)\s+(?:more\s+)?(?:minute|min)\b`,
  String.raw`\b(?:hours?|hrs?|seconds?|secs?|days?|weeks?)\b`,
  String.raw`\b(?:half|halves|quarters?|thirds?|couple|few|several|dozens?|hundreds?|thousands?|millions?|double|twice|triple)\b`,
  String.raw`\b(?:${Object.keys(TENS).join('|')})(?:[-\s](?:${SMALL.slice(1, 10).join('|')})\b)?\b`,
  String.raw`\b(?:${SMALL.join('|')})\b`,
].join('|'), 'gu');
const TOTAL = /(?<!\bup\s)\bto\s+(?:\d+|[a-z]+ty\b|[a-z]+teen\b|ten\b)|\btotal\b/;
// Words that ask for less than N: refused in the person's confirmed words, never read as an amount.
const LESS = /\b(?:less|fewer|shorter|smaller|some|little|part|partly|partial|partially|portion|halfway|only)\b/;
const plain = (words) => String(words ?? '').normalize('NFKC').toLowerCase();
const valueOf = (w) => {
  if (/^[0-9]+$/.test(w)) return +w;
  const [a, b] = w.split(/[-\s]+/);
  if (a in TENS) return TENS[a] + (b ? SMALL.indexOf(b) : 0);
  return SMALL.includes(w) ? SMALL.indexOf(w) : NaN;
};
export function grantRefusal(words, n) {
  const t = plain(words);
  const other = [...t.matchAll(AMOUNT)].find((m) => valueOf(m[0]) !== n);
  if (other) return `name an amount other than the ${n} minutes it grants: "${other[0]}"`;
  const total = t.match(TOTAL);
  if (total) return `name a total ("${total[0]}"), not an amount added`;
  return null;
}

// The person's confirmed words on an answer that grants N minutes: grantRefusal, then no word asking for
// less (less, fewer, shorter, smaller, some, little, part, partly, partial, partially, portion, halfway,
// only; half is refused by grantRefusal). Why not, or null. Pure.
export function confirmRefusal(words, n) {
  const why = grantRefusal(words, n);
  if (why) return why;
  const less = plain(words).match(LESS);
  return less ? `ask for less than the ${n} minutes it grants ("${less[0]}")` : null;
}

// The text of a question that grants N minutes, field by field: [field, text] pairs, the approving
// option checked by grantOption. Throws the first field that names another amount or a total. Pure.
export function grantFields(fields, n) {
  for (const [field, value] of fields) {
    const why = grantRefusal(value, n);
    if (why) throw new Error(`${field} ${why.replace(/^name /, 'names ').replace(`the ${n} minutes it grants`, `${n} minutes`)}`);
  }
}

// The approving option of a question that grants N minutes states it: an empty description becomes
// "N more minutes"; any other must contain those words and, with the label, name no other amount.
// Returns the option to store, or throws why not. Pure.
export function grantOption(opt, n) {
  const description = opt.description ?? `${n} more minutes`;
  if (!description.toLowerCase().includes(`${n} more minutes`)) throw new Error(`the approving option "${opt.label}" must state "${n} more minutes" (or leave its description empty: it is then written for you)`);
  grantFields([[`the approving option "${opt.label}"`, `${opt.label} | ${description}`]], n);
  return { ...opt, description };
}

// Every field of a question that grants N minutes ({ text, header, options, approves }): the question, the
// header, the approving option (grantOption) and each other option name no amount but N minutes. `ask` runs it
// before storing, `extend` again on the stored question before granting. Returns the options to store, or
// throws the first field that does not. Pure.
export function grantQuestion({ text, header, options, approves }, n) {
  grantFields([['the question', text], ['the header', header]], n);
  return options.map((x) => {
    if (x.label === approves) return grantOption(x, n);
    grantFields([[`option "${x.label}"`, `${x.label} | ${x.description ?? ''}`]], n);
    return x;
  });
}
