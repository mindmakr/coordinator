// What counts as the person approving a step only they may approve (today:
// `run.mjs extend`, more rounds for a unit). Two things must both hold:
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
//    maybe, unless, but, or a question mark.
// Pure.

export const PERSON_SURFACES = ['dashboard', 'web'];
const APPROVE = /\bapproved?\b/i;
const DOUBT = /\b(no|not|don'?t|do not|never|refuse[ds]?|reject(ed)?|declined?|disapprove[ds]?|unapproved|wait|maybe|perhaps|unless|but|if)\b|n't\b|\?/i;

export const fromPerson = (e) => !!e && e.by !== 'lead' && (PERSON_SURFACES.includes(e.via) || (e.via === 'cli' && !!e.confirm));
export const noteApproves = (text) => APPROVE.test(String(text ?? '')) && !DOUBT.test(String(text ?? ''));

// Why a question's latest answer does not approve, or null when it does.
export function answerRefusal(q) {
  const a = q?.answer;
  if (!q.approves) return `${q.id} marks no option as approving (ask … --approves <label>)`;
  if (!a) return `${q.id} has no answer yet`;
  if (a.by !== 'person' || !fromPerson(a)) return `${q.id}'s answer was not given by the person on the dashboard or the web (a lead's \`answer\` counts only with --by person --confirm "<their words>")`;
  if (a.other || a.choices.length !== 1 || a.choices[0] !== q.approves) return `${q.id} was answered "${[...a.choices, ...(a.other ? [a.other] : [])].join(', ')}", not "${q.approves}"`;
  return null;
}

// Why a person's note does not approve, or null when it does.
export function noteRefusal(n) {
  if (!fromPerson(n)) return 'the note was not added by the person on the dashboard or the web (a lead\'s `note --kind person` counts only with --confirm, pasting their words)';
  if (!noteApproves(n.text)) return `the note does not clearly approve: it must say "approve" or "approved", with no no, not, but, if, maybe or question`;
  return null;
}

// How many rounds the person's own words name ("two more rounds", "3 rounds"), or null when
// they name no number: then an approval is for one round. The largest number named wins.
const NUMBERS = { one: 1, two: 2, three: 3, four: 4, a: null, single: 1, couple: 2 };
export function namedRounds(words) {
  const found = [];
  for (const m of String(words ?? '').toLowerCase().matchAll(/\b(\d+|one|two|three|four|single)\b/g)) found.push(/^\d+$/.test(m[1]) ? +m[1] : NUMBERS[m[1]]);
  const n = found.filter((x) => Number.isInteger(x) && x > 0);
  return n.length ? Math.max(...n) : null;
}
