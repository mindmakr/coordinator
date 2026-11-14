// One lead per run (docs/design/one-boss.md 5.1 and 5.2; references/durability.md, "One lead").
// A run records the window that leads it (`lead.claim`): an id, the tool, the time. Lead steps
// from any other window are refused; a gone lead is taken over, and the takeover is logged.
// Pure over the state, the environment and the clock it is given.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { harnessName } from './harness.mjs';
import { agoText } from './progress.mjs';
import { withLock, writeAtomic } from './store.mjs';

// The steps that change a run's plan or course; only its lead runs them. There is no stop command: a stop is
// recorded by `next` (a lead step only when it records one; run.mjs checks that) and by `close`. Worker steps
// (beat, built, evidence, an agent's note), read-only steps, answers and person notes are never lead steps.
export const LEAD_STEPS = new Set(['init', 'add', 'add-specialist', 'start', 'reset', 'verdict', 'strategy', 'extend', 'freeze',
  'foldin', 'ship', 'integrate', 'close', 'ask', 'use-answer', 'pause', 'resume', 'push', 'pull', 'next']);

// Tools whose own window id and window process were checked on a real install (references/harnesses.md).
// Add a tool here only once its variables are verified: a guessed name could make two windows one lead.
// Every other tool passes --lead <id> or sets COORDINATOR_LEAD, and only the quiet rule tells it is gone.
export const SESSION_VARS = { 'claude-code': { session: 'CLAUDE_CODE_SESSION_ID', pid: 'CLAUDE_PID' } };

export const DEFAULT_STALE = 45;
// A lead whose window has ended (its tool gave the window's process, which no longer runs) is gone once the run
// saw no lead step and no unit beat for this long (the owner's call, 2026-11-14): a resumed window (same session,
// new process) keeps its run if it acts within it.
export const ENDED_MINUTES = 10;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MINUTE = 60_000;
const ms = (iso) => { const t = typeof iso === 'string' ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
export const staleMinutes = (s) => s.budget?.staleMinutes ?? DEFAULT_STALE;

// This window's lead id: a short hash of the tool's own session id where the tool gives one (never the
// raw id, never a host or user name), else --lead, else COORDINATOR_LEAD, else a fresh random id the
// claiming step prints. pid: the tool's window process, when the tool gives one, for liveness.
export function identity(harness, { flag, env = process.env, random = () => randomBytes(6).toString('hex') } = {}) {
  const vars = SESSION_VARS[harness];
  const sid = vars ? env[vars.session] : undefined;
  if (typeof sid === 'string' && sid.trim()) {
    const pid = Number(env[vars.pid]);
    const id = createHash('sha256').update(`coordinator-lead\0${sid.trim()}`).digest('hex').slice(0, 12);
    return { id, source: 'session', ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}) };
  }
  for (const [raw, name, source] of [[flag, '--lead', 'flag'], [env.COORDINATOR_LEAD, 'COORDINATOR_LEAD', 'env']]) {
    if (raw === undefined || raw === '') continue;
    if (typeof raw !== 'string' || !ID.test(raw)) throw new Error(`${name} takes the lead id the claim printed (letters, digits, . _ -; up to 64)`);
    return { id: raw, source };
  }
  return { id: random(), source: 'random' };
}

// The run's last sign of a lead at work: its own last lead step, or a beat from one of its units.
export function lastActive(s) {
  const times = [s.lead?.at, s.lead?.since, ...(s.units ?? []).map((u) => u.heartbeatAt)].map(ms).filter((t) => t !== null);
  return times.length ? Math.max(...times) : null;
}

// A random id for this PC, made once in the coordinator's home folder (never a host or user name). A lead's
// window process is checked only on the PC that recorded it: a pid from another PC (a pulled run) says nothing.
// create: false only reads it (a check never makes one: no lead can have been recorded here without it).
const MACHINE_FILE = 'machine-id';
const MACHINE = /^[0-9a-f]{16}$/;
export function machineId(home, { create = true } = {}) {
  const file = join(home, MACHINE_FILE);
  const read = () => { try { const t = readFileSync(file, 'utf8').trim(); return MACHINE.test(t) ? t : null; } catch { return null; } };
  const had = read();
  if (had || !create) return had;
  return withLock(file, () => { const again = existsSync(file) ? read() : null; if (again) return again; const id = randomBytes(8).toString('hex'); writeAtomic(file, `${id}\n`); return id; });
}
// What a run records for this PC: a hash of the PC's id, the project's key (registry.mjs projectKey: a hash of
// its state folder) and the run's id, so that two runs pushed from different repos, even under the same run id,
// cannot be linked to one PC by it.
export const runMachine = (machine, project, run) => createHash('sha256').update(`coordinator-machine\0${machine}\0${project}\0${run}`).digest('hex').slice(0, 16);

