// Every question names its project, run and task, from one label the script builds
// (lib/questions.mjs questionLabel; design one-boss 5.3): in `ask`, `questions`, `show`,
// the run's dashboard, its unit pages, and the read-only /run/… and /p/… pages.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runSync } from './inproc.mjs';
import { projectPage } from '../lib/dashboard.mjs';
import { projectName, questionLabel, questions, runName } from '../lib/questions.mjs';
import { readRegistry } from '../lib/registry.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'coord-qlabel-'));
const home = join(tmp, 'home');
const stateDir = join(tmp, 'payday-web-nextjs', '.coordinator');
mkdirSync(stateDir, { recursive: true });
const env = { ...process.env, COORDINATOR_DIR: stateDir, COORDINATOR_HOME: home };
const children = [];
// Windows keeps the folder busy until the served child has exited.
after(async () => {
  await Promise.all(children.map((c) => (c.exitCode !== null ? null : new Promise((ok) => { c.once('exit', ok); c.kill(); }))));
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
});

const run = (...a) => {
  const r = runSync(a, { cwd: tmp, env });
  let out = r.stdout; try { out = JSON.parse(r.stdout); } catch { /* text */ }
  return { code: r.status, out, err: r.stderr };
};
const ask = (r, ...extra) => run('ask', r, '--question', 'Show the card on mobile?', '--header', 'Mobile', '--option', 'Yes|as designed', '--option', 'No|desktop only', ...extra);
const RUN = 'payday-fi-1426';
const WHOLE = `payday-web-nextjs · Financial Insights (${RUN})`;
const TASK = `${WHOLE} › Task u2: Payout summary card`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const labelLine = (label) => `<p class="qlabel" title="Which run and task this question comes from">${esc(label)}</p>`;

test('the label: project, run name (alias, else goal clipped) and id, then the task by id and title (else bar)', () => {
  const s = { id: 'r9', goal: 'Make the monthly totals match the bank statement on every account page', units: [{ id: 'u1', bar: 'totals test green' }, { id: 'u2', title: 'Payout card', bar: 'b' }] };
  assert.equal(runName(s), 'Make the monthly totals match the bank …', 'the goal, clipped to 40');
  assert.equal(questionLabel(s, null, 'payday'), 'payday · Make the monthly totals match the bank … (r9)');
  assert.equal(questionLabel(s, 'u1', 'payday'), 'payday · Make the monthly totals match the bank … (r9) › Task u1: totals test green', 'no title: the bar');
  assert.equal(questionLabel({ ...s, alias: 'Totals' }, 'u2', 'payday'), 'payday · Totals (r9) › Task u2: Payout card', 'the alias beats the goal');
  assert.equal(projectName(join('D:', 'projects', 'payday', '.coordinator')), 'payday', 'the folder that holds .coordinator/');
  assert.equal(projectName(join(tmp, 'shared-state')), 'shared-state', 'COORDINATOR_DIR naming another folder: that folder');
});

