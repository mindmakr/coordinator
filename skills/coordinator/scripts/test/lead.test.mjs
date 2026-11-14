// One lead per run, no second builder (lib/lead.mjs; docs/design/one-boss.md 5.1, 5.2).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { updateRun } from '../lib/events.mjs';
import { NAMES } from '../lib/harness.mjs';
import { claim, decideLead, goneWhy, identity, LEAD_STEPS, leadInfo, machineId, SESSION_VARS, secondBuilder, windowAlive } from '../lib/lead.mjs';
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
  assert.equal(active.message, "run r is led by another window (Claude Code, last active 12 min ago (13:53 local, UTC+3)); /coordinator:status r takes it over once that window has been quiet for 45 min, or now with the person's yes: --takeover --reason R. If you are that window, pass the --lead id its claim printed (or set COORDINATOR_LEAD).");
  assert.equal(decideLead(run(other), { id: 'x', source: 'session' }, { nowMs: NOW }).message.includes('pass the --lead'), false, 'a session id cannot be passed');
  assert.match(decideLead(run(other), me, { nowMs: NOW, takeover: true }).message, /still active .*needs --takeover --reason R, and only after the person says yes/);
  const forced = decideLead(run(other), me, { nowMs: NOW, takeover: true, reason: 'the person said yes', timeZone: 'UTC' });
  assert.deepEqual(forced, { action: 'claim', from: 'old', why: 'the person said yes (its lead was still active: Claude Code, last active 12 min ago (10:53 local, UTC))' });
  // A unit beat keeps the lead active, as its own lead steps do.
  const quiet = { ...other, at: iso(50), since: iso(50) };
  assert.equal(goneWhy(run(quiet), NOW), 'quiet');
  assert.equal(goneWhy(run(quiet, { units: [{ id: 'u', heartbeatAt: iso(3) }] }), NOW), null);
  const gone = decideLead(run(quiet), me, { nowMs: NOW, timeZone: 'UTC' });
  assert.equal(gone.action, 'refuse'); assert.match(gone.message, /lead is gone \(Claude Code, last active 50 min ago \(10:15 local, UTC\); quiet for over 45 min\): run.mjs lead r takes it over/);
  assert.deepEqual(decideLead(run(quiet), me, { nowMs: NOW, claimGone: true, timeZone: 'UTC' }), { action: 'claim', from: 'old', why: 'quiet for over 45 min; last active 50 min ago (10:15 local, UTC)' });
  assert.equal(decideLead(run(quiet), me, { nowMs: NOW, takeover: true }).action, 'claim');
  // The window's process, where the tool gives one and it was recorded on this PC.
  const pid = { ...other, pid: 77, machine: 'm1' };
  const here = (alive) => windowAlive(() => alive, () => 'm1');
  assert.equal(goneWhy(run(pid), NOW, here(false)), 'ended');
  assert.equal(goneWhy(run(pid), NOW, here(true)), null);
  assert.equal(goneWhy(run({ ...pid, at: iso(60), since: iso(60) }), NOW, here(true)), 'quiet', 'a live (maybe reused) pid falls back to the quiet rule');
  assert.equal(goneWhy(run(pid), NOW, windowAlive(() => false, () => 'm2')), null, 'a pid from another PC says nothing');
  assert.equal(leadInfo(run(pid), NOW, { alive: here(false) }).goneText, 'its window has ended');
  // A takeover is logged.
  const s = run(other);
  claim(s, me, { harness: 'codex', at: iso(0), from: 'old', why: 'quiet since 10:15' });
  assert.deepEqual(s.lead, { id: 'me', harness: 'codex', since: iso(0), at: iso(0), from: 'old' });
  assert.deepEqual(s.notes, [{ kind: 'decision', text: 'took over from old: quiet since 10:15', at: iso(0) }]);
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
});

