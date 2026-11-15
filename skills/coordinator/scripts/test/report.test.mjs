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
import { liveCtx, staticCtx } from '../lib/hud.mjs';
import { reportMarkdown, reportPage } from '../lib/report/page.mjs';
import { repeatedGaps, retroMarkdown, retroModel, retroPage, retroPending } from '../lib/retro.mjs';

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
  // Each unit keeps its own changed paths (the report's By unit view); the run's list is their union.
  assert.deepEqual(d.changes[0].paths, d.files); assert.ok(d.changes[0].paths.includes('drizzle/0042_add_payouts.sql'));
  assert.deepEqual(d.changes.slice(1).map((c) => c.paths), [[], []]);
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
  assert.match(hud(), /<a href="report\.html">Report<\/a>/);
  assert.match(hud(), /<a href="retro\.html">Retro<\/a>/);
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

test('round 3: notes with a value on the next line, a credential table row or a login are masked; what is left is refused, never echoed', () => {
  const V = ['Zq9xSynthNext!71', 'tkSynthRow8842QQ', 'SynthLogin!4471', 'synthletmein'];
  const notes = join(root, 'r3.md');
  writeFileSync(notes, ['## Ops', 'Admin password:', `  ${V[0]}`, '', '| Name | Value |', '| --- | --- |', `| API_TOKEN | ${V[1]} |`, '', `login: admin / ${V[2]}`, `user: qa password: ${V[3]}`].join('\n'));
  run('report', 'r2', '--file', notes);
  const leaks = () => ['events.jsonl', 'state.json', 'report.html'].map((f) => readFileSync(join(runDir('r2'), f), 'utf8')).join('\n');
  for (const v of V) assert.ok(!leaks().includes(v), `leaked ${v.slice(0, 5)}…`);
  assert.match(readFileSync(join(runDir('r2'), 'report.html'), 'utf8'), /\[redacted\]/);
  // Open-ended prose the masks miss: refused with file:line, the value never printed; --i-checked stores it.
  const odd = 'Q7vSynthOdd!x2';
  writeFileSync(notes, `## Ops\nThe staging otp is ${odd} for now.\n`);
  const r = cli('report', 'r2', '--file', notes);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /report refused: r3\.md:2 still looks like a credential/);
  assert.ok(!(r.stdout + r.stderr).includes(odd));
  assert.ok(!leaks().includes(odd));
  writeFileSync(notes, '## Ops\nThe token now expires after 15 minutes (docs/RELEASE.md).\n');
  run('report', 'r2', '--file', notes); // prose about a token is not refused
  writeFileSync(notes, '## Ops\nThe otp is Q7vSynthOdd!x2-changed in the sandbox only.\n');
  run('report', 'r2', '--file', notes, '--i-checked');
});

test('round 4: the closed rule refuses a credential word with a value nearby, never a file:line after "otp", and the page states the rule', () => {
  const notes = join(root, 'r4.md');
  writeFileSync(notes, '## Changes\n- The code now expires after 15 minutes (see `backend/src/services/shared/otp.service.ts:415`).\n- `password_changed_at` added in `drizzle/0119_x.sql`.\n');
  run('report', 'r2', '--file', notes);
  writeFileSync(notes, '## Ops\nThe kiosk PIN, for now, stays 48219930 until Monday.\n');
  const r = cli('report', 'r2', '--file', notes);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /r4\.md:2/);
  assert.ok(!(r.stdout + r.stderr).includes('48219930'));
  run('init', 'r5', '--goal', 'g', '--bar', 'b', '--fence', 'f');
  assert.match(readFileSync(join(runDir('r5'), 'report.html'), 'utf8'), /Release notes never carry credentials, tokens or one-time codes\. Name the setting \(e\.g\. API_TOKEN\), never its value\./);
});

