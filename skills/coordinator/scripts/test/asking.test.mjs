// How the lead asks: the blocking dialog by default, or dashboard first (references/commands/run.md, Asking).
// The run's intake answer wins over the project's setting, and `run.mjs ask` prints the mode in force.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isLeadStep } from '../lib/lead.mjs';
import { askingMode } from '../lib/questions.mjs';
import { checkSettings } from '../lib/settings.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'coord-asking-'));
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }));

let n = 0;
// A fresh project per test: its own state folder and settings file.
function project(settings) {
  const dir = join(tmp, `p${++n}`, '.coordinator');
  mkdirSync(dir, { recursive: true });
  if (settings) writeFileSync(join(dir, 'coordinator.json'), JSON.stringify(settings));
  const env = { ...process.env, COORDINATOR_DIR: dir, COORDINATOR_HOME: join(tmp, 'home') };
  // as(lead, …): the same step from the window whose lead id is `lead` (home.setup.mjs gives every test 'test-lead').
  const as = (lead, ...a) => {
    const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...a], { cwd: tmp, env: { ...env, COORDINATOR_LEAD: lead }, encoding: 'utf8' });
    let out = r.stdout; try { out = JSON.parse(r.stdout); } catch { /* text */ }
    return { code: r.status, out, err: r.stderr };
  };
  const run = (...a) => as(env.COORDINATOR_LEAD, ...a);
  run.as = as;
  assert.equal(run('init', 'r1', '--goal', 'g', '--bar', 'b', '--fence', 'f').code, 0);
  run.dir = dir;
  return run;
}
const ask = (run) => run('ask', 'r1', '--question', 'Merge the fix now?', '--header', 'Merge', '--option', 'Yes|merge it', '--option', 'No|leave it open');

test('askingMode: the run wins, then the project, else the dialog', () => {
  assert.deepEqual(askingMode({}, {}), { mode: 'dialog', from: 'default' });
  assert.deepEqual(askingMode({}, { asking: 'dashboard' }), { mode: 'dashboard', from: 'project' });
  assert.deepEqual(askingMode({ askMode: 'dialog' }, { asking: 'dashboard' }), { mode: 'dialog', from: 'run' });
  assert.deepEqual(askingMode({ askMode: 'dashboard' }, {}), { mode: 'dashboard', from: 'run' });
  assert.deepEqual(askingMode({ askMode: 'popup' }, { asking: 'chat' }), { mode: 'dialog', from: 'default' }, 'a value that is not a mode counts as unset');
});

test('the "asking" setting is checked: dialog or dashboard', () => {
  const problems = (s) => checkSettings(s, tmp).filter((p) => p.key === 'asking').map((p) => `${p.level}:${p.text}`);
  assert.deepEqual(problems({ asking: 'dialog' }), []);
  assert.deepEqual(problems({ asking: 'dashboard' }), []);
  assert.deepEqual(problems({ asking: 'chat' }), ['fail:asking must be dialog or dashboard']);
  assert.deepEqual(problems({ asking: true }), ['fail:asking must be dialog or dashboard']);
});

test('ask prints the dialog when nothing chose another mode', () => {
  const run = project();
  const r = ask(run);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.asked, 'q1');
  assert.deepEqual(r.out.asking, { mode: 'dialog', from: 'default' });
});

test('ask prints the project setting, and the run\'s intake answer wins over it', () => {
  const run = project({ asking: 'dashboard' });
  assert.deepEqual(ask(run).out.asking, { mode: 'dashboard', from: 'project' });
  const d = run('note', 'r1', '--kind', 'decision', '--text', 'Asking: the blocking dialog, the person\'s intake answer', '--asking', 'dialog');
  assert.equal(d.code, 0, d.err);
  assert.equal(d.out.asking, undefined, 'only ask prints the mode');
  assert.deepEqual(ask(run).out.asking, { mode: 'dialog', from: 'run' });
});

