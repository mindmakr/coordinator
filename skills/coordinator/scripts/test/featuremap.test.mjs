import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { extractBarSurfaceRefs, findFeatureMap, validateBehavioursAgainstFeatureMap } from '../lib/featuremap.mjs';
import { buildMap } from '../lib/map/build.mjs';

const RUN_MJS = resolve('skills/coordinator/scripts/run.mjs');
const temps = [];

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'coord-fm-'));
  temps.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'app.js'), 'export function main() { return 1; }\n');
  writeFileSync(
    join(dir, 'feature-map.json'),
    JSON.stringify({
      version: 1,
      panels: ['invoice-panel', { id: 'checkout-summary', file: 'src/app.js' }],
      actions: ['applyCoupon', { name: 'submitOrder', consequential: true }],
      states: ['empty', 'applied', 'submitted'],
      routes: ['/checkout', { path: '/invoices', name: 'InvoicesPage' }],
    }),
  );
  return dir;
}

function cli(cwd, args) {
  return JSON.parse(
    execFileSync(process.execPath, [RUN_MJS, ...args], {
      cwd,
      env: { ...process.env, COORDINATOR_DIR: join(cwd, '.coordinator') },
      encoding: 'utf8',
    }),
  );
}

function cliFails(cwd, args) {
  let err;
  assert.throws(
    () => execFileSync(process.execPath, [RUN_MJS, ...args], {
      cwd,
      env: { ...process.env, COORDINATOR_DIR: join(cwd, '.coordinator') },
      encoding: 'utf8',
      stdio: 'pipe',
    }),
    (e) => {
      err = e;
      return true;
    },
  );
  return `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

describe('feature-map.json bar validation & map merge (#158)', () => {
  it('B1: rejects unregistered panel or action IDs in add, behave, and freeze with valid IDs listed', () => {
    const dir = makeProject();
    cli(dir, ['init', 'fm-run', '--goal', 'validate checkout UI contracts cleanly', '--bar', 'every panel renders totals with zero errors', '--fence', 'checkout flow only']);

    const addPanelErr = cliFails(dir, [
      'add', 'fm-run', 'u1',
      '--bar', 'verify <ReinsPanel id="ghost-panel"> renders cleanly',
      '--behaviour', 'invoice-panel shows totals accurately without overflow',
    ]);
    assert.match(addPanelErr, /unregistered panel "ghost-panel"/i);
    assert.match(addPanelErr, /valid panels: \[checkout-summary, invoice-panel\]/i);

    const addActionErr = cliFails(dir, [
      'add', 'fm-run', 'u1',
      '--bar', 'verify checkout panel renders cleanly',
      '--behaviour', 'running reins exec ghostAction updates discount',
    ]);
    assert.match(addActionErr, /unregistered action "ghostAction"/i);
    assert.match(addActionErr, /valid actions: \[applyCoupon, submitOrder\]/i);

    // Valid unit succeeds in add, then behave with unregistered panel fails
    cli(dir, [
      'add', 'fm-run', 'u1',
      '--bar', 'verify <ReinsPanel id="invoice-panel"> applies discount',
      '--behaviour', 'reins exec applyCoupon updates checkout total cleanly',
    ]);

    const behaveErr = cliFails(dir, [
      'behave', 'fm-run', 'u1',
      '--text', 'click panel "missing-modal" after action "ghostSave" completes',
    ]);
    assert.match(behaveErr, /unregistered panel "missing-modal"/i);

    // Manually tamper feature-map.json to remove applyCoupon so freeze catches stale bars
    writeFileSync(
      join(dir, 'feature-map.json'),
      JSON.stringify({ version: 1, panels: ['invoice-panel'], actions: ['submitOrder'] }),
    );
    const freezeErr = cliFails(dir, ['freeze', 'fm-run']);
    assert.match(freezeErr, /unregistered action "applyCoupon"/i);
    assert.match(freezeErr, /valid actions: \[submitOrder\]/i);
  });

  it('B2: accepts registered IDs and [new] / --new-surface surfaces, records surfaceContract, and merges into map.json', () => {
    const dir = makeProject();
    cli(dir, ['init', 'fm-ok', '--goal', 'validate checkout UI contracts cleanly', '--bar', 'every panel renders totals with zero errors', '--fence', 'checkout flow only']);

    // Marked [new] on unit bar allows introducing a brand-new panel and action across behaviours
    cli(dir, [
      'add', 'fm-ok', 'u1',
      '--bar', '[new] add <ReinsPanel id="promo-banner"> using reins exec applyCoupon',
      '--behaviour', 'new panel "promo-banner" shows discount badge on checkout-summary',
      '--behaviour', 'action "applyCoupon" updates promo state without console errors',
    ]);
    const stateAfterAdd = JSON.parse(readFileSync(join(dir, '.coordinator', 'runs', 'fm-ok', 'state.json'), 'utf8'));
    const u1 = stateAfterAdd.units.find((u) => u.id === 'u1');
    assert.ok(Array.isArray(u1.surfaceContract));
    assert.ok(u1.surfaceContract.some((c) => c.kind === 'panel' && c.id === 'promo-banner' && c.status === 'new'));
    assert.ok(u1.surfaceContract.some((c) => c.kind === 'action' && c.id === 'applyCoupon' && c.status === 'registered'));

    // Passing --new-surface on behave works for another unit; freeze preserves priorContract
    cli(dir, ['add', 'fm-ok', 'u2', '--bar', 'wire submitOrder on checkout-summary']);
    cli(dir, [
      'behave', 'fm-ok', 'u2',
      '--text', 'clicking action "confirmSplitPayment" submits split invoice cleanly',
      '--new-surface',
    ]);
    cli(dir, ['freeze', 'fm-ok']);
    const frozenState = JSON.parse(readFileSync(join(dir, '.coordinator', 'runs', 'fm-ok', 'state.json'), 'utf8'));
    assert.equal(frozenState.frozen, true);

    // Removing the surface-citing behaviour clears stale surfaceContract
    cli(dir, ['behave', 'fm-ok', 'u2', '--id', 'B1', '--remove', '--reason', 'dropping test surface behaviour']);
    const afterRemove = JSON.parse(readFileSync(join(dir, '.coordinator', 'runs', 'fm-ok', 'state.json'), 'utf8'));
    assert.equal(afterRemove.units.find((u) => u.id === 'u2').surfaceContract, undefined);

    const map = buildMap(dir, { maxSeconds: 10 });
    assert.equal(map.meta.featureMap.path, 'feature-map.json');
    assert.ok(map.surfaces.some((s) => s.kind === 'reins-action' && s.name === 'applyCoupon'));
    assert.ok(map.surfaces.some((s) => s.kind === 'reins-panel' && s.name === 'checkout-summary'));
    assert.ok(map.surfaces.some((s) => s.kind === 'reins-state' && s.name === 'submitted'));
    const invRoute = map.surfaces.find((s) => s.kind === 'route' && s.path === '/invoices');
    assert.ok(invRoute);
    assert.equal(invRoute.method, 'GET');
    assert.equal(invRoute.file, 'feature-map.json');
    assert.ok(Array.isArray(invRoute.services));

    // End-to-end `run.mjs map` renders mapPage HTML without crashing on feature-map routes
    cli(dir, ['map', 'fm-ok', '--root', dir]);
    const mapHtmlPath = join(dir, '.coordinator', 'runs', 'fm-ok', 'map.html');
    assert.equal(existsSync(mapHtmlPath), true);
    assert.match(readFileSync(mapHtmlPath, 'utf8'), /\/invoices/);
    const touched = cli(dir, ['touches', 'fm-ok', 'src/app.js', '--json']);
    assert.equal(touched.file, 'src/app.js');
  });

  it('rejects path traversal, invalid CLI flags, ReDoS inputs, and sanitizes route fields', () => {
    const dir = makeProject();
    const outsideDir = mkdtempSync(join(tmpdir(), 'coord-fm-outside-'));
    temps.push(outsideDir);
    writeFileSync(join(outsideDir, 'secret.json'), '{"panels":["x"]}');

    assert.throws(
      () => findFeatureMap(dir, '../outside/secret.json'),
      /must stay inside project root/i,
    );
    assert.throws(
      () => findFeatureMap(dir, ''),
      /non-empty string/i,
    );

    const linkPath = join(dir, 'escaped-map.json');
    let symlinkCreated = false;
    try {
      symlinkSync(join(outsideDir, 'secret.json'), linkPath);
      symlinkCreated = true;
    } catch {
      // Windows without developer mode may disallow file symlinks; relative traversal above still verified.
    }
    if (symlinkCreated) {
      assert.throws(() => findFeatureMap(dir, 'escaped-map.json'), /symlink escapes project root/i);
    }

    // Ignores hyphenated test-id= and stays linear on repeated unclosed <ReinsPanel fragments
    const attrRefs = extractBarSurfaceRefs('<ReinsPanel test-id="alpha" id="invoice-panel">');
    assert.deepEqual(attrRefs.map((r) => `${r.kind}:${r.id}`), ['panel:invoice-panel']);

    const t0 = performance.now();
    const redosRefs = extractBarSurfaceRefs('<ReinsPanel '.repeat(1500));
    const elapsedMs = performance.now() - t0;
    assert.deepEqual(redosRefs, []);
    assert.ok(elapsedMs < 150, `expected linear regex scan (<150ms), got ${elapsedMs.toFixed(1)}ms`);

    // Sanitizes malformed route method/file types and rejects bare/invalid CLI flags
    writeFileSync(
      join(dir, 'malformed-routes.json'),
      JSON.stringify({
        panels: ['invoice-panel'],
        routes: [{ path: '/orders', method: 123, file: ['bad'] }, { path: '/ok', method: 'post', file: 'src/app.js' }],
      }),
    );
    const badFm = findFeatureMap(dir, 'malformed-routes.json');
    assert.deepEqual(badFm.routes, [
      { path: '/orders', method: 'GET' },
      { path: '/ok', method: 'POST', file: 'src/app.js' },
    ]);

    cli(dir, ['init', 'fm-flags', '--goal', 'validate CLI flag handling cleanly', '--bar', 'every panel renders totals with zero errors', '--fence', 'checkout flow only']);
    assert.match(cliFails(dir, ['add', 'fm-flags', 'u1', '--bar', 'use invoice-panel', '--feature-map']), /requires a non-empty path/i);
    assert.match(cliFails(dir, ['add', 'fm-flags', 'u1', '--bar', 'use invoice-panel', '--new-surface', 'yes']), /--new-surface takes no value/i);

    const refs = extractBarSurfaceRefs('Check <ReinsPanel id="invoice-panel"> and reins exec applyCoupon');
    assert.deepEqual(
      refs.map((r) => `${r.kind}:${r.id}`),
      ['panel:invoice-panel', 'action:applyCoupon'],
    );
    const fm = findFeatureMap(dir);
    const res = validateBehavioursAgainstFeatureMap(['uses panel "invoice-panel" and action "applyCoupon"'], fm);
    assert.equal(res.ok, true);
    assert.equal(res.matched.length, 2);
  });
});
