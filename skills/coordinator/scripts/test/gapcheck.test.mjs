import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { planCheck, refsToCheck } from '../lib/gapcheck.mjs';
import { gaps } from '../lib/gaps.mjs';
import { selfModel } from '../lib/self.mjs';
import { selfPage } from '../lib/selfpage.mjs';
import { staticCtx } from '../lib/hud.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'coordinator-gapcheck-'));
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const T0 = '2026-11-01T10:00:00.000Z';
const at = (min) => new Date(Date.parse(T0) + min * 60_000).toISOString();

// GitHub as a table: "owner/repo#n" -> issue JSON. Every call is logged.
function fakeGh(table, { installed = true, signedIn = true } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    if (!installed) return { status: null, stdout: '', stderr: '', missing: true };
    if (args[0] === '--version') return { status: 0, stdout: 'gh 2.60' };
    if (args[0] === 'auth') return { status: signedIn ? 0 : 1, stdout: '', stderr: signedIn ? 'Logged in' : 'not logged in' };
    const m = /^repos\/(.+)\/(issues|pulls)\/(\d+)$/.exec(args[1]);
    const row = m && table[`${m[1]}#${m[3]}`];
    if (!row) return { status: 1, stdout: '', stderr: 'Not Found' };
    return { status: 0, stdout: JSON.stringify(m[2] === 'pulls' ? { merge_commit_sha: row.sha ?? null } : row) };
  };
  gh.calls = calls;
  return gh;
}
const merged = (sha = 'abc1234') => ({ state: 'closed', pull_request: { merged_at: at(500) }, sha });
const closedIssue = { state: 'closed', state_reason: 'completed' };
const openIssue = { state: 'open' };

// The critic's sentences: a note that only mentions a ref never closes its gap, whatever GitHub says.
const MENTIONS = [
  'see #1230 for context; the mobile side is still missing',
  'Compare with https://github.com/acme/web/pull/1230 behaviour; the same bug exists in the export',
  'listed in release notes on acme/web#1230 still to write',
  'Compare with acme/web#1230 behaviour; the same bug exists…',
];
function fixture() {
  const r = {
    id: 'r1', repo: 'acme/web', createdAt: T0, closed: { outcome: 'partial', decision: 'stopped', at: at(100) }, notes: [],
    units: [
      { id: 'u1', status: 'stopped', rounds: [{ n: 1, gap: 'g', at: at(10) }], log: [{ kind: 'stop', at: at(11) }], links: [{ kind: 'issue', url: 'https://github.com/acme/web/issues/1' }, { kind: 'pr', url: 'https://github.com/acme/web/pull/2' }] },
      { id: 'u2', status: 'stopped', rounds: [{ n: 1, gap: 'see #1230 for context', at: at(10) }], links: [{ kind: 'issue', url: 'https://github.com/acme/web/issues/3' }] },
      { id: 'u3', status: 'stopped', rounds: [{ n: 1, gap: 'g', at: at(10) }], links: [{ kind: 'pr', url: 'https://github.com/acme/web/pull/4' }] },
    ],
  };
  for (const [i, text] of MENTIONS.entries()) r.notes.push({ kind: 'follow-up', text, at: at(i + 1) });
  r.notes.push(
    { kind: 'follow-up', text: 'Filed as acme/mobile#5', at: at(10) }, // tracked, in a repo no run links: unverified until checked
    { kind: 'follow-up', text: 'Filed as acme/mobile#6', at: at(11) }, // tracked, but #6 does not exist
  );
  return r;
}
const TABLE = { 'acme/web#1': closedIssue, 'acme/web#2': merged('def5678'), 'acme/web#3': closedIssue, 'acme/web#4': { state: 'closed', pull_request: { merged_at: null } }, 'acme/web#1230': merged(), 'acme/mobile#5': openIssue };