test('the closed rule shows beside stored notes too; a code word with a value is refused', () => {
  const notes = join(root, 'r6.md');
  writeFileSync(notes, '## Changes\n- Payouts settle once.\n');
  run('report', 'r5', '--file', notes);
  const html = readFileSync(join(runDir('r5'), 'report.html'), 'utf8');
  assert.match(html, /class="report-rule"><b>Release notes never carry credentials/);
  assert.match(html, /Payouts settle once/);
  writeFileSync(notes, '## Ops\nThe sandbox code stays 55720123 for testers.\n');
  const r = cli('report', 'r5', '--file', notes);
  assert.notEqual(r.status, 0);
  assert.ok(!(r.stdout + r.stderr).includes('55720123'));
});

const view = (over = {}) => ({ id: 'r', repo: 'o/r', phase: 'closed: done', open: false, units: [{ id: 'u1', title: 'Payouts settle once', status: 'pass', links: [{ kind: 'pr', url: 'https://github.com/o/r/pull/7' }, { kind: 'merge', url: 'https://github.com/o/r/commit/abc1234' }] }, { id: 'u2', title: 'Copy', status: 'stopped', links: [] }], ...over });
const ids = (html) => [...html.matchAll(/data-d="([^"]+)" data-a="panel-/g)].map((x) => x[1]);
const draftData = (over = {}) => ({ at: '2026-11-15T10:00:00Z', changes: [], diffs: [], files: [], migrations: [], scripts: [], env: [], jobs: [], copy: [], ...over });

test('report page: the shared shell, KPI row and panels for every section it had; Copy only on the live page, Download always', () => {
  const d = draftData({ diffs: [{ unit: 'u2', ok: false, why: 'no recorded diff' }], files: ['src/a.js'], migrations: [{ path: 'drizzle/1.sql', unit: 'u1' }] });
  const html = reportPage(view(), Date.now(), null, { report: { text: '## r\n### Fixed\n- x (#7)', at: '2026-11-15T10:00:00Z', source: 'n.md' }, draft: d, quality: null });
  assert.match(html, /<div class="head"><h1>Report<\/h1>/);
  assert.match(html, /<div class="kpis">/);
  assert.deepEqual(ids(html), ['changes', 'notes', 'files', 'devops', 'quality']);
  assert.match(html, /<details class="panel" data-d="devops" data-a="panel-devops">/); // starts closed
  assert.match(html, /<h4 class="md">Fixed<\/h4>/);
  assert.match(html, /<span class="lbl">Migrations added <span class="chip">1<\/span>/); assert.match(html, /<span class="lbl">Scripts added <span class="chip">0<\/span>/); // per-section counts
  assert.match(html, /drizzle\/1\.sql/); assert.match(html, /Not read from git: u2/); assert.match(html, /Not measured yet/);
  assert.match(html, /<a class="btn sm" download="report-r\.md"/);
  assert.doesNotMatch(html, /data-copy|<script/);
  const live = reportPage(view(), Date.now(), liveCtx({ ...staticCtx('', 0), token: 't' }, 'r'), { report: { text: 'x', at: 'a' } });
  assert.match(live, /data-copy>Copy Markdown<\/button>/);
  assert.match(live, /<a href="[^"]*u1[^"]*">u1<\/a>/); // the unit links
  // The breadcrumb is the run pages' own: This PC, the project, the run, then Report.
  assert.match(reportPage(view(), Date.now(), { ...staticCtx('', 0), pc: { label: 'This PC', href: '/pc' }, project: 'proj' }, {}),
    /<nav class="crumbs"[^>]*>[\s\S]*?<a href="\/pc">This PC<\/a><span class="sep"[^>]*>\/<\/span><span>proj<\/span><span class="sep"[^>]*>\/<\/span><a href="hud\.html">r<\/a><span class="sep"[^>]*>\/<\/span><span class="here" aria-current="location">Report<\/span>/);
  // A PR linked again on a later try counts once.
  const twice = view({ units: [{ id: 'u1', status: 'pass', links: [{ kind: 'pr', url: 'https://github.com/o/r/pull/7' }, { kind: 'pr', url: 'https://github.com/o/r/pull/7' }, { kind: 'merge', url: 'https://github.com/o/r/commit/abc1234' }] }] });
  assert.match(reportPage(twice, Date.now(), null, {}), /<span class="k">Pull requests<\/span><span class="v">1<\/span><span class="s">1 merged<\/span>/);
  const bare = reportPage(view({ units: [] }), Date.now(), null, {});
  assert.match(bare, /Not written yet/); assert.match(bare, /No units\./); assert.match(bare, /download="report-r\.md"/); // no notes and no draft: both buttons export the not-written state
});

