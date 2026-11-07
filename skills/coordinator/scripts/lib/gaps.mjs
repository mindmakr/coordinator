// Gaps across every run: what was left undone, so nobody forgets it. Derived
// from run state only (no git, no network). What shows, by kind:
//   stopped      a unit the rules stopped, with its last gap and cause
//   unfinished   a unit left neither passed nor stopped when its run closed
//   run          a run closed partial or stopped, with its reason
//   follow-up    a follow-up note
//   out-of-fence a follow-up or decision recorded as out of the run's fence
//   deferred     a decision or info note that puts work off (DEFER, a closed list)
//   upstream     a follow-up or retro note proposing a change to the skill
//   question     a question for the person
//   escape       a defect found after a unit passed
// The rules that resolve a gap are closed lists too; references/hud.md lists
// them. A person or the lead closes one with `run.mjs gap close`: a decision
// note with `gap: <id>` in that run's log; the last such note wins (`reopen`).
// Ids: <source>:<run>:<unit or ->:<seq>. Source is the note's own kind
// (follow-up, retro, decision, info, escape), `question` (seq qN), `stopped`
// (seq: the unit's nth stop), `unfinished` or `run`. An id never depends on
// what the text says, so a closure survives a change to these rules. Pure.
import { questions, answerText } from './questions.mjs';
import { clip } from './plain.mjs';
import { following } from './chain.mjs';
import { repoFromText } from './links.mjs';

export const KINDS = ['stopped', 'unfinished', 'run', 'follow-up', 'out-of-fence', 'deferred', 'upstream', 'question', 'escape'];
export const SOURCES = ['stopped', 'unfinished', 'run', 'follow-up', 'retro', 'decision', 'info', 'escape', 'question'];
export const KIND_LABEL = { stopped: 'stopped unit', unfinished: 'unfinished unit', run: 'run closed early', 'follow-up': 'follow-up', 'out-of-fence': 'out of fence', deferred: 'deferred', upstream: 'upstream', question: 'question', escape: 'escape' };
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UPSTREAM = /^\s*upstream\s*:|github\.com\/mindmakr\/coordinator\b|mindmakr\/coordinator#\d/i;
// A note that records upstream issues being filed is a record, not a proposal.
const FILED = /\b(?:posted|filed)\s+upstream\b|\bupstream\s+(?:filed|posted)\b/i;
const FENCE = /(?<![\w-])(?:out[\s-]of[\s-]fence|outside (?:this run'?s|the run'?s|the) fence)(?![\w-])/i;
// Deferral in a decision or info note: these phrases only (references/hud.md). "later" counts
// only where a clause ends ("fix the wording later.", "stays for later"), never as in "later disputes".
export const DEFER_PHRASES = ['later (ending a clause)', 'follow-up issue(s)', 'deferred', 'defer to', 'next release', 'out of fence'];
const DEFER = /(?<![\w-])(?:later(?=\s*(?:[.;,:)!]|$))|follow[\s-]up issues?|deferred|defer to|next release|out[\s-]of[\s-]fence)(?![\w-])/i;
// Work handed to a unit: "folded into c12" resolves once c12 passed (this run or a later one).
const FOLDED = /\bfold(?:ed)?\s+in(?:to)?\s+([A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])/gi;

// Issue and PR references: a GitHub URL, owner/repo#n, repo#n (the run's owner) or #n (the run's repo).
const REF = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)|(?<![\w/.-])(?:([A-Za-z0-9][A-Za-z0-9-]{0,38})\/)?([A-Za-z0-9][A-Za-z0-9._-]{0,99})?#(\d{1,7})\b/g;
// A reference tracks the gap only right after one of these (references/hud.md); a URL or #n
// anywhere else is the work itself or a PR it waits on. repo#n of another repo counts unless a PR or a wait precedes it.
const TRACK = /\b(?:tracked|filed|opened|moved|logged|raised|continues?|continued)(?:\s+(?:as|in|at|to|under))?\s*(?:an?\s+)?(?:(?:follow-up\s+)?issue|pr|pull request)?\s*:?\s*$/i;
const WAIT = /\b(?:pr|pull|waits?|waiting|after|until|merges?|on)\s*$/i;

