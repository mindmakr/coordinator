// Gaps across every run: what was left undone, so nobody forgets it. Derived
// from run state only (no git, no network). Kinds:
//   stopped      a unit the rules stopped, with its last gap and cause
//   unfinished   a unit left neither passed nor stopped when its run closed
//   run          a run closed partial or stopped, with its reason
//   follow-up    a follow-up note
//   out-of-fence a follow-up the lead recorded as outside the run's fence
//   upstream     a follow-up or retro note proposing a change to the skill
//   question     a question for the person
//   escape       a defect found after a unit passed
// A gap is resolved when the state shows it (a continuing unit passed, the
// question was answered, the note links an issue or PR, the run records the
// upstream issue) or when someone closed it: `run.mjs gap close`, a decision
// note with `gap: <id>` in that run's log. The last such note wins (`reopen`).
// Ids are kind:run:unit:seq (unit "-" when none), stable across reloads. Pure.
import { questions, answerText } from './questions.mjs';
import { clip } from './plain.mjs';
import { following } from './chain.mjs';

export const KINDS = ['stopped', 'unfinished', 'run', 'follow-up', 'out-of-fence', 'upstream', 'question', 'escape'];
export const KIND_LABEL = { stopped: 'stopped unit', unfinished: 'unfinished unit', run: 'run closed early', 'follow-up': 'follow-up', 'out-of-fence': 'out of fence', upstream: 'upstream', question: 'question', escape: 'escape' };
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UPSTREAM = /^\s*upstream\s*:|github\.com\/mindmakr\/coordinator\b|mindmakr\/coordinator#\d/i;
// A note that records upstream issues being filed is a record, not a proposal.
const FILED = /\b(?:posted|filed)\s+upstream\b|\bupstream\s+(?:filed|posted)\b/i;
const FENCE = /\bout(?:side)?[\s-]+(?:of\s+)?(?:this\s+run'?s\s+|the\s+(?:run'?s\s+)?)?fence\b/i;
// An issue or PR: a GitHub URL, or owner/repo#n. A bare #n is the work's own number, not a link.
const REF = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+|(?<![\w/.-])[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}#\d{1,7}\b/g;
const refs = (t) => [...new Set(String(t ?? '').match(REF) ?? [])];

export const gapId = (kind, run, unit, seq) => `${kind}:${run}:${unit ?? '-'}:${seq}`;
export function parseGapId(id) {
  const m = /^([a-z-]+):([^:]+):([^:]+):([A-Za-z0-9]+)$/.exec(String(id ?? ''));
  if (!m || !KINDS.includes(m[1]) || !ID.test(m[2]) || !(m[3] === '-' || ID.test(m[3]))) return null;
  return { kind: m[1], run: m[2], unit: m[3] === '-' ? null : m[3], seq: m[4] };
}

// The runs and units that continue this one, to the end of the chain (lib/chain.mjs:
// the child run's `continues`, else the parent unit's `continuedIn`). Older runs have neither.
function continuations(byId, runId, unitId) {
  const out = []; const seen = new Set([`${runId}:${unitId}`]);
  for (let next = following(byId, runId, unitId); next && !seen.has(`${next.run}:${next.unit}`); next = following(byId, next.run, next.unit)) {
    seen.add(`${next.run}:${next.unit}`);
    const r = byId.get(next.run); const u = r?.units?.find((x) => x.id === next.unit);
    out.push({ ...next, known: !!u, status: u?.status ?? null, closed: !!r?.closed });
  }
  return out;
}

// A stopped or unfinished unit: resolved when a later run finished it; carried when a later run holds it now.
function chainResolution(byId, run, unit) {
  const chain = continuations(byId, run.id, unit.id).filter((l) => l.known);
  const last = chain.at(-1);
  if (!last) return null;
  const name = `${last.run}${last.unit !== unit.id ? `:${last.unit}` : ''}`;
  if (chain.some((l) => l.status === 'pass')) {
    const p = chain.find((l) => l.status === 'pass');
    return { reason: `finished in ${p.run}${p.unit !== unit.id ? `:${p.unit}` : ''} (passed)`, by: 'state', derived: true };
  }
  return { reason: `carried into ${name} (${last.closed && !['pass', 'stopped'].includes(last.status) ? 'unfinished' : last.status}): the gap is listed there`, by: 'state', derived: true };
}

const lastRound = (u) => (u.rounds ?? []).filter((r) => r && (r.gap || r.cause)).at(-1) ?? null;
const stopAt = (u) => (u.log ?? []).filter((e) => e?.kind === 'stop').at(-1)?.at ?? (u.rounds ?? []).at(-1)?.at ?? null;

