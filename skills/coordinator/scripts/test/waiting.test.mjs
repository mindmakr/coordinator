// Design one-boss 5.5: what waits on the person, across every registered run, from state on disk only
// (lib/waiting.mjs): open questions with their label, upstream proposals not filed (lib/gaps.mjs), runs
// finished but not closed, retros pending, paused runs and an out-of-date plugin from the last stored
// doctor check; the PC front page's Waiting on you and `run.mjs waiting [--json]` show the same list.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { looseEnds, needsSection, pcModel, pcPage, pcVersion } from '../lib/dashboard.mjs';
import { doctorFile, doctorRecord, readDoctorRecord, saveDoctorRecord } from '../lib/doctorrecord.mjs';
import { readRegistry } from '../lib/registry.mjs';
import { lastDecidedAt, waitingFrom, waitingList, waitingText } from '../lib/waiting.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'coord-waiting-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const T0 = Date.parse('2026-11-10T08:00:00Z');
const H = 3_600_000;
const at = (h) => new Date(T0 + h * H).toISOString();
const pass = (n, h) => ({ n, verdict: 'pass', score: 9, gap: null, evidence: 'green', at: at(h) });
const unit = (id, extra = {}) => ({ id, bar: `${id} works`, title: `Task ${id}`, after: null, status: 'open', strategyChanges: 0, strategyAt: -1, heartbeatAt: null, rounds: [], log: [], ...extra });
const run = (id, extra = {}) => ({
  id, tag: 'code', goal: `goal of ${id}`, alias: `${id} work`, bar: 'b', fence: 'f', paths: [],
  budget: { maxRounds: 4, maxMinutes: 10_000, maxUnits: 6, maxAdded: 2, staleMinutes: 45 },
  createdAt: at(0), frozen: true, addedAfterFreeze: 0, integration: { rounds: [] }, closed: null, notes: [], units: [unit('u1', { status: 'building', heartbeatAt: at(1) })], ...extra,
});
const NOW = T0 + 72 * H;

// One project with one run of each kind, plus quiet ones that must not show.
const fixture = () => [{
  key: 'k1', name: 'payday', runs: [
    run('asking', { notes: [{ kind: 'question', text: 'Ship it?', header: 'Ship', options: [{ label: 'Yes' }, { label: 'No' }], unit: 'u1', at: at(30) }] }),
    run('upstream', { closed: { outcome: 'done', decision: 'done', at: at(5) }, units: [unit('u1', { status: 'pass', rounds: [pass(1, 3)] })], notes: [
      { kind: 'retro', text: 'upstream: board.mjs drops labels', at: at(4) },
      { kind: 'retro', text: 'upstream: lib/hud.mjs shows no age', at: at(6) },
      { kind: 'retro', text: 'a lesson, not a proposal', at: at(6) },
    ] }),
    run('filed', { closed: { outcome: 'done', decision: 'done', at: at(5) }, units: [unit('u1', { status: 'pass', rounds: [pass(1, 3)] })], notes: [
      { kind: 'retro', text: 'upstream: plan.mjs is slow', at: at(4) }, { kind: 'info', text: 'filed upstream: mindmakr/coordinator#200', at: at(5) }, { kind: 'retro', text: 'done', at: at(5) },
    ] }),
    run('stopped', { units: [unit('u1', { status: 'pass', rounds: [pass(1, 10)] }), unit('u2', { status: 'stopped', stopReason: 'no progress', log: [{ kind: 'stop', at: at(12) }] })] }),
    run('failcheck', { units: [unit('u1', { status: 'pass', rounds: [pass(1, 20)] })], integration: { rounds: [{ verdict: 'fail', gap: 'e2e red', at: at(22) }] }, notes: [{ kind: 'retro', text: 'went fine', at: at(23) }] }),
    run('retro', { units: [unit('u1', { status: 'pass', rounds: [pass(1, 40)] })], integration: { rounds: [{ verdict: 'pass', at: at(41) }] } }),
    run('paused', { pauses: [{ from: at(50), reason: 'overnight' }] }),
    run('quiet'),
    run('closedq', { closed: { outcome: 'done', decision: 'done', at: at(9) }, units: [unit('u1', { status: 'pass', rounds: [pass(1, 3)] })], notes: [{ kind: 'question', text: 'Old?', at: at(2) }, { kind: 'retro', text: 'ok', at: at(9) }] }),
  ],
}];

