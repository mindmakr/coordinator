#!/usr/bin/env node
// The coordinator's run state: one JSON file per run, written only through here.
// Each step is refused unless the loop asked for it (see allows() in lib/rules.mjs).
//
//   run.mjs init <run> --goal G --bar B --fence F [--paths a,b] [--tag T] [--max-rounds 4]
//                      [--max-minutes 240] [--max-units 6] [--max-added 2] [--stale-minutes 45]
//   run.mjs add <run> <unit> --bar B [--after U] [--reason R]      (--reason required after freeze)
//   run.mjs freeze <run>
//   run.mjs start <run> <unit>      only when next says build, or check-stale with phase building
//   run.mjs beat <run> <unit>       builder or critic still working
//   run.mjs built <run> <unit>      builder finished: the unit waits for a critic
//   run.mjs reset <run> <unit> --reason R     in-progress unit with no artifact goes back to build (after a crash)
//   run.mjs verdict <run> <unit> pass|fail --evidence E [--gap G] --score 0-10   only after built;
//                  score required on fail; on a run with --paths, pass needs a clean detect.mjs --unit result
//   run.mjs strategy <run> <unit> --text T                          only when next says change-strategy
//   run.mjs integrate <run> pass|fail --evidence E [--gap G]        only when next says integrate
//   run.mjs note <run> --kind decision|follow-up|question|bar|info --text T
//   run.mjs next <run>     prints what to do and records any stops
//   run.mjs show <run>     prints the workbench
//   run.mjs close <run> --outcome done|partial|stopped [--reason R]   reason required when closing before the rules end the run
//   run.mjs list | stats [--tag T] | where      where prints the state folder for briefs (COORDINATOR_DIR)
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { num, oneOf, optText, parse, score, text } from './lib/args.mjs';
import { allows, decide, decideUnit, stats } from './lib/rules.mjs';
import { baseDir, isSafeId, readJson, safeId, update, writeAtomic } from './lib/store.mjs';
import { render } from './lib/workbench.mjs';

const FLAGS = {
  init: ['goal', 'bar', 'fence', 'paths', 'tag', 'max-rounds', 'max-minutes', 'max-units', 'max-added', 'stale-minutes'],
  add: ['bar', 'after', 'reason'], verdict: ['evidence', 'gap', 'score'], strategy: ['text'],
  integrate: ['evidence', 'gap'], note: ['kind', 'text'], close: ['outcome', 'reason'], stats: ['tag'], reset: ['reason'],
};

// Stops cascade (a stopped unit stops the units stacked on it): apply until nothing changes.
function applyStops(st) {
  const stopped = new Map();
  for (let changed = true; changed;) {
    changed = false;
    for (const u of decide(st).units) if (u.action === 'stop') {
      const unit = st.units.find((x) => x.id === u.id); unit.status = 'stopped'; unit.stopReason = u.reason;
      stopped.set(u.id, u); changed = true;
    }
  }
  return stopped;
}

const runsDir = () => join(baseDir('project'), 'runs');
const stateFile = (run) => join(runsDir(), safeId(run, 'run'), 'state.json');
const now = () => new Date().toISOString();
const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean) : []);

function load(run) {
  if (!existsSync(stateFile(run))) throw new Error(`no run: ${run}`);
  return readJson(stateFile(run), null);
}

// Every change: locked, atomic, refused on a closed run, workbench refreshed in the same lock.
function change(run, mutate, { closedOk = false } = {}) {
  if (!existsSync(stateFile(run))) throw new Error(`no run: ${run}`);
  return update(stateFile(run), null, (s) => { if (s.closed && !closedOk) throw new Error(`run ${run} is closed`); mutate(s); },
    (s) => writeAtomic(join(runsDir(), run, 'workbench.md'), render(s, decide(s))));
}

function unitOf(s, id) {
  const u = s.units.find((x) => x.id === safeId(id, 'unit'));
  if (!u) throw new Error(`no unit ${id} in run ${s.id}`);
  return u;
}

function expect(s, u, cmd) {
  const d = decideUnit(u, s, Date.now());
  if (!s.frozen) throw new Error('freeze the run first');
  if (!allows(cmd, d)) throw new Error(`${cmd} refused: next says "${d.action}"${d.reason ? ` (${d.reason})` : ''} for ${u.id}`);
}