test('which references each open gap asks about: the unit\'s own PRs and unverified tracked refs, never a ref a note only mentions', () => {
  const asks = refsToCheck([fixture()]);
  const by = Object.fromEntries(asks.map((a) => [a.gap.id, a.refs.map((r) => `${r.repo}#${r.n}`).sort()]));
  assert.deepEqual(by, { 'stopped:r1:u1:1': ['acme/web#2'], 'stopped:r1:u3:1': ['acme/web#4'], 'follow-up:r1:-:5': ['acme/mobile#5'], 'follow-up:r1:-:6': ['acme/mobile#6'] });
  assert.equal(refsToCheck([fixture()], 'other').length, 0, '--run narrows it');
});

test('the plan: a unit\'s own merged PR or a tracked ref that exists closes; the critic\'s mentions never do; each reference is asked once', () => {
  const gh = fakeGh(TABLE);
  const p = planCheck([fixture()], { gh, today: '2026-11-07' });
  assert.equal(p.ok, true);
  const c = Object.fromEntries(p.closes.map((x) => [x.gap, x]));
  assert.deepEqual(Object.keys(c).sort(), ['follow-up:r1:-:5', 'stopped:r1:u1:1']);
  assert.equal(c['stopped:r1:u1:1'].reason, "checked on 2026-11-07: its PR https://github.com/acme/web/pull/2 merged; the critic's last gap was not re-checked");
  assert.equal(c['stopped:r1:u1:1'].merge, 'https://github.com/acme/web/commit/def5678', 'its own PR merged: the merge is recorded');
  assert.equal(c['follow-up:r1:-:5'].reason, 'checked on 2026-11-07: tracked in https://github.com/acme/mobile/issues/5, which exists (open)');
  for (const g of ['follow-up:r1:-:1', 'follow-up:r1:-:2', 'follow-up:r1:-:3', 'follow-up:r1:-:4', 'stopped:r1:u2:1']) assert.equal(c[g], undefined, `${g}: a mention, though #1230 merged`);
  assert.equal(c['stopped:r1:u3:1'], undefined, 'a PR closed without merging closes nothing');
  assert.equal(c['follow-up:r1:-:6'], undefined, 'a tracked ref that does not exist closes nothing');
  assert.equal(gh.calls.some((x) => x.includes('1230')), false, 'a mention is never even asked');
  const apiCalls = gh.calls.filter((x) => x.startsWith('api repos/') && x.includes('/issues/'));
  assert.equal(apiCalls.length, new Set(apiCalls).size, 'each reference once');
});

test('no gh, or gh not signed in: says so and plans nothing', () => {
  for (const [o, re] of [[{ installed: false }, /not installed/], [{ signedIn: false }, /not signed in/]]) {
    const gh = fakeGh(TABLE, o);
    const p = planCheck([fixture()], { gh });
    assert.equal(p.ok, false); assert.match(p.error, re); assert.equal(p.closes.length, 0);
    assert.equal(gh.calls.filter((x) => x.startsWith('api')).length, 0);
  }
});

