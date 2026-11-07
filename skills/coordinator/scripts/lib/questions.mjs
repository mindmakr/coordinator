// Questions the lead asks and the person answers, from the CLI or the local
// answer page (lib/serve.mjs), and notes the person adds. A question is a
// `question` note, numbered q1, q2, … in the order asked, so questions logged
// by older versions with `note --kind question` keep their ids and still load.
import { clip } from './plain.mjs';
import { oneOf, optText, text } from './args.mjs';

export const HEADER_MAX = 12;
export const OTHER = '__other'; // the "Other" radio on the answer page
const now = () => new Date().toISOString();
const asked = (s) => (s.notes ?? []).filter((n) => n.kind === 'question');

export function find(s, id) {
  const m = /^q(\d+)$/.exec(String(id ?? ''));
  const q = m ? asked(s)[+m[1] - 1] : null;
  if (!q) throw new Error(`no question ${id} in run ${s.id}`);
  return q;
}

const decided = (s, id) => (s.notes ?? []).some((n) => n.kind === 'decision' && n.answers === id);
const hasUnit = (s, unit) => { if (unit !== undefined && !s.units.some((u) => u.id === unit)) throw new Error(`no unit ${unit} in run ${s.id}`); return unit ?? null; };

function option(raw) {
  const [label, ...rest] = String(raw).split('|');
  return { label: text(label, 'option label', 60), description: optText(rest.join('|'), 200) };
}

// Like the harness's question tool: 2-4 options, the recommended one first.
// Free text ("Other") is always allowed. Returns the new question's id.
export function ask(s, o) {
  const options = (Array.isArray(o.option) ? o.option : []).map(option);
  if (options.length < 2 || options.length > 4) throw new Error('give 2-4 --option "label|description", the recommended one first');
  if (new Set(options.map((x) => x.label.toLowerCase())).size !== options.length) throw new Error('option labels must differ');
  const header = text(o.header, 'header', 100);
  if (header.length > HEADER_MAX) throw new Error(`--header is ${HEADER_MAX} characters at most`);
  if (o.multi !== undefined && o.multi !== true) throw new Error('--multi takes no value');
  // --approves: the option that means "yes" to a step only the person may approve (lib/approval.mjs).
  const approves = o.approves === undefined ? null : options.find((x) => x.label.toLowerCase() === String(o.approves).trim().toLowerCase())?.label;
  if (approves === undefined) throw new Error(`--approves must name one of the options (${options.map((x) => x.label).join(', ')})`);
  if (approves && o.multi === true) throw new Error('--approves goes with a single-answer question');
  s.notes.push({
    kind: 'question', text: text(o.question, 'question', 1000), header, options, multi: o.multi === true,
    unit: hasUnit(s, o.unit), recommend: options[0].label, at: now(), history: [], usedAt: null, ...(approves ? { approves } : {}),
  });
  return `q${asked(s).length}`;
}

// Records an answer, or changes it until the lead has used it. Every answer is kept.
// via: where it was given (lib/approval.mjs): 'dashboard', 'web' or 'cli'; confirm: the person's words, for a CLI answer.
const VIA = ['dashboard', 'web', 'cli'];
export function answer(s, id, { choices = [], other = null, by = 'person', via = undefined, confirm = undefined }) {
  const q = find(s, id);
  if (q.usedAt) throw new Error(`${id} is already used by the lead; its answer can no longer change`);
  if (decided(s, id)) throw new Error(`${id} is closed by a decision`);
  const labels = (q.options ?? []).map((x) => x.label);
  const picked = [...new Set(choices.map((c) => {
    const hit = labels.find((l) => l.toLowerCase() === String(c).trim().toLowerCase());
    if (!hit) throw new Error(`${id} has no option "${clip(c, 60)}"${labels.length ? ` (options: ${labels.join(', ')})` : ': it has none, answer with --other'}`);
    return hit;
  }))];
  const free = optText(other, 1000);
  if (!picked.length && !free) throw new Error('give an answer: --choice or --other');
  if (!q.multi && picked.length + (free ? 1 : 0) > 1) throw new Error(`${id} takes one answer: one --choice, or --other`);
  const words = confirm === undefined ? null : text(confirm, 'confirm (the person\'s own words)', 1000);
  if (words && (by !== 'person' || via !== 'cli')) throw new Error('--confirm goes with --by person, on the CLI');
  q.history = [...(q.history ?? []), { choices: picked, other: free, by: oneOf(by, ['person', 'lead'], '--by'), ...(via !== undefined ? { via: oneOf(via, VIA, 'via') } : {}), ...(words ? { confirm: words } : {}), at: now() }];
}

export function useAnswer(s, id) {
  const q = find(s, id);
  if (!q.history?.length) throw new Error(`${id} has no answer yet`);
  if (q.usedAt) throw new Error(`${id} is already used`);
  q.usedAt = now();
}

// The answer page's fields: a single question's "Other" radio stands for the text box.
export function fromForm(q, choice, other) {
  if (q.multi) return { choices: choice.filter((c) => c !== OTHER), other };
  return choice.includes(OTHER) || !choice.length ? { choices: [], other } : { choices: choice.slice(0, 1), other: null };
}

export function personNote(s, { text: t, unit, via = undefined, confirm = false }) {
  if (confirm && via !== 'cli') throw new Error('--confirm goes with a note typed on the CLI');
  s.notes.push({ kind: 'person', text: text(t, 'text', 1000), unit: hasUnit(s, unit || undefined), ...(via !== undefined ? { via: oneOf(via, VIA, 'via') } : {}), ...(confirm ? { confirm: true } : {}), at: now() });
}

export const answerText = (a) => (a ? [...a.choices, ...(a.other ? [`"${a.other}"`] : [])].join(', ') : '');

// Every question with its state: open, answered (waiting for the lead), used, or decided.
export function questions(run) {
  return asked(run).map((n, i) => {
    const id = `q${i + 1}`;
    const history = n.history ?? [];
    const status = n.usedAt ? 'used' : decided(run, id) ? 'decided' : history.length ? 'answered' : 'open';
    return {
      id, text: n.text, header: n.header ?? null, options: n.options ?? [], multi: !!n.multi, unit: n.unit ?? null,
      recommend: n.recommend ?? null, approves: n.approves ?? null, at: n.at, answer: history.at(-1) ?? null, history, usedAt: n.usedAt ?? null,
      status, open: status === 'open',
    };
  });
}

// One line per new or changed answer and per new note from the person, between
// two reads of the state. With no earlier read: the answers still waiting for the lead.
export function events(prev, next) {
  const before = prev ? questions(prev) : [];
  const lines = [];
  for (const q of questions(next)) {
    const seen = prev ? (before.find((b) => b.id === q.id)?.history.length ?? 0) : (q.status === 'answered' ? q.history.length - 1 : q.history.length);
    q.history.slice(seen).forEach((a, k) => {
      const verb = seen + k ? 'changed' : 'answer';
      lines.push(`${verb} ${q.id}${q.unit ? ` (${q.unit})` : ''} by ${a.by}: ${clip(answerText(a), 200)} · ${clip(q.header || q.text, 60)}`);
    });
  }
  const notes = (n) => (n?.notes ?? []).filter((x) => x.kind === 'person');
  if (prev) for (const n of notes(next).slice(notes(prev).length)) lines.push(`note by person${n.unit ? ` on ${n.unit}` : ''}: ${clip(n.text, 240)}`);
  return lines;
}
