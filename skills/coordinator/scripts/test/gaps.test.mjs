import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { closeGap, gapId, gaps, gapsModel, gapsText, parseGapId } from '../lib/gaps.mjs';
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

test('every kind is derived from the state, with where it came from, its time and an id from the note kind and seq', () => {
  const a = mkRun('r-a', [
    unit('u1', 'stopped', { stopReason: 'budget: rounds', rounds: [{ n: 1, verdict: 'fail', gap: 'first', at: at(10) }, { n: 2, verdict: 'fail', gap: 'the auth check is missing', cause: 'no test', at: at(20) }], log: [{ kind: 'stop', at: at(21) }] }),
    unit('u2', 'building'), unit('u3', 'pass'),
  ], { outcome: 'partial', decision: 'integrate', at: at(60) }, { repo: 'acme/web' });
  a.notes.push(
    { kind: 'decision', text: 'closed early as partial at "integrate": out of time', at: at(59) },
    { kind: 'follow-up', text: 'Payroll menu misses a link', at: at(30) },
    { kind: 'follow-up', text: 'Mobile label: outside this run\'s fence', at: at(31) },
    { kind: 'follow-up', text: 'Filed as acme/web#12', at: at(32) },
    { kind: 'retro', text: 'upstream: the stale stop fires too early', at: at(33) },
    { kind: 'retro', text: 'A plain lesson, not a gap', at: at(34) },
    { kind: 'escape', unit: 'u3', round: 1, text: 'a defect after the pass', at: at(35) },
    { kind: 'question', text: 'Ship it?', header: 'Ship', options: [{ label: 'Yes' }, { label: 'No' }], at: at(36), history: [] },
    { kind: 'question', text: 'Merge?', header: 'Merge', options: [{ label: 'Yes' }, { label: 'No' }], at: at(37), history: [{ choices: ['Yes'], other: null, by: 'person', at: at(38) }] },
    { kind: 'decision', text: 'User: #1231 stays for later.', at: at(39) },
    { kind: 'info', text: 'The export goes to a follow-up issue', at: at(40) },
    { kind: 'decision', text: 'Accepted: it filtered the first 200, so later disputes vanished; deferred-comment resync stays', at: at(41) },
    { kind: 'decision', text: 'Mobile copy is out of fence, next release', at: at(42) },
  );
  const list = gaps([a]);
  const stopped = byKind(list, 'stopped')[0];
  assert.equal(stopped.id, 'stopped:r-a:u1:1');
  assert.match(stopped.text, /Stopped: budget: rounds\. Last gap: the auth check is missing/);
  assert.equal(stopped.cause, 'no test'); assert.equal(stopped.from, 'verdict, round 2'); assert.equal(stopped.status, 'open');
  assert.deepEqual(byKind(list, 'unfinished').map((g) => [g.id, g.at]), [['unfinished:r-a:u2:1', at(60)]]);
  const r = byKind(list, 'run')[0];
  assert.equal(r.id, 'run:r-a:-:1'); assert.match(r.text, /out of time/); assert.equal(r.status, 'open');
  assert.deepEqual(byKind(list, 'follow-up').map((g) => [g.id, g.status]), [['follow-up:r-a:-:2', 'open'], ['follow-up:r-a:-:4', 'resolved']]);
  assert.match(byKind(list, 'follow-up')[1].resolution.reason, /tracked in https:\/\/github\.com\/acme\/web\/issues\/12/);
  assert.deepEqual(byKind(list, 'out-of-fence').map((g) => g.id), ['follow-up:r-a:-:3', 'decision:r-a:-:13'], 'the id keeps the note kind, whatever the text says');
  assert.deepEqual(byKind(list, 'upstream').map((g) => [g.id, g.status]), [['retro:r-a:-:5', 'open']]);
  assert.equal(list.some((g) => g.text === 'A plain lesson, not a gap'), false, 'a retro lesson is not a gap');
  assert.deepEqual(byKind(list, 'escape').map((g) => [g.id, g.unit]), [['escape:r-a:u3:7', 'u3']]);
  assert.deepEqual(byKind(list, 'question').map((g) => [g.id, g.status]), [['question:r-a:-:q1', 'open'], ['question:r-a:-:q2', 'resolved']]);
  assert.match(byKind(list, 'question')[1].resolution.reason, /answered by person: Yes/);
  assert.deepEqual(byKind(list, 'deferred').map((g) => g.id), ['decision:r-a:-:10', 'info:r-a:-:11'], '"later disputes" and "deferred-comment" are not deferrals');
  const m = gapsModel([a]);
  assert.equal(m.openCount, list.filter((g) => g.status === 'open').length);
  assert.equal(m.openRuns, 1);
  for (const g of list) assert.deepEqual(parseGapId(g.id)?.run, 'r-a', g.id);
});

