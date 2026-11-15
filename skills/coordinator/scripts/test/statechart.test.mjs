import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  buildStatechart,
  checkBarFeasibility,
  renderStatechartSvg,
  syncStatechartStatuses,
  verifyStateTransitions,
} from '../lib/statechart.mjs';
import { decide } from '../lib/rules.mjs';
import { unitPage } from '../lib/unitpage.mjs';
import { view } from '../lib/view.mjs';

const execFileAsync = promisify(execFile);
const RUN_MJS = realpathSync(new URL('../run.mjs', import.meta.url));
const HOME_SETUP = pathToFileURL(realpathSync(new URL('./home.setup.mjs', import.meta.url))).href;

function withTempWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'coord-statechart-'));
  const coordDir = join(dir, '.coordinator');
  mkdirSync(coordDir, { recursive: true });
  return { dir, coordDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function runCli(args, { cwd, coordDir, expectFail = false } = {}) {
  const env = { ...process.env, COORDINATOR_DIR: coordDir, COORDINATOR_REGISTRY: 'off', COORDINATOR_HARNESS: 'claude-code' };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['--import', HOME_SETUP, RUN_MJS, ...args], { cwd, env, timeout: 15_000 });
    if (expectFail) throw new Error(`Expected failure, got exit 0: ${stdout}`);
    return { code: 0, stdout, stderr };
  } catch (e) {
    if (!expectFail) throw new Error(`CLI failed (${args.join(' ')}): ${e.stderr || e.message}`);
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message };
  }
}

async function startJevServer(scoreMap) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const userContent = parsed.messages?.find((m) => m.role === 'user')?.content ?? '';
      const results = [];
      for (const [id, prob] of Object.entries(scoreMap)) {
        if (userContent.includes(`${id}:`) || Object.keys(scoreMap).length === 1) {
          results.push({ id, probability: prob, rationale: prob < 0.30 ? 'Requires shared state between unlinked parties' : 'Observable deterministic transition' });
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'cmpl-test',
        model: 'typesafe/jev-noul',
        choices: [{ message: { content: JSON.stringify({ results }) } }],
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { endpoint: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(r)) };
}

