// pkg-scripts: COORDINATOR.md commands are found in the package.json where they live,
// in a monorepo as well as a single package (#61).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { contextCheck } from '../lib/doctor.mjs';
import { packageDirs, staleCommands } from '../lib/pkg-scripts.mjs';

const root = mkdtempSync(join(tmpdir(), 'coord-pkg-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const pkg = (p, dir, json) => { mkdirSync(join(p, dir), { recursive: true }); writeFileSync(join(p, dir, 'package.json'), JSON.stringify(json)); };
// The PayDay layout: no root package.json; backend/, frontend/, marketing/ each have one.
const monorepo = () => {
  const p = join(root, `p${++n}`); mkdirSync(p);
  pkg(p, 'backend', { name: 'backend', scripts: { 'db:generate': 'x', 'verify:guardrails': 'x', test: 'x' } });
  pkg(p, 'frontend', { name: '@acme/web', scripts: { lint: 'x' } });
  pkg(p, 'node_modules/junk', { scripts: { junk: 'x' } });
  mkdirSync(join(p, 'docs'));
  return p;
};
const ctx = (p) => ({ project: p });

test('B1: a command only backend/package.json has is found there, and named', () => {
  const p = monorepo();
  writeFileSync(join(p, 'COORDINATOR.md'), '- run `npm run verify:guardrails`\n- only `npm run db:generate`\n');
  const r = contextCheck(ctx(p));
  assert.equal(r.status, 'ok', r.text);
  assert.match(r.text, /npm run verify:guardrails, npm run db:generate in backend\/package\.json/);
});

test('B2: a command no package.json has still warns and lists every file searched', () => {
  const p = monorepo();
  writeFileSync(join(p, 'COORDINATOR.md'), '`npm run db:generate` and `npm run nowhere`\n');
  const r = contextCheck(ctx(p));
  assert.equal(r.status, 'warn');
  assert.match(r.text, /npm run nowhere \(searched backend\/package\.json, frontend\/package\.json\)/);
  assert.doesNotMatch(r.text, /db:generate|node_modules|docs/);
});

test('a command named with a directory is looked up in that folder only', () => {
  const p = monorepo();
  const doc = (s) => staleCommands(s, p);
  for (const form of ['cd backend && npm run db:generate', 'cd ./backend/ && npm run db:generate', 'npm --prefix backend run db:generate',
    'npm --prefix=backend run db:generate', 'pnpm -C backend db:generate', 'pnpm --dir backend run db:generate', 'yarn --cwd backend db:generate',
    'npm -w backend run db:generate', 'npm run lint --silent; npm --workspace @acme/web run lint']) {
    const r = doc(`\`${form}\``);
    assert.deepEqual(r.missing, [], form);
  }
  // The script exists elsewhere, but not in the folder the command names.
  for (const form of ['cd frontend && npm run db:generate', 'npm --prefix frontend run db:generate', 'yarn --cwd frontend db:generate']) {
    const r = doc(`\`${form}\``);
    assert.deepEqual(r.missing, ['frontend: ' + (form.startsWith('yarn') ? 'yarn db:generate' : 'npm run db:generate')], form);
    assert.deepEqual(r.searched, ['frontend/package.json'], form);
  }
  assert.deepEqual(doc('`cd api && npm test`').searched, ['api/package.json']);
  assert.deepEqual(doc('`npm --prefix backend ci` and `npm --prefix backend install`').missing, []);
});

test('workspaces from the root package.json are searched, with globs one level deep', () => {
  const p = join(root, `p${++n}`); mkdirSync(p);
  pkg(p, '.', { workspaces: ['packages/*', 'tools/cli', '!packages/skip'], scripts: { verify: 'x' } });
  pkg(p, 'packages/api', { scripts: { 'db:check': 'x' } });
  pkg(p, 'tools/cli', { scripts: { build: 'x' } });
  assert.deepEqual(packageDirs(p), ['.', 'packages/api', 'tools/cli']);
  const r = staleCommands('`npm run verify`, `npm run db:check`, `npm run build`, `npm test`', p);
  assert.deepEqual(r.missing, ['npm test']);
  assert.deepEqual(r.found, { 'packages/api/package.json': ['npm run db:check'], 'tools/cli/package.json': ['npm run build'] });
  assert.deepEqual(r.searched, ['package.json', 'packages/api/package.json', 'tools/cli/package.json']);
  const q = join(root, `p${++n}`); mkdirSync(q);
  pkg(q, '.', { workspaces: { packages: ['apps/**'] } });
  pkg(q, 'apps/web', { scripts: { dev: 'x' } });
  assert.deepEqual(staleCommands('`npm run dev`', q).missing, []);
});

test('fold 1: pnpm -w is the workspace root and takes no value; npm -w names a folder', () => {
  const p = monorepo();
  pkg(p, '.', { scripts: { verify: 'x' } });
  assert.deepEqual(staleCommands('`pnpm -w verify`', p).missing, []);
  assert.deepEqual(staleCommands('`pnpm -w db:generate`', p).missing, ['.: pnpm db:generate']);
  assert.deepEqual(staleCommands('`npm -w backend run db:generate`', p).missing, []);
});

test('fold 2: pnpm --filter, pnpm -r and yarn workspace', () => {
  const p = monorepo();
  const s = (d) => staleCommands(d, p);
  assert.deepEqual(s('`pnpm --filter backend db:generate` `pnpm -F @acme/web run lint` `pnpm --filter=./backend run test`').missing, []);
  assert.deepEqual(s('`pnpm --filter @acme/web db:generate`').missing, ['frontend: pnpm db:generate']);
  assert.deepEqual(s('`pnpm --filter "@acme/*" run lint`').missing, []); // a pattern: searched everywhere
  assert.deepEqual(s('`pnpm -r run lint` `pnpm --recursive db:generate`').missing, []);
  assert.deepEqual(s('`pnpm -r run gone`').searched, ['backend/package.json', 'frontend/package.json']);
  assert.deepEqual(s('`yarn workspace @acme/web lint` `yarn workspace backend run db:generate`').missing, []);
  assert.deepEqual(s('`yarn workspace @acme/web db:generate`').missing, ['frontend: yarn db:generate']);
});

test('fold 3: -w and --prefix after the script name', () => {
  const p = monorepo();
  assert.deepEqual(staleCommands('`npm run lint -w frontend` `npm run db:generate --prefix backend` `npm run db:generate --workspace=backend`', p).missing, []);
  assert.deepEqual(staleCommands('`npm run lint -w backend`', p).missing, ['backend: npm run lint']);
  assert.deepEqual(staleCommands('`npm run db:generate -- -w frontend`', p).missing, []); // after --: the script's own args
});

test('fold 4: a folder outside the project is never read', () => {
  const p = monorepo();
  for (const form of ['cd .. && npm run nothere', 'npm --prefix ../x run nothere', 'cd backend && npm --prefix ../.. run nothere', 'pnpm -C /tmp run nothere'])
    assert.deepEqual(staleCommands(`\`${form}\``, p), { missing: [], searched: [], unreadable: [], found: {} }, form);
  assert.deepEqual(staleCommands('`cd backend/.. && npm run lint`', p).missing, []);
});

test('fold 5: a package.json that is not valid JSON is named, not listed silently', () => {
  const p = monorepo();
  mkdirSync(join(p, 'api')); writeFileSync(join(p, 'api', 'package.json'), '{ "scripts": ');
  const r = staleCommands('`npm run gone`', p);
  assert.deepEqual(r.unreadable, ['api/package.json']);
  writeFileSync(join(p, 'COORDINATOR.md'), '`npm run gone`\n');
  assert.match(contextCheck(ctx(p)).text, /could not read api\/package\.json \(not valid JSON\)/);
  writeFileSync(join(p, 'COORDINATOR.md'), '`cd api && npm test` `npm run lint`\n');
  const c = contextCheck(ctx(p));
  assert.equal(c.status, 'warn'); assert.match(c.text, /api: npm test .*could not read api\/package\.json/);
  writeFileSync(join(p, 'COORDINATOR.md'), '`npm run db:generate`\n');
  // api/ sorts before backend/, so it is consulted on the way: still named.
  assert.match(contextCheck(ctx(p)).text, /commands found, could not read api\/package\.json/);
});

test('no package.json anywhere: every command warns, searched names the root file', () => {
  const p = join(root, `p${++n}`); mkdirSync(p);
  const r = staleCommands('`npm run lint`', p);
  assert.deepEqual(r.missing, ['npm run lint']); assert.deepEqual(r.searched, ['package.json']);
});