test('report page: Files the run changed, by file with the units that changed each, and by unit with each unit\'s count and paths', () => {
  const changes = [
    { unit: 'u1', status: 'pass', files: 2, paths: ['src/a.js', 'src/b.js'] },
    { unit: 'u2', status: 'stopped', files: 1, paths: ['src/a.js'] },
    { unit: 'u3', status: 'open', files: 0, paths: [] },
  ];
  const html = reportPage(view(), Date.now(), null, { draft: draftData({ changes, files: ['src/a.js', 'src/b.js'] }) });
  const panel = html.slice(html.indexOf('data-d="files"'), html.indexOf('data-d="devops"'));
  assert.match(panel, /<th scope="col">File<\/th><th scope="col">Units<\/th>/);
  assert.match(panel, /<span class="mono">src\/a\.js<\/span><\/td><td><a href="units\/u1\.html">u1<\/a>, <a href="units\/u2\.html">u2<\/a><\/td>/);
  assert.match(panel, /<span class="mono">src\/b\.js<\/span><\/td><td><a href="units\/u1\.html">u1<\/a><\/td>/);
  assert.match(panel, /<summary>By unit · 2<\/summary>/); // u3 changed nothing: not listed
  assert.match(panel, /<td><a href="units\/u1\.html">u1<\/a><\/td><td class="num">2<\/td><td><span class="mono">src\/a\.js<\/span><br><span class="mono">src\/b\.js<\/span><\/td>/);
  assert.match(panel, /<td><a href="units\/u2\.html">u2<\/a><\/td><td class="num">1<\/td>/);
  // A draft stored before per-unit paths: the counts, and how to get the paths.
  const old = reportPage(view(), Date.now(), null, { draft: draftData({ changes: [{ unit: 'u1', status: 'pass', files: 3 }], files: ['src/a.js'] }) });
  assert.match(old, /<td class="num">3<\/td><td><span class="muted">not stored; run\.mjs report --draft again<\/span>/);
});