test('B1: questions with their label, upstream per run, unclosed, retro pending, paused, plugin; oldest first', () => {
  const doctor = { checkedAt: at(60), mine: '1.6.1', latest: '1.7.0' };
  const items = waitingFrom(fixture(), { doctor, version: '1.6.1', nowMs: NOW });
  const by = (kind, runId) => items.find((x) => x.kind === kind && x.run === runId);
  assert.deepEqual(items.map((x) => `${x.kind}:${x.run}`), ['upstream:upstream', 'unclosed:stopped', 'unclosed:failcheck', 'question:asking', 'retro:retro', 'paused:paused', 'plugin:null'], 'oldest first; quiet, filed and closed runs absent');

  const q = by('question', 'asking');
  assert.equal(q.label, 'payday · asking work (asking) › Task u1: Task u1', 'the u3 label: project, run, task');
  assert.equal(q.since, at(30));
  assert.equal(q.link, '/#needs-k1-asking', 'to its answer form under Waiting on you');

  const up = by('upstream', 'upstream');
  assert.equal(up.items.length, 2, 'both proposals of the run, one item; the plain retro note is a lesson');
  assert.equal(up.text, '2 upstream proposals not filed', 'the summary says how many; the first proposal is in the list, not repeated here');
  assert.ok(!up.text.includes('board.mjs'), 'no duplicate of the first proposal in the summary');
  assert.equal(up.since, at(4), 'since the oldest proposal');
  assert.equal(up.link, '/p/k1/run/upstream/retro');
  assert.ok(!items.some((x) => x.run === 'filed'), 'a run that records its proposals filed upstream has none (lib/gaps.mjs)');

  const st = by('unclosed', 'stopped');
  assert.match(st.text, /1 unit stopped \(u2\); the final check has not run; retro pending/);
  assert.equal(st.since, at(12), 'since its last unit was decided');
  assert.ok(!by('retro', 'stopped'), 'one item per run: the unclosed one says the retro is pending');
  assert.match(by('unclosed', 'failcheck').text, /the final check failed$/);
  assert.equal(by('unclosed', 'failcheck').since, at(22));

  const r = by('retro', 'retro');
  assert.equal(r.fix, '/coordinator:retro retro');
  assert.equal(r.since, at(41));
  assert.equal(r.link, '/p/k1/run/retro/retro');

  const p = by('paused', 'paused');
  assert.equal(p.text, 'paused: overnight');
  assert.equal(p.since, at(50));
  assert.equal(p.fix, 'run.mjs resume paused');

  const plug = items.at(-1);
  assert.equal(plug.since, at(60));
  assert.match(plug.text, /1\.6\.1; 1\.7\.0 is out/);
  for (const x of items) assert.ok(x.since && !Number.isNaN(Date.parse(x.since)), `${x.kind} says since when`);
});

test('B1: the plugin item needs a stored check that found a newer release than the skill that runs now', () => {
  const plugin = (doctor, version = '1.6.1') => waitingFrom([], { doctor, version, nowMs: NOW }).filter((x) => x.kind === 'plugin');
  assert.equal(plugin(null).length, 0, 'no stored check: no item');
  assert.equal(plugin({ checkedAt: at(1), mine: '1.7.0', latest: '1.7.0' }).length, 0, 'up to date');
  assert.equal(plugin({ checkedAt: at(1), mine: '1.6.1', latest: '1.7.0' }, '1.7.0').length, 0, 'updated since the check');
  assert.equal(plugin({ checkedAt: at(1), mine: '1.6.1', latest: '1.7.0' }).length, 1);
  assert.deepEqual(waitingFrom([], { nowMs: NOW }), [], 'nothing at all');
});

test('B1: the doctor check is kept on disk only from an online version check, and read back', () => {
  const home = join(tmp, 'doc-home');
  assert.equal(readDoctorRecord(home), null, 'no file: none');
  assert.equal(doctorRecord([{ id: 'version', status: 'skip', text: 'offline' }]), null, 'offline or unreachable: nothing to keep');
  const rec = doctorRecord([{ id: 'node', status: 'ok' }, { id: 'version', status: 'warn', text: 'x', mine: '1.6.1', latest: '1.7.0' }], at(2));
  assert.deepEqual(rec, { checkedAt: at(2), mine: '1.6.1', latest: '1.7.0' });
  const file = saveDoctorRecord(rec, home);
  assert.equal(file, doctorFile(home));
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), rec);
  assert.deepEqual(readDoctorRecord(home), rec);
});

