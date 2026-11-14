// One lead per run, no second builder (lib/lead.mjs; docs/design/one-boss.md 5.1, 5.2).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseLog, replay, updateRun } from '../lib/events.mjs';
import { NAMES } from '../lib/harness.mjs';
import { blankPid, claim, claimText, decideLead, ENDED_MINUTES, goneWhy, identity, LEAD_STEPS, leadInfo, machineId, refresh, runMachine, SESSION_VARS, secondBuilder, stale, windowAlive } from '../lib/lead.mjs';
import { projectKey } from '../lib/registry.mjs';
import { agoText, zone } from '../lib/progress.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'coordinator-lead-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const base = { ...process.env, COORDINATOR_DIR: dir };
const json = (s) => { try { return JSON.parse(s); } catch { return s; } };
// Each window is its own process environment: `lead` names its COORDINATOR_LEAD (null: none at all).
function as(lead, ...a) {
  const env = { ...base };
  if (lead === null) delete env.COORDINATOR_LEAD; else env.COORDINATOR_LEAD = lead;
  const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...a], { env, encoding: 'utf8' });
  return { code: r.status, out: json(r.stdout), raw: r.stdout, err: r.stderr };
}
const withEnv = (extra, ...a) => {
  const env = { ...base, ...extra };
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...a], { env, encoding: 'utf8' });
  return { code: r.status, out: json(r.stdout), raw: r.stdout, err: r.stderr };
};
const A = (...a) => as('lead-a', ...a);
const B = (...a) => as('lead-b', ...a);
const runDir = (r) => join(dir, 'runs', r);
const events = (r) => readFileSync(join(runDir(r), 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const state = (r) => JSON.parse(readFileSync(join(runDir(r), 'state.json'), 'utf8'));
// Moves the run's clock back: its lead and units last showed life `min` minutes ago.
const age = (r, min) => updateRun(runDir(r), { kind: 'note' }, (s) => {
  const t = new Date(Date.now() - min * 60_000).toISOString();
  if (s.lead) { s.lead.at = t; s.lead.since = t; }
  s.createdAt = t; for (const u of s.units) if (u.heartbeatAt) u.heartbeatAt = t;
});
const LOCAL = /\d+ min ago \(\d\d:\d\d local, UTC[+-]?[\d:]*\)|under a minute ago \(\d\d:\d\d local, UTC[+-]?[\d:]*\)/;
const make = (who, r, ...extra) => { const x = who('init', r, '--goal', 'g', '--bar', 'b', '--fence', 'f', '--harness', 'codex', ...extra); assert.equal(x.code, 0, x.err); return x; };
const NOW = Date.parse('2026-11-14T11:05:00.000Z');
const iso = (min) => new Date(NOW - min * 60_000).toISOString();
const run = (lead, extra = {}) => ({ id: 'r', budget: { staleMinutes: 45 }, createdAt: iso(300), units: [], notes: [], ...(lead ? { lead } : {}), ...extra });

test('B5: ages are minutes ago plus the local clock time and its zone, worked out by the script', () => {
  // This PC runs at UTC+3: 11:05 UTC is 14:05 local.
  assert.equal(agoText(iso(52), NOW, 'Asia/Riyadh'), '52 min ago (13:13 local, UTC+3)');
  assert.equal(agoText('2026-11-14T11:05:00.000Z', NOW + 12 * 60_000, 'Asia/Riyadh'), '12 min ago (14:05 local, UTC+3)');
  assert.equal(agoText(iso(0), NOW, 'UTC'), 'under a minute ago (11:05 local, UTC)');
  assert.equal(zone(NOW, 'Asia/Kolkata'), 'UTC+5:30');
  assert.equal(agoText(undefined, NOW), null);
});

test('B1, B6: the lead id is a hash of the tool\'s own session id where one was verified, else --lead or COORDINATOR_LEAD, else random', () => {
  const sid = '0f9a3c1e-5b2d-4e8f-9a7c-1d2e3f4a5b6c';
  const cc = identity('claude-code', { env: { CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PID: '4242' } });
  assert.match(cc.id, /^[0-9a-f]{12}$/); assert.equal(cc.source, 'session'); assert.equal(cc.pid, 4242);
  assert.ok(!sid.includes(cc.id) && !cc.id.includes(sid.slice(0, 8)), 'never the raw session id');
  assert.equal(identity('claude-code', { env: { CLAUDE_CODE_SESSION_ID: sid } }).id, cc.id, 'the same window, the same id');
  assert.notEqual(identity('claude-code', { env: { CLAUDE_CODE_SESSION_ID: `${sid}x` } }).id, cc.id);
  assert.equal(identity('claude-code', { env: { CLAUDE_CODE_SESSION_ID: sid }, flag: 'copied-id' }).id, cc.id, 'a window cannot pass itself off as another');
  assert.deepEqual(identity('claude-code', { env: { COORDINATOR_LEAD: 'w1' } }), { id: 'w1', source: 'env' });
  // Only Claude Code's variables are verified (references/harnesses.md); no other tool's id is guessed.
  assert.deepEqual(Object.keys(SESSION_VARS), ['claude-code']);
  const guesses = { CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PID: '1', CODEX_SESSION_ID: 's', CODEX_THREAD_ID: 't', GEMINI_SESSION_ID: 'g', ANTIGRAVITY_SESSION_ID: 'a', CURSOR_TRACE_ID: 'c', CURSOR_SESSION_ID: 'c2', TERM_SESSION_ID: 'x' };
  for (const h of Object.keys(NAMES).filter((x) => x !== 'claude-code')) {
    assert.deepEqual(identity(h, { env: guesses, flag: 'given' }), { id: 'given', source: 'flag' }, `${h}: --lead`);
    assert.deepEqual(identity(h, { env: { ...guesses, COORDINATOR_LEAD: 'set' } }), { id: 'set', source: 'env' }, `${h}: COORDINATOR_LEAD`);
    assert.deepEqual(identity(h, { env: guesses, random: () => 'abc123' }), { id: 'abc123', source: 'random' }, `${h}: random, never a guessed variable`);
  }
  assert.throws(() => identity('codex', { env: {}, flag: 'a b' }), /--lead takes the lead id/);
  assert.throws(() => identity('codex', { env: {}, flag: true }), /--lead takes the lead id/);
  assert.throws(() => identity('codex', { env: { COORDINATOR_LEAD: '../x' } }), /COORDINATOR_LEAD takes/);
  assert.match(identity('cursor', { env: {} }).id, /^[0-9a-f]{12}$/);
});

test('B2, B3: the lead decides; others are refused while it is active, and take over once it is gone', () => {
  const me = { id: 'me', source: 'env' }; const other = { id: 'old', harness: 'claude-code', since: iso(120), at: iso(12) };
  assert.deepEqual(decideLead(run(null), me, { nowMs: NOW }), { action: 'claim', from: null, why: null });
  assert.deepEqual(decideLead(run({ ...other, id: 'me' }), me, { nowMs: NOW }), { action: 'lead' });
  const active = decideLead(run(other), me, { nowMs: NOW, timeZone: 'Asia/Riyadh' });
  assert.equal(active.action, 'refuse');
  assert.equal(active.message, "run r is led by another window (Claude Code, last active 12 min ago (13:53 local, UTC+3)); leave its lead steps to it. Once it has been quiet for 45 min, run.mjs lead r takes it over; to take it over now, only with the person's yes: run.mjs lead r --takeover --reason R. If you are that window, pass the --lead id its claim printed (or set COORDINATOR_LEAD in this window's shell).");
  assert.equal(decideLead(run(other), { id: 'x', source: 'session' }, { nowMs: NOW }).message.includes('pass the --lead'), false, 'a session id cannot be passed');
  // A lead step's --takeover (claimGone) never takes an active lead; only run.mjs lead --takeover --reason (force) does.
  assert.equal(decideLead(run(other), me, { nowMs: NOW, claimGone: true }).action, 'refuse');
  const forced = decideLead(run(other), me, { nowMs: NOW, force: 'the person said yes', timeZone: 'UTC' });
  assert.deepEqual(forced, { action: 'claim', from: 'old', why: 'the person said yes (its lead was still active: Claude Code, last active 12 min ago (10:53 local, UTC))' });
  // A unit beat keeps the lead active, as its own lead steps do.
  const quiet = { ...other, at: iso(50), since: iso(50) };
  assert.equal(goneWhy(run(quiet), NOW), 'quiet');
  assert.equal(goneWhy(run(quiet, { units: [{ id: 'u', heartbeatAt: iso(3) }] }), NOW), null);
  const gone = decideLead(run(quiet), me, { nowMs: NOW, timeZone: 'UTC' });
  assert.equal(gone.action, 'refuse'); assert.match(gone.message, /lead is gone \(Claude Code, last active 50 min ago \(10:15 local, UTC\); quiet for over 45 min\): run.mjs lead r takes it over/);
  assert.deepEqual(decideLead(run(quiet), me, { nowMs: NOW, claimGone: true, timeZone: 'UTC' }), { action: 'claim', from: 'old', why: 'quiet for over 45 min; last active 50 min ago (10:15 local, UTC)' });
  assert.deepEqual(decideLead(run(quiet), me, { nowMs: NOW, force: 'moved', timeZone: 'UTC' }), { action: 'claim', from: 'old', why: 'moved (quiet for over 45 min; last active 50 min ago (10:15 local, UTC))' });
  // The window's process, where the tool gives one and it was recorded on this PC.
  const pid = { ...other, pid: 77, machine: 'm1' };
  const here = (alive) => windowAlive(() => alive, () => 'm1');
  // B3 (the owner's q1): a window that has ended is gone after 10 quiet minutes, well inside the stale minutes.
  assert.equal(ENDED_MINUTES, 10);
  const endedAt = (min) => ({ ...pid, at: iso(min), since: iso(min) });
  assert.equal(goneWhy(run(endedAt(11)), NOW, here(false)), 'ended', 'an ended window, quiet for 11 min');
  assert.equal(goneWhy(run(endedAt(9)), NOW, here(false)), null, 'not gone at 9 min: a resumed window may still act');
  assert.equal(goneWhy(run(endedAt(30), { units: [{ id: 'u', heartbeatAt: iso(4) }] }), NOW, here(false)), null, 'a unit beat inside the 10 min keeps it');
  assert.equal(goneWhy(run(endedAt(11)), NOW, here(true)), null, 'a live window uses only the quiet rule');
  assert.equal(goneWhy(run(endedAt(11)), NOW, windowAlive(() => false, () => 'm2')), null, 'a pid from another PC says nothing');
  assert.equal(goneWhy(run(endedAt(11)), NOW), null, 'nor does an unknown one');
  const quietPid = endedAt(60);
  assert.equal(goneWhy(run(quietPid), NOW, here(false)), 'ended');
  assert.equal(goneWhy(run(quietPid), NOW, here(true)), 'quiet', 'a live (maybe reused) pid cannot keep a quiet lead');
  assert.equal(goneWhy(run(quietPid), NOW, windowAlive(() => false, () => 'm2')), 'quiet');
  assert.equal(leadInfo(run(endedAt(11)), NOW, { alive: here(false) }).goneText, 'its window has ended and it has been quiet for over 10 min');
  // While its window's process can be checked here, the refusal names both rules.
  assert.match(decideLead(run(endedAt(5)), me, { nowMs: NOW, alive: here(true), timeZone: 'UTC' }).message, /Once its window has closed and it has been quiet for 10 min \(or, whatever its window does, for 45 min\), run\.mjs lead r takes it over/);
  // A resumed window (same session, new pid) that acts stays the lead: its step records the new process.
  const resumed = run(endedAt(9));
  assert.equal(decideLead(resumed, { id: 'old', pid: 99 }, { nowMs: NOW, alive: here(false) }).action, 'lead');
  refresh(resumed, { id: 'old', pid: 99 }, { at: iso(0), machine: 'm1' });
  assert.equal(goneWhy(resumed, NOW + 11 * 60_000, windowAlive((p) => p === 99, () => 'm1')), null, 'its new window runs');
  assert.equal(windowAlive(() => false, () => null)(pid, 'r'), null, 'no id for this PC: nothing recorded here');
  // A takeover is logged.
  const s = run(other);
  claim(s, me, { harness: 'codex', at: iso(0), from: 'old', why: 'quiet since 10:15' });
  assert.deepEqual(s.lead, { id: 'me', harness: 'codex', since: iso(0), at: iso(0), from: 'old' });
  assert.deepEqual(s.notes, [{ kind: 'decision', text: 'took over from old: quiet since 10:15', at: iso(0) }]);
  // A lead step by the same lead records its window's process again; another lead is never touched.
  const mine = { id: 'me', harness: 'claude-code', since: iso(30), at: iso(30), pid: 11, machine: 'mm' };
  assert.equal(stale(mine, { id: 'me', pid: 11 }, 'mm'), false);
  assert.equal(stale(mine, { id: 'me', pid: 12 }, 'mm'), true, 'a resumed window: a new process');
  assert.equal(stale(mine, { id: 'other', pid: 12 }, 'mm'), false);
  const r2 = run({ ...mine });
  refresh(r2, { id: 'me', pid: 12 }, { at: iso(0), machine: 'mm' });
  assert.deepEqual(r2.lead, { ...mine, pid: 12, at: iso(0) });
  refresh(r2, { id: 'me' }, { at: iso(0) });
  assert.equal(r2.lead.pid, undefined, 'no process given: none kept');
  assert.deepEqual([...LEAD_STEPS].sort(), ['add', 'add-specialist', 'ask', 'close', 'extend', 'foldin', 'freeze', 'init', 'integrate', 'next', 'pause', 'pull', 'push', 'reset', 'resume', 'ship', 'start', 'strategy', 'use-answer', 'verdict']);
});

test('B4: a unit at work keeps its agent while it beats', () => {
  const s = run(null, { units: [] });
  const u = { id: 'u2', status: 'building', heartbeatAt: iso(12) };
  assert.equal(secondBuilder(u, s, NOW, { timeZone: 'Asia/Riyadh' }), "start refused: u2 is being built, last beat 12 min ago (13:53 local, UTC+3), younger than the run's 45 stale minutes; a second builder would work on the same task. Wait for its report, or, once you know its agent is gone, start --takeover --reason R");
  assert.match(secondBuilder({ ...u, status: 'judging' }, s, NOW), /u2 is being judged/);
  assert.equal(secondBuilder({ ...u, heartbeatAt: iso(46) }, s, NOW), null, 'stale: the lead checks it (check-stale)');
  assert.equal(secondBuilder({ ...u, status: 'open' }, s, NOW), null);
});

test('this PC\'s id is random, made once, and never a host or user name', () => {
  const home = mkdtempSync(join(dir, 'home-'));
  const id = machineId(home);
  assert.match(id, /^[0-9a-f]{16}$/); assert.equal(machineId(home), id);
  assert.ok(!id.includes(hostname().toLowerCase()));
  assert.equal(machineId(mkdtempSync(join(dir, 'home-')), { create: false }), null, 'a check never makes one');
  // A run records a value of its own, so runs pushed from different repos cannot be linked to one PC by it.
  assert.match(runMachine(id, 'p1', 'r1'), /^[0-9a-f]{16}$/);
  assert.notEqual(runMachine(id, 'p1', 'r1'), runMachine(id, 'p1', 'r2')); assert.notEqual(runMachine(id, 'p1', 'r1'), id);
  assert.notEqual(runMachine(id, 'p1', 'r1'), runMachine(id, 'p2', 'r1'), 'the same run id in two repos: two values');
  assert.equal(runMachine(id, 'p1', 'r1'), runMachine(id, 'p1', 'r1'));
});

test('B1: init claims the run; the claim names the id, the tool and the time, never a host or user name', () => {
  const sid = '7c1d2e3f-aaaa-bbbb-cccc-1234567890ab';
  const r = withEnv({ CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PID: String(process.pid), COORDINATOR_LEAD: undefined }, 'init', 'b1', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--harness', 'claude-code');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.claim.claimed, true); assert.equal(r.out.claim.tool, 'Claude Code'); assert.equal(r.out.claim.pass, undefined, 'the session id needs no passing');
  const ev = events('b1');
  assert.deepEqual(ev.map((e) => e.kind), ['run.init', 'lead.claim']);
  const lead = state('b1').lead;
  assert.equal(lead.id, r.out.claim.id); assert.equal(lead.harness, 'claude-code'); assert.equal(lead.pid, process.pid);
  const pc = machineId(process.env.COORDINATOR_HOME, { create: false });
  assert.equal(lead.machine, runMachine(pc, projectKey(dir), 'b1'), 'this run\'s own value for the PC'); assert.notEqual(lead.machine, pc, 'never the PC\'s id itself');
  assert.ok(Date.now() - Date.parse(lead.since) < 60_000);
  const log = readFileSync(join(runDir('b1'), 'events.jsonl'), 'utf8');
  for (const secret of [sid, hostname(), userInfo().username]) assert.equal(log.toLowerCase().includes(secret.toLowerCase()), false, `the log never holds ${secret === sid ? 'the raw session id' : 'a host or user name'}`);
  // The same window leads on.
  assert.equal(withEnv({ CLAUDE_CODE_SESSION_ID: sid, COORDINATOR_LEAD: undefined }, 'add', 'b1', 'u1', '--bar', 'b').code, 0);
  // Another Claude Code window is another lead, whatever --lead it copies.
  const other = withEnv({ CLAUDE_CODE_SESSION_ID: `${sid}-2`, COORDINATOR_LEAD: undefined }, 'add', 'b1', 'u2', '--bar', 'b', '--lead', lead.id);
  assert.equal(other.code, 1); assert.match(other.err, /led by another window \(Claude Code, last active /);
});

test('B1, B6: a tool with no window id gets a random id it must pass; a run made before leads is claimed by its first lead step', () => {
  const r = as(null, 'init', 'b6', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--harness', 'gemini');
  assert.equal(r.code, 0, r.err);
  const id = r.out.claim.id;
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.match(r.out.claim.pass, new RegExp(`pass --lead ${id} on every lead step of this run, or set COORDINATOR_LEAD=${id} in this window's shell only, never in a profile file`));
  assert.doesNotMatch(claimText({ id: 'x', source: 'random' }, {}, 'codex').pass, /where your shell keeps it/);
  const again = as(null, 'add', 'b6', 'u1', '--bar', 'b', '--harness', 'gemini');
  assert.equal(again.code, 1, 'without its id it is any other window'); assert.match(again.err, /pass the --lead id its claim printed/);
  assert.equal(as(null, 'add', 'b6', 'u1', '--bar', 'b', '--harness', 'gemini', '--lead', id).code, 0);
  assert.equal(as(id, 'freeze', 'b6', '--harness', 'gemini').code, 0, 'or COORDINATOR_LEAD');
  assert.equal(as(null, 'add', 'b6', 'u2', '--bar', 'b', '--lead', 'not ok').code, 1);
  // An older run: no lead, no lead.claim; its first lead step claims it, and the log still replays.
  updateRun(runDir('old1'), { kind: 'run.init' }, () => ({ id: 'old1', tag: 'general', goal: 'g', bar: 'b', fence: 'f', paths: [], budget: { maxRounds: 4, maxMinutes: 240, maxUnits: 6, maxAdded: 2, staleMinutes: 45, maxStudies: 2 }, createdAt: new Date().toISOString(), frozen: false, addedAfterFreeze: 0, units: [], notes: [], integration: { rounds: [] }, closed: null }));
  assert.equal(B('show', 'old1').code, 0);
  assert.match(B('show', 'old1').raw, /^lead {7}none recorded yet: the next lead step claims the run$/m);
  const add = B('add', 'old1', 'u1', '--bar', 'b', '--harness', 'cursor');
  assert.equal(add.code, 0, add.err); assert.equal(add.out.claim.id, 'lead-b'); assert.equal(add.out.claim.pass, undefined);
  assert.deepEqual(events('old1').map((e) => e.kind), ['run.init', 'lead.claim', 'unit.add']);
  assert.equal(state('old1').lead.harness, 'cursor');
  assert.equal(A('add', 'old1', 'u2', '--bar', 'b').code, 1, 'and from then on it has one lead');
});

test('B2: lead steps from another window are refused; worker steps, reads, answers and person notes never are', () => {
  make(A, 'b2', '--stale-minutes', '30');
  A('add', 'b2', 'u1', '--bar', 'b'); A('add', 'b2', 'u2', '--bar', 'b'); A('freeze', 'b2'); A('start', 'b2', 'u1');
  const q = A('ask', 'b2', '--question', 'Ship?', '--header', 'Ship', '--option', 'Yes|now', '--option', 'No|later');
  assert.equal(q.code, 0, q.err);
  const before = events('b2').length;
  const unitBefore = JSON.stringify(state('b2').units);
  const steps = [['add', 'b2', 'u3', '--bar', 'b'], ['add-specialist', 'b2', 'u1', 'security', '--reason', 'r'], ['start', 'b2', 'u2'], ['reset', 'b2', 'u1', '--reason', 'r'],
    ['verdict', 'b2', 'u1', 'pass', '--evidence', 'e'], ['strategy', 'b2', 'u1', '--text', 't'], ['extend', 'b2', 'u1', '--rounds', '1', '--reason', 'r'], ['freeze', 'b2'],
    ['foldin', 'b2', 'u1', '--head', 'abc1234', '--evidence', 'e'], ['ship', 'b2', 'u1', '--merge', 'https://x/pull/1', '--reason', 'r'], ['integrate', 'b2', 'pass'],
    ['close', 'b2', '--outcome', 'stopped', '--reason', 'r'], ['ask', 'b2', '--question', 'x?'], ['use-answer', 'b2', 'q1'], ['pause', 'b2', '--reason', 'r'], ['resume', 'b2'],
    ['push', 'b2', '--to', join(dir, 'pit-b2')], ['pull', 'b2', '--from', join(dir, 'pit-b2')]];
  for (const s of steps) {
    const r = B(...s);
    assert.equal(r.code, 1, `${s[0]} refused`);
    assert.match(r.err, new RegExp(`run b2 is led by another window \\(Codex, last active ${LOCAL.source.split('|')[1]}\\); leave its lead steps to it\\. Once it has been quiet for 30 min, run\\.mjs lead b2 takes it over; to take it over now, only with the person's yes: run\\.mjs lead b2 --takeover --reason R`), `${s[0]}: ${r.err}`);
  }
  // A lead step's --takeover never takes an active lead, and a step's own --reason is no takeover reason.
  for (const s of [['add', 'b2', 'u3', '--bar', 'b', '--takeover'], ['reset', 'b2', 'u1', '--reason', 'r', '--takeover'], ['pause', 'b2', '--reason', 'r', '--takeover'],
    ['close', 'b2', '--outcome', 'stopped', '--reason', 'r', '--takeover'], ['start', 'b2', 'u1', '--takeover', '--reason', 'its builder crashed']]) {
    const r = B(...s);
    assert.equal(r.code, 1, `${s.join(' ')} refused`); assert.match(r.err, /run\.mjs lead b2 --takeover --reason R/, `${s[0]}: ${r.err}`);
  }
  assert.match(B('freeze', 'b2', '--reason', 'r', '--takeover').err, /unknown option --reason/, 'a step with no reason of its own takes none');
  assert.equal(events('b2').length, before, 'nothing written');
  assert.equal(JSON.stringify(state('b2').units), unitBefore, 'u1 kept its builder');
  // Never refused.
  for (const s of [['beat', 'b2', 'u1', '--text', 'pushed'], ['evidence', 'b2', 'u1', '--kind', 'log', '--text', 'x'], ['note', 'b2', '--kind', 'info', '--text', 'agent note'],
    ['built', 'b2', 'u1', '--report', 'done'], ['show', 'b2'], ['status-line', 'b2'], ['questions', 'b2'], ['list'], ['next', 'b2'], ['lead', 'b2'],
    ['answer', 'b2', 'q1', '--choice', 'Yes'], ['note', 'b2', '--kind', 'person', '--text', 'from the person', '--confirm']]) {
    const r = B(...s);
    assert.equal(r.code, 0, `${s[0]} ${s.slice(2).join(' ')}: ${r.err}`);
  }
  // The lead itself goes on.
  assert.equal(A('verdict', 'b2', 'u1', 'pass', '--evidence', 'tests pass').code, 0);
  // next is a lead step only when it records a stop.
  make(A, 'b2s', '--max-rounds', '1');
  A('add', 'b2s', 'u', '--bar', 'b'); A('freeze', 'b2s'); A('start', 'b2s', 'u'); A('built', 'b2s', 'u'); A('verdict', 'b2s', 'u', 'fail', '--evidence', 'e', '--gap', 'g', '--score', '3', '--severity', 'high');
  const n = B('next', 'b2s');
  assert.equal(n.code, 1); assert.match(n.err, /led by another window/);
  const mine = A('next', 'b2s');
  assert.equal(mine.code, 0, mine.err); assert.equal(mine.out.units[0].action, 'stop'); assert.equal(state('b2s').units[0].status, 'stopped', 'recorded by the lead');
});

test('B3: a gone lead is taken over by run.mjs lead or --takeover, and the takeover is logged', () => {
  make(A, 'b3', '--stale-minutes', '5');
  A('add', 'b3', 'u1', '--bar', 'b');
  // Active: another window only reads who leads, unless the person agreed to a takeover.
  const seen = B('lead', 'b3');
  assert.equal(seen.code, 0); assert.equal(seen.out.you, false); assert.equal(seen.out.claimed, undefined); assert.equal(seen.out.tool, 'Codex');
  assert.match(seen.out.lastActive, LOCAL); assert.match(seen.out.step, /--takeover --reason R/);
  assert.equal(seen.out.id, undefined, 'another window\'s id is not printed');
  assert.match(B('lead', 'b3', '--takeover').err, /reason \(why this window takes the run over/);
  assert.equal(B('lead', 'b3', '--reason', 'x').code, 1, '--reason goes with --takeover');
  assert.equal(A('lead', 'b3').out.you, true);
  // Quiet: the next window takes it over without asking.
  age('b3', 10);
  const refused = B('add', 'b3', 'u2', '--bar', 'b');
  assert.equal(refused.code, 1); assert.match(refused.err, /lead is gone \(Codex, last active 10 min ago \(\d\d:\d\d local, UTC[^)]*\); quiet for over 5 min\): run.mjs lead b3 takes it over/);
  const took = B('lead', 'b3', '--harness', 'antigravity');
  assert.equal(took.code, 0, took.err);
  assert.equal(took.out.claimed, true); assert.equal(took.out.you, true); assert.equal(took.out.tookOverFrom, 'lead-a'); assert.equal(took.out.tool, 'Antigravity');
  const s = state('b3');
  assert.equal(s.lead.id, 'lead-b'); assert.equal(s.lead.from, 'lead-a');
  assert.match(s.notes.at(-1).text, /^took over from lead-a: quiet for over 5 min; last active 10 min ago \(\d\d:\d\d local, UTC/);
  assert.equal(events('b3').at(-1).kind, 'lead.claim');
  // The old window stops instead of competing.
  const old = A('add', 'b3', 'u3', '--bar', 'b');
  assert.equal(old.code, 1); assert.match(old.err, /led by another window \(Antigravity, last active under a minute ago/);
  // While the lead is active, only run.mjs lead --takeover --reason (after the person's yes), logged with the reason.
  assert.match(A('add', 'b3', 'u3', '--bar', 'b', '--takeover').err, /run\.mjs lead b3 --takeover --reason R/);
  const forced = A('lead', 'b3', '--takeover', '--reason', 'the person moved to this window');
  assert.equal(forced.code, 0, forced.err); assert.equal(forced.out.tookOverFrom, 'lead-b'); assert.equal(forced.out.you, true);
  assert.match(state('b3').notes.at(-1).text, /^took over from lead-b: the person moved to this window \(its lead was still active: Antigravity, last active/);
  assert.equal(A('add', 'b3', 'u3', '--bar', 'b').code, 0);
  // A gone lead: a lead step with --takeover claims it too.
  age('b3', 10);
  const n = events('b3').length;
  const step = B('freeze', 'b3', '--takeover');
  assert.equal(step.code, 0, step.err); assert.equal(state('b3').lead.id, 'lead-b'); assert.equal(state('b3').frozen, true);
  assert.deepEqual(events('b3').slice(n).map((e) => e.kind), ['lead.claim', 'run.freeze'], 'the claim, then the step');
});

test('the claim is written with its step or not at all: a step that fails leaves the old lead', () => {
  make(A, 'b5', '--stale-minutes', '5');
  A('add', 'b5', 'u1', '--bar', 'b'); A('freeze', 'b5'); A('start', 'b5', 'u1');
  age('b5', 10);
  const n = events('b5').length;
  const bad = B('start', 'b5', 'u1', '--takeover');
  assert.equal(bad.code, 1); assert.match(bad.err, /reason \(why u1 gets a new builder/);
  assert.equal(events('b5').length, n, 'nothing written'); assert.equal(state('b5').lead.id, 'lead-a');
  const ok = B('start', 'b5', 'u1', '--takeover', '--reason', 'its builder went quiet with its window');
  assert.equal(ok.code, 0, ok.err); assert.equal(ok.out.claim.tookOverFrom, 'lead-a');
  assert.deepEqual(events('b5').slice(n).map((e) => e.kind), ['lead.claim', 'unit.start']);
  // init checks its --lead before it writes: a bad one leaves no run, and the retry works.
  assert.match(as(null, 'init', 'b5i', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--lead', 'not ok').err, /--lead takes the lead id/);
  assert.equal(as(null, 'show', 'b5i').code, 1, 'no run made');
  make(A, 'b5i');
});

test('init --continues and add --continues respect the parent run\'s lead', () => {
  make(A, 'p1', '--stale-minutes', '5'); A('add', 'p1', 'u1', '--bar', 'b');
  const refused = B('init', 'c1', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--continues', 'p1:u1');
  assert.equal(refused.code, 1); assert.match(refused.err, /--continues p1:u1: run p1 is led by another window \(Codex, last active /);
  assert.equal(B('show', 'c1').code, 1, 'no run made'); assert.equal(state('p1').units[0].continuedIn, undefined, 'the parent is untouched');
  make(B, 'c2'); assert.match(B('add', 'c2', 'u1', '--bar', 'b', '--continues', 'p1:u1').err, /--continues p1:u1: run p1 is led by another window/);
  assert.equal(A('init', 'c3', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--continues', 'p1:u1').code, 0, 'its own lead may');
  // A gone lead is no bar: the link is all it writes there.
  make(A, 'p2', '--stale-minutes', '5'); A('add', 'p2', 'u1', '--bar', 'b'); age('p2', 10);
  const ok = B('init', 'c4', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--continues', 'p2:u1');
  assert.equal(ok.code, 0, ok.err); assert.equal(state('p2').lead.id, 'lead-a', 'the parent\'s lead is not taken');
});

test('a resumed Claude Code window (same session, new process) keeps its run', () => {
  const sid = 'resumed-window-session';
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const cc = (pid, ...a) => withEnv({ CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PID: String(pid), COORDINATOR_LEAD: undefined }, ...a);
  assert.equal(cc(dead, 'init', 'rs', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--harness', 'claude-code').code, 0);
  // Resumed: its old process has ended, but it led a moment ago; another window does not take the run.
  const seen = B('lead', 'rs');
  assert.equal(seen.code, 0); assert.equal(seen.out.claimed, undefined); assert.equal(seen.out.gone, undefined);
  // Its own run.mjs lead (the step /coordinator:status runs) records the new process.
  const n = events('rs').length;
  const mine = cc(process.pid, 'lead', 'rs');
  assert.equal(mine.out.you, true, mine.err); assert.equal(state('rs').lead.pid, process.pid);
  assert.equal(events('rs').at(-1).kind, 'lead.claim'); assert.equal(events('rs').length, n + 1);
  assert.equal(cc(process.pid, 'lead', 'rs').code, 0); assert.equal(events('rs').length, n + 1, 'nothing new to record: nothing written');
  // So do its lead steps.
  assert.equal(cc(dead, 'add', 'rs', 'u1', '--bar', 'b').code, 0);
  assert.equal(state('rs').lead.pid, dead);
  assert.equal(cc(process.pid, 'add', 'rs', 'u3', '--bar', 'b').code, 0);
  assert.equal(state('rs').lead.pid, process.pid);
  assert.equal(B('lead', 'rs').out.claimed, undefined);
  assert.equal(B('add', 'rs', 'u2', '--bar', 'b').code, 1);
});

test('B3: a window that has ended (its tool gave its process) is gone after 10 quiet minutes, well inside the stale minutes, and the log says it ended', () => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const sid = 'dead-window-session';
  const r = withEnv({ CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PID: String(dead), COORDINATOR_LEAD: undefined }, 'init', 'b3p', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--harness', 'claude-code');
  assert.equal(r.code, 0, r.err);
  assert.equal(B('lead', 'b3p').out.claimed, undefined, 'active by its last step');
  age('b3p', 9);
  const early = B('lead', 'b3p');
  assert.equal(early.out.claimed, undefined, 'not gone at 9 min'); assert.equal(early.out.gone, undefined);
  assert.match(B('add', 'b3p', 'u9', '--bar', 'b').err, /Once its window has closed and it has been quiet for 10 min \(or, whatever its window does, for 45 min\)/);
  age('b3p', 11);
  const seen = B('lead', 'b3p');
  assert.equal(seen.out.claimed, true, seen.err); assert.match(state('b3p').notes.at(-1).text, /^took over from [0-9a-f]{12}: its window has ended and it has been quiet for over 10 min; last active 11 min ago/);
});

test('B4, B5: start on a unit at work is refused unless --takeover --reason, logged on the unit; show, next and status-line print local ages', () => {
  make(A, 'b4');
  A('add', 'b4', 'u1', '--bar', 'b'); A('freeze', 'b4'); A('start', 'b4', 'u1'); A('beat', 'b4', 'u1', '--text', 'pushed');
  const again = A('start', 'b4', 'u1');
  assert.equal(again.code, 1);
  assert.match(again.err, new RegExp(`start refused: u1 is being built, last beat ${LOCAL.source.split('|')[1]}, younger than the run's 45 stale minutes; a second builder would work on the same task`));
  assert.match(A('start', 'b4', 'u1', '--takeover').err, /reason \(why u1 gets a new builder/);
  assert.match(A('start', 'b4', 'u1', '--reason', 'x').err, /--reason goes with --force-start or --takeover/);
  // Another window cannot: the run's active lead refuses it, naming the step that takes the run over.
  const other = B('start', 'b4', 'u1', '--takeover', '--reason', 'x');
  assert.equal(other.code, 1); assert.match(other.err, /run\.mjs lead b4 --takeover --reason R/);
  assert.equal(state('b4').lead.id, 'lead-a');
  const took = A('start', 'b4', 'u1', '--takeover', '--reason', 'its builder crashed with the window');
  assert.equal(took.code, 0, took.err);
  const u = state('b4').units[0];
  assert.equal(u.status, 'building');
  assert.match(u.log.findLast((e) => e.kind === 'start' && e.text.startsWith('took over')).text, /^took over from the builder \(last beat under a minute ago \(\d\d:\d\d local, UTC[^)]*\)\): its builder crashed with the window$/);
  A('built', 'b4', 'u1');
  assert.match(A('start', 'b4', 'u1').err, /u1 is being judged/);
  // Ages, from the script, in local time.
  const show = A('show', 'b4').raw;
  assert.match(show, /^lead {7}Codex · since under a minute ago \(\d\d:\d\d local, UTC[^)]*\) · last active under a minute ago \(\d\d:\d\d local, UTC[^)]*\)$/m);
  assert.match(show, /^ +last beat under a minute ago \(\d\d:\d\d local, UTC[^)]*\)$/m);
  assert.match(show, /· started under a minute ago \(\d\d:\d\d local, UTC/);
  const next = A('next', 'b4').out;
  assert.match(next.units[0].lastBeat, LOCAL); assert.equal(next.lead.tool, 'Codex'); assert.match(next.lead.lastActive, LOCAL);
  assert.match(A('status-line', 'b4').raw, /checking u1 round 1, last beat under a minute ago \(\d\d:\d\d local, UTC[^)]*\)/);
  // A run with no lead yet (made before leads): the window that claims it in this step takes no busy unit.
  updateRun(runDir('b4'), { kind: 'note' }, (s) => { delete s.lead; });
  const n = events('b4').length;
  const fresh = B('start', 'b4', 'u1', '--takeover', '--reason', 'x');
  assert.equal(fresh.code, 1); assert.match(fresh.err, /start --takeover refused: u1 is being judged, and this window did not lead run b4 before this step\. Taking over the run comes first, as its own step: run\.mjs lead b4/);
  assert.equal(events('b4').length, n, 'nothing written, not even the claim');
});

test('init writes run.init and its lead.claim in one write; a failing claim leaves no run', () => {
  const d = mkdtempSync(join(dir, 'one-write-'));
  assert.throws(() => updateRun(d, { kind: 'run.init', then: { kind: 'lead.claim', mutate: () => { throw new Error('refused'); } } }, () => ({ id: 'x', units: [] })), /refused/);
  assert.throws(() => readFileSync(join(d, 'events.jsonl')), /ENOENT/, 'neither event written');
  updateRun(d, { kind: 'run.init', then: { kind: 'lead.claim', mutate: (s) => { s.lead = { id: 'a', since: iso(0), at: iso(0) }; } } }, () => ({ id: 'x', units: [] }));
  const ev = readFileSync(join(d, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(ev.map((e) => e.kind), ['run.init', 'lead.claim']);
});

test('push keeps the lead\'s window process off the copy: every lead.pid is blanked, and the copy still replays', () => {
  const d = mkdtempSync(join(dir, 'blank-'));
  updateRun(d, { kind: 'run.init' }, () => ({ id: 'x', units: [] }));
  updateRun(d, { kind: 'lead.claim' }, (s) => { s.lead = { id: 'a', since: iso(5), at: iso(5), pid: 4242, machine: 'm' }; });
  updateRun(d, { kind: 'lead.claim' }, (s) => { s.lead.pid = 4343; s.lead.at = iso(1); });
  updateRun(d, { kind: 'lead.claim' }, (s) => { delete s.lead.pid; delete s.lead.machine; });
  updateRun(d, { kind: 'lead.claim' }, (s) => { s.lead = { id: 'b', since: iso(0), at: iso(0), pid: 4444, machine: 'm' }; });
  const raw = readFileSync(join(d, 'events.jsonl'), 'utf8');
  const masked = raw.split('\n').filter(Boolean).map((l) => `${JSON.stringify(blankPid(JSON.parse(l)))}\n`).join('');
  for (const pid of ['4242', '4343', '4444']) { assert.ok(raw.includes(pid)); assert.equal(masked.includes(pid), false, `no ${pid} in the copy`); }
  const s = replay(parseLog(Buffer.from(masked), 'masked').events);
  assert.deepEqual(s.lead, { id: 'b', since: iso(0), at: iso(0), pid: null, machine: 'm' });
  assert.equal(windowAlive(() => false, () => 'm')(s.lead, 'x'), null, 'a blank process says nothing');
  const note = { kind: 'note', payload: { ops: [{ op: 'set', path: ['notes'], value: [] }] } };
  assert.deepEqual(blankPid(note), note);
});