function trackedRefs(text, repo) {
  const out = [];
  for (const m of String(text ?? '').matchAll(REF)) {
    const before = text.slice(Math.max(0, m.index - 48), m.index);
    let url; let named = false;
    if (m[1]) url = `https://github.com/${m[1]}/${m[2]}/${m[3]}`;
    else {
      const owner = m[4] ?? repo?.split('/')[0]; const name = m[5] ?? (m[4] ? null : repo?.split('/')[1]);
      if (m[4] && !m[5]) continue; // "owner/#1" is not a reference
      named = !!m[5];
      if (!owner || !name) { if (TRACK.test(before)) out.push(m[0]); continue; }
      url = `https://github.com/${owner}/${name}/issues/${m[6]}`;
    }
    if (TRACK.test(before) || (named && !WAIT.test(before))) out.push(url);
  }
  return [...new Set(out)];
}

export const gapId = (source, run, unit, seq) => `${source}:${run}:${unit ?? '-'}:${seq}`;
export function parseGapId(id) {
  const m = /^([a-z-]+):([^:]+):([^:]+):([A-Za-z0-9]+)$/.exec(String(id ?? ''));
  if (!m || !SOURCES.includes(m[1]) || !ID.test(m[2]) || !(m[3] === '-' || ID.test(m[3]))) return null;
  return { source: m[1], run: m[2], unit: m[3] === '-' ? null : m[3], seq: m[4] };
}

// The runs and units that continue this one, to the end of the chain (lib/chain.mjs). Older runs have neither link.
function continuations(byId, runId, unitId) {
  const out = []; const seen = new Set([`${runId}:${unitId}`]);
  for (let next = following(byId, runId, unitId); next && !seen.has(`${next.run}:${next.unit}`); next = following(byId, next.run, next.unit)) {
    seen.add(`${next.run}:${next.unit}`);
    const u = byId.get(next.run)?.units?.find((x) => x.id === next.unit);
    if (!u) break;
    out.push({ ...next, status: u.status });
  }
  return out;
}

const lastRound = (u) => (u.rounds ?? []).filter((r) => r && (r.gap || r.cause)).at(-1) ?? null;
const stops = (u) => (u.log ?? []).filter((e) => e?.kind === 'stop');
// A merge recorded after the unit's last stop: the work landed although the rules stopped it.
function mergedAfterStop(u, stoppedAt) {
  const m = (u.links ?? []).filter((l) => l?.kind === 'merge' && typeof l.url === 'string' && (!stoppedAt || String(l.at ?? '') >= stoppedAt)).at(-1);
  return m ? { reason: `merged after stop: ${m.url}`, by: 'state', derived: true, at: m.at ?? null } : null;
}
// A decision or info note after the last verdict (the stop is recorded a moment after it) that opens with the unit's id and says it merged: "m1 merged as PR #39 …".
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mergedByNote(run, u, stoppedAt) {
  const re = new RegExp(`^\\s*${esc(u.id)}(?![\\w-])[^.;]{0,40}?\\bmerged\\b`, 'i');
  const i = (run.notes ?? []).findLastIndex((n) => n && ['decision', 'info'].includes(n.kind) && typeof n.text === 'string' && re.test(n.text) && (!stoppedAt || String(n.at ?? '') >= stoppedAt));
  return i < 0 ? null : { reason: `merged after stop, says ${run.notes[i].kind} note ${i + 1}: ${clip(run.notes[i].text, 120)}`, by: 'state', derived: true, at: run.notes[i].at ?? null };
}

const trackedBy = (text, repo, what = 'tracked in') => { const r = trackedRefs(text, repo); return r.length ? { reason: `${what} ${r.join(', ')}`, by: 'state', derived: true } : null; };

