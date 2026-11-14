// The service tests never write to the person's run register, ~/.coordinator/registry.json
// (design 5.7): package.json loads the skill's test/home.setup.mjs, so this process and every
// run.mjs a test starts get a temporary COORDINATOR_HOME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { leadEnv } from '../src/demo/runs.mjs';
import { makeRun } from './helpers.mjs';

const home = process.env.COORDINATOR_HOME;
const norm = (p) => { const r = resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };

test('the tests run with a temporary COORDINATOR_HOME, never the real ~/.coordinator', () => {
  assert.ok(home, 'set by --import ../skills/coordinator/scripts/test/home.setup.mjs in package.json');
  assert.notEqual(norm(home), norm(join(homedir(), '.coordinator')));
  assert.ok(norm(home).startsWith(`${norm(tmpdir())}${process.platform === 'win32' ? '\\' : '/'}`), `${home} is in the temporary folder`);
});

test('a run.mjs started by the test helpers writes its register entry to that temporary home', () => {
  const id = `home-probe-${process.pid}`;
  makeRun(id);
  const reg = JSON.parse(readFileSync(join(home, 'registry.json'), 'utf8'));
  assert.ok(reg.runs.some((e) => e.run === id), 'the env reached run.mjs: its entry is in the temporary register');
});

test('the demo lead\'s run.mjs keeps the temporary home and never writes a register', () => {
  const env = leadEnv('/x/.coordinator');
  assert.equal(env.COORDINATOR_HOME, home);
  assert.equal(env.COORDINATOR_REGISTRY, 'off');
  assert.equal(env.COORDINATOR_DIR, '/x/.coordinator');
  assert.equal('COORDINATOR_HOME' in leadEnv('/x', { PATH: 'p' }), false, 'nothing set: nothing added');
});