test('lastDecidedAt: the latest time a unit or the final check logged', () => {
  assert.equal(lastDecidedAt(run('x', { units: [unit('u1', { rounds: [pass(1, 3)], log: [{ kind: 'stop', at: at(7) }] })], integration: { rounds: [{ verdict: 'fail', at: at(5) }] } })), at(7));
  assert.equal(lastDecidedAt(run('x', { units: [] })), at(0), 'nothing logged: when it started');
});

test('the dashboard and the waiting list read only from disk: no network or process module', () => {
  for (const f of ['waiting.mjs', 'doctorrecord.mjs']) {
    const src = readFileSync(join(scripts, 'lib', f), 'utf8');
    assert.doesNotMatch(src, /node:(https?|net|tls|child_process|dgram)|\bfetch\(/, f);
  }
});

// The CLI and the page, over real registered runs in two projects.
const home = join(tmp, 'home');
const stateOf = (name) => join(tmp, name, '.coordinator');
const env = (name) => ({ ...process.env, COORDINATOR_DIR: stateOf(name), COORDINATOR_HOME: home, COORDINATOR_REGISTRY: 'on', COORDINATOR_HARNESS: '' });
const cli = (name, args) => {
  const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...args], { cwd: tmp, env: env(name), encoding: 'utf8' });
  let out = null; try { out = JSON.parse(r.stdout); } catch { /* text */ }
  return { code: r.status, out, raw: r.stdout, err: r.stderr };
};
const ok = (r) => { assert.equal(r.code, 0, r.err); return r; };