function unitGaps(run, repo, out) {
  for (const u of run.units ?? []) {
    if (!u || typeof u.id !== 'string') continue;
    if (u.status === 'stopped') {
      const r = lastRound(u); const st = stops(u);
      const at = st.at(-1)?.at ?? (u.rounds ?? []).at(-1)?.at ?? run.closed?.at ?? run.createdAt ?? null;
      const why = u.stopReason ? `Stopped: ${u.stopReason}.` : 'Stopped.';
      out.push({
        kind: 'stopped', source: 'stopped', run: run.id, unit: u.id, seq: Math.max(1, st.length), at,
        text: r?.gap ? `${why} Last gap: ${r.gap}` : why, cause: r?.cause ?? null,
        from: r ? `verdict, round ${r.n ?? (u.rounds ?? []).indexOf(r) + 1}` : 'the stop rule',
        auto: mergedAfterStop(u, st.at(-1)?.at ?? null) ?? mergedByNote(run, u, (u.rounds ?? []).at(-1)?.at ?? st.at(-1)?.at ?? null) ?? (r?.gap ? trackedBy(r.gap, repo, 'its last gap is tracked in') : null), chain: true,
      });
    } else if (run.closed && u.status !== 'pass') {
      out.push({
        kind: 'unfinished', source: 'unfinished', run: run.id, unit: u.id, seq: 1, at: run.closed.at ?? null,
        text: `Left ${u.status ?? 'open'} when the run closed (${run.closed.outcome ?? 'closed'})${u.title ? `: ${u.title}` : ''}.`, cause: null,
        from: 'run close', auto: null, chain: true,
      });
    }
  }
}

// "folded into c12": resolved once a unit of that id passed in this run or a later one.
function folded(text, run, list) {
  for (const m of String(text).matchAll(FOLDED)) {
    const id = m[1];
    const hit = list.filter((r) => r.id === run.id || String(r.createdAt) >= String(run.createdAt)).find((r) => r.units?.some((u) => u.id === id && u.status === 'pass'));
    if (hit) return { reason: `folded into ${id}, which passed in ${hit.id}`, by: 'state', derived: true };
  }
  return null;
}