test('statecharts & Jev bar-feasibility pre-check (#160)', async (t) => {
  await t.test('B1: Jev noul feasibility < 0.30 flags impossible behaviour and halts freeze & start', async () => {
    const ws = withTempWorkspace();
    let srv;
    try {
      let score = 0.12;
      srv = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          const results = [{ id: 'B1', probability: score, rationale: score < 0.30 ? 'Exact-once across unlinked parties sharing no state is uncheckable' : 'Checkable via state store' }];
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'jev-1', model: 'typesafe/jev-noul', choices: [{ message: { content: JSON.stringify({ results }) } }] }));
        });
      });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const { port } = srv.address();
      writeFileSync(join(ws.coordDir, 'coordinator.json'), JSON.stringify({
        helpers: { provider: 'custom', endpoint: `http://127.0.0.1:${port}/v1`, models: { noul: 'typesafe/jev-noul' } },
      }));

      await runCli(['init', 'sc-b1', '--goal', 'Checkout flow', '--bar', 'State transitions hold', '--fence', 'src/'], { cwd: ws.dir, coordDir: ws.coordDir });
      await runCli([
        'add', 'sc-b1', 'u1',
        '--bar', 'Exact-once checkout',
        '--behaviour', 'Given unlinked nodes sharing no state, when payment executes, then exact-once delivery occurs',
      ], { cwd: ws.dir, coordDir: ws.coordDir });

      const frozenFail = await runCli(['freeze', 'sc-b1'], { cwd: ws.dir, coordDir: ws.coordDir, expectFail: true });
      assert.match(frozenFail.stderr, /< 0\.30/);
      assert.match(frozenFail.stderr, /B1 \(0\.12/);

      const stateAfterFail = JSON.parse(await (await import('node:fs/promises')).readFile(join(ws.coordDir, 'runs', 'sc-b1', 'state.json'), 'utf8'));
      assert.equal(Boolean(stateAfterFail.frozen), false, 'worktree/freeze must be halted on < 0.30');

      const startFail = await runCli(['start', 'sc-b1', 'u1'], { cwd: ws.dir, coordDir: ws.coordDir, expectFail: true });
      assert.match(startFail.stderr, /freeze|0\.30/i);

      score = 0.91;
      await runCli(['freeze', 'sc-b1'], { cwd: ws.dir, coordDir: ws.coordDir });
      await runCli(['start', 'sc-b1', 'u1'], { cwd: ws.dir, coordDir: ws.coordDir });
      const stateAfterPass = JSON.parse(await (await import('node:fs/promises')).readFile(join(ws.coordDir, 'runs', 'sc-b1', 'state.json'), 'utf8'));
      assert.equal(stateAfterPass.frozen, true);
      assert.ok(stateAfterPass.units[0].statechart.transitions.length >= 1);
      assert.match(stateAfterPass.units[0].statechart.textTable, /\| ID \| From \| Action \| To \| Status \|/);
    } finally {
      if (srv) await new Promise((r) => srv.close(r));
      ws.cleanup();
    }
  });

  await t.test('B2: unitPage renders accessible SVG statechart and table with status marks, IDs, titles, and XSS escaping', () => {
    const unit = {
      id: 'u-auth',
      title: 'Auth session <script>alert(1)</script>',
      bar: 'User logs in idle -> authenticated and logs out authenticated -> signed-out',
      status: 'open',
      rounds: [],
      behaviours: [
        { id: 'B1', text: 'When submitLogin runs, transitions from idle to authenticated', status: 'pass', evidence: 'ok' },
        { id: 'B2', text: 'When logout runs, transitions from authenticated to <img onerror=alert(1)>', status: 'fail', evidence: 'stuck' },
      ],
    };
    unit.statechart = buildStatechart(unit, { actions: ['submitLogin', 'logout'], states: ['idle', 'authenticated'] });
    syncStatechartStatuses(unit);

    const run = {
      id: 'r-sc',
      tag: 'test',
      goal: 'Auth',
      bar: 'Works',
      fence: 'src/',
      createdAt: '2026-11-15T12:00:00.000Z',
      budget: { maxRounds: 4, maxMinutes: 60, maxUnits: 5, maxAdded: 2 },
      units: [unit],
      notes: [],
    };
    const v = view(run, decide(run), Date.parse('2026-11-15T12:05:00.000Z'));
    const html = unitPage(v, 'u-auth', Date.parse('2026-11-15T12:05:00.000Z'));

    assert.match(html, /<svg class="statechart"/);
    assert.match(html, /role="img"/);
    assert.match(html, /✓\s*B1/);
    assert.match(html, /✕\s*B2/);
    assert.match(html, /\[pass\]/);
    assert.match(html, /\[fail\]/);
    assert.match(html, /stroke-dasharray="6 3"/, 'non-colour dash pattern differentiates states/edges');
    assert.match(html, /<table class="t"/);
    assert.match(html, /submitLogin/);
    assert.doesNotMatch(html, /<script>alert\(1\)/);
    assert.doesNotMatch(html, /<img onerror=/);
    const svgOnly = renderStatechartSvg(unit.statechart);
    assert.doesNotMatch(svgOnly, /<script>/);
  });

  await t.test('B3: verdict --reins-packet fails undeclared reins_state transitions with attached state evidence', async () => {
    const ws = withTempWorkspace();
    try {
      await runCli(['init', 'sc-b3', '--goal', 'Cart flow', '--bar', 'Only declared cart transitions happen', '--fence', 'src/'], { cwd: ws.dir, coordDir: ws.coordDir });
      const explicitChart = JSON.stringify({
        states: [
          { id: 'empty', title: 'Empty Cart', kind: 'initial' },
          { id: 'has-items', title: 'Has Items', kind: 'state' },
        ],
        transitions: [
          { id: 'B1', from: 'empty', to: 'has-items', action: 'addItem', title: 'Adding an item populates the cart' },
        ],
      });
      await runCli([
        'add', 'sc-b3', 'u1',
        '--bar', 'Cart moves empty -> has-items',
        '--behaviour', 'Given an empty cart, when addItem runs, then cart state moves from empty to has-items',
        '--statechart', explicitChart,
      ], { cwd: ws.dir, coordDir: ws.coordDir });
      await runCli(['freeze', 'sc-b3', '--skip-feasibility'], { cwd: ws.dir, coordDir: ws.coordDir });
      await runCli(['start', 'sc-b3', 'u1', '--skip-feasibility'], { cwd: ws.dir, coordDir: ws.coordDir });
      await runCli(['built', 'sc-b3', 'u1', '--report', 'built cart'], { cwd: ws.dir, coordDir: ws.coordDir });

      const badPacketPath = join(ws.dir, 'reins-bad-packet.json');
      writeFileSync(badPacketPath, JSON.stringify({
        schemaVersion: '1.0.0',
        snapshots: [
          { action: 'init', state: { cart: { status: 'empty', count: 0 } } },
          { action: 'rogueAction', state: { cart: { status: 'orphaned-refund', count: 1 } } },
        ],
      }));

      await runCli([
        'verdict', 'sc-b3', 'u1', 'pass',
        '--score', '9',
        '--evidence', 'manual UI click',
        '--behaviour', 'B1=pass:looks ok',
        '--reins-packet', badPacketPath,
      ], { cwd: ws.dir, coordDir: ws.coordDir });

      const st = JSON.parse(await (await import('node:fs/promises')).readFile(join(ws.coordDir, 'runs', 'sc-b3', 'state.json'), 'utf8'));
      const u1 = st.units[0];
      assert.equal(u1.status, 'open', 'undeclared transition must fail unit back to open');
      assert.equal(u1.rounds[0].verdict, 'fail');
      assert.equal(u1.rounds[0].cause, 'undeclared state transition');
      assert.equal(u1.behaviours[0].status, 'fail');
      assert.match(u1.behaviours[0].evidence, /empty -> orphaned-refund/);
      assert.ok(u1.evidence.some((e) => /orphaned-refund/.test(e.text)), 'state evidence must be attached to unit evidence');

      // Pure verifyStateTransitions accepts valid transitions cleanly.
      const good = verifyStateTransitions(u1.statechart, {
        snapshots: [
          { action: 'init', state: { status: 'empty' } },
          { action: 'addItem', state: { status: 'has-items' } },
        ],
      });
      assert.equal(good.ok, true);
      assert.equal(good.undeclared.length, 0);
    } finally {
      ws.cleanup();
    }
  });

  await t.test('rejects symlinks and path traversal on --statechart and --reins-packet', async () => {
    const ws = withTempWorkspace();
    const outside = mkdtempSync(join(tmpdir(), 'outside-sc-'));
    try {
      await runCli(['init', 'sc-sec', '--goal', 'Sec', '--bar', 'Safe', '--fence', 'src/'], { cwd: ws.dir, coordDir: ws.coordDir });
      const outsideFile = join(outside, 'secret.json');
      writeFileSync(outsideFile, JSON.stringify({ transitions: [{ from: 'a', to: 'b' }] }));
      const symPath = join(ws.dir, 'link.json');
      try { symlinkSync(outsideFile, symPath); } catch { return; /* Windows unprivileged symlink skip */ }
      const err = await runCli([
        'add', 'sc-sec', 'u1',
        '--bar', 'Safe',
        '--behaviour', 'B1',
        '--statechart', 'link.json',
      ], { cwd: ws.dir, coordDir: ws.coordDir, expectFail: true });
      assert.match(err.stderr, /regular file|symlink/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      ws.cleanup();
    }
  });

  await t.test('checkBarFeasibility skips gracefully offline or unconfigured', async () => {
    const off = await checkBarFeasibility({ id: 'u1', bar: 'x', behaviours: [{ id: 'B1', text: 'y' }] }, { on: false, why: 'disabled' });
    assert.equal(off.ok, true);
    assert.equal(off.skipped, true);

    const offline = await checkBarFeasibility(
      { id: 'u1', bar: 'x', behaviours: [{ id: 'B1', text: 'y' }] },
      { on: true, provider: 'custom', endpoint: 'http://127.0.0.1:1/v1', models: { noul: 'typesafe/jev-noul' } },
      { askNoulFn: async () => ({ fallback: true, why: 'connect ECONNREFUSED' }) },
    );
    assert.equal(offline.ok, true);
    assert.equal(offline.fallback, true);
  });
});
