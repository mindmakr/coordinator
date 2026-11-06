// Behaviours make up a bar: plain "Given … when … then …" or "It should …"
// sentences a critic marks pass or fail, each with its evidence. A unit has its
// own; the run's goal has its own too (`target` is a unit, or the run for the goal).
import { text } from './args.mjs';
import { unmet } from './rules.mjs';

export const ID = /^[A-Z]{1,2}\d{1,3}$/i;
const MAX = 30;
const now = () => new Date().toISOString();

const listOf = (s, unit) => (unit ? (unit.behaviours ??= []) : (s.goalBehaviours ??= []));
const nextId = (list, prefix) => `${prefix}${list.reduce((n, b) => Math.max(n, +b.id.replace(/\D/g, '') || 0), 0) + 1}`;

function checkId(id) {
  if (!ID.test(String(id))) throw new Error(`behaviour id must look like B1 or G2, got: ${id}`);
  return String(id).toUpperCase();
}

// Adds, rewords (back to unchecked) or removes one behaviour. Returns its id.
export function behave(s, unit, { id, text: t, remove = false }) {
  if (unit && ['pass', 'stopped'].includes(unit.status)) throw new Error(`unit ${unit.id} is ${unit.status}: its behaviours are final`);
  const list = listOf(s, unit);
  if (remove) {
    const i = list.findIndex((b) => b.id === checkId(id));
    if (i < 0) throw new Error(`no behaviour ${id}`);
    list.splice(i, 1);
    return checkId(id);
  }
  const bid = id === undefined ? nextId(list, unit ? 'B' : 'G') : checkId(id);
  const found = list.find((b) => b.id === bid);
  const words = text(t, 'text', 500);
  if (found) Object.assign(found, { text: words, status: 'unchecked', evidence: null, at: now() });
  else {
    if (list.length >= MAX) throw new Error(`${MAX} behaviours at most`);
    list.push({ id: bid, text: words, status: 'unchecked', evidence: null, at: now() });
  }
  return bid;
}

// "B1=pass:evidence" or "B1=fail:what went wrong". A pass needs evidence.
export function parseMark(raw) {
  const m = /^\s*([A-Z]{1,2}\d{1,3})\s*=\s*(pass|fail)\s*(?::\s*([\s\S]*))?$/i.exec(String(raw ?? ''));
  if (!m) throw new Error(`--behaviour must look like B1=pass:"evidence" or B1=fail:"gap", got: ${raw}`);
  const evidence = m[3]?.trim() ? text(m[3], 'behaviour evidence', 1000) : null;
  if (m[2].toLowerCase() === 'pass' && !evidence) throw new Error(`${m[1]}=pass needs evidence: ${m[1]}=pass:"what shows it"`);
  return { id: m[1].toUpperCase(), status: m[2].toLowerCase(), evidence };
}

// Applies the critic's marks; when the verdict is a pass, every behaviour must pass.
// Returns the marks as recorded on the round.
export function mark(list, raws, verdict) {
  const marks = (raws ?? []).map(parseMark);
  for (const m of marks) if (!list.some((b) => b.id === m.id)) throw new Error(`no behaviour ${m.id}`);
  const after = list.map((b) => { const m = marks.findLast((x) => x.id === b.id); return m ? { ...b, ...m, at: now() } : b; });
  const open = unmet(after);
  if (verdict === 'pass' && open.length) throw new Error(`pass refused: behaviour ${open.map((b) => `${b.id} (${b.status})`).join(', ')} not passing; mark each with --behaviour ${open[0].id}=pass:"evidence"`);
  after.forEach((b, i) => Object.assign(list[i], b));
  return marks;
}

// A new build makes the critic look again: marks go back to unchecked.
export function reopen(list) { for (const b of list ?? []) Object.assign(b, { status: 'unchecked', evidence: null }); }