test('references: tracked or filed resolves, owner-less refs count against the run repo, a PR the note waits on does not', () => {
  const a = mkRun('r-ref', [unit('u1', 'pass', { links: [{ kind: 'pr', url: 'https://github.com/acme/web/pull/3' }] })], null);
  const texts = [
    'Mobile label: payday-employee-react-native#240 (web only)', // another repo's issue, no owner
    'Moved to #42',
    'Waiting on https://github.com/acme/web/pull/7 to merge',
    'Delete the branch after PR #239 merges',
    '#1207: menu misses a link',
    'Tracked in https://github.com/acme/web/issues/9',
    'Waits on mobile#5',
  ];
  for (const [i, text] of texts.entries()) a.notes.push({ kind: 'follow-up', text, at: at(i) });
  const st = gaps([a]).map((g) => [g.text, g.status, g.resolution?.reason ?? null]);
  assert.deepEqual(st.map((x) => x[1]), ['resolved', 'resolved', 'open', 'open', 'open', 'resolved', 'open']);
  assert.match(st[0][2], /https:\/\/github\.com\/acme\/payday-employee-react-native\/issues\/240/, 'resolved against the run repo (from its links)');
  assert.match(st[1][2], /https:\/\/github\.com\/acme\/web\/issues\/42/);
});

test('a stopped unit merged after its stop is resolved; stop ids use the stop count; folded follow-ups resolve when the unit passed', () => {
  const a = mkRun('r-m', [
    unit('D', 'stopped', { stopReason: 'budget: time', log: [{ kind: 'stop', at: at(10) }, { kind: 'reset', at: at(11) }, { kind: 'stop', at: at(20) }], links: [{ kind: 'merge', url: 'https://github.com/acme/web/commit/abc1234', at: at(25) }] }),
    unit('E', 'stopped', { log: [{ kind: 'stop', at: at(30) }], links: [{ kind: 'merge', url: 'https://github.com/acme/web/commit/def5678', at: at(5) }] }),
    unit('c12', 'pass'),
  ], null);
  a.notes.push({ kind: 'follow-up', text: 'From c11 r6 critic, folded into c12: mark trail pending', at: at(1) }, { kind: 'follow-up', text: 'Folded into c99: never built', at: at(2) });
  const list = gaps([a]);
  const d = list.find((g) => g.unit === 'D');
  assert.equal(d.id, 'stopped:r-m:D:2', 'the second stop has its own id');
  assert.equal(d.status, 'resolved'); assert.match(d.resolution.reason, /^merged after stop: https:\/\/github\.com\/acme\/web\/commit\/abc1234/);
  assert.equal(list.find((g) => g.unit === 'E').status, 'open', 'a merge before the stop does not resolve it');
  const f = list.filter((g) => g.kind === 'follow-up');
  assert.deepEqual(f.map((g) => g.status), ['resolved', 'open']);
  assert.equal(f[0].resolution.reason, 'folded into c12, which passed in r-m');
});

