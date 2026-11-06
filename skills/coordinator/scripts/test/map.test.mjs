import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildMap } from '../lib/map/build.mjs';
import { lex } from '../lib/map/lex.mjs';
import { analyse } from '../lib/map/js.mjs';
import { load, record, validate } from '../lib/map/log.mjs';
import { mapPage } from '../lib/map/page.mjs';
import { exportTarget, jsonc } from '../lib/map/resolve.mjs';
import { callMatches } from '../lib/map/surfaces.mjs';
import { text, touches } from '../lib/map/touches.mjs';
import { build as buildRun, mapView, pitStopFiles } from '../lib/map/index.mjs';
import { staticCtx } from '../lib/hud.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scripts = join(here, '..');
const fixture = join(here, 'fixtures', 'map-project');
const dir = mkdtempSync(join(tmpdir(), 'coordinator-map-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// A copy outside any git repo exercises the folder walk; the fixture in place, git's file list.
const copy = join(dir, 'project');
cpSync(fixture, copy, { recursive: true });
const map = buildMap(copy);
const byId = (list, id) => list.find((x) => x.id === id);

test('modules: relative, tsconfig paths, workspace exports, CommonJS and the .js → .ts swap', () => {
  assert.deepEqual(byId(map.modules, 'src/routes/employer.ts').imports, ['src/services/employer.service.ts', 'src/services/ewa.service.ts'], '@/ alias from tsconfig paths');
  assert.deepEqual(byId(map.modules, 'src/server.ts').imports, ['src/routes/employer.ts'], './routes/employer.js resolves to the .ts file');
  assert.deepEqual(byId(map.modules, 'src/services/employer.service.ts').imports, ['packages/shared/src/index.ts', 'packages/shared/src/money.ts'], 'package exports, dist → src');
  assert.deepEqual(byId(map.modules, 'src/lib/legacy.js').imports, ['src/services/employer.service.ts', 'src/services/ewa.service.ts']);
  assert.deepEqual(byId(map.modules, 'src/server.ts').ext, ['fastify']);
  assert.equal(map.meta.unresolved, 0);
  assert.equal(map.meta.root, 'project', 'the root is named, never an absolute path');
});

test('the fallback scan resolves Python and Go imports', () => {
  assert.deepEqual(byId(map.modules, 'tools/report.py').imports, ['tools/helpers.py', 'tools/shapes.py']);
  assert.deepEqual(byId(map.modules, 'tools/report.py').ext, ['os']);
  assert.deepEqual(byId(map.modules, 'cmd/main.go').imports, ['internal/util/util.go']);
});

test('shared helpers list who uses them; settings say where they are read and written', () => {
  assert.deepEqual(byId(map.helpers, 'src/services/employer.service.ts#changeEmployerSettings').usedBy, ['src/routes/employer.ts', 'src/services/ewa.service.ts']);
  assert.deepEqual(byId(map.helpers, 'src/services/employer.service.ts#loadEmployer').usedBy, ['src/lib/legacy.js', 'src/routes/employer.ts', 'src/services/ewa.service.ts'], 'require destructuring and ns.name count');
  const auto = byId(map.settings, 'key:settings.autoDisburse');
  assert.deepEqual(auto.reads, ['src/services/ewa.service.ts:5']);
  assert.deepEqual(auto.writes, ['src/services/employer.service.ts:11', 'src/services/employer.service.ts:7'], 'an assignment and an object literal; the type literal is not a write');
  assert.deepEqual(auto.owners, ['employer']);
  const bank = byId(map.settings, 'env:BANK_PROVIDER');
  assert.deepEqual([bank.reads, bank.declared], [['src/services/employer.service.ts:16'], ['.env.example']]);
});

test('surfaces: prefixed Fastify routes with their services, app-router pages and handlers, message keys', () => {
  const patch = byId(map.surfaces, 'route:PATCH /v1/employer/settings src/routes/employer.ts');
  assert.ok(patch, 'register(…, { prefix }) applies to the plugin file');
  assert.deepEqual(patch.services, ['src/services/employer.service.ts'], 'what the handler names, not every import of the file');
  assert.deepEqual(byId(map.surfaces, 'route:POST /v1/employer/disburse src/routes/employer.ts').services, ['src/services/ewa.service.ts'], 'through a local function, one call deep');
  assert.ok(byId(map.surfaces, 'route:GET /api/health app/api/health/route.ts'));
  const screen = byId(map.surfaces, 'screen:/employer app/(dashboard)/employer/page.tsx');
  assert.deepEqual(screen.calls, ['route:GET /v1/employer/settings src/routes/employer.ts'], 'the screen reaches the route through its client call');
  assert.deepEqual(byId(map.surfaces, 'message:employer.subtitle'), { id: 'message:employer.subtitle', kind: 'message', usedBy: ['app/(dashboard)/employer/page.tsx'], missing: ['ar'] });
  assert.equal(byId(map.surfaces, 'message:employer.unused'), undefined, 'unused keys with every locale are counted, not listed');
  assert.deepEqual(map.meta.messages, { keys: 3, unused: 1, unknownLookups: 0, catalogs: ['messages ar/en 3'] });
});

test('reuse candidates: renamed copies of a function have the same shape', () => {
  assert.deepEqual(map.reuse.map((r) => r.fns), [['src/services/employer.service.ts#sumRows:21', 'src/services/ewa.service.ts#totalOf:9']]);
});

test('the build is deterministic and works on git\'s file list too', () => {
  const again = buildMap(fixture);
  for (const c of ['modules', 'helpers', 'settings', 'surfaces', 'reuse']) assert.deepEqual(again[c], map[c], c);
});

test('a build past its time cap is marked partial', () => {
  let t = 0;
  const m = buildMap(copy, { maxSeconds: 1, now: () => (t += 400) });
  assert.equal(m.meta.partial, true);
  assert.ok(m.meta.scanned < map.meta.scanned);
});

test('the lexer keeps offsets and survives JSX apostrophes, regexes and nested templates', () => {
  const src = "const a = `x${`y${1}`}`; const r = /}/g;\nconst el = <p>Don't</p>;\nfunction f() { return '}'; }\n";
  const { code, bare } = lex(src);
  assert.equal(code.length, src.length); assert.equal(bare.length, src.length);
  assert.equal((bare.match(/\{/g) ?? []).length, (bare.match(/\}/g) ?? []).length, 'braces balance once strings and regexes are blanked');
  assert.ok(bare.includes('function f() {'));
  const a = analyse("import def, { a as b, type C } from './x';\nimport * as ns from './y';\nns.go();\nexport const go = async () => {};\n");
  assert.deepEqual(a.imports.map((i) => [i.spec, i.names]), [['./x', ['a', 'C', 'default']], ['./y', ['*', 'go']]]);
  assert.deepEqual(a.exports.map((e) => [e.name, e.kind]), [['go', 'function']]);
});

test('resolver pieces: tsconfig JSON with comments, package exports, route matching', () => {
  assert.deepEqual(jsonc('{ // c\n "a": "http://x", /* d */ "b": [1,], }'), { a: 'http://x', b: [1] });
  assert.equal(exportTarget({ './x/*': { import: './dist/x/*.js' } }, './x/y'), './dist/x/y.js');
  assert.equal(exportTarget('./i.js', '.'), './i.js');
  assert.ok(callMatches('/employer/${id}', '/v1/employer/:id'));
  assert.ok(callMatches('${API}/admin/dashboard', '/v1/admin/dashboard'));
  assert.ok(!callMatches('/${id}', '/v1/employer/:id'), 'a call with no literal segment matches nothing');
});

test('events: one build line, deltas and a done line; a rebuild with no change adds no delta', () => {
  const d = join(dir, 'log1');
  record(d, map, { unit: 'u1' });
  const first = readFileSync(join(d, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(first.map((e) => e.seq), first.map((_, i) => i + 1));
  assert.equal(first[0].kind, 'map.build'); assert.equal(first.at(-1).kind, 'map.done'); assert.equal(first[0].unit, 'u1');
  assert.ok(first.every((e) => e.v === 1 && typeof e.at === 'string'));
  const snap = record(d, buildMap(copy));
  const all = readFileSync(join(d, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(all.slice(first.length).map((e) => e.kind), ['map.build', 'map.done']);
  assert.equal(snap.build.n, 2); assert.equal(snap.upTo.seq, all.length);
  const raw = readFileSync(join(d, 'map.json'), 'utf8');
  assert.match(raw, /^\{"v":1,\n"upTo":\{"seq":\d+,"sha256":"[0-9a-f]{64}"\}/);
  assert.ok(raw.split('\n').length > map.modules.length, 'one record per line');
});

test('a changed project records only what changed, and a removed file as a deletion', () => {
  const d = join(dir, 'log2');
  const proj = join(dir, 'project2');
  cpSync(fixture, proj, { recursive: true });
  record(d, buildMap(proj));
  const n = readFileSync(join(d, 'events.jsonl'), 'utf8').trim().split('\n').length;
  rmSync(join(proj, 'src', 'lib', 'legacy.js'));
  writeFileSync(join(proj, 'src', 'extra.ts'), "export const x = process.env.EXTRA;\n");
  const snap = record(d, buildMap(proj));
  const deltas = readFileSync(join(d, 'events.jsonl'), 'utf8').trim().split('\n').slice(n).map((l) => JSON.parse(l)).filter((e) => e.kind === 'map.delta');
  const mods = deltas.find((e) => e.coll === 'modules');
  assert.deepEqual(mods.del, ['src/lib/legacy.js']);
  assert.deepEqual(mods.set.map((r) => r.id), ['src/extra.ts']);
  assert.ok(byId(snap.settings, 'env:EXTRA'));
  assert.ok(!snap.modules.some((m) => m.id === 'src/lib/legacy.js'));
});

test('a stale, missing or tampered snapshot is rebuilt from the events; a broken log fails loudly', () => {
  const d = join(dir, 'log1');
  const good = readFileSync(join(d, 'map.json'), 'utf8');
  rmSync(join(d, 'map.json'));
  load(d);
  assert.equal(readFileSync(join(d, 'map.json'), 'utf8'), good, 'replayed byte for byte');
  writeFileSync(join(d, 'map.json'), good.replace(/"sha256":"[0-9a-f]+"/, `"sha256":"${'0'.repeat(64)}"`));
  assert.equal(load(d).modules.length, map.modules.length, 'a bad hash means replay');
  assert.equal(readFileSync(join(d, 'map.json'), 'utf8'), good);

  const events = readFileSync(join(d, 'events.jsonl'), 'utf8');
  const lines = events.trim().split('\n');
  writeFileSync(join(d, 'events.jsonl'), `${[lines[0], ...lines.slice(2)].join('\n')}\n`);
  assert.throws(() => load(d), /seq .*gap/, 'a missing line is a gap');
  const tampered = lines.map((l) => (l.includes('"coll":"helpers"') ? l.replace('src/routes/employer.ts', 'src/elsewhere.ts') : l));
  writeFileSync(join(d, 'events.jsonl'), `${tampered.join('\n')}\n`);
  rmSync(join(d, 'map.json'));
  assert.throws(() => load(d), /does not reproduce/, 'an edited delta misses the digest');
  writeFileSync(join(d, 'events.jsonl'), `${lines.join('\n')}\n{"v":1,"seq":${lines.length + 1},"kind":"map.oops"}\n`);
  assert.throws(() => load(d), /invalid event/);
  writeFileSync(join(d, 'events.jsonl'), events);
  assert.throws(() => validate({ v: 1, seq: 1, at: 'x', kind: 'map.delta', build: 1, coll: 'nope', set: [], del: [] }), /unknown collection/);
});

test('touches: what a file imports, who reaches it, helpers, settings, surfaces and reuse', () => {
  const snap = load(join(dir, 'log1'));
  const t = touches(snap, 'src/services/employer.service.ts');
  assert.deepEqual(t.importedBy, ['src/lib/legacy.js', 'src/routes/employer.ts', 'src/services/ewa.service.ts']);
  assert.equal(t.reach, 4, 'legacy, routes, ewa and server within three steps');
  assert.equal(t.surfaces[0].direct, true, 'direct surfaces first');
  assert.ok(t.surfaces.filter((x) => !x.direct).every((x, i, a) => i === 0 || a[i - 1].steps <= x.steps), 'then by import distance');
  assert.deepEqual(t.helpersHere.map((h) => h.name), ['changeEmployerSettings', 'loadEmployer']);
  assert.deepEqual(t.settings.map((s) => s.id), ['env:BANK_PROVIDER', 'key:settings.autoDisburse', 'key:settings.payday']);
  assert.ok(t.surfaces.some((s) => s.id.startsWith('route:PATCH /v1/employer/settings') && s.direct));
  const out = text(t);
  assert.match(out, /Defines shared helper changeEmployerSettings \(line 10\), used by 2/);
  assert.match(out, /Writes settings: key:settings.autoDisburse/);
  assert.match(out, /Reuse candidate \(9 lines, same shape\)/);
  assert.equal(touches(snap, `${copy.replace(/\\/g, '/')}/src/server.ts`).file, 'src/server.ts', 'an absolute path is found by its tail');
  assert.equal(touches(snap, 'nope.ts'), null);
});

test('the map page: inline SVG graph, CSS-only filters, no script, escaped text, GitHub links', () => {
  const snap = load(join(dir, 'log1'));
  snap.build = { ...snap.build, repo: 'acme/app', commit: 'a'.repeat(40), pushed: true, root: '<b>x</b>' };
  const html = mapPage(snap, staticCtx(dir, 0), 'r1');
  assert.match(html, /<svg class="graph"/);
  assert.ok(!/<script/i.test(html), 'the static page carries no script');
  assert.match(html, /script-src|default-src 'none'/);
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;') && !html.includes('<b>x</b>'));
  assert.ok(html.includes(`https://github.com/acme/app/blob/${'a'.repeat(40)}/src/routes/employer.ts#L11`));
  assert.match(html, /id="f-a\d+" checked/); assert.match(html, /id="f-w10"/); assert.match(html, /id="f-cycles"/);
  assert.match(html, /:root:has\(#f-a0:not\(:checked\)\)/);
  assert.match(html, /href="hud.html">← r1 dashboard/);
});

// ---- CLI ----
const state = join(dir, 'state');
function cli(...args) {
  const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...args], { env: { ...process.env, COORDINATOR_DIR: state }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('run.mjs map writes the map beside the run, links it from the dashboard, and touches reads it', () => {
  assert.equal(cli('init', 'm1', '--goal', 'g', '--bar', 'b', '--fence', 'f').code, 0);
  assert.equal(cli('touches', 'm1', 'src/server.ts').code, 1, 'no map yet');
  assert.ok(!readFileSync(join(state, 'runs', 'm1', 'hud.html'), 'utf8').includes('Project map'));
  const r = cli('map', 'm1', '--root', copy);
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.equal(out.build, 1); assert.equal(out.partial, false); assert.equal(out.stats.modules, map.modules.length);
  for (const f of ['map/events.jsonl', 'map/map.json', 'map/map.md', 'map.html']) assert.ok(existsSync(join(state, 'runs', 'm1', f)), f);
  assert.match(readFileSync(join(state, 'runs', 'm1', 'map', 'map.md'), 'utf8'), /# Project map: project/);
  assert.match(readFileSync(join(state, 'runs', 'm1', 'hud.html'), 'utf8'), /<a class="open" href="map.html">Project map →<\/a>/);
  const t = cli('touches', 'm1', 'src/services/ewa.service.ts');
  assert.equal(t.code, 0, t.err);
  assert.match(t.out, /^What src\/services\/ewa.service.ts touches \(project map\):/);
  assert.match(t.out, /Uses shared helpers: changeEmployerSettings/);
  assert.equal(JSON.parse(cli('touches', 'm1', 'src/server.ts', '--json').out).file, 'src/server.ts');
  assert.equal(cli('map', 'm1', '--root', copy, '--dest', dir).code, 1, '--dest needs --pit-stop');
  assert.equal(cli('map', 'm1', '--unit', 'ghost', '--root', copy).code, 1);
  assert.equal(cli('map', 'nope', '--root', copy).code, 1);
});

test('--pit-stop stages the log and summary in the run\'s folder, never the project tree; --dest copies them and refuses a foreign log', () => {
  const def = cli('map', 'm1', '--root', copy, '--pit-stop');
  assert.equal(def.code, 0, def.err);
  const staged = join(state, 'runs', 'm1', 'pit-stop', 'map');
  assert.deepEqual(JSON.parse(def.out).pitStop.files, ['events.jsonl', 'map.md'], 'map.json is rebuilt from the log, so it does not ship');
  assert.ok(existsSync(join(staged, 'events.jsonl')) && existsSync(join(staged, 'map.md')) && !existsSync(join(staged, 'map.json')));
  assert.ok(!existsSync(join(copy, 'coordinator')), 'nothing written into the mapped project');
  const dest = join(dir, 'repo-map');
  assert.equal(cli('map', 'm1', '--root', copy, '--pit-stop', '--dest', dest).code, 0);
  assert.equal(readFileSync(join(dest, 'events.jsonl'), 'utf8'), readFileSync(join(state, 'runs', 'm1', 'map', 'events.jsonl'), 'utf8'));
  assert.equal(cli('map', 'm1', '--root', copy, '--pit-stop', '--dest', dest).code, 0, 'a later pit stop extends the same log');
  writeFileSync(join(dest, 'events.jsonl'), `${readFileSync(join(dest, 'events.jsonl'), 'utf8')}{"v":1,"seq":999}\n`);
  const refused = cli('map', 'm1', '--root', copy, '--pit-stop', '--dest', dest);
  assert.equal(refused.code, 1); assert.match(refused.err, /pit stop refused/);
  const files = pitStopFiles(join(state, 'runs', 'm1'), 'm1');
  assert.deepEqual(Object.keys(files), ['runs/m1/map/events.jsonl', 'runs/m1/map/map.md'], 'what push will carry to the state branch');
});

test('a build cut short by the time cap is refused over a full map unless --force', () => {
  const runDir = join(state, 'runs', 'm1');
  const before = readFileSync(join(runDir, 'map', 'events.jsonl'), 'utf8');
  let t = 0;
  const opts = { root: copy, maxSeconds: 1, ctx: staticCtx(runDir, 0), now: () => (t += 400) }; // a clock that runs out mid-scan
  assert.throws(() => buildRun('m1', runDir, opts), /stopped at the 1 s cap.*--force/);
  assert.equal(readFileSync(join(runDir, 'map', 'events.jsonl'), 'utf8'), before, 'nothing recorded');
  t = 0;
  const snap = buildRun('m1', runDir, { ...opts, force: true });
  assert.equal(snap.build.partial, true);
  assert.equal(snap.modules.length, map.modules.length, 'a forced partial build removes nothing');
});

test('a corrupt log is named, with --fresh as the way out; the page says so too', () => {
  const log = join(state, 'runs', 'm1', 'map', 'events.jsonl');
  const good = readFileSync(log, 'utf8');
  writeFileSync(log, `${good}not json\n`);
  const t = cli('touches', 'm1', 'src/server.ts');
  assert.equal(t.code, 1); assert.match(t.err, /is not JSON.*run.mjs map m1 --fresh/);
  const html = mapView('m1', join(state, 'runs', 'm1'), staticCtx(join(state, 'runs', 'm1'), 0));
  assert.match(html, /Project map · not readable/); assert.match(html, /is not JSON/); assert.match(html, /--fresh/);
  const fresh = cli('map', 'm1', '--root', copy, '--fresh');
  assert.equal(fresh.code, 0, fresh.err);
  assert.equal(JSON.parse(fresh.out).build, 1, 'a new log');
  assert.ok(readdirSync(join(state, 'runs', 'm1')).some((n) => n.startsWith('map.old-')), 'the broken map is kept aside');
});

test('the live dashboard serves /map and /run/<id>/map behind the token', async () => {
  assert.equal(cli('init', 'm2', '--goal', 'g', '--bar', 'b', '--fence', 'f').code, 0);
  assert.equal(cli('map', 'm2', '--root', copy).code, 0);
  assert.equal(cli('init', 'm3', '--goal', 'g', '--bar', 'b', '--fence', 'f').code, 0);
  const child = spawn(process.execPath, [join(scripts, 'run.mjs'), 'serve', 'm1'], { env: { ...process.env, COORDINATOR_DIR: state } });
  try {
    const url = await new Promise((ok, fail) => {
      let buf = '';
      child.stdout.on('data', (c) => { buf += c; const m = /"url":\s*"([^"]+)"/.exec(buf); if (m) ok(m[1]); });
      child.on('exit', () => fail(new Error('serve exited')));
    });
    const u = new URL(url);
    const page = await fetch(`${u.origin}/map${u.search}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<svg class="graph"/);
    assert.match(html, /href="\/\?t=/, 'back link keeps the token');
    assert.match(await (await fetch(url)).text(), /href="\/map\?t=[^"]+">Project map →/);
    assert.equal((await fetch(`${u.origin}/map`)).status, 403, 'no token, no map');
    const other = await fetch(`${u.origin}/run/m2/map${u.search}`);
    assert.equal(other.status, 200, 'another run\'s map at /run/<id>/map');
    assert.match(await other.text(), /href="\/run\/m2\?t=[^"]+">← m2 dashboard[\s\S]*Project map · project/, 'its back link goes to that run');
    assert.equal((await fetch(`${u.origin}/run/m3/map${u.search}`)).status, 404, 'a run with no map has no map page');
  } finally { child.kill(); }
});