function noteGaps(run, list, repo, out) {
  const notes = Array.isArray(run.notes) ? run.notes : [];
  const filed = notes.filter((n) => n && FILED.test(String(n.text ?? '')));
  const filedRefs = [...new Set(filed.flatMap((n) => [...String(n.text).matchAll(/https?:\/\/[^\s,;)]+|[\w.-]+\/[\w.-]+#\d+/g)].map((x) => x[0].replace(/[.]+$/, ''))))];
  const seenUp = new Set();
  notes.forEach((n, i) => {
    if (!n || typeof n.text !== 'string' || typeof n.gap === 'string') return;
    const base = { source: n.kind, run: run.id, unit: typeof n.unit === 'string' ? n.unit : null, seq: i + 1, at: n.at ?? null, text: n.text, cause: null };
    const tracked = () => { const r = trackedRefs(n.text, repo); return r.length ? { reason: `tracked in ${r.join(', ')}`, by: 'state', derived: true } : null; };
    if (n.kind === 'escape') return out.push({ ...base, kind: 'escape', from: `escape note${n.round ? `, after the pass in round ${n.round}` : ''}`, auto: null });
    if (['decision', 'info'].includes(n.kind)) {
      if (n.answers || /^closed early as /.test(n.text) || !DEFER.test(n.text)) return;
      return out.push({ ...base, kind: FENCE.test(n.text) ? 'out-of-fence' : 'deferred', from: `${n.kind} note`, auto: tracked() ?? folded(n.text, run, list) });
    }
    if (!['follow-up', 'retro'].includes(n.kind) || FILED.test(n.text)) return;
    if (UPSTREAM.test(n.text)) {
      const key = n.text.trim().replace(/\s+/g, ' ').toLowerCase();
      if (seenUp.has(key)) return; // the same proposal twice in one run is one gap
      seenUp.add(key);
      const auto = tracked() ?? (filed.length ? { reason: `the run records upstream issues filed${filedRefs.length ? `: ${filedRefs.join(', ')}` : ''}`, by: 'state', derived: true } : null);
      return out.push({ ...base, kind: 'upstream', from: `${n.kind} note`, auto });
    }
    if (n.kind !== 'follow-up') return; // a retro note that is not an upstream proposal is a lesson, not a gap
    out.push({ ...base, kind: FENCE.test(n.text) ? 'out-of-fence' : 'follow-up', from: 'follow-up note', auto: tracked() ?? folded(n.text, run, list) });
  });
}

function questionGaps(run, out) {
  let qs = [];
  try { qs = questions(run); } catch { return; }
  for (const q of qs) {
    const auto = q.status === 'open' ? null
      : q.status === 'decided' ? { reason: 'closed by a decision', by: 'state', derived: true }
        : { reason: `answered by ${q.answer?.by ?? 'person'}: ${answerText(q.answer)}`, by: 'state', derived: true, at: q.answer?.at ?? null };
    out.push({ kind: 'question', source: 'question', run: run.id, unit: q.unit, seq: q.id, at: q.at ?? null, text: q.header ? `${q.header}: ${q.text}` : String(q.text ?? ''), cause: null, from: `question ${q.id}`, auto });
  }
}

function runGap(run, repo, out) {
  const outcome = run.closed?.outcome;
  if (!['partial', 'stopped'].includes(outcome)) return null;
  const early = (run.notes ?? []).filter((n) => n?.kind === 'decision' && /^closed early as /.test(String(n.text ?? ''))).at(-1);
  const reason = early ? early.text : `closed ${outcome} at "${run.closed.decision ?? '?'}".`;
  const g = { kind: 'run', source: 'run', run: run.id, unit: null, seq: 1, at: run.closed.at ?? null, text: `${reason[0].toUpperCase()}${reason.slice(1)}`, cause: null, from: 'run close', auto: null, own: trackedBy(reason, repo, 'what is left is tracked in') };
  out.push(g);
  return g;
}

// The closures recorded in a run's log: decision notes with `gap`, the last one per id.
function closures(run) {
  const m = new Map();
  for (const n of run.notes ?? []) {
    if (!n || n.kind !== 'decision' || typeof n.gap !== 'string') continue;
    m.set(n.gap, n.reopen ? null : { reason: String(n.reason ?? n.text ?? ''), by: n.by === 'person' ? 'person' : 'lead', at: n.at ?? null, derived: false, ...(n.confirm ? { confirm: String(n.confirm) } : {}) });
  }
  return m;
}

/** Every gap in these runs, open and resolved. `runs`: run states (old shapes load). */
export function gaps(runs) {
  const list = (runs ?? []).filter((r) => r && typeof r.id === 'string' && Array.isArray(r.units));
  const byId = new Map(list.map((r) => [r.id, r]));
  const out = []; const runGaps = [];
  for (const run of list) {
    const repo = typeof run.repo === 'string' ? run.repo : repoFromText(JSON.stringify(run.units));
    noteGaps(run, list, repo, out);
    questionGaps(run, out);
    const units = []; unitGaps(run, repo, units); out.push(...units);
    const rg = runGap(run, repo, out); if (rg) runGaps.push([rg, units]);
  }
  const closed = new Map(list.map((r) => [r.id, closures(r)]));
  const settled = new Map();
  const settle = (g, extra = null) => {
    const id = gapId(g.source, g.run, g.unit, g.seq);
    const resolution = closed.get(g.run)?.get(id) ?? g.auto ?? extra ?? null;
    const s = { id, kind: g.kind, run: g.run, unit: g.unit, at: g.at, text: g.text, cause: g.cause, from: g.from, carried: g.carried ?? null, status: resolution ? 'resolved' : 'open', resolution };
    settled.set(g, s); return s;
  };
  // Unit gaps settle on their own first; then a chain follows its end: resolved once the last
  // link passed or its own gap is resolved, else open and "carried → run:unit".
  const unitGapAt = new Map();
  for (const g of out.filter((x) => x.chain)) { settle(g); unitGapAt.set(`${g.run}:${g.unit}`, g); }
  for (const g of out.filter((x) => x.chain)) {
    if (settled.get(g).status === 'resolved') continue;
    const chain = continuations(byId, g.run, g.unit); const last = chain.at(-1);
    if (!last) continue;
    const name = `${last.run}:${last.unit}`;
    const endGap = unitGapAt.get(name);
    const end = endGap ? settled.get(endGap) : null;
    if (last.status === 'pass') settle(g, { reason: `finished in ${name} (passed)`, by: 'state', derived: true });
    else if (end?.status === 'resolved') settle(g, { reason: `finished in ${name}: ${end.resolution.reason}`, by: 'state', derived: true });
    else settled.get(g).carried = name;
  }
  for (const g of out.filter((x) => !x.chain && x.kind !== 'run')) settle(g);
  for (const [g, units] of runGaps) {
    g.auto = units.length && units.every((u) => settled.get(u).status === 'resolved') ? { reason: `every unit gap of the run is resolved (${units.length})`, by: 'state', derived: true } : g.own;
    settle(g);
  }
  const order = new Map([...list].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map((r, i) => [r.id, i]));
  return out.map((g) => settled.get(g)).sort((a, b) => order.get(a.run) - order.get(b.run) || String(a.at ?? '').localeCompare(String(b.at ?? '')) || a.id.localeCompare(b.id));
}

// The model the page and the text read: open and resolved, grouped by run (newest run first).
export function gapsModel(runs) {
  const all = gaps(runs);
  const open = all.filter((g) => g.status === 'open');
  const group = (xs) => { const m = new Map(); for (const g of xs) { if (!m.has(g.run)) m.set(g.run, []); m.get(g.run).push(g); } return [...m].map(([run, items]) => ({ run, items })); };
  return { open: group(open), resolved: group(all.filter((g) => g.status === 'resolved')), openCount: open.length, openRuns: new Set(open.map((g) => g.run)).size, resolvedCount: all.length - open.length, kinds: KINDS.filter((k) => all.some((g) => g.kind === k)), runs: [...new Set(all.map((g) => g.run))] };
}

// The decision note `gap close` (or `gap reopen`) adds to the run that owns the gap.
// A closure by the person carries their own words (`confirm`), like `answer --by person --confirm`.
export function closeGap(s, id, { reason, by = 'lead', confirm = null, reopen = false, at = new Date().toISOString() }) {
  const p = parseGapId(id);
  if (!p) throw new Error(`not a gap id: ${id} (source:run:unit:seq, as run.mjs gaps lists them)`);
  if (p.run !== s.id) throw new Error(`gap ${id} belongs to run ${p.run}, not ${s.id}`);
  if (!['person', 'lead'].includes(by)) throw new Error('--by must be person or lead');
  if (by === 'person' && !(typeof confirm === 'string' && confirm.trim())) throw new Error('--by person needs --confirm "<their words>": never close a gap for the person without them');
  if (by !== 'person' && confirm !== null) throw new Error('--confirm goes with --by person');
  s.notes ??= [];
  s.notes.push({ kind: 'decision', text: `${reopen ? 'reopened' : 'closed'} gap ${id}: ${reason}`, gap: id, reason, by, ...(by === 'person' ? { via: 'cli', confirm: confirm.trim() } : {}), ...(reopen ? { reopen: true } : {}), at });
}

// `run.mjs gaps`: one line per gap, then the count.
export function gapsText(list) {
  const open = list.filter((g) => g.status === 'open');
  const runs = new Set(open.map((g) => g.run)).size;
  const lines = list.map((g) => `${g.id}  [${KIND_LABEL[g.kind]}] ${g.status === 'open' ? (g.carried ? `[carried → ${g.carried}] ` : '') : `[resolved: ${clip(g.resolution.reason, 80)}] `}${clip(g.text.replace(/\s+/g, ' '), 140)}`);
  lines.push(`${open.length} open gap${open.length === 1 ? '' : 's'} across ${runs} run${runs === 1 ? '' : 's'}`);
  return `${lines.join('\n')}\n`;
}