function judged(evidence, v, gapText) {
  const verdict = v === 'pass' && !evidence ? 'fail' : v;
  const gap = verdict === 'fail' ? (gapText ?? (evidence ? 'unspecified' : 'PASS claimed without evidence')) : null;
  return { verdict, gap };
}

const commands = {
  init([run], o) {
    safeId(run, 'run');
    const fresh = {
      id: run, tag: safeId(o.tag ?? 'general', 'tag'),
      goal: text(o.goal, 'goal'), bar: text(o.bar, 'bar'), fence: text(o.fence, 'fence'), paths: list(o.paths),
      budget: {
        maxRounds: num(o['max-rounds'], 4, 1, 8), maxMinutes: num(o['max-minutes'], 240, 5, 10_080),
        maxUnits: num(o['max-units'], 6, 1, 20), maxAdded: num(o['max-added'], 2, 0, 10),
        staleMinutes: num(o['stale-minutes'], 45, 5, 1440),
      },
      createdAt: now(), frozen: false, addedAfterFreeze: 0, units: [], notes: [], integration: { rounds: [] }, closed: null,
    };
    return update(stateFile(run), null, (s) => { if (s) throw new Error(`run exists: ${run}`); return fresh; },
      (s) => writeAtomic(join(runsDir(), run, 'workbench.md'), render(s, decide(s))));
  },
  add([run, unit], o) {
    return change(run, (s) => {
      safeId(unit, 'unit');
      if (s.units.some((u) => u.id === unit)) throw new Error(`unit exists: ${unit}`);
      if (s.units.length >= s.budget.maxUnits) throw new Error(`unit cap reached (${s.budget.maxUnits}): log the extra work as a follow-up note`);
      if (o.after) unitOf(s, o.after);
      if (s.frozen) {
        const reason = text(o.reason, 'reason (the run is frozen)');
        if (s.addedAfterFreeze >= s.budget.maxAdded) throw new Error('scope cap reached: log the extra work as a follow-up note and carry on');
        s.addedAfterFreeze++;
        s.notes.push({ kind: 'scope', text: `added ${unit}: ${reason}`, at: now() });
      }
      s.units.push({ id: unit, bar: text(o.bar, 'bar'), after: o.after ?? null, status: 'open', rounds: [], strategyChanges: 0, strategyAt: -1, heartbeatAt: null, stopReason: null });
    });
  },
  freeze([run]) { return change(run, (s) => { if (!s.units.length) throw new Error('add units first'); s.frozen = true; }); },
  start([run, unit]) { return change(run, (s) => { const u = unitOf(s, unit); expect(s, u, 'start'); u.status = 'building'; u.heartbeatAt = now(); }); },
  beat([run, unit]) {
    return change(run, (s) => { const u = unitOf(s, unit); if (!['building', 'judging'].includes(u.status)) throw new Error(`unit ${unit} is ${u.status}`); expect(s, u, 'beat'); u.heartbeatAt = now(); });
  },
  built([run, unit]) {
    return change(run, (s) => { const u = unitOf(s, unit); if (u.status !== 'building') throw new Error(`unit ${unit} is ${u.status}, not building`); expect(s, u, 'built'); u.status = 'judging'; u.heartbeatAt = now(); });
  },
  verdict([run, unit, v], o) {
    return change(run, (s) => {
      const u = unitOf(s, unit);
      if (u.status !== 'judging') throw new Error(`verdict refused: unit ${unit} is ${u.status}; record built first`);
      expect(s, u, 'verdict');
      oneOf(v, ['pass', 'fail'], 'verdict');
      if (v === 'fail' && o.score === undefined) throw new Error('--score is required on a fail (it drives the no-progress stop)');
      if (v === 'fail' && !optText(o.gap)) throw new Error('--gap is required on a fail (it drives the same-gap stop)');
      const evidence = optText(o.evidence);
      const { verdict, gap } = judged(evidence, v, optText(o.gap, 500));
      const round = u.rounds.length + 1;
      if (verdict === 'pass' && s.paths?.length && !(u.detect?.round === round && u.detect.clean)) {
        throw new Error(`pass refused: no clean detect result for round ${round}; run detect.mjs --run ${s.id} --unit ${u.id} --base … first`);
      }
      u.rounds.push({ n: round, verdict, score: score(o.score), gap, evidence, at: now() });
      u.status = verdict === 'pass' ? 'pass' : 'open';
    });
  },
  reset([run, unit], o) {
    return change(run, (s) => {
      const u = unitOf(s, unit);
      if (!['building', 'judging'].includes(u.status)) throw new Error(`unit ${unit} is ${u.status}, not in progress`);
      s.notes.push({ kind: 'info', text: `reset ${unit} (${u.status} → open): ${text(o.reason, 'reason', 300)}`, at: now() });
      u.status = 'open'; u.heartbeatAt = null;
    });
  },
  strategy([run, unit], o) {
    return change(run, (s) => {
      const u = unitOf(s, unit);
      expect(s, u, 'strategy');
      u.strategyChanges++; u.strategyAt = u.rounds.length;
      s.notes.push({ kind: 'strategy', text: `${unit}: ${text(o.text, 'text', 500)}`, at: now() });
    });
  },
  integrate([run, v], o) {
    return change(run, (s) => {
      const d = decide(s).decision;
      if (d !== 'integrate') throw new Error(`integrate refused: the run is at "${d}"`);
      oneOf(v, ['pass', 'fail'], 'verdict');
      const evidence = optText(o.evidence);
      s.integration.rounds.push({ ...judged(evidence, v, optText(o.gap, 500)), evidence, at: now() });
    });
  },
  note([run], o) {
    const kind = oneOf(o.kind, ['decision', 'follow-up', 'question', 'bar', 'info'], '--kind');
    return change(run, (s) => { s.notes.push({ kind, text: text(o.text, 'text', 1000), at: now() }); }, { closedOk: kind === 'follow-up' });
  },
  // Returns this round's actions (a stop shows once, here) and records the stops.
  // Stops cascade (a stopped unit stops the units stacked on it), so apply them
  // until nothing changes; each stop is reported once, here.
  next([run]) {
    let stopped;
    const s = change(run, (st) => { stopped = applyStops(st); });
    const plan = decide(s);
    return { decision: plan.decision, units: plan.units.map((u) => stopped.get(u.id) ?? u) };
  },
  show([run]) { const s = load(run); process.stdout.write(render(s, decide(s))); return null; },
  close([run], o) {
    const outcome = oneOf(o.outcome, ['done', 'partial', 'stopped'], '--outcome');
    return change(run, (s) => {
      applyStops(s); // an expired budget ends in-progress units first
      const busy = s.units.filter((u) => ['building', 'judging'].includes(u.status)).map((u) => u.id);
      if (busy.length) throw new Error(`close refused: ${busy.join(', ')} still in progress`);
      const d = decide(s).decision;
      if (outcome === 'done' && d !== 'done') throw new Error(`close --outcome done refused: the run is at "${d}"; use partial or stopped`);
      // Ending before the rules say so (giving up early) needs a stated reason.
      const expected = { partial: 'done-with-gaps', stopped: 'stopped' }[outcome];
      if (expected && d !== expected) s.notes.push({ kind: 'decision', text: `closed early as ${outcome} at "${d}": ${text(o.reason, 'reason (closing before the rules end the run)', 500)}`, at: now() });
      s.closed = { outcome, decision: d, at: now() };
    });
  },
  list() {
    if (!existsSync(runsDir())) return [];
    return readdirSync(runsDir()).filter((d) => isSafeId(d) && existsSync(stateFile(d))).map((d) => {
      try {
        const s = readJson(stateFile(d), null);
        return { run: s.id, tag: s.tag, createdAt: s.createdAt, closed: s.closed?.outcome ?? null, decision: decide(s).decision };
      } catch (e) { return { run: d, createdAt: '', error: `unreadable: ${e.message}` }; }
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  // Forward slashes and single quotes ($ and ` stay literal), so it pastes safely into a shell brief.
  where() { const d = baseDir('project').replace(/\\/g, '/'); return { stateDir: d, env: `COORDINATOR_DIR='${d.replace(/'/g, "'\\''")}'` }; },
  stats(_, o) {
    return stats(commands.list().filter((r) => !r.error && r.closed && (!o.tag || r.tag === o.tag)).map((r) => load(r.run)));
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!commands[cmd]) { console.error('usage: run.mjs init|add|freeze|start|beat|built|reset|verdict|strategy|integrate|note|next|show|close|list|stats|where … (see the header of run.mjs)'); process.exit(2); }
try {
  const { pos, opt } = parse(rest, FLAGS[cmd] ?? []);
  const out = commands[cmd](pos, opt);
  if (out !== null) console.log(JSON.stringify(['next', 'list', 'stats', 'where'].includes(cmd) ? out : { ok: true, run: out.id, decision: decide(out).decision }, null, 2));
} catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