test('the label is masked and carries no control or direction characters', () => {
  const token = `ghp_${'a1B2'.repeat(9)}`;
  const s = { id: 'r9', alias: `Totals ${token}`, goal: 'g', units: [{ id: 'u1', title: 'Card\u0007 ‮gnp.exe‬\nnext', bar: 'b' }] };
  const label = questionLabel(s, 'u1', 'pro\u0000ject');
  assert.ok(!label.includes(token), 'the token is masked');
  assert.match(label, /\[redacted\]/);
  assert.doesNotMatch(label, /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
  assert.equal(label, 'pro ject · Totals [redacted] (r9) › Task u1: Card gnp.exe next');
  assert.equal(questions({ ...s, notes: [{ kind: 'question', text: 'q?', unit: 'u1', options: [], history: [] }] }, { project: 'p' })[0].label, questionLabel(s, 'u1', 'p'), 'questions() carries the same label');
});

test('run.mjs ask returns the label, with the task only for a question on a unit; questions and show carry it', () => {
  assert.equal(run('init', RUN, '--alias', 'Financial Insights', '--goal', 'Insights page for payday', '--bar', 'b', '--fence', 'f').code, 0);
  assert.equal(run('add', RUN, 'u1', '--bar', 'totals test green').code, 0);
  assert.equal(run('add', RUN, 'u2', '--bar', 'card renders', '--title', 'Payout summary card').code, 0);
  assert.equal(run('freeze', RUN).code, 0);
  const whole = ask(RUN);
  assert.equal(whole.code, 0, whole.err);
  assert.equal(whole.out.asked, 'q1');
  assert.equal(whole.out.label, WHOLE, 'a question on the whole run: no task');
  const onUnit = ask(RUN, '--unit', 'u2');
  assert.equal(onUnit.out.label, TASK);
  const qs = run('questions', RUN).out;
  assert.deepEqual(qs.map((q) => q.label), [WHOLE, TASK]);
  const state = JSON.parse(readFileSync(join(stateDir, 'runs', RUN, 'state.json'), 'utf8'));
  assert.ok(state.notes.every((n) => n.label === undefined), 'built when read, never stored or typed');
  const show = run('show', RUN).out;
  assert.ok(show.includes(`needs you  ${WHOLE}\n           q1: Show the card on mobile?`), show);
  assert.ok(show.includes(`           ${TASK}\n           q2: Show the card on mobile?`), show);
});

test('the run dashboard and the unit page show the label above each question, open and answered', () => {
  const hud = readFileSync(join(stateDir, 'runs', RUN, 'hud.html'), 'utf8');
  assert.ok(hud.includes(`<li class="q" id="q1" data-a="q-q1">${labelLine(WHOLE)}`), 'Needs you: q1');
  assert.ok(hud.includes(`<li class="q" id="q2" data-a="q-q2">${labelLine(TASK)}`), 'Needs you: q2');
  const card = hud.slice(hud.indexOf('data-a="list-Questions"'));
  assert.ok(card.includes(`${labelLine(WHOLE)}q1: Show the card on mobile?`) && card.includes(`${labelLine(TASK)}q2: Show the card on mobile?`), 'the Questions card');
  const unit = readFileSync(join(stateDir, 'runs', RUN, 'units', 'u2.html'), 'utf8');
  assert.ok(unit.includes(labelLine(TASK)), 'the unit page');
  assert.equal(run('answer', RUN, 'q2', '--choice', 'Yes').code, 0);
  assert.equal(run('use-answer', RUN, 'q2').code, 0);
  const done = readFileSync(join(stateDir, 'runs', RUN, 'hud.html'), 'utf8');
  assert.ok(done.includes(`<li data-a="aq-q2">${labelLine(TASK)}<b>q2</b>`), 'an answered question keeps its label');
});

test('the read-only /p/<key>/run/… pages name the run\'s own project', () => {
  const e = readRegistry({ home }).find((x) => x.run === RUN);
  assert.ok(e, 'the run is registered');
  const live = { token: 't', nonce: 'n' };
  const nav = { path: '/', label: 'This PC', href: '/?t=t' };
  const page = projectPage(`/p/${e.key}/run/${RUN}`, live, [e], nav);
  assert.ok(page.includes(labelLine(WHOLE)) && page.includes(labelLine(TASK)), 'the run page');
  assert.ok(projectPage(`/p/${e.key}/run/${RUN}/unit/u2`, live, [e], nav).includes(labelLine(TASK)), 'the unit page');
});

test('the served /run/<other> page shows the same label', async () => {
  assert.equal(run('init', 'other', '--goal', 'another run', '--bar', 'b', '--fence', 'f').code, 0);
  const c = spawn(process.execPath, [join(scripts, 'run.mjs'), 'serve', 'other'], { cwd: tmp, env });
  children.push(c);
  const url = await new Promise((ok, fail) => {
    let buf = '';
    c.stdout.on('data', (d) => { buf += d; const m = /"url":\s*"([^"]+)"/.exec(buf); if (m) ok(m[1]); });
    c.on('exit', () => fail(new Error('serve exited')));
  });
  const u = new URL(url);
  const html = await (await fetch(`${u.origin}/run/${RUN}${u.search}`)).text();
  assert.ok(html.includes(labelLine(WHOLE)) && html.includes(labelLine(TASK)), 'another run of this folder, read-only');
  const unit = await (await fetch(`${u.origin}/run/${RUN}/unit/u2${u.search}`)).text();
  assert.ok(unit.includes(labelLine(TASK)), 'its unit page');
});
