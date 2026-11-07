import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { closeGap, gapId, gaps, gapsModel, parseGapId } from '../lib/gaps.mjs';
import { selfModel, selfText } from '../lib/self.mjs';
import { selfPage } from '../lib/selfpage.mjs';
import { liveCtx, staticCtx } from '../lib/hud.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'coordinator-gaps-'));
const env = { ...process.env, COORDINATOR_DIR: join(dir, 'state') };
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const json = (s) => { try { return JSON.parse(s); } catch { return s; } };
const run = (...a) => { const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...a], { env, encoding: 'utf8', cwd: dir }); return { code: r.status, out: json(r.stdout), raw: r.stdout, err: r.stderr }; };

const T0 = '2026-11-01T10:00:00.000Z';
const at = (min) => new Date(Date.parse(T0) + min * 60_000).toISOString();
const mkRun = (id, units, closed = null, extra = {}) => ({ id, goal: `goal ${id}`, createdAt: extra.createdAt ?? T0, units, notes: [], closed, ...extra });
const unit = (id, status, more = {}) => ({ id, status, rounds: [], ...more });
const byKind = (list, kind) => list.filter((g) => g.kind === kind);

test('every kind is derived from the state, with its source, time and id', () => {
  const a = mkRun('r-a', [
    unit('u1', 'stopped', { stopReason: 'budget: rounds', rounds: [{ n: 1, verdict: 'fail', gap: 'first', at: at(10) }, { n: 2, verdict: 'fail', gap: 'the auth check is missing', cause: 'no test', at: at(20) }] }),
    unit('u2', 'building'), unit('u3', 'pass'),
  ], { outcome: 'partial', decision: 'integrate', at: at(60) });
  a.notes.push(
    { kind: 'decision', text: 'closed early as partial at "integrate": out of time', at: at(59) },
    { kind: 'follow-up', text: 'Payroll menu misses a link', at: at(30) },
    { kind: 'follow-up', text: 'Mobile label: outside this run\'s fence', at: at(31) },
    { kind: 'follow-up', text: 'Filed it: acme/web#12', at: at(32) },
    { kind: 'retro', text: 'upstream: the stale stop fires too early', at: at(33) },
    { kind: 'retro', text: 'A plain lesson, not a gap', at: at(34) },
    { kind: 'escape', unit: 'u3', round: 1, text: 'a defect after the pass', at: at(35) },
    { kind: 'question', text: 'Ship it?', header: 'Ship', options: [{ label: 'Yes' }, { label: 'No' }], at: at(36), history: [] },
    { kind: 'question', text: 'Merge?', header: 'Merge', options: [{ label: 'Yes' }, { label: 'No' }], at: at(37), history: [{ choices: ['Yes'], other: null, by: 'person', at: at(38) }] },
  );
  const list = gaps([a]);
  const stopped = byKind(list, 'stopped')[0];
  assert.equal(stopped.id, 'stopped:r-a:u1:1');
  assert.match(stopped.text, /Stopped: budget: rounds\. Last gap: the auth check is missing/);
  assert.equal(stopped.cause, 'no test'); assert.equal(stopped.source, 'verdict, round 2'); assert.equal(stopped.status, 'open');
  assert.deepEqual(byKind(list, 'unfinished').map((g) => [g.id, g.at]), [['unfinished:r-a:u2:1', at(60)]]);
  const r = byKind(list, 'run')[0];
  assert.equal(r.id, 'run:r-a:-:1'); assert.match(r.text, /out of time/); assert.equal(r.status, 'open');
  assert.deepEqual(byKind(list, 'follow-up').map((g) => [g.text, g.status]), [['Payroll menu misses a link', 'open'], ['Filed it: acme/web#12', 'resolved']]);
  assert.match(byKind(list, 'follow-up')[1].resolution.reason, /tracked in acme\/web#12/);
  assert.equal(byKind(list, 'out-of-fence').length, 1);
  assert.deepEqual(byKind(list, 'upstream').map((g) => [g.id, g.status]), [['upstream:r-a:-:5', 'open']]);
  assert.equal(list.some((g) => g.text === 'A plain lesson, not a gap'), false, 'a retro lesson is not a gap');
  assert.deepEqual(byKind(list, 'escape').map((g) => [g.id, g.unit]), [['escape:r-a:u3:7', 'u3']]);
  assert.deepEqual(byKind(list, 'question').map((g) => [g.id, g.status]), [['question:r-a:-:q1', 'open'], ['question:r-a:-:q2', 'resolved']]);
  assert.match(byKind(list, 'question')[1].resolution.reason, /answered by person: Yes/);
  const m = gapsModel([a]);
  assert.equal(m.openCount, list.filter((g) => g.status === 'open').length);
  assert.equal(m.openRuns, 1);
  for (const g of list) assert.deepEqual(parseGapId(g.id)?.run, 'r-a', g.id);
});

test('upstream proposals are acted on when the run records the filed issue; a done run has no run gap', () => {
  const a = mkRun('r-up', [unit('u1', 'pass')], { outcome: 'done', decision: 'done', at: at(60) });
  a.notes.push({ kind: 'retro', text: 'upstream: board crashes', at: at(1) }, { kind: 'retro', text: 'upstream filed: mindmakr/coordinator#45', at: at(2) });
  const list = gaps([a]);
  assert.equal(list.length, 1, 'the filing note is a record, not a proposal');
  assert.equal(list[0].status, 'resolved'); assert.match(list[0].resolution.reason, /mindmakr\/coordinator#45/);
});

test('chain-aware: a stopped unit continued by a later run that passed is resolved; carried while it is not; the run gap follows', () => {
  const a = mkRun('r1', [unit('c14', 'stopped', { stopReason: 'budget: rounds' })], { outcome: 'partial', decision: 'stopped', at: at(60) });
  const b = mkRun('r2', [unit('c14', 'building')], null, { createdAt: at(100), continues: [{ run: 'r1', unit: 'c14' }] });
  let list = gaps([a, b]);
  assert.match(list.find((g) => g.id === 'stopped:r1:c14:1').resolution.reason, /carried into r2 \(building\)/);
  b.units[0].status = 'pass';
  list = gaps([a, b]);
  assert.equal(list.find((g) => g.id === 'stopped:r1:c14:1').resolution.reason, 'finished in r2 (passed)');
  assert.equal(list.find((g) => g.id === 'run:r1:-:1').status, 'resolved', 'every unit gap of the run is resolved');
  // The parent's own record (continuedIn), another unit id, through two runs.
  const p = mkRun('p1', [unit('x', 'open')], { outcome: 'partial', decision: 'continue', at: at(10) });
  p.units[0].continuedIn = [{ run: 'p2', unit: 'x2', at: at(20) }];
  const q = mkRun('p2', [unit('x2', 'stopped')], { outcome: 'stopped', decision: 'stopped', at: at(30) }, { createdAt: at(15) });
  const r = mkRun('p3', [unit('x3', 'pass')], { outcome: 'done', decision: 'done', at: at(50) }, { createdAt: at(40), continues: [{ run: 'p2', unit: 'x2', as: 'x3' }] });
  list = gaps([p, q, r]);
  assert.equal(list.find((g) => g.id === 'unfinished:p1:x:1').resolution.reason, 'finished in p3:x3 (passed)');
  assert.equal(list.find((g) => g.id === 'stopped:p2:x2:1').resolution.reason, 'finished in p3:x3 (passed)');
  // A link to a run that is not here leaves the gap open; a loop ends.
  const lone = mkRun('l1', [unit('y', 'stopped', { continuedIn: [{ run: 'gone', at: at(1) }] })], null);
  assert.equal(gaps([lone])[0].status, 'open');
  const l2 = mkRun('l2', [unit('z', 'stopped', { continuedIn: [{ run: 'l3' }] })]); const l3 = mkRun('l3', [unit('z', 'stopped', { continuedIn: [{ run: 'l2' }] })]);
  assert.equal(gaps([l2, l3]).length, 2);
});

test('closure notes: the last one wins, reopen undoes it, a wrong run or id is refused', () => {
  const a = mkRun('r1', [unit('u1', 'stopped')], { outcome: 'stopped', decision: 'stopped', at: at(5) });
  const id = gapId('stopped', 'r1', 'u1', 1);
  closeGap(a, id, { reason: 'shipped by the person', by: 'person', at: at(6) });
  let g = gaps([a]).find((x) => x.id === id);
  assert.equal(g.status, 'resolved'); assert.deepEqual([g.resolution.by, g.resolution.derived, g.resolution.reason], ['person', false, 'shipped by the person']);
  closeGap(a, id, { reason: 'not done after all', reopen: true, at: at(7) });
  g = gaps([a]).find((x) => x.id === id);
  assert.equal(g.status, 'open');
  assert.throws(() => closeGap(a, 'stopped:other:u1:1', { reason: 'x' }), /belongs to run other/);
  assert.throws(() => closeGap(a, 'nope', { reason: 'x' }), /not a gap id/);
  assert.equal(parseGapId('stopped:r1:-:1').unit, null);
});

test('old runs load: no notes, no rounds, no closed, odd entries', () => {
  const old = { id: 'old', units: [{ id: 'u1', status: 'stopped' }, { id: 'u2' }], createdAt: T0 };
  const list = gaps([old, null, { id: 'x' }]);
  assert.deepEqual(list.map((g) => [g.id, g.text]), [['stopped:old:u1:1', 'Stopped.']]);
  const closedOld = { id: 'old2', units: [{ id: 'u1' }], closed: { outcome: 'partial' }, notes: [{ kind: 'follow-up' }, null] };
  assert.deepEqual(gaps([closedOld]).map((g) => g.id).sort(), ['run:old2:-:1', 'unfinished:old2:u1:1']);
});

test('the page: a Gaps section with its count in the header and the nav; escaped; unit links static and live; filter on the live page only', () => {
  const a = mkRun('r-a', [unit('u1', 'stopped', { stopReason: '<img src=x onerror=alert(1)>', rounds: [{ n: 1, gap: 'g', cause: '<b>c</b>', at: at(1) }] })], null, { createdAt: at(0) });
  a.notes.push({ kind: 'follow-up', text: `<script>alert(1)</script> ${'long '.repeat(80)} see javascript:alert(1) and https://example.com/x`, at: at(2) });
  const b = mkRun('r-b', [unit('v1', 'pass')], { outcome: 'done', decision: 'done', at: at(9) });
  b.notes.push({ kind: 'question', text: 'Q?', header: 'H', options: [], at: at(3), history: [{ choices: [], other: 'yes', by: 'person', at: at(4) }] });
  const m = selfModel({ runs: [a, b] });
  const html = selfPage(m, Date.now(), { ...staticCtx('', 0), runHref: (id) => `runs/${id}/hud.html` });
  assert.match(html, /<a href="#self-gaps">2 open gaps across 1 run<\/a>/);
  assert.match(html, /href="#self-gaps">Gaps · 2</);
  assert.match(html, /data-k="self-gaps"/);
  assert.doesNotMatch(html, /<script>alert|<img src=x|<b>c<\/b>/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /href="runs\/r-a\/units\/u1\.html"/);
  assert.match(html, /data-d="gap-follow-up:r-a:-:1"/, 'long text: the full text is behind a toggle');
  assert.match(html, /data-d="self-gaps-resolved"/); assert.doesNotMatch(html, /<details[^>]*data-d="self-gaps-resolved"[^>]* open/, 'resolved stays folded');
  assert.doesNotMatch(html, /data-gaps role/, 'no filter on the snapshot');
  const live = selfPage(m, Date.now(), liveCtx({ token: 'tok', nonce: 'n' }, 'r-b'));
  assert.match(live, /href="\/run\/r-a\/unit\/u1\?t=tok"/);
  assert.match(live, /<form class="tl-tools" data-gaps role="search">/);
  assert.match(live, /<option value="question">question<\/option>/);
  assert.match(selfText(m), /gaps {6}2 open gaps across 1 run · 1 resolved/);
  assert.match(selfPage(selfModel({ runs: [] }), Date.now(), staticCtx('', 0)), /No gaps:/);
});

test('cli: gaps lists, gap close writes a decision to the run log (closed runs too), the closure survives a reload, reopen', () => {
  assert.equal(run('init', 'g1', '--goal', 'g', '--bar', 'b', '--fence', 'f').code, 0);
  run('add', 'g1', 'u1', '--bar', 'b'); run('freeze', 'g1');
  assert.equal(run('note', 'g1', '--kind', 'follow-up', '--text', 'Check the export button').code, 0);
  assert.equal(run('close', 'g1', '--outcome', 'stopped', '--reason', 'out of time').code, 0);
  const listed = run('gaps', '--json').out;
  assert.deepEqual(listed.map((g) => g.kind).sort(), ['follow-up', 'run', 'unfinished']);
  const fid = listed.find((g) => g.kind === 'follow-up').id;
  assert.match(run('gaps').raw, /3 open gaps across 1 run/);
  const before = readFileSync(join(dir, 'state', 'runs', 'g1', 'events.jsonl'), 'utf8').trim().split('\n').length;
  const c = run('gap', 'close', 'g1', fid, '--reason', 'done in PR 5', '--by', 'person');
  assert.equal(c.code, 0, c.err);
  const log = readFileSync(join(dir, 'state', 'runs', 'g1', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.length, before + 1); assert.equal(log.at(-1).kind, 'note');
  assert.equal(log.at(-1).payload.ops[0].values[0].gap, fid);
  const again = run('gaps', '--json', '--all').out.find((g) => g.id === fid);
  assert.deepEqual([again.status, again.resolution.by, again.resolution.reason], ['resolved', 'person', 'done in PR 5']);
  assert.match(run('gap', 'close', 'g1', fid, '--reason', 'x').err, /already closed/);
  assert.match(run('gap', 'close', 'g1', 'follow-up:g1:-:99', '--reason', 'x').err, /no gap/);
  assert.match(run('gap', 'close', 'g1', fid.replace(':g1:', ':g2:'), '--reason', 'x').err, /belongs to run g2/);
  assert.match(run('gap', 'close', 'g1', fid).err, /reason/);
  assert.match(run('gap', 'shut', 'g1', fid, '--reason', 'x').err, /close, reopen|must be one of/);
  assert.equal(run('gap', 'reopen', 'g1', fid, '--reason', 'not merged').code, 0);
  assert.equal(run('gaps', '--json').out.find((g) => g.id === fid).status, 'open');
  // A legacy state.json without an event log: closing imports it first, nothing is lost.
  const legacy = join(dir, 'state', 'runs', 'old1'); mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'state.json'), JSON.stringify({ id: 'old1', tag: 'code', goal: 'g', bar: 'b', fence: 'f', paths: [], createdAt: T0, frozen: true, addedAfterFreeze: 0, budget: { maxRounds: 4, maxMinutes: 240, maxUnits: 6, maxAdded: 2, staleMinutes: 45 }, integration: { rounds: [] }, units: [{ id: 'a', bar: 'b', status: 'stopped', after: null, strategyChanges: 0, strategyAt: -1, heartbeatAt: null, stopReason: 'no progress', rounds: [] }], notes: [], closed: { outcome: 'stopped', decision: 'stopped', at: at(1) } }));
  assert.equal(run('gap', 'close', 'old1', 'stopped:old1:a:1', '--reason', 'superseded').code, 0);
  const kinds = readFileSync(join(legacy, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).kind);
  assert.deepEqual(kinds, ['run.imported', 'note']);
});