// Whether the lead's window process still runs: true or false where its tool gave one and it was recorded on
// this PC, else null (unknown). pidAlive: (pid) => boolean; machine: (run) => this PC's value for that run, or null.
export const windowAlive = (pidAlive, machine) => (lead, run) => {
  if (!Number.isInteger(lead?.pid) || !lead.machine) return null;
  const here = machine(run);
  return here && lead.machine === here ? pidAlive(lead.pid) : null;
};

// Why the recorded lead counts as gone, or null while it is active. 'ended': the tool gave its window's process,
// that process no longer runs on this PC, and the run saw no lead step and no unit beat for ENDED_MINUTES (a
// resumed window has a new process; its next lead step, or run.mjs lead, records it). 'quiet': whatever the
// process, none for the run's stale minutes. An unknown or live pid uses only the quiet rule, so a reused pid
// cannot keep a quiet lead. alive: (lead, run) => true | false | null (windowAlive).
export function goneWhy(s, nowMs, alive = null) {
  if (!s.lead) return null;
  const last = lastActive(s);
  const quiet = last === null ? Infinity : nowMs - last;
  if (quiet > ENDED_MINUTES * MINUTE && alive && alive(s.lead, s.id) === false) return 'ended';
  return quiet > staleMinutes(s) * MINUTE ? 'quiet' : null;
}

// What a person or another window reads about the lead; every age is worked out here.
export function leadInfo(s, nowMs, { alive = null, timeZone } = {}) {
  if (!s.lead) return null;
  const gone = goneWhy(s, nowMs, alive);
  const last = lastActive(s);
  return {
    tool: harnessName(s.lead.harness), since: agoText(s.lead.since, nowMs, timeZone), lastActive: agoText(last, nowMs, timeZone),
    gone, goneText: gone === 'ended' ? `its window has ended and it has been quiet for over ${ENDED_MINUTES} min` : gone === 'quiet' ? `quiet for over ${staleMinutes(s)} min` : null,
  };
}

const who = (i) => `${i.tool}, last active ${i.lastActive ?? 'at an unknown time'}`;

// What a step from `me` may do on this run: 'lead' (me leads it), 'claim' (no lead yet, or a takeover:
// from, why), or 'refuse' (message). The two ways to take a run over are separate:
// - claimGone: a gone lead is claimed (run.mjs lead, or a lead step given --takeover);
// - force: the person's reason to take over a lead that is still active, given only by run.mjs lead
//   --takeover --reason R. A lead step never takes over an active lead, and no step's own --reason counts.
export function decideLead(s, me, { nowMs, alive = null, timeZone, claimGone = false, force = null } = {}) {
  if (!s.lead) return { action: 'claim', from: null, why: null };
  if (s.lead.id === me.id) return { action: 'lead' };
  const i = leadInfo(s, nowMs, { alive, timeZone });
  const yours = me.source === 'session' ? '' : " If you are that window, pass the --lead id its claim printed (or set COORDINATOR_LEAD in this window's shell).";
  if (i.gone) {
    const gone = `${i.goneText}; last active ${i.lastActive ?? 'at an unknown time'}`;
    if (claimGone || force) return { action: 'claim', from: s.lead.id, why: force ? `${force} (${gone})` : gone };
    return { action: 'refuse', message: `run ${s.id}'s lead is gone (${who(i)}; ${i.goneText}): run.mjs lead ${s.id} takes it over (or add --takeover to this step).${yours}` };
  }
  if (force) return { action: 'claim', from: s.lead.id, why: `${force} (its lead was still active: ${who(i)})` };
  // Where its window's process can be checked here, it counts as gone sooner once that window has closed.
  const once = alive && alive(s.lead, s.id) !== null
    ? `Once its window has closed and it has been quiet for ${ENDED_MINUTES} min (or, whatever its window does, for ${staleMinutes(s)} min)`
    : `Once it has been quiet for ${staleMinutes(s)} min`;
  return { action: 'refuse', message: `run ${s.id} is led by another window (${who(i)}); leave its lead steps to it. ${once}, run.mjs lead ${s.id} takes it over; to take it over now, only with the person's yes: run.mjs lead ${s.id} --takeover --reason R.${yours}` };
}