test('report markdown: the stored notes, else the draft from git', () => {
  assert.equal(reportMarkdown(view(), { report: { text: 'stored' }, draft: {} }), 'stored');
  assert.match(reportMarkdown(view(), { draft: draftData() }), /^## r · 2026-11-15/);
  assert.match(reportMarkdown(view(), {}), /^# Report · r\n\nNot written yet\./);
});

test('retro: repeated gaps group a gap raised in two or more rounds by cause, then wording; the checklist reads the run', () => {
  const rd = (gap, cause) => ({ verdict: 'fail', gap, cause });
  const s = { id: 'r', tag: 'code', budget: { maxRounds: 4, maxMinutes: 60, maxUnits: 6 }, notes: [{ kind: 'retro', text: 'u2 stopped: needs the person. Tokens by role measured', at: 'a' }],
    units: [{ id: 'u1', status: 'pass', rounds: [rd('lock stays held', 'lock release'), rd('other words', 'lock release'), { verdict: 'pass' }] }, { id: 'u2', status: 'stopped', stopReason: 'budget', rounds: [rd('a one-off', 'x')] }, { id: 'u3', status: 'pass', rounds: [rd('lock still held', 'Lock  Release'), {}] }] };
  assert.deepEqual(repeatedGaps(s), [{ gap: 'lock stays held', cause: 'lock release', units: ['u1', 'u3'], rounds: 3 }]);
  const m = retroModel(s);
  assert.deepEqual(m.checklist.map((c) => [c.label, c.done]), [['Retro notes', true], ['Repeated gaps', false], ['Stopped units', true], ['Run closed', false]]);
  const withLesson = retroModel(s, { lessons: [{ id: 'L1', tag: 'code', text: 't', from: ['r'], seen: 1 }] });
  assert.equal(withLesson.checklist[1].done, true);
  // A stopped unit without a recorded reason leaves the item open; with none stopped the item is dropped, and nothing guesses at spend.
  const noReason = retroModel({ ...s, units: [{ id: 'u2', status: 'stopped', rounds: [] }] });
  assert.equal(noReason.checklist.find((c) => c.label === 'Stopped units').done, false);
  assert.equal(retroModel({ ...s, units: [{ id: 'u1', status: 'pass', rounds: [] }] }).checklist.some((c) => c.label === 'Stopped units'), false);
  assert.equal(m.checklist.some((c) => /spend/i.test(c.label)), false);
});

test('retro budget: the Units row shows the cap as the budget and the count as used', () => {
  const s = { id: 'r', tag: 'code', budget: { maxRounds: 4, maxMinutes: 60, maxUnits: 6 }, notes: [], units: [{ id: 'u1', status: 'pass', rounds: [] }, { id: 'u2', status: 'pass', rounds: [] }] };
  const m = retroModel(s);
  assert.equal(m.budget.units, 6); assert.equal(m.budget.usedUnits, 2);
  assert.match(retroPage(m, view(), Date.now(), null, false), /<td[^>]*>Units<\/td>\s*<td[^>]*>6<\/td>\s*<td[^>]*>2<\/td>/);
  assert.match(retroPage(retroModel({ ...s, budget: { maxRounds: 4, maxMinutes: 60 } }), view(), Date.now(), null, false), /<td[^>]*>Units<\/td>\s*<td[^>]*>–<\/td>\s*<td[^>]*>2<\/td>/); // no maxUnits: a dash, not "undefined"
});

test('retro page: shared shell, KPI row and the panels, links to units, Download always and Copy only live', () => {
  const s = { id: 'r', tag: 'code', budget: { maxRounds: 4, maxMinutes: 60, maxUnits: 6 }, notes: [{ kind: 'retro', text: 'Repeated gap: dates', at: 'a' }, { kind: 'retro', text: 'upstream: fix #3', at: 'b' }, { kind: 'escape', unit: 'u1', round: 2, text: 'missed', at: 'c' }],
    units: [{ id: 'u1', status: 'pass', rounds: [{ verdict: 'fail', gap: 'dates differ', cause: 'clock' }, { verdict: 'fail', gap: 'dates differ', cause: 'clock' }, {}] }, { id: 'u2', status: 'stopped', stopReason: 'round budget', rounds: [] }] };
  const m = retroModel(s, { lessons: [{ id: 'L1', tag: 'code', text: 'Use the clock', from: ['r'], seen: 2, scope: 'project' }] });
  const html = retroPage(m, view(), Date.now(), null, false);
  assert.match(html, /<div class="head"><h1>Retro<\/h1>/);
  assert.match(html, /<div class="kpis">/);
  assert.deepEqual(ids(html), ['budget', 'notes', 'lessons', 'gaps', 'stopped', 'spend', 'checklist', 'upstream', 'staffing', 'escapes']);
  for (const [id, closed] of [['gaps', true], ['stopped', true], ['escapes', true], ['budget', false], ['lessons', false]]) assert.equal(new RegExp(`data-d="${id}"[^>]*\\sopen`).test(html), !closed, id);
  assert.match(html, /Use the clock/); assert.match(html, /dates differ/); assert.match(html, /round budget/);
  assert.match(html, /<a class="mono" href="[^"]*u2[^"]*">u2<\/a>/);
  assert.match(html, /download="retro-r\.md"/); assert.doesNotMatch(html, /data-copy/);
  assert.match(retroPage(m, view(), Date.now(), { ...staticCtx('', 0), pc: { label: 'This PC', href: '/pc' } }, false), /<a href="\/pc">This PC<\/a>[\s\S]*?<a href="hud\.html">r<\/a>[\s\S]*?<span class="here" aria-current="location">Retro<\/span>/, 'the run pages\' breadcrumb');
  assert.match(retroPage(m, view(), Date.now(), liveCtx({ ...staticCtx('', 0), token: 't' }, 'r'), true), /data-copy>Copy Markdown[\s\S]*Retro pending/);
  const md = retroMarkdown(m);
  assert.match(md, /^# Retro · r\n\n## Budget\n- Tries per unit: 3 of 4/);
  assert.match(md, /## Repeated gaps\n- dates differ \(u1; 2 rounds\)/); assert.match(md, /## Stopped units\n- u2: round budget/);
});

// Run hud-followups f2 (B3): the canvas's Spend and Staffing panels, and budget rows the run records.
test('retro: Spend per agent kind and per unit from launch figures, Staffing from critic setups, time and review minutes used', () => {
  const T = (min) => new Date(Date.parse('2026-01-01T00:00:00Z') + min * 60_000).toISOString();
  const s = { id: 'r', tag: 'code', createdAt: T(0), closed: { outcome: 'done', at: T(120) }, budget: { maxRounds: 4, maxMinutes: 240, maxUnits: 6 }, notes: [{ kind: 'escape', unit: 'u1', text: 'missed', at: T(130) }],
    units: [
      { id: 'u1', status: 'pass', log: [{ kind: 'start', at: T(0) }, { kind: 'built', at: T(30) }, { kind: 'start', at: T(50) }, { kind: 'built', at: T(70) }],
        rounds: [{ n: 1, verdict: 'fail', gap: 'g', critic: 'general, opus, full depth', at: T(40), builtBy: 'opus' }, { n: 2, verdict: 'pass', critic: 'general, sonnet, delta review', at: T(90), builtBy: 'sonnet', specialists: { security: { verdict: 'pass', critic: 'security, opus' } } }],
        costs: [{ step: 'start', role: 'builder', tokensIn: 600_000, minutes: 50, at: T(0) }, { step: 'verdict', role: 'critic', tokensIn: 300_000, minutes: 30, at: T(40) }, { step: 'verdict', role: 'critic:security', tokensIn: 100_000, at: T(90), cost: { amount: 1.25, currency: 'USD' } }] },
      { id: 'u2', status: 'stopped', stopReason: 'budget', rounds: [] },
    ] };
  const m = retroModel(s);
  assert.deepEqual(m.spend.byKind.map((g) => [g.label, g.tokensIn, g.share]), [['Builders', 600_000, 60], ['General critics', 300_000, 30], ['Specialist critics', 100_000, 10]]);
  assert.deepEqual(m.staffing.critics.map((g) => [g.critic, g.setup, g.rounds, g.passed, g.escapes]), [['general', 'general, opus, full depth', 1, 0, 0], ['general', 'general, sonnet, delta review', 1, 1, 1], ['security', 'security, opus', 1, 1, null]]);
  assert.equal(m.budget.usedMinutes, 120); assert.equal(m.budget.reviewMedian, 10, 'reviews took 10 and 20 minutes: the median is the lower middle');
  const html = retroPage(m, view(), Date.now(), null, false);
  const panelOf = (id) => { const i = html.indexOf(`data-d="${id}"`); assert.ok(i > 0, id); return html.slice(i, html.indexOf('</details>', i)); };
  const spend = panelOf('spend');
  assert.match(spend, /<span class="meta">1000k in tokens · 80 min · 1\.25 USD<\/span>/);
  assert.match(spend, /<tr data-a="spend-builder"><td>Builders<\/td><td class="num">600k<\/td><td class="num">–<\/td><td class="num">50<\/td><td class="num">–<\/td><td class="num">60%<\/td><\/tr>/);
  assert.match(spend, /<tr data-a="spend-specialist"><td>Specialist critics<\/td><td class="num">100k<\/td><td class="num">–<\/td><td class="num">–<\/td><td class="num">1\.25 USD<\/td><td class="num">10%<\/td><\/tr>/);
  assert.match(spend, /<tr data-a="spend-u-u1"><td><a class="mono" href="[^"]*u1[^"]*">u1<\/a><\/td><td class="num">1000k<\/td>/);
  assert.doesNotMatch(spend, /spend-u-u2/, 'a unit with no recorded launch is not listed as zero');
  const staffing = panelOf('staffing');
  assert.match(staffing, /<td>General<div class="cause">general, sonnet, delta review<\/div><\/td><td class="num">1<\/td><td class="num">1<\/td><td class="num">1<\/td>/);
  assert.match(staffing, /<td>Specialist security<div class="cause">security, opus<\/div><\/td><td class="num">1<\/td><td class="num">1<\/td><td class="num">–<\/td>/);
  assert.doesNotMatch(staffing, /min-width/, 'no min width: every column stays in view in the side column');
  assert.match(staffing, /Builder models: opus 0\/1 passed · sonnet 1\/1 passed/);
  assert.match(html, /<td>Time, minutes<\/td><td class="num">240<\/td><td class="num">120<\/td>/);
  assert.match(html, /<td>Review minutes per try<\/td><td class="num">–<\/td><td class="num">10<\/td>/);
  assert.match(html, /<td>Tokens in<\/td><td class="num">–<\/td><td class="num">1000k<\/td>/);
  // Nothing recorded: the panels say so, nothing is guessed.
  const bare = retroPage(retroModel({ id: 'r', tag: 'code', budget: { maxRounds: 4, maxMinutes: 60 }, notes: [], units: [{ id: 'u1', status: 'open', rounds: [] }] }), view(), Date.now(), null, false);
  assert.match(bare, /Not recorded: the lead passes --tokens-in, --minutes or --cost/); assert.match(bare, /No round judged yet\./);
  // Copy and Download carry the page's Spend and Staffing, and the time used.
  const md = retroMarkdown(m);
  assert.match(md, /- Time: 120 of 240 min used\n- Review minutes per try: 10 \(median\)\n/);
  assert.match(md, /## Spend\n- Total: 1000k in tokens · 80 min · 1\.25 USD\n\n### By agent kind\n- Builders: 600k in tokens · 50 min \(60% of tokens in\)\n- General critics: 300k in tokens · 30 min \(30% of tokens in\)\n- Specialist critics: 100k in tokens · 1\.25 USD \(10% of tokens in\)\n\n### By unit\n- u1: 1000k in tokens · 80 min · 1\.25 USD\n/);
  assert.doesNotMatch(md.slice(md.indexOf('## Spend'), md.indexOf('## Staffing')), /u2/, 'a unit with no recorded launch is not listed');
  assert.match(md, /## Staffing\n- General, general, opus, full depth: 1 rounds, 0 passed, 0 escapes\n- General, general, sonnet, delta review: 1 rounds, 1 passed, 1 escapes\n- Specialist security, security, opus: 1 rounds, 1 passed\n- Builder models: opus 0\/1 passed · sonnet 1\/1 passed$/);
  assert.match(retroMarkdown(retroModel({ id: 'r', tag: 'code', budget: { maxRounds: 4, maxMinutes: 60 }, notes: [], units: [{ id: 'u1', status: 'open', rounds: [] }] })), /## Spend\n- Total: not recorded\n\n## Staffing\n- No round judged yet\.$/);
});
