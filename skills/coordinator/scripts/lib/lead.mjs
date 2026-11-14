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

// The steps that change a run's plan or course; only its lead runs them. `next` is one only when it
// records a stop (run.mjs checks that). Worker steps (beat, built, evidence, an agent's note), read-only
// steps, answers and person notes are never lead steps.
export const LEAD_STEPS = new Set(['init', 'add', 'add-specialist', 'start', 'reset', 'verdict', 'strategy', 'extend', 'freeze',
  'foldin', 'ship', 'integrate', 'close', 'ask', 'use-answer', 'pause', 'resume', 'push', 'pull', 'next']);

// Tools whose own window id and window process were checked on a real install (references/harnesses.md).
// Add a tool here only once its variables are verified: a guessed name could make two windows one lead.
// Every other tool passes --lead <id> or sets COORDINATOR_LEAD, and only the quiet rule tells it is gone.
export const SESSION_VARS = { 'claude-code': { session: 'CLAUDE_CODE_SESSION_ID', pid: 'CLAUDE_PID' } };

export const DEFAULT_STALE = 45;
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
const MACHINE_FILE = 'machine-id';
const MACHINE = /^[0-9a-f]{16}$/;
export function machineId(home) {
  const file = join(home, MACHINE_FILE);
  const read = () => { try { const t = readFileSync(file, 'utf8').trim(); return MACHINE.test(t) ? t : null; } catch { return null; } };
  return read() ?? withLock(file, () => { const had = existsSync(file) ? read() : null; if (had) return had; const id = randomBytes(8).toString('hex'); writeAtomic(file, `${id}\n`); return id; });
}

// Whether the lead's window process still runs: true or false where its tool gave one and it was recorded on
// this PC, else null (unknown). pidAlive: (pid) => boolean; machine: () => this PC's id.
export const windowAlive = (pidAlive, machine) => (lead) => (Number.isInteger(lead?.pid) && lead.machine && lead.machine === machine() ? pidAlive(lead.pid) : null);

// Why the recorded lead counts as gone, or null while it is active: 'ended' when the tool gave its window's
// process and that process no longer runs; 'quiet' when neither a lead step nor a unit beat came for the
// run's stale minutes. A reused pid can only make a gone window look alive; the quiet rule still holds.
// alive: (lead) => true | false | null (lib/lead.mjs windowAlive).
export function goneWhy(s, nowMs, alive = null) {
  if (!s.lead) return null;
  if (alive && alive(s.lead) === false) return 'ended';
  const last = lastActive(s);
  return last === null || nowMs - last > staleMinutes(s) * MINUTE ? 'quiet' : null;
}

// What a person or another window reads about the lead; every age is worked out here.
export function leadInfo(s, nowMs, { alive = null, timeZone } = {}) {
  if (!s.lead) return null;
  const gone = goneWhy(s, nowMs, alive);
  const last = lastActive(s);
  return {
    tool: harnessName(s.lead.harness), since: agoText(s.lead.since, nowMs, timeZone), lastActive: agoText(last, nowMs, timeZone),
    gone, goneText: gone === 'ended' ? 'its window has ended' : gone === 'quiet' ? `quiet for over ${staleMinutes(s)} min` : null,
  };
}

const who = (i) => `${i.tool}, last active ${i.lastActive ?? 'at an unknown time'}`;

// What a lead step from `me` may do on this run: 'lead' (me leads it), 'claim' (no lead yet, or a takeover:
// from, why), or 'refuse' (message). claimGone: a gone lead is taken over without --takeover (run.mjs lead).
export function decideLead(s, me, { nowMs, alive = null, timeZone, takeover = false, reason = null, claimGone = false } = {}) {
  if (!s.lead) return { action: 'claim', from: null, why: null };
  if (s.lead.id === me.id) return { action: 'lead' };
  const i = leadInfo(s, nowMs, { alive, timeZone });
  const yours = me.source === 'session' ? '' : ' If you are that window, pass the --lead id its claim printed (or set COORDINATOR_LEAD).';
  if (i.gone) {
    if (takeover || claimGone) return { action: 'claim', from: s.lead.id, why: reason ?? `${i.goneText}; last active ${i.lastActive ?? 'at an unknown time'}` };
    return { action: 'refuse', message: `run ${s.id}'s lead is gone (${who(i)}; ${i.goneText}): run.mjs lead ${s.id} takes it over (or add --takeover to this step).${yours}` };
  }
  if (takeover && reason) return { action: 'claim', from: s.lead.id, why: `${reason} (its lead was still active: ${who(i)})` };
  if (takeover) return { action: 'refuse', message: `run ${s.id} is led by another window that is still active (${who(i)}): a takeover now needs --takeover --reason R, and only after the person says yes` };
  return { action: 'refuse', message: `run ${s.id} is led by another window (${who(i)}); /coordinator:status ${s.id} takes it over once that window has been quiet for ${staleMinutes(s)} min, or now with the person's yes: --takeover --reason R.${yours}` };
}

// Records me as the run's lead; a takeover is logged as "took over from <id>: <why>".
export function claim(s, me, { harness, at, from = null, why = null, machine = null }) {
  s.lead = { id: me.id, harness: harness ?? 'unknown', since: at, at, ...(me.pid && machine ? { pid: me.pid, machine } : {}), ...(from ? { from } : {}) };
  if (from) (s.notes ??= []).push({ kind: 'decision', text: `took over from ${from}: ${why ?? 'no reason given'}`, at });
  return s.lead;
}

// A lead step that changed the run: the lead was active then.
export function touch(s, at) { if (s.lead) s.lead.at = at; }

// What a claim prints: the id, and how to pass it when the tool gives no session id of its own.
export function claimText(me, lead, harness) {
  return {
    claimed: true, id: me.id, tool: harnessName(harness), ...(lead.from ? { tookOverFrom: lead.from } : {}),
    ...(me.source === 'random' ? { pass: `this tool gives no window id: pass --lead ${me.id} on every lead step of this run, or set COORDINATOR_LEAD=${me.id} where your shell keeps it` } : {}),
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
