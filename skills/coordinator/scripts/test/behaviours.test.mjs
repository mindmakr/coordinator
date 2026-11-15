// Behaviour text is never cut (#128): over 500 characters is refused with the
// limit, the length and "split it"; at 500 or fewer it is stored and briefed whole.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runSync } from './inproc.mjs';
import { behave, TEXT_MAX } from '../lib/behaviours.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'coordinator-behaviours-'));
after(() => rmSync(dir, { recursive: true, force: true }));
function cli(...args) {
  const r = runSync(args, { env: { ...process.env, COORDINATOR_DIR: dir } });
  let out = null; try { out = JSON.parse(r.stdout || 'null'); } catch { out = r.stdout; }
  return { code: r.status, out, err: r.stderr };
}
const ok = (...a) => { const r = cli(...a); assert.equal(r.code, 0, `${a.join(' ')}: ${r.err}`); return r.out; };
const state = (run) => JSON.parse(readFileSync(join(dir, 'runs', run, 'state.json'), 'utf8'));

// The issue's case: a long behaviour that ended mid-sentence ("… and there is no 60-day rule. Settled ").
const sentence = 'Given a payslip with an advance, when the month closes, then the advance is settled from that month and there is no 60-day rule. ';
const long = (sentence.repeat(5) + 'Settled advances show on the next payslip.').trim();
const at500 = ('Given a full line, when it is stored, then it is kept whole' + ' and kept'.repeat(60)).slice(0, 499) + '.';
const refusal = (n) => new RegExp(`behaviour text is ${n} characters, over the 500 limit: split it into two behaviours`);

test('the limit is 500 and the fixtures sit either side of it', () => {
  assert.equal(TEXT_MAX, 500);
  assert.ok(long.length > 500, `long is ${long.length}`);
  assert.equal(at500.length, 500);
});

test('behave refuses text over 500 characters, names the limit and the length, and stores nothing', () => {
  const s = { goalBehaviours: [] };
  const unit = { id: 'a', status: 'open', behaviours: [{ id: 'B1', text: 'old words', status: 'pass', evidence: 'e' }] };
  assert.throws(() => behave(s, unit, { text: long }), refusal(long.length));
  assert.throws(() => behave(s, unit, { id: 'B1', text: long }), refusal(long.length));
  assert.throws(() => behave(s, null, { text: long }), refusal(long.length));
  assert.deepEqual(unit.behaviours, [{ id: 'B1', text: 'old words', status: 'pass', evidence: 'e' }]);
  assert.deepEqual(s.goalBehaviours, []);
});

test('behave stores text of 500 characters or fewer complete and unchanged', () => {
  const s = {};
  const unit = { id: 'a', status: 'open' };
  assert.equal(behave(s, unit, { text: at500 }), 'B1');
  assert.equal(unit.behaviours[0].text, at500);
  assert.equal(behave(s, null, { text: '  short goal line  ' }), 'G1');
  assert.equal(s.goalBehaviours[0].text, 'short goal line');
});

test('behave --text, behave --goal --text and add --behaviour refuse over 500 through the CLI and store nothing', () => {
  ok('init', 'long', '--goal', 'g', '--bar', 'the tests in test/x pass', '--fence', 'f');
  ok('add', 'long', 'a', '--bar', 'b', '--behaviour', 'Given x, when y, then z');
  const before = JSON.stringify(state('long'));

  for (const args of [['behave', 'long', 'a', '--text', long], ['behave', 'long', 'a', '--id', 'B1', '--text', long], ['behave', 'long', '--goal', '--text', long], ['add', 'long', 'b', '--bar', 'b', '--behaviour', long]]) {
    const r = cli(...args);
    assert.notEqual(r.code, 0, `${args.slice(0, 3).join(' ')} should fail`);
    assert.match(r.err, refusal(long.length));
  }
  assert.equal(JSON.stringify(state('long')), before, 'nothing stored');
  assert.equal(state('long').units.some((u) => u.id === 'b'), false, 'add left no unit behind');
});

test('a 500-character behaviour shows whole in behaviours and in the builder and critic briefs', () => {
  ok('init', 'full', '--goal', 'g', '--bar', 'the tests in test/x pass', '--fence', 'f');
  ok('add', 'full', 'a', '--bar', 'b', '--behaviour', at500);
  ok('behave', 'full', 'a', '--text', at500);
  ok('behave', 'full', '--goal', '--text', at500);
  const shown = ok('behaviours', 'full');
  assert.deepEqual(shown.units.a.map((b) => b.text), [at500, at500]);
  assert.deepEqual(shown.goal.map((b) => b.text), [at500]);
  for (const role of ['builder', 'critic']) {
    const brief = cli('brief', 'full', 'a', '--role', role);
    assert.equal(brief.code, 0, brief.err);
    const text = typeof brief.out === 'string' ? brief.out : JSON.stringify(brief.out);
    assert.ok(text.includes(`B1: ${at500}`) || text.includes(JSON.stringify(`B1: ${at500}`).slice(1, -1)), `${role} brief carries B1 whole`);
  }
});
