// How the lead asks: the blocking dialog by default, or dashboard first (references/commands/run.md, Asking).
// The run's intake answer wins over the project's setting, and `run.mjs ask` prints the mode in force.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
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
  const run = (...a) => {
    const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...a], { cwd: tmp, env, encoding: 'utf8' });
    let out = r.stdout; try { out = JSON.parse(r.stdout); } catch { /* text */ }
    return { code: r.status, out, err: r.stderr };
  };
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