test('B2, B3: run.mjs waiting and the PC front page show the same list, oldest first; empty says so', () => {
  const empty = cli('alpha', ['waiting']);
  assert.equal(empty.code, 0, empty.err);
  assert.equal(empty.raw, 'Nothing waits on you.\n');
  assert.deepEqual(cli('alpha', ['waiting', '--json']).out, []);
  const pc0 = pcModel(readRegistry({ home }));
  const page0 = pcPage(pc0, Date.now(), { live: { token: 't', nonce: 'n' } }, []);
  assert.match(page0, /<section data-k="pc-needs"[^>]*><div class="needs calm">Nothing needs you on this PC\.<\/div>/);
  assert.match(page0, /<section data-k="pc-loose"[^>]*><p class="empty">Nothing waits on you\.<\/p>/);
  // Long lists scroll inside their panel (the canvas's heights), so the page stays short.
  for (const [id, h] of [['pc-blocked', 240], ['pc-loose', 300], ['pc-concluded', 260]]) assert.match(page0, new RegExp(`data-d="${id}"[^>]*>[\\s\\S]*?<div class="body scroll[^"]*" style="max-height:${h}px">`), id);

  ok(cli('alpha', ['init', 'ra', '--goal', 'goal a', '--bar', 'b', '--fence', 'f', '--alias', 'alpha work']));
  ok(cli('alpha', ['add', 'ra', 'u1', '--bar', 'b', '--title', 'Mobile card']));
  ok(cli('alpha', ['pause', 'ra', '--reason', 'overnight']));
  ok(cli('beta', ['init', 'rb', '--goal', 'goal b', '--bar', 'b', '--fence', 'f', '--alias', 'beta work']));
  ok(cli('beta', ['add', 'rb', 'u1', '--bar', 'b', '--title', 'Totals']));
  ok(cli('beta', ['note', 'rb', '--kind', 'follow-up', '--text', 'upstream: board.mjs drops labels']));
  ok(cli('beta', ['ask', 'rb', '--question', 'Ship beta?', '--header', 'Ship', '--option', 'Yes|ship it', '--option', 'No|wait', '--unit', 'u1']));

  const json = ok(cli('beta', ['waiting', '--json'])).out;
  assert.deepEqual(json.map((x) => `${x.kind}:${x.project}:${x.run}`), ['paused:alpha:ra', 'upstream:beta:rb', 'question:beta:rb'], 'oldest first, across both projects');
  assert.match(json[2].label, /^beta · beta work \(rb\) › Task u1: Totals$/);
  const entries = readRegistry({ home });
  const same = waitingList(entries, { home, nowMs: Date.now() });
  assert.deepEqual(same.map(({ since, ...x }) => x), json.map(({ since, ...x }) => x), 'the CLI prints what the one function builds');
  const text = ok(cli('beta', ['waiting'])).raw.trim().split('\n');
  assert.equal(text.length, 4);
  assert.match(text[0], /^under a minute ago\s+alpha · alpha work \(ra\)\s+\[paused\] paused: overnight\s+→ run\.mjs resume ra$/);
  assert.match(text[1], /beta · beta work \(rb\)\s+\[upstream proposals not filed\] 1 upstream proposal not filed: upstream: board\.mjs drops labels/);
  assert.equal(text[3], '3 items waiting on you');

  // The front page: Waiting on you first, the question once (with its form), then the rest, each with its age.
  const nowMs = Date.now();
  const pc = pcModel(entries, { nowMs });
  const ctx = { answerForm: { token: 'tok' }, pcHref: (k, r, sub = '') => `/p/${k}/run/${r}${sub}?t=tok` };
  const page = pcPage(pc, nowMs, { live: { token: 'tok', nonce: 'n' }, ...ctx }, same);
  // Runs scroll once: the table's own box (its header sticks to it), not the panel body around it.
  const runsPanel = page.slice(page.indexOf('data-d="pc-runs"'), page.indexOf('data-d="pc-blocked"'));
  assert.match(runsPanel, /<div class="body flush">/, 'the Runs panel body does not scroll');
  assert.match(runsPanel, /<div class="scroll tbox" style="max-height:380px">/, 'the table box is the one scroller');
  const top = page.indexOf('id="pc-needs"');
  assert.ok(top > 0 && top < page.indexOf('id="self-pc"'), 'Questions sit above the runs');
  assert.equal(page.split('Ship beta?').length - 1, 1, 'the open question shows once, with its answer form');
  assert.match(needsSection(pc, ctx), /<form/);
  assert.match(page, /<h2>Loose ends<\/h2><span class="count">2<\/span>/);
  assert.match(page, /<span class="k">Loose ends<\/span><span class="v">2<\/span><span class="s">oldest under a minute<\/span>/);
  const sec = looseEnds(pc, same, ctx);
  assert.equal(sec.split('<li>').length - 1, 2, 'the question is not listed again');
  assert.ok(sec.indexOf('paused: overnight') < sec.indexOf('1 upstream proposal not filed'), 'oldest first');
  const keyB = entries.find((e) => e.run === 'rb').key;
  assert.ok(sec.includes(`href="/p/${keyB}/run/rb/retro?t=tok"`), 'upstream proposals link to the run\'s retro page');
  assert.match(sec, /waiting <time datetime="[^"]+" class="age" title="[^"]+ UTC">under a minute<\/time> ago/, 'how long it has waited, kept current by the live page');
  assert.match(sec, /<code>run\.mjs resume ra<\/code>/);

  // The stored doctor check shows, and the live page re-renders when it changes.
  const withHome = (fn) => { const was = process.env.COORDINATOR_HOME; process.env.COORDINATOR_HOME = home; try { return fn(); } finally { process.env.COORDINATOR_HOME = was; } };
  const v0 = withHome(() => pcVersion(entries));
  saveDoctorRecord({ checkedAt: new Date().toISOString(), mine: '0.0.1', latest: '99.0.0' }, home);
  assert.notEqual(withHome(() => pcVersion(entries)), v0);
  const out = ok(cli('beta', ['waiting', '--json'])).out;
  assert.equal(out.at(-1).kind, 'plugin', 'newest last');
  assert.match(out.at(-1).text, /99.0.0 is out/);
});

test('B5: the age column pads to the longest age, so long ages keep the lines aligned', () => {
  const now = Date.parse('2026-11-14T12:00:00Z');
  const item = (since, text) => ({ project: 'p', key: 'k', run: 'r1', name: null, kind: 'paused', what: 'paused', text, since, link: null, fix: null });
  const lines = waitingText([item('2026-11-13T23:28:00Z', 'a'), item('2026-11-14T11:59:00Z', 'b'), item(null, 'c')], now).split('\n').slice(0, 3);
  const col = lines.map((l) => l.indexOf('p ·'));
  assert.ok(col.every((c) => c === col[0] && c > 0), `where starts in one column: ${JSON.stringify(lines)}`);
});