test('B1: init claims the run; the claim names the id, the tool and the time, never a host or user name', () => {
  const sid = '7c1d2e3f-aaaa-bbbb-cccc-1234567890ab';
  const r = withEnv({ CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PID: String(process.pid), COORDINATOR_LEAD: undefined }, 'init', 'b1', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--harness', 'claude-code');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.claim.claimed, true); assert.equal(r.out.claim.tool, 'Claude Code'); assert.equal(r.out.claim.pass, undefined, 'the session id needs no passing');
  const ev = events('b1');
  assert.deepEqual(ev.map((e) => e.kind), ['run.init', 'lead.claim']);
  const lead = state('b1').lead;
  assert.equal(lead.id, r.out.claim.id); assert.equal(lead.harness, 'claude-code'); assert.equal(lead.pid, process.pid); assert.match(lead.machine, /^[0-9a-f]{16}$/);
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
  assert.match(r.out.claim.pass, new RegExp(`pass --lead ${id} on every lead step of this run, or set COORDINATOR_LEAD=${id}`));
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
  const steps = [['add', 'b2', 'u3', '--bar', 'b'], ['add-specialist', 'b2', 'u1', 'security', '--reason', 'r'], ['start', 'b2', 'u2'], ['reset', 'b2', 'u1', '--reason', 'r'],
    ['verdict', 'b2', 'u1', 'pass', '--evidence', 'e'], ['strategy', 'b2', 'u1', '--text', 't'], ['extend', 'b2', 'u1', '--rounds', '1', '--reason', 'r'], ['freeze', 'b2'],
    ['foldin', 'b2', 'u1', '--head', 'abc1234', '--evidence', 'e'], ['ship', 'b2', 'u1', '--merge', 'https://x/pull/1', '--reason', 'r'], ['integrate', 'b2', 'pass'],
    ['close', 'b2', '--outcome', 'stopped', '--reason', 'r'], ['ask', 'b2', '--question', 'x?'], ['use-answer', 'b2', 'q1'], ['pause', 'b2', '--reason', 'r'], ['resume', 'b2'],
    ['push', 'b2', '--to', join(dir, 'pit-b2')], ['pull', 'b2', '--from', join(dir, 'pit-b2')]];
  for (const s of steps) {
    const r = B(...s);
    assert.equal(r.code, 1, `${s[0]} refused`);
    assert.match(r.err, new RegExp(`run b2 is led by another window \\(Codex, last active ${LOCAL.source.split('|')[1]}\\); /coordinator:status b2 takes it over once that window has been quiet for 30 min`), `${s[0]}: ${r.err}`);
  }
  assert.equal(events('b2').length, before, 'nothing written');
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
  assert.equal(B('lead', 'b3', '--takeover').code, 1);
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
  // While the lead is active, --takeover --reason (after the person's yes), logged with the reason.
  const forced = A('add', 'b3', 'u3', '--bar', 'b', '--takeover', '--reason', 'the person moved to this window');
  assert.equal(forced.code, 0, forced.err); assert.equal(forced.out.claim.tookOverFrom, 'lead-b');
  assert.match(state('b3').notes.at(-1).text, /^took over from lead-b: the person moved to this window \(its lead was still active: Antigravity, last active/);
  // A gone lead: a lead step with --takeover claims it too.
  age('b3', 10);
  const step = B('freeze', 'b3', '--takeover');
  assert.equal(step.code, 0, step.err); assert.equal(state('b3').lead.id, 'lead-b'); assert.equal(state('b3').frozen, true);
});

test('B3: a window that has ended (its tool gave its process) is gone at once', () => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  const sid = 'dead-window-session';
  const r = withEnv({ CLAUDE_CODE_SESSION_ID: sid, CLAUDE_PID: String(dead), COORDINATOR_LEAD: undefined }, 'init', 'b3p', '--goal', 'g', '--bar', 'b', '--fence', 'f', '--harness', 'claude-code');
  assert.equal(r.code, 0, r.err);
  const seen = B('lead', 'b3p');
  assert.equal(seen.out.claimed, true, seen.err); assert.match(state('b3p').notes.at(-1).text, /^took over from [0-9a-f]{12}: its window has ended; last active under a minute ago/);
});

test('B4, B5: start on a unit at work is refused unless --takeover --reason, logged on the unit; show, next and status-line print local ages', () => {
  make(A, 'b4');
  A('add', 'b4', 'u1', '--bar', 'b'); A('freeze', 'b4'); A('start', 'b4', 'u1'); A('beat', 'b4', 'u1', '--text', 'pushed');
  const again = A('start', 'b4', 'u1');
  assert.equal(again.code, 1);
  assert.match(again.err, new RegExp(`start refused: u1 is being built, last beat ${LOCAL.source.split('|')[1]}, younger than the run's 45 stale minutes; a second builder would work on the same task`));
  assert.match(A('start', 'b4', 'u1', '--takeover').err, /reason \(why u1 gets a new builder/);
  assert.match(A('start', 'b4', 'u1', '--reason', 'x').err, /--reason goes with --force-start or --takeover/);
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
});