// Records me as the run's lead; a takeover is logged as "took over from <id>: <why>".
export function claim(s, me, { harness, at, from = null, why = null, machine = null }) {
  s.lead = { id: me.id, harness: harness ?? 'unknown', since: at, at, ...(me.pid && machine ? { pid: me.pid, machine } : {}), ...(from ? { from } : {}) };
  if (from) (s.notes ??= []).push({ kind: 'decision', text: `took over from ${from}: ${why ?? 'no reason given'}`, at });
  return s.lead;
}

// Whether a lead step by the run's own lead must record this window again: its process (a resumed window
// has a new one) or this PC's value differ from what the run holds. machine: this PC's value for the run.
export function stale(lead, me, machine) {
  if (!lead || lead.id !== me.id) return false;
  const pid = me.pid && machine ? me.pid : null;
  return (lead.pid ?? null) !== pid || (pid !== null && lead.machine !== machine);
}
// A lead step by the run's lead: it was active then, from this window's process (where its tool gives one).
export function refresh(s, me, { at, machine = null }) {
  if (!s.lead || s.lead.id !== me.id) return;
  s.lead.at = at;
  if (me.pid && machine) { s.lead.pid = me.pid; s.lead.machine = machine; } else { delete s.lead.pid; delete s.lead.machine; }
}

// What a claim prints: the id, and how to pass it when the tool gives no session id of its own.
export function claimText(me, lead, harness) {
  return {
    claimed: true, id: me.id, tool: harnessName(harness), ...(lead.from ? { tookOverFrom: lead.from } : {}),
    ...(me.source === 'random' ? { pass: `this tool gives no window id: pass --lead ${me.id} on every lead step of this run, or set COORDINATOR_LEAD=${me.id} in this window's shell only, never in a profile file (every window would then share one lead)` } : {}),
  };
}

// The second-builder guard (design 5.2): a unit being built or judged whose last beat is younger than the
// run's stale minutes keeps its agent. The refusal, or null when start may go on.
export function secondBuilder(u, s, nowMs, { timeZone } = {}) {
  if (!['building', 'judging'].includes(u.status)) return null;
  const since = u.heartbeatAt ?? s.createdAt;
  const t = ms(since);
  if (t !== null && nowMs - t > staleMinutes(s) * MINUTE) return null;
  return `start refused: ${u.id} is ${u.status === 'building' ? 'being built' : 'being judged'}, last beat ${agoText(since, nowMs, timeZone) ?? 'not recorded'}, younger than the run's ${staleMinutes(s)} stale minutes; a second builder would work on the same task. Wait for its report, or, once you know its agent is gone, start --takeover --reason R`;
}

// What a pushed copy keeps of the lead (lib/statesync.mjs): its window's process means nothing off this PC, so
// each lead.pid an event sets is blanked to null there (blank, not dropped, so the copy's log still replays).
export function blankPid(e) {
  const keep = (v) => (v && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, 'pid') ? { ...v, pid: null } : v);
  const op = (o) => {
    if (o?.op !== 'set' || !Array.isArray(o.path)) return o;
    if (o.path.length === 2 && o.path[0] === 'lead' && o.path[1] === 'pid') return { ...o, value: null };
    if (o.path.length === 1 && o.path[0] === 'lead') return { ...o, value: keep(o.value) };
    if (o.path.length === 0 && o.value?.lead) return { ...o, value: { ...o.value, lead: keep(o.value.lead) } };
    return o;
  };
  const p = e?.payload;
  if (Array.isArray(p?.ops)) return { ...e, payload: { ...p, ops: p.ops.map(op) } };
  if (p?.state?.lead) return { ...e, payload: { ...p, state: { ...p.state, lead: keep(p.state.lead) } } };
  return e;
}