function unitGaps(run, byId, out) {
  for (const u of run.units ?? []) {
    if (!u || typeof u.id !== 'string') continue;
    if (u.status === 'stopped') {
      const r = lastRound(u);
      const why = u.stopReason ? `Stopped: ${u.stopReason}.` : 'Stopped.';
      out.push({
        kind: 'stopped', run: run.id, unit: u.id, seq: 1, at: stopAt(u) ?? run.closed?.at ?? run.createdAt ?? null,
        text: r?.gap ? `${why} Last gap: ${r.gap}` : why, cause: r?.cause ?? null,
        source: r ? `verdict, round ${r.n ?? (u.rounds ?? []).indexOf(r) + 1}` : 'the stop rule',
        auto: chainResolution(byId, run, u),
      });
    } else if (run.closed && u.status !== 'pass') {
      out.push({
        kind: 'unfinished', run: run.id, unit: u.id, seq: 1, at: run.closed.at ?? null,
        text: `Left ${u.status ?? 'open'} when the run closed (${run.closed.outcome ?? 'closed'})${u.title ? `: ${u.title}` : ''}.`, cause: null,
        source: 'run close', auto: chainResolution(byId, run, u),
      });
    }
  }
}

function noteGaps(run, out) {
  const notes = Array.isArray(run.notes) ? run.notes : [];
  const filed = notes.filter((n) => n && FILED.test(String(n.text ?? '')));
  const filedRefs = [...new Set(filed.flatMap((n) => refs(n.text)))];
  notes.forEach((n, i) => {
    if (!n || typeof n.text !== 'string') return;
    const base = { run: run.id, unit: typeof n.unit === 'string' ? n.unit : null, seq: i + 1, at: n.at ?? null, text: n.text, cause: null };
    if (n.kind === 'escape') return out.push({ ...base, kind: 'escape', source: `escape note${n.round ? `, after the pass in round ${n.round}` : ''}`, auto: null });
    if (!['follow-up', 'retro'].includes(n.kind)) return;
    if (FILED.test(n.text)) return;
    const own = refs(n.text);
    if (UPSTREAM.test(n.text)) {
      const auto = own.length ? { reason: `linked to ${own.join(', ')}`, by: 'state', derived: true }
        : filed.length ? { reason: `the run records upstream issues filed${filedRefs.length ? `: ${filedRefs.join(', ')}` : ''}`, by: 'state', derived: true } : null;
      return out.push({ ...base, kind: 'upstream', source: `${n.kind} note`, auto });
    }
    if (n.kind !== 'follow-up') return; // a retro note that is not an upstream proposal is a lesson, not a gap
    out.push({ ...base, kind: FENCE.test(n.text) ? 'out-of-fence' : 'follow-up', source: 'follow-up note', auto: own.length ? { reason: `tracked in ${own.join(', ')}`, by: 'state', derived: true } : null });
  });
}

function questionGaps(run, out) {
  let qs = [];
  try { qs = questions(run); } catch { return; }
  for (const q of qs) {
    const n = Number(q.id.slice(1));
    const auto = q.status === 'open' ? null
      : q.status === 'decided' ? { reason: 'closed by a decision', by: 'state', derived: true }
        : { reason: `answered by ${q.answer?.by ?? 'person'}: ${answerText(q.answer)}`, by: 'state', derived: true, at: q.answer?.at ?? null };
    out.push({ kind: 'question', run: run.id, unit: q.unit, seq: `q${n}`, at: q.at ?? null, text: q.header ? `${q.header}: ${q.text}` : String(q.text ?? ''), cause: null, source: `question ${q.id}`, auto });
  }
}

function runGap(run, unitList, out) {
  const outcome = run.closed?.outcome;
  if (!['partial', 'stopped'].includes(outcome)) return;
  const early = (run.notes ?? []).filter((n) => n?.kind === 'decision' && /^closed early as /.test(String(n.text ?? ''))).at(-1);
  const reason = early ? early.text : `closed ${outcome} at "${run.closed.decision ?? '?'}"`;
  const mine = unitList.filter((g) => g.run === run.id);
  out.push({
    kind: 'run', run: run.id, unit: null, seq: 1, at: run.closed.at ?? null, text: early ? `${reason[0].toUpperCase()}${reason.slice(1)}` : `${reason[0].toUpperCase()}${reason.slice(1)}.`, cause: null, source: 'run close',
    // `open` is settled once every unit gap is: see gaps() below.
    auto: null, units: mine,
  });
}