test('the intake answer is a decision note on the run, and a bad mode or kind is refused', () => {
  const run = project();
  assert.equal(run('note', 'r1', '--kind', 'decision', '--text', 'Asking: dashboard first', '--asking', 'dashboard').code, 0);
  assert.deepEqual(ask(run).out.asking, { mode: 'dashboard', from: 'run' });
  const note = JSON.parse(readFileSync(join(run.dir, 'runs', 'r1', 'state.json'), 'utf8')).notes.find((x) => x.kind === 'decision');
  assert.deepEqual([note.text, note.asking, note.unit], ['Asking: dashboard first', 'dashboard', undefined]);
  const bad = run('note', 'r1', '--kind', 'decision', '--text', 't', '--asking', 'popup');
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /--asking must be one of: dialog, dashboard/);
  const info = run('note', 'r1', '--kind', 'info', '--text', 't', '--asking', 'dialog');
  assert.notEqual(info.code, 0);
  assert.match(info.err, /--asking goes with --kind decision/);
  assert.deepEqual(ask(run).out.asking, { mode: 'dashboard', from: 'run' }, 'a refused note changes nothing');
});

test('note --asking is a lead step: refused from another window, naming the lead; every other note is a worker step', () => {
  assert.equal(isLeadStep('note', { kind: 'decision', asking: 'dashboard' }), true);
  assert.equal(isLeadStep('note', { kind: 'decision' }), false);
  assert.equal(isLeadStep('note', { kind: 'info' }), false);
  assert.equal(isLeadStep('add', {}), true);
  assert.equal(isLeadStep('beat', { asking: 'dialog' }), false, 'only note has a lead form');
  const run = project();
  const other = (...a) => run.as('other-window', ...a);
  const dir = run.dir;
  const state = () => JSON.parse(readFileSync(join(dir, 'runs', 'r1', 'state.json'), 'utf8'));
  // r1's lead is test-lead (init claimed it). Another window's --asking note is refused like any other lead step.
  const before = JSON.stringify(state());
  const r = other('note', 'r1', '--kind', 'decision', '--text', 'Asking: dashboard first', '--asking', 'dashboard');
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /run r1 is led by another window (.+, last active .+); leave its lead steps to it. .*run.mjs lead r1 --takeover --reason R/);
  assert.match(r.err, /pass the --lead id its claim printed/, 'and says how the lead itself passes its id');
  assert.equal(JSON.stringify(state()), before, 'nothing written');
  assert.deepEqual(ask(run).out.asking, { mode: 'dialog', from: 'default' }, 'the mode in force is unchanged');
  // --takeover on that note never takes an active lead.
  assert.equal(other('note', 'r1', '--kind', 'decision', '--text', 't', '--asking', 'dashboard', '--takeover').code, 1);
  // Every other note from that window is a worker step and is written.
  for (const k of ['decision', 'info', 'situation']) {
    const n = other('note', 'r1', '--kind', k, '--text', `agent note (${k})`);
    assert.equal(n.code, 0, `${k}: ${n.err}`);
  }
  assert.equal(state().notes.filter((x) => x.text.startsWith('agent note')).length, 3);
  // --lead and --takeover belong to the lead form only.
  const plain = other('note', 'r1', '--kind', 'info', '--text', 't', '--lead', 'test-lead');
  assert.equal(plain.code, 1); assert.match(plain.err, /--lead and --takeover go with --asking: any other note is a worker step/);
  // The lead itself sets it, and so does a window that passes the lead's id.
  assert.equal(run('note', 'r1', '--kind', 'decision', '--text', 'Asking: dashboard first', '--asking', 'dashboard').code, 0);
  assert.deepEqual(ask(run).out.asking, { mode: 'dashboard', from: 'run' });
  const passed = other('note', 'r1', '--kind', 'decision', '--text', 'Asking: the dialog', '--asking', 'dialog', '--lead', 'test-lead');
  assert.equal(passed.code, 0, passed.err);
  assert.deepEqual(ask(run).out.asking, { mode: 'dialog', from: 'run' });
});
