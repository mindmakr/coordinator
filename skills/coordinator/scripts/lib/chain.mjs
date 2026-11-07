// One piece of work across runs (#36): a unit stopped in one run and finished
// in a follow-on run (`init --continues <run>:<unit>`, `add <run> <unit>
// --continues …` for another id, or `link --continues` afterwards) is a chain.
// The child run records `continues: [{ run, unit, as? }]` (`as`: the child's
// unit id when it differs); the parent's unit records `continuedIn: [{ run,
// unit?, at }]`. A unit is continued at most once (no forks), so a chain is a
// line and stats count it once. Both fields are optional: older runs have
// neither and load as before. Pure.

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FINISHED = ['pass', 'stopped'];

// "<run>:<unit>" as { run, unit }; throws on anything else.
export function parseContinues(raw) {
  const m = /^([^:]+):([^:]+)$/.exec(String(raw ?? '').trim());
  if (!m || !ID.test(m[1]) || !ID.test(m[2])) throw new Error(`--continues must be <run>:<unit>, got: ${raw}`);
  return { run: m[1], unit: m[2] };
}

export const continuesOf = (run) => (Array.isArray(run?.continues) ? run.continues.filter((c) => c && ID.test(c.run) && ID.test(c.unit) && (c.as === undefined || ID.test(c.as))) : []);
// The child's unit id for one `continues` entry.
export const childId = (c) => c.as ?? c.unit;
const unitIn = (run, id) => run?.units?.find((u) => u.id === id) ?? null;

// The run (and unit) this unit continues, if any.
export function previous(byId, runId, unitId) {
  const c = continuesOf(byId.get(runId)).find((x) => childId(x) === unitId);
  return c ? { run: c.run, unit: c.unit } : null;
}

// The run (and unit) that continued this unit: a loaded run that says so, else the parent's own record.
export function following(byId, runId, unitId) {
  const kids = [];
  for (const r of byId.values()) for (const c of continuesOf(r)) if (c.run === runId && c.unit === unitId) kids.push({ r, c });
  kids.sort((a, b) => String(a.r.createdAt).localeCompare(String(b.r.createdAt)));
  if (kids.length) return { run: kids[0].r.id, unit: childId(kids[0].c) };
  const rec = unitIn(byId.get(runId), unitId)?.continuedIn?.find((c) => c && ID.test(c.run));
  return rec ? { run: rec.run, unit: typeof rec.unit === 'string' && ID.test(rec.unit) ? rec.unit : unitId } : null;
}

// Where a unit stands: pass or stopped; "unfinished" when its run closed with it
// neither (open, building, judging); else its live status.
export const outcomeOf = (status, closed) => (FINISHED.includes(status) ? status : closed ? 'unfinished' : status);

// One link of a chain as the pages show it. `known: false` when that run is not loaded here.
function linkOf(byId, ref) {
  const run = byId.get(ref.run); const u = unitIn(run, ref.unit);
  if (!u) return { run: ref.run, unit: ref.unit, known: false, status: null, stopReason: null, rounds: [], outcome: null };
  return { run: ref.run, unit: ref.unit, known: true, status: u.status, stopReason: u.stopReason ?? null, rounds: u.rounds ?? [], outcome: outcomeOf(u.status, !!run.closed) };
}

// The whole chain through (runId, unitId), oldest run first; null when the unit stands alone.
export function chainOf(runs, runId, unitId) {
  const byId = runs instanceof Map ? runs : new Map(runs.map((r) => [r.id, r]));
  const seen = new Set([`${runId}:${unitId}`]);
  const before = [];
  for (let p = previous(byId, runId, unitId); p && !seen.has(`${p.run}:${p.unit}`); p = previous(byId, p.run, p.unit)) { seen.add(`${p.run}:${p.unit}`); before.unshift(linkOf(byId, p)); }
  const after = [];
  for (let n = following(byId, runId, unitId); n && !seen.has(`${n.run}:${n.unit}`); n = following(byId, n.run, n.unit)) { seen.add(`${n.run}:${n.unit}`); after.push(linkOf(byId, n)); }
  if (!before.length && !after.length) return null;
  const here = linkOf(byId, { run: runId, unit: unitId });
  const all = [...before, here, ...after];
  const final = all.findLast((l) => l.known) ?? here;
  return { before, after, final: { run: final.run, unit: final.unit, status: final.status, outcome: final.outcome }, rounds: all.reduce((n, l) => n + l.rounds.length, 0) };
}

// Every unit of these runs, with a chain counted once: a unit continued in a run
// of this set is folded into the last link, its rounds added up and its outcome
// taken from that last run ("unfinished" when that run closed with it open).
// A continuation outside the set (an open run, for closed-run stats) leaves the
// unit as it stands. `links`: each run and unit id of the chain, oldest first.
export function chainUnits(runs) {
  const byId = new Map(runs.map((r) => [r.id, r]));
  const out = [];
  for (const run of runs) for (const u of run.units) {
    const next = following(byId, run.id, u.id);
    if (next && unitIn(byId.get(next.run), next.unit)) continue; // counted in the run that continued it
    const links = [{ run: run.id, unit: u.id, status: u.status, rounds: u.rounds.length }];
    const seen = new Set([`${run.id}:${u.id}`]);
    for (let p = previous(byId, run.id, u.id); p && !seen.has(`${p.run}:${p.unit}`); p = previous(byId, p.run, p.unit)) {
      seen.add(`${p.run}:${p.unit}`);
      const pu = unitIn(byId.get(p.run), p.unit);
      if (!pu) break;
      links.unshift({ run: p.run, unit: p.unit, status: pu.status, rounds: pu.rounds.length });
    }
    out.push({ run: run.id, id: u.id, status: u.status, outcome: outcomeOf(u.status, !!run.closed), rounds: links.reduce((n, l) => n + l.rounds, 0), runs: links.map((l) => l.run), links, unit: u });
  }
  return out;
}

// The runs this run links to, both ways, through `continues` and `continuedIn`, loaded with `load(id)`
// (which may throw or return null for a run that is gone). Includes the run itself.
export function linkedRuns(run, load) {
  const got = new Map([[run.id, run]]);
  const todo = [run];
  while (todo.length) {
    const r = todo.pop();
    const ids = [...continuesOf(r).map((c) => c.run), ...r.units.flatMap((u) => (u.continuedIn ?? []).map((c) => c?.run))];
    for (const id of ids) {
      if (!ID.test(String(id)) || got.has(id)) continue;
      let s = null; try { s = load(id); } catch { /* gone or unreadable: the chain shows it as unknown */ }
      got.set(id, s);
      if (s && Array.isArray(s.units)) todo.push(s);
    }
  }
  return new Map([...got].filter(([, s]) => s && Array.isArray(s.units)));
}

// A link's name: its run, and its unit id when that differs from the unit shown.
export const linkName = (l, here) => (l.unit === here ? l.run : `${l.run}:${l.unit}`);

// "continues coordinator-1.0 (3 tries, stopped) · continued in coordinator-1.0b (3 tries, pass)"
export function chainLine(c, here) {
  if (!c) return '';
  const one = (l) => (l.known ? `${linkName(l, here)} (${l.rounds.length} ${l.rounds.length === 1 ? 'try' : 'tries'}, ${l.outcome})` : `${linkName(l, here)} (not here)`);
  return [c.before.length ? `continues ${c.before.map(one).join(' → ')}` : '', c.after.length ? `continued in ${c.after.map(one).join(' → ')}` : ''].filter(Boolean).join(' · ');
}
