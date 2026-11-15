// Questions the lead asks and the person answers, from the CLI or the local
// answer page (lib/serve.mjs), and notes the person adds. A question is a
// `question` note, numbered q1, q2, … in the order asked, so questions logged
// by older versions with `note --kind question` keep their ids and still load.
import { basename, dirname } from 'node:path';
import { clip } from './plain.mjs';
import { num, oneOf, optText, text } from './args.mjs';
import { grantQuestion } from './approval.mjs';
import { maskSecrets } from './secrets.mjs';

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
  const question = text(o.question, 'question', 1000);
  // --grant-minutes N: the run time the approving option grants (`extend <run> --answer qN`); its text states it,
  // and no field of the question names another amount of time (lib/approval.mjs grantRefusal).
  const grant = grantMinutes(o['grant-minutes'], approves, o.unit);
  let stored = options;
  if (grant) {
    try { stored = grantQuestion({ text: question, header, options, approves }, grant); } catch (e) { throw new Error(`ask refused: ${e.message}`); }
  }
  s.notes.push({
    kind: 'question', text: question, header, options: stored, multi: o.multi === true,
    unit: hasUnit(s, o.unit), recommend: options[0].label, at: now(), history: [], usedAt: null, ...(approves ? { approves } : {}), ...(grant ? { grantMinutes: grant } : {}),
  });
  return `q${asked(s).length}`;
}

export const GRANT_MAX = 1440; // a day: more run time than that is a new run, not an extend
function grantMinutes(value, approves, unit) {
  if (value === undefined) return null;
  if (!approves) throw new Error('--grant-minutes goes with --approves: the option that grants the time');
  if (unit !== undefined) throw new Error("--grant-minutes is for the run's time: a question on a unit grants rounds (extend <run> <unit>)");
  try { return num(value, null, 1, GRANT_MAX); } catch (e) { throw new Error(`--grant-minutes: ${e.message}`); }
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
// project: the project's name (projectName), shown first in each question's label.
export function questions(run, { project = null } = {}) {
  return asked(run).map((n, i) => {
    const id = `q${i + 1}`;
    const history = n.history ?? [];
    const status = n.usedAt ? 'used' : decided(run, id) ? 'decided' : history.length ? 'answered' : 'open';
    return {
      id, text: n.text, header: n.header ?? null, options: n.options ?? [], multi: !!n.multi, unit: n.unit ?? null,
      recommend: n.recommend ?? null, approves: n.approves ?? null, grantMinutes: n.grantMinutes ?? null, at: n.at, answer: history.at(-1) ?? null, history, usedAt: n.usedAt ?? null,
      status, open: status === 'open', label: questionLabel(run, n.unit ?? null, project),
    };
  });
}

// Where a question comes from, so the person knows which run they answer (design one-boss 5.3):
// "<project> · <run name> (<run id>)", then " › Task <unit id>: <unit title>" for a question on a unit.
// Built here only: the lead never types it. Masked, control and direction characters removed, clipped.
const NAME_MAX = 40;
const TITLE_MAX = 60;
const clean = (v) => (typeof v === 'string' ? maskSecrets(v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')).replace(/\s+/g, ' ').trim() : '');

// The run's name: its alias, else its title (or goal), clipped.
export const runName = (run) => clip(clean(run.alias) || clean(run.title) || clean(run.goal), NAME_MAX);

// The project's name: the folder that holds `.coordinator/` (or the state folder's own name when COORDINATOR_DIR names another folder).
export const projectName = (stateDir) => clean(basename(basename(stateDir) === '.coordinator' ? dirname(stateDir) : stateDir));

export function questionLabel(run, unit = null, project = null) {
  const name = runName(run);
  const head = `${project ? `${clip(clean(project), NAME_MAX)} · ` : ''}${name ? `${name} ` : ''}(${clean(run.id)})`;
  if (!unit) return head;
  const u = (run.units ?? []).find((x) => x.id === unit);
  const title = clip(clean(u?.title) || clean(u?.bar), TITLE_MAX);
  return `${head} › Task ${clean(unit)}${title ? `: ${title}` : ''}`;
}

// How the lead asks (references/commands/run.md, Asking): `dialog`, the harness's question tool, is the default;
// `dashboard` logs the question, writes it in the chat and opens no dialog, so an answer on a dashboard is never
// stuck behind a dialog that waits for the terminal. The run's own choice (its intake answer, `note --kind decision
// --asking`) wins over the project's ("asking" in .coordinator/coordinator.json). A value that is not a mode
// counts as unset (doctor reports a bad setting).
export const ASKING = ['dialog', 'dashboard'];
export function askingMode(run, settings = {}) {
  if (ASKING.includes(run?.askMode)) return { mode: run.askMode, from: 'run' };
  if (ASKING.includes(settings?.asking)) return { mode: settings.asking, from: 'project' };
  return { mode: 'dialog', from: 'default' };
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