test('chain-aware: carried is open ("carried → run:unit") until the chain end passes or its own gap resolves; the run gap follows', () => {
  const a = mkRun('r1', [unit('c14', 'stopped', { stopReason: 'budget: rounds' })], { outcome: 'partial', decision: 'stopped', at: at(60) });
  const b = mkRun('r2', [unit('c14', 'building')], null, { createdAt: at(100), continues: [{ run: 'r1', unit: 'c14' }] });
  let g = gaps([a, b]).find((x) => x.id === 'stopped:r1:c14:1');
  assert.deepEqual([g.status, g.carried], ['open', 'r2:c14']);
  assert.match(gapsText(gaps([a, b])), /\[carried → r2:c14\]/);
  b.units[0].status = 'stopped'; b.units[0].links = [{ kind: 'merge', url: 'https://github.com/acme/web/commit/abc1234', at: at(200) }];
  g = gaps([a, b]).find((x) => x.id === 'stopped:r1:c14:1');
  assert.equal(g.status, 'resolved'); assert.match(g.resolution.reason, /finished in r2:c14: merged after stop/);
  b.units[0].status = 'pass'; delete b.units[0].links;
  const list = gaps([a, b]);
  assert.equal(list.find((x) => x.id === 'stopped:r1:c14:1').resolution.reason, 'finished in r2:c14 (passed)');
  assert.equal(list.find((x) => x.id === 'run:r1:-:1').status, 'resolved', 'every unit gap of the run is resolved');
  // The parent's own record (continuedIn), another unit id, through two runs.
  const p = mkRun('p1', [unit('x', 'open')], { outcome: 'partial', decision: 'continue', at: at(10) });
  p.units[0].continuedIn = [{ run: 'p2', unit: 'x2', at: at(20) }];
  const q = mkRun('p2', [unit('x2', 'stopped')], { outcome: 'stopped', decision: 'stopped', at: at(30) }, { createdAt: at(15) });
  const r = mkRun('p3', [unit('x3', 'pass')], { outcome: 'done', decision: 'done', at: at(50) }, { createdAt: at(40), continues: [{ run: 'p2', unit: 'x2', as: 'x3' }] });
  const l2 = gaps([p, q, r]);
  assert.equal(l2.find((x) => x.id === 'unfinished:p1:x:1').resolution.reason, 'finished in p3:x3 (passed)');
  assert.equal(l2.find((x) => x.id === 'stopped:p2:x2:1').resolution.reason, 'finished in p3:x3 (passed)');
  // A link to a run that is not here leaves the gap open; a loop ends.
  const lone = mkRun('l1', [unit('y', 'stopped', { continuedIn: [{ run: 'gone', at: at(1) }] })], null);
  assert.deepEqual([gaps([lone])[0].status, gaps([lone])[0].carried], ['open', null]);
  const m2 = mkRun('l2', [unit('z', 'stopped', { continuedIn: [{ run: 'l3' }] })]); const m3 = mkRun('l3', [unit('z', 'stopped', { continuedIn: [{ run: 'l2' }] })]);
  assert.equal(gaps([m2, m3]).length, 2);
});

test('closure notes: the last one wins, reopen undoes it, the person needs their words, a wrong run or id is refused; identical upstream notes are one gap', () => {
  const a = mkRun('r1', [unit('u1', 'stopped')], { outcome: 'stopped', decision: 'stopped', at: at(5) });
  const id = gapId('stopped', 'r1', 'u1', 1);
  assert.throws(() => closeGap(a, id, { reason: 'shipped', by: 'person' }), /--confirm/);
  assert.throws(() => closeGap(a, id, { reason: 'shipped', by: 'lead', confirm: 'yes' }), /--confirm goes with --by person/);
  closeGap(a, id, { reason: 'shipped by the person', by: 'person', confirm: 'yes, it shipped in 1.0.0', at: at(6) });
  let g = gaps([a]).find((x) => x.id === id);
  assert.equal(g.status, 'resolved'); assert.deepEqual([g.resolution.by, g.resolution.derived, g.resolution.reason, g.resolution.confirm], ['person', false, 'shipped by the person', 'yes, it shipped in 1.0.0']);
  closeGap(a, id, { reason: 'not done after all', reopen: true, at: at(7) });
  g = gaps([a]).find((x) => x.id === id);
  assert.equal(g.status, 'open');
  assert.throws(() => closeGap(a, 'stopped:other:u1:1', { reason: 'x' }), /belongs to run other/);
  assert.throws(() => closeGap(a, 'nope', { reason: 'x' }), /not a gap id/);
  assert.equal(parseGapId('stopped:r1:-:1').unit, null);
  const u = mkRun('r-u', [], null);
  u.notes.push({ kind: 'retro', text: 'upstream: board crashes', at: at(1) }, { kind: 'retro', text: 'Upstream:  board  crashes', at: at(2) });
  assert.equal(gaps([u]).length, 1);
});