// The closures recorded in a run's log: decision notes with `gap`, the last one per id.
function closures(run) {
  const m = new Map();
  for (const n of run.notes ?? []) {
    if (!n || n.kind !== 'decision' || typeof n.gap !== 'string') continue;
    m.set(n.gap, n.reopen ? null : { reason: String(n.reason ?? n.text ?? ''), by: n.by === 'person' ? 'person' : 'lead', at: n.at ?? null, derived: false });
  }
  return m;
}

/** Every gap in these runs, open and resolved. `runs`: run states (old shapes load). */
export function gaps(runs) {
  const list = (runs ?? []).filter((r) => r && typeof r.id === 'string' && Array.isArray(r.units));
  const byId = new Map(list.map((r) => [r.id, r]));
  const out = [];
  for (const run of list) {
    const units = [];
    unitGaps(run, byId, units);
    noteGaps(run, out);
    questionGaps(run, out);
    out.push(...units);
    runGap(run, units, out);
  }
  const closed = new Map(list.map((r) => [r.id, closures(r)]));
  const settle = (g) => {
    const id = gapId(g.kind, g.run, g.unit, g.seq);
    const manual = closed.get(g.run)?.get(id);
    const resolution = manual ?? g.auto ?? null;
    return { id, kind: g.kind, run: g.run, unit: g.unit, at: g.at, text: g.text, cause: g.cause, source: g.source, status: resolution ? 'resolved' : 'open', resolution };
  };
  const done = new Map();
  for (const g of out.filter((x) => x.kind !== 'run')) done.set(g, settle(g));
  for (const g of out.filter((x) => x.kind === 'run')) {
    const unitsOpen = g.units.filter((u) => done.get(u)?.status === 'open').length;
    g.auto = g.units.length && !unitsOpen ? { reason: `every unit gap of the run is resolved (${g.units.length})`, by: 'state', derived: true } : null;
    done.set(g, settle(g));
  }
  const order = new Map([...list].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map((r, i) => [r.id, i]));
  return out.map((g) => done.get(g)).sort((a, b) => order.get(a.run) - order.get(b.run) || String(a.at ?? '').localeCompare(String(b.at ?? '')) || a.id.localeCompare(b.id));
}

// The model the page and the text read: open and resolved, grouped by run (newest run first).
export function gapsModel(runs) {
  const all = gaps(runs);
  const open = all.filter((g) => g.status === 'open');
  const group = (xs) => { const m = new Map(); for (const g of xs) { if (!m.has(g.run)) m.set(g.run, []); m.get(g.run).push(g); } return [...m].map(([run, items]) => ({ run, items })); };
  return { open: group(open), resolved: group(all.filter((g) => g.status === 'resolved')), openCount: open.length, openRuns: new Set(open.map((g) => g.run)).size, resolvedCount: all.length - open.length, kinds: KINDS.filter((k) => all.some((g) => g.kind === k)), runs: [...new Set(all.map((g) => g.run))] };
}

// The decision note `gap close` (or `gap reopen`) adds to the run that owns the gap.
export function closeGap(s, id, { reason, by = 'lead', reopen = false, at = new Date().toISOString() }) {
  const p = parseGapId(id);
  if (!p) throw new Error(`not a gap id: ${id} (kind:run:unit:seq, as run.mjs gaps lists them)`);
  if (p.run !== s.id) throw new Error(`gap ${id} belongs to run ${p.run}, not ${s.id}`);
  if (!['person', 'lead'].includes(by)) throw new Error('--by must be person or lead');
  s.notes ??= [];
  s.notes.push({ kind: 'decision', text: `${reopen ? 'reopened' : 'closed'} gap ${id}: ${reason}`, gap: id, reason, by, ...(reopen ? { reopen: true } : {}), at });
}

// `run.mjs gaps`: one line per gap, then the count.
export function gapsText(list) {
  const open = list.filter((g) => g.status === 'open');
  const lines = list.map((g) => `${g.id}  ${g.status === 'open' ? '' : `[resolved: ${clip(g.resolution.reason, 80)}] `}${clip(g.text.replace(/\s+/g, ' '), 140)}`);
  lines.push(`${open.length} open gap${open.length === 1 ? '' : 's'} across ${new Set(open.map((g) => g.run)).size} run${new Set(open.map((g) => g.run)).size === 1 ? '' : 's'}`);
  return `${lines.join('\n')}\n`;
}
