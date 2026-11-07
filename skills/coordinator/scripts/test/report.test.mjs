// The run's report and retro: the safe Markdown renderer, the git-derived
// draft, storing notes, the pages in the snapshot, the retro banner and close's warning.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { copyNote, draft, draftMarkdown, gitRunner } from '../lib/report/draft.mjs';
import { markdown } from '../lib/report/md.mjs';
import { retroModel, retroPending } from '../lib/retro.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'coord-report-'));
after(() => rmSync(root, { recursive: true, force: true }));
const project = join(root, 'proj'); const state = join(root, 'state');
mkdirSync(project);
const git = (...a) => { const r = spawnSync('git', a, { cwd: project, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const put = (p, t) => { mkdirSync(dirname(join(project, p)), { recursive: true }); writeFileSync(join(project, p), t); };
const cli = (...args) => spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...args], { cwd: project, env: { ...process.env, COORDINATOR_DIR: state }, encoding: 'utf8' });
const run = (...a) => { const r = cli(...a); assert.equal(r.status, 0, `${a.join(' ')}: ${r.stderr}`); return r.stdout; };
const runDir = (id) => join(state, 'runs', id);

git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
put('.env.example', 'DATABASE_URL=\n'); put('src/app.js', 'export const a = 1;\n');
git('add', '-A'); git('commit', '-qm', 'base');
const base = git('rev-parse', 'HEAD');
put('.env.example', 'DATABASE_URL=\nPAYOUT_WEBHOOK_SECRET=\n');
put('drizzle/0042_add_payouts.sql', 'CREATE TABLE payouts (id int);\n');
put('scripts/backfill-payouts.ts', 'console.log("backfill");\n');
put('src/jobs.js', 'export function start(boss) {\n  boss.work("payout.settle", settle);\n}\n');
git('add', '-A'); git('commit', '-qm', 'payouts');
const head = git('rev-parse', 'HEAD');

test('markdown: headings, lists, tables and code render; HTML and script never pass through', () => {
  const html = markdown('## Fixed\n- Payouts settle **once** (`settle()`) #12\n- <script>alert(1)</script>\n\n| Change | Expected |\n| --- | --- |\n| a \\| b | <img src=x onerror=1> |\n\n```\n<b>raw</b>\n```\n[x](javascript:alert(1)) https://example.com/p', 'o/r');
  assert.match(html, /<h3 class="md">Fixed<\/h3>/);
  assert.match(html, /<b>once<\/b>/);
  assert.match(html, /<code>settle\(\)<\/code>/);
  assert.match(html, /href="https:\/\/github\.com\/o\/r\/issues\/12"/);
  assert.match(html, /<td>a \| b<\/td>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=1&gt;/);
  assert.match(html, /<pre>&lt;b&gt;raw&lt;\/b&gt;<\/pre>/);
  assert.match(html, /href="https:\/\/example\.com\/p"/);
  assert.doesNotMatch(html, /<script|<img|href="javascript/);
});

test('draft: migrations, env names, scripts and jobs from each unit\'s recorded diff; an unreadable range is said, not guessed', () => {
  const s = {
    id: 'r', notes: [{ kind: 'decision', text: 'Copy for the payout SMS is awaiting approval in Copy Studio', at: 'x' }],
    units: [
      { id: 'u1', title: 'Payouts settle once', status: 'pass', bar: 'b', detect: { base, head }, links: [{ kind: 'pr', url: 'https://github.com/o/r/pull/7' }, { kind: 'merge', url: 'https://github.com/o/r/pull/7' }] },
      { id: 'u2', status: 'stopped', bar: 'Mobile copy', detect: { base: 'deadbeef', head: 'cafebabe' } },
      { id: 'u3', status: 'open', bar: 'Not started' },
    ],
  };
  const d = draft(s, { git: gitRunner(project) });
  assert.deepEqual(d.migrations.map((m) => m.path), ['drizzle/0042_add_payouts.sql']);
  assert.deepEqual(d.env.map((e) => `${e.name} ${e.change}`), ['PAYOUT_WEBHOOK_SECRET added']);
  assert.deepEqual(d.scripts.map((x) => x.path), ['scripts/backfill-payouts.ts']);
  assert.equal(d.jobs.length, 1); assert.match(d.jobs[0].text, /boss\.work\("payout\.settle"/); assert.equal(d.jobs[0].file, 'src/jobs.js');
  assert.equal(d.copy.length, 1);
  assert.deepEqual(d.diffs.map((x) => x.ok), [true, false, false]);
  const md = draftMarkdown(d, s);
  assert.match(md, /### Changes\n- Payouts settle once: TODO/);
  assert.match(md, /Not in this release \(not passed\): u2 \(stopped\), u3 \(open\)/);
  assert.match(md, /\| Payouts settle once \| TODO \| TODO \| TODO \| TODO \|/);
  assert.match(md, /`PAYOUT_WEBHOOK_SECRET` added in `\.env\.example`/);
  assert.match(md, /Not read from git: u2 \(git cannot read/);
  assert.doesNotMatch(md, /DATABASE_URL/); // unchanged: not listed
});

test('retro: pending once every unit is decided, until a retro note; the model gathers lessons, upstream and escapes', () => {
  const s = { id: 'r', tag: 'code', budget: { maxRounds: 4, maxMinutes: 60, maxUnits: 6 }, units: [{ id: 'u1', status: 'pass', rounds: [{}, {}] }, { id: 'u2', status: 'building', rounds: [] }], notes: [] };
  assert.equal(retroPending(s, 'continue'), false);
  s.units[1].status = 'stopped'; s.units[1].stopReason = 'round budget';
  assert.equal(retroPending(s, 'continue'), true);
  s.notes.push({ kind: 'retro', text: 'Repeated gap: dates', at: 'a' }, { kind: 'retro', text: 'upstream: rebase guidance', at: 'b' }, { kind: 'escape', unit: 'u1', round: 2, text: 'missed a locale', at: 'c' });
  assert.equal(retroPending(s, 'continue'), false);
  const closed = [1, 2, 3].map((n) => ({ id: `c${n}`, tag: 'code', closed: { outcome: 'done' }, budget: s.budget, units: [{ id: 'x', status: 'pass', rounds: Array(n).fill({}) }], notes: [] }));
  const m = retroModel(s, { lessons: [{ id: 'L1', tag: 'code', text: 'Use the simulated clock', from: ['r'], seen: 1 }, { id: 'L2', tag: 'code', text: 'other', from: ['z'], seen: 1 }], closed });
  assert.deepEqual(m.notes.map((n) => n.text), ['Repeated gap: dates']);
  assert.deepEqual(m.upstream.map((n) => n.text), ['upstream: rebase guidance']);
  assert.deepEqual(m.lessons.map((l) => l.id), ['L1']);
  assert.equal(m.escapes[0].unit, 'u1');
  assert.equal(m.budget.usedRounds, 2); assert.equal(m.budget.suggested, 4); assert.equal(m.budget.from, 3);
  assert.deepEqual(m.budget.stopped, [{ id: 'u2', reason: 'round budget' }]);
});

test('CLI: report and retro pages in the snapshot, notes stored and escaped, the banner, quality, and close warns without a retro', () => {
  run('init', 'r1', '--goal', 'ship payouts', '--bar', 'b', '--fence', 'f');
  run('add', 'r1', 'u1', '--bar', 'payouts settle once', '--title', 'Payouts settle once');
  run('freeze', 'r1');
  const hud = () => readFileSync(join(runDir('r1'), 'hud.html'), 'utf8');
  const report = () => readFileSync(join(runDir('r1'), 'report.html'), 'utf8');
  assert.match(hud(), /href="report\.html">Report →/);
  assert.match(hud(), /href="retro\.html">Retro →/);
  assert.match(report(), /Not written yet/);
  assert.match(report(), /run\.mjs report r1 --file notes\.md/);
  assert.match(report(), /Not measured yet/);
  assert.equal(JSON.parse(run('report', 'r1')).notes, null);

  writeFileSync(join(root, 'notes.md'), '## r1\n### Fixed\n- Payouts settle once (#7) <script>x</script>\n- token: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
  const stored = JSON.parse(run('report', 'r1', '--file', join(root, 'notes.md')));
  assert.equal(stored.notes.source, 'notes.md');
  assert.match(report(), /<h4 class="md">Fixed<\/h4>/);
  assert.match(report(), /&lt;script&gt;x/);
  assert.doesNotMatch(report(), /ghp_abcdef/); // masked on the way in
  assert.match(readFileSync(join(runDir('r1'), 'events.jsonl'), 'utf8'), /"kind":"report"/);
  assert.notEqual(cli('report', 'r1', '--file', join(root, 'missing.md')).status, 0);

  // Quality on the project only (the unit has no recorded diff), then on the run: stored and shown.
  // Synthetic secrets planted in the project never reach stdout, quality.json, the report or any file in the state.
  const PLANTED = ['Zq9!synthetic-Pw-7731', ['sk', 'live', '51SynthEt1cK3yZz9Qq8Ww7Ee6Rr'].join('_') /* built at run time, so no key-shaped string sits in the repo */, 'django-insecure-synth9x7f2k3m4n5b6v7c8'];
  put('src/leak.ts', [`const dbPassword = '${PLANTED[0]}';`, `const STRIPE_KEY = '${PLANTED[1]}';`, `eval(code, '${PLANTED[1]}');`, `logger.info({ email: user.email, password: '${PLANTED[0]}' });`].join('\n'));
  put('app/settings.py', `SECRET_KEY = "${PLANTED[2]}"\n`);
  const outs = [run('quality', '--project'), run('quality', 'r1'), run('quality', 'r1', '--json')];
  assert.match(outs[0], /Project: \d+ files/);
  assert.match(outs[1], /not a compliance certification/);
  assert.match(outs[1], /src\/leak\.ts:1 +credential assigned a literal/);
  assert.ok(existsSync(join(runDir('r1'), 'quality.json')));
  assert.match(report(), /Signals, not a verdict/);
  assert.match(report(), /src\/leak\.ts:1/);
  const filesIn = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesIn(join(dir, e.name)) : [readFileSync(join(dir, e.name), 'utf8')]));
  for (const text of [...outs, ...filesIn(state)]) for (const p of PLANTED) assert.ok(!text.includes(p), `a planted secret leaked: ${p.slice(0, 6)}…`);
  rmSync(join(project, 'src', 'leak.ts')); rmSync(join(project, 'app'), { recursive: true });
  assert.notEqual(cli('quality').status, 0);

  // Every unit decided: the banner and the retro page; a retro note clears it.
  run('start', 'r1', 'u1'); run('built', 'r1', 'u1'); run('verdict', 'r1', 'u1', 'pass', '--evidence', 'tests green', '--score', '9');
  assert.match(hud(), /Retro pending/);
  assert.match(hud(), /\/coordinator:retro r1/);
  assert.match(readFileSync(join(runDir('r1'), 'retro.html'), 'utf8'), /Retro pending/);
  run('integrate', 'r1', 'pass', '--evidence', 'merged and green');
  const warned = JSON.parse(run('close', 'r1', '--outcome', 'done'));
  assert.match(warned.warning, /no retro note: ask the person to run \/coordinator:retro r1/);
  run('note', 'r1', '--kind', 'retro', '--text', 'Repeated gap: none');
  assert.doesNotMatch(hud(), /Retro pending/);
  assert.match(readFileSync(join(runDir('r1'), 'retro.html'), 'utf8'), /Repeated gap: none/);

  run('init', 'r2', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  run('add', 'r2', 'u1', '--bar', 'b'); run('freeze', 'r2');
  run('start', 'r2', 'u1'); run('built', 'r2', 'u1'); run('verdict', 'r2', 'u1', 'pass', '--evidence', 'e', '--score', '9');
  run('integrate', 'r2', 'pass', '--evidence', 'e'); run('note', 'r2', '--kind', 'retro', '--text', 'done');
  assert.equal(JSON.parse(run('close', 'r2', '--outcome', 'done')).warning, undefined);
});

test('serve: /report and /retro behind the token, for the served run and another run read-only', async () => {
  const child = spawn(process.execPath, [join(scripts, 'run.mjs'), 'serve', 'r2'], { cwd: project, env: { ...process.env, COORDINATOR_DIR: state } });
  try {
    const url = await new Promise((ok, bad) => {
      let buf = '';
      child.stdout.on('data', (d) => { buf += d; const m = /"url":\s*"([^"]+)"/.exec(buf); if (m) ok(m[1]); });
      child.on('exit', () => bad(new Error('serve exited')));
    });
    const u = new URL(url); const t = u.searchParams.get('t');
    const get = async (p) => { const r = await fetch(`${u.origin}${p}`); return { status: r.status, body: await r.text() }; };
    assert.equal((await get('/report')).status, 403);
    const rep = await get(`/report?t=${t}`);
    assert.equal(rep.status, 200);
    assert.match(rep.body, /Report · r2/);
    assert.match(rep.body, /aria-current="page">Report</);
    assert.match((await get(`/retro?t=${t}`)).body, /Retro · r2/);
    const other = await get(`/run/r1/report?t=${t}`);
    assert.match(other.body, /Payouts settle once/);
    assert.equal((await get(`/run/nope/retro?t=${t}`)).status, 404);
  } finally {
    const gone = new Promise((ok) => child.once('exit', ok)); child.kill(); await gone;
  }
});

test('round 2: bold never touches an href; copy notes need the copy store; retro counts builds a reset ended', () => {
  const html = markdown('see https://x.example/**y" onmouseover="alert(1)** and **bold**');
  assert.match(markdown('a **bold** word'), /<b>bold<\/b>/);
  assert.doesNotMatch(html, /href="[^"]*<b>/);
  assert.doesNotMatch(html, /onmouseover="alert/);
  for (const a of html.matchAll(/<a [^>]*>/g)) assert.doesNotMatch(a[0], /<b>|<\/b>/);
  assert.equal(copyNote('The payout SMS is awaiting approval in Copy Studio'), true);
  assert.equal(copyNote('copy store: two keys not yet approved'), true);
  assert.equal(copyNote('merge each PR when READY; new SMS wording marked awaiting approval'), false);
  assert.equal(copyNote('Copy Studio moved to Postgres'), false);
  const s = { id: 'r', tag: 't', budget: { maxRounds: 4, maxMinutes: 60, maxUnits: 6 }, notes: [], units: [{ id: 'u1', status: 'pass', rounds: [{}], log: [{ kind: 'start' }, { kind: 'reset' }, { kind: 'start' }, { kind: 'start' }, { kind: 'reset' }] }] };
  const m = retroModel(s);
  assert.equal(m.budget.usedRounds, 1); assert.equal(m.budget.builds, 3); assert.equal(m.budget.resets, 2);
});