// A fake gh binary on PATH: gh (sh) and gh.cmd (Windows) run gh.mjs, which answers from FAKE_GH_TABLE.
function fakeBin() {
  const bin = join(dir, 'bin'); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh.mjs'), `import { readFileSync, appendFileSync } from 'node:fs';
const a = process.argv.slice(2); appendFileSync(process.env.FAKE_GH_LOG, a.join(' ') + '\\n');
if (a[0] === '--version') { console.log('gh 2.60'); process.exit(0); }
if (a[0] === 'auth') process.exit(process.env.FAKE_GH_AUTH === 'no' ? 1 : 0);
const t = JSON.parse(readFileSync(process.env.FAKE_GH_TABLE, 'utf8'));
const m = /^repos\\/(.+)\\/(issues|pulls)\\/(\\d+)$/.exec(a[1] ?? ''); const row = m && t[m[1] + '#' + m[3]];
if (!row) { console.error('Not Found'); process.exit(1); }
console.log(JSON.stringify(m[2] === 'pulls' ? { merge_commit_sha: row.sha ?? null } : row));
`);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath.replace(/\\/g, '/')}" "$(dirname "$0")/gh.mjs" "$@"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(bin, 'gh.cmd'), `@"${process.execPath}" "%~dp0gh.mjs" %*\r\n`);
  return bin;
}

test('cli: --dry-run changes nothing; --check writes the closures and the merge link and remembers when it ran; no gh changes nothing', () => {
  const state = join(dir, 'state'); const runDir = join(state, 'runs', 'r1'); mkdirSync(runDir, { recursive: true });
  const r = { ...fixture(), tag: 'code', goal: 'g', bar: 'b', fence: 'f', paths: [], frozen: true, addedAfterFreeze: 0, budget: { maxRounds: 4, maxMinutes: 240, maxUnits: 6, maxAdded: 2, staleMinutes: 45 }, integration: { rounds: [] } };
  r.units = r.units.map((u) => ({ bar: 'b', after: null, strategyChanges: 0, strategyAt: -1, heartbeatAt: null, stopReason: 'budget: rounds', ...u }));
  writeFileSync(join(runDir, 'state.json'), JSON.stringify(r));
  writeFileSync(join(dir, 'table.json'), JSON.stringify(TABLE));
  const bin = fakeBin(); const log = join(dir, 'gh.log'); writeFileSync(log, '');
  const env = { ...process.env, COORDINATOR_DIR: state, FAKE_GH_TABLE: join(dir, 'table.json'), FAKE_GH_LOG: log, PATH: `${bin}${delimiter}${process.env.PATH}` };
  const run = (e, ...a) => { const x = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...a], { env: e, encoding: 'utf8', cwd: dir }); return { code: x.status, out: (() => { try { return JSON.parse(x.stdout); } catch { return x.stdout; } })(), err: x.stderr }; };
  const before = readFileSync(join(runDir, 'state.json'), 'utf8');

  const dry = run(env, 'gaps', '--check', '--dry-run');
  assert.equal(dry.code, 0, dry.err);
  assert.equal(dry.out.closes.length, 2); assert.equal(dry.out.dryRun, true);
  assert.equal(readFileSync(join(runDir, 'state.json'), 'utf8'), before, 'dry run: nothing written');
  assert.equal(existsSync(join(runDir, 'events.jsonl')), false); assert.equal(existsSync(join(state, 'gaps-check.json')), false);
  assert.match(readFileSync(log, 'utf8'), /api repos\/acme\/web\/issues\/2\b/, 'the fake gh on PATH answered');

  const none = run({ ...env, PATH: join(dir, 'empty') }, 'gaps', '--check');
  assert.match(none.err, /not installed/); assert.equal(none.out.checked, false);
  const out = run({ ...env, FAKE_GH_AUTH: 'no' }, 'gaps', '--check');
  assert.match(out.err, /not signed in/);
  assert.equal(readFileSync(join(runDir, 'state.json'), 'utf8'), before, 'no gh / signed out: nothing written');

  const real = run(env, 'gaps', '--check');
  assert.equal(real.code, 0, real.err);
  const after = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
  const closes = after.notes.filter((n) => n.gap);
  assert.deepEqual(closes.map((n) => n.gap).sort(), ['follow-up:r1:-:5', 'stopped:r1:u1:1']);
  assert.ok(closes.every((n) => n.by === 'lead' && n.checked?.ref && /^checked on \d{4}-\d{2}-\d{2}: (?:its PR|tracked in) https:\/\/github\.com\//.test(n.reason)));
  assert.deepEqual(after.units[0].links.at(-1).url, 'https://github.com/acme/web/commit/def5678');
  const last = JSON.parse(readFileSync(join(state, 'gaps-check.json'), 'utf8'));
  assert.equal(last.closed, 2);
  const g = gaps([after]).find((x) => x.id === 'stopped:r1:u1:1');
  assert.equal(g.resolution.checked.state, 'merged');
  const html = selfPage(selfModel({ runs: [after], gapsCheck: last }), Date.now(), { ...staticCtx('', 0), runHref: (id) => `runs/${id}/hud.html` });
  assert.match(html, /by lead, checked with gh/); assert.match(html, /Last checked against GitHub <time/);
  assert.match(run(env, 'gaps', '--dry-run').err, /go with --check/);
});