test('upstream proposals are acted on when the run records the filed issue; a done run has no run gap', () => {
  const a = mkRun('r-up', [unit('u1', 'pass')], { outcome: 'done', decision: 'done', at: at(60) });
  a.notes.push({ kind: 'retro', text: 'upstream: board crashes', at: at(1) }, { kind: 'retro', text: 'upstream filed: mindmakr/coordinator#45', at: at(2) });
  const list = gaps([a]);
  assert.equal(list.length, 1, 'the filing note is a record, not a proposal');
  assert.equal(list[0].status, 'resolved'); assert.match(list[0].resolution.reason, /mindmakr\/coordinator#45/);
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
  assert.match(run('gap', 'close', 'g1', fid, '--reason', 'done in PR 5', '--by', 'person').err, /--confirm/);
  const c = run('gap', 'close', 'g1', fid, '--reason', 'done in PR 5', '--by', 'person', '--confirm', 'yes, PR 5 did it');
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

test('the page: a carried gap says where it went; a long resolution reason is clipped, with the full one on hover', () => {
  const a = mkRun('r1', [unit('c14', 'stopped')], null);
  const b = mkRun('r2', [unit('c14', 'building'), unit('u2', 'stopped')], null, { createdAt: at(100), continues: [{ run: 'r1', unit: 'c14' }], frozen: true, budget: { maxRounds: 4, maxMinutes: 1e9, maxUnits: 6, maxAdded: 2, staleMinutes: 1e9 } });
  closeGap(b, 'stopped:r2:u2:1', { reason: `superseded ${'x'.repeat(300)}`, by: 'lead', at: at(101) });
  const html = selfPage(selfModel({ runs: [a, b] }), Date.now(), { ...staticCtx('', 0), runHref: (id) => `runs/${id}/hud.html` });
  assert.match(html, /<b>carried → r2:c14<\/b>/);
  assert.match(html, /<span title="superseded x{300}">superseded x+…<\/span>/);
});

test('a stopped unit whose last gap was moved to an issue, and a run whose reason says where the rest continues, are tracked', () => {
  const a = mkRun('r1', [unit('c14', 'stopped', { rounds: [{ n: 1, gap: 'trail refresh holds a slot; moved to #42 by the person', at: at(1) }] }), unit('m1', 'stopped', { rounds: [{ n: 1, gap: 'see #43 for the PR', at: at(2) }] })], { outcome: 'partial', decision: 'stopped', at: at(5) }, { repo: 'acme/coord' });
  a.notes.push({ kind: 'decision', text: 'closed early as partial at "stopped": shipped; the rest continues in #42 (1.0.1)', at: at(4) });
  const list = gaps([a]);
  assert.equal(list.find((g) => g.unit === 'c14').resolution.reason, 'its last gap is tracked in https://github.com/acme/coord/issues/42');
  assert.equal(list.find((g) => g.unit === 'm1').status, 'open');
  assert.equal(list.find((g) => g.kind === 'run').resolution.reason, 'what is left is tracked in https://github.com/acme/coord/issues/42');
});

test('a decision note that opens with the unit id and says it merged resolves its stop; one before the last verdict or about another unit does not', () => {
  const a = mkRun('r1', [unit('m1', 'stopped', { rounds: [{ n: 3, gap: 'g', at: at(10) }] }), unit('m10', 'stopped', { rounds: [{ n: 1, gap: 'g', at: at(10) }] }), unit('m3', 'stopped', { rounds: [{ n: 1, gap: 'g', at: at(10) }] })], null);
  a.notes.push({ kind: 'decision', text: 'm1 merged as PR #39 after the extra round', at: at(11) }, { kind: 'decision', text: 'm3 merged early', at: at(5) });
  const st = Object.fromEntries(gaps([a]).map((g) => [g.unit, g.status]));
  assert.deepEqual(st, { m1: 'resolved', m10: 'open', m3: 'open' });
});
