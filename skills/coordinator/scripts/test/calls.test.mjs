import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scanFns } from '../lib/map/fns.mjs';
import { callsText, link, scanAll, unitCalls } from '../lib/map/calls.mjs';
import { diffRanges } from '../lib/map/calls-git.mjs';
import { callsView, unitCalls as unitCallsHtml } from '../lib/map/callsview.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scripts = join(here, '..');
const dir = mkdtempSync(join(tmpdir(), 'coordinator-calls-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const root = join(dir, 'project');
cpSync(join(here, 'fixtures', 'calls-project'), root, { recursive: true });
const index = link(scanAll(root));
const fn = (id) => index.fns.get(id);
const to = (id) => fn(id).calls.filter((c) => c.to).map((c) => c.to).sort();
const by = (id) => (index.callers.get(id) ?? []).map((c) => c.from).sort();

test('scan: functions, methods and arrows with their line ranges; TS signatures are not functions', () => {
  const s = scanFns(readFileSync(join(root, 'src/svc/service.ts'), 'utf8'));
  assert.deepEqual(s.fns.map((f) => [f.q, f.line, f.end]), [['Service.run', 13, 15], ['Service.stop', 17, 19], ['Service.inner', 21, 24]], 'interface methods and the function type are not functions');
  const b = scanFns(readFileSync(join(root, 'src/b.ts'), 'utf8'));
  assert.deepEqual(b.fns.map((f) => f.q), ['helper', 'twice', 'fmt', 'greet'], 'an arrow with a return type and an expression body counts');
  assert.equal(b.exports.default, 'greet');
  const a = scanFns(readFileSync(join(root, 'src/app.ts'), 'utf8'));
  assert.deepEqual(a.fns.filter((f) => f.name === 'overloaded').length, 1, 'overload signatures have no body');
  assert.equal(a.classes.find((c) => c.name === 'App').fields.svc, 'Service', 'a typed field');
  assert.equal(a.classes.find((c) => c.name === 'App').fields.other, 'Svc', 'a field built with new');
});

test('scan: calls in comments, strings and templates are not calls; a template expression is', () => {
  const all = [...index.fns.values()].flatMap((f) => f.calls.map((c) => c.n));
  for (const fake of ['notACall', 'fakeBlock', 'fake', 'notReal']) assert.ok(!all.includes(fake), fake);
  assert.deepEqual(to('src/b.ts#greet'), ['src/b.ts#fmt'], '${fmt(1)} inside a template');
});

test('link: ESM named, default and namespace imports, barrels and tsconfig paths', () => {
  assert.deepEqual(to('src/app.ts#main'), ['src/app.ts#App.constructor', 'src/app.ts#App.start', 'src/app.ts#main2', 'src/b.ts#fmt', 'src/b.ts#greet', 'src/b.ts#helper']);
  assert.equal(fn('src/app.ts#main').calls.find((c) => c.to === 'src/app.ts#main2').k, 'ref', 'setTimeout(main2) is a passed callback');
  assert.deepEqual(to('src/b.ts#helper'), ['src/b.ts#twice'], 'a local function');
});

test('link: this.method(), this.field.method() through a typed or built field, new X().m()', () => {
  assert.deepEqual(to('src/svc/service.ts#Service.run'), ['src/svc/service.ts#Service.inner']);
  assert.deepEqual(to('src/app.ts#App.start'), ['src/app.ts#App.log', 'src/b.ts#fmt', 'src/svc/service.ts#Service.run', 'src/svc/service.ts#Service.stop'], 'svc: Service, other = new Svc() through a re-export alias');
  assert.deepEqual(to('src/app.ts#main2'), ['src/svc/service.ts#Service', 'src/svc/service.ts#Service.run']);
  assert.deepEqual(by('src/svc/service.ts#Service.inner'), ['src/svc/service.ts#Service.run', 'src/svc/service.ts#Service.stop']);
});

test('link: a method with a generic default, and a name bound by await import() inside the function', () => {
  assert.deepEqual(to('src/lazy.ts#Lazy.json'), ['src/lazy.ts#Lazy.token']);
  assert.deepEqual(to('src/lazy.ts#lazy'), ['src/b.ts#helper'], 'the destructured import is not a shadowing local');
});

test('link: CommonJS require, destructured require and module.exports objects', () => {
  assert.deepEqual(to('cjs/use.js#go'), ['cjs/lib.js#one', 'cjs/lib.js#three', 'cjs/lib.js#two']);
  assert.deepEqual(to('cjs/lib.js#three'), ['cjs/lib.js#one'], 'an object shorthand method');
  assert.deepEqual(by('cjs/lib.js#one'), ['cjs/lib.js#three', 'cjs/use.js#go']);
});

test('link: unresolved calls keep their name; outside packages are named', () => {
  const start = fn('src/app.ts#App.start');
  assert.ok(start.calls.some((c) => !c.to && c.n === 'String'));
  const s = scanFns("import { eq } from 'drizzle-orm';\nexport function q() { return eq(a, b) + window.thing(); }\n");
  assert.deepEqual(s.fns[0].calls.map((c) => c.n), ['eq', 'thing']);
  const g = scanFns("export function h(a: number, b: number) { if (a < b && b > 0) return client.get<Api<{ ok: boolean; n: number }>>('/x'); }\n");
  assert.deepEqual(g.fns[0].calls.map((c) => c.n), ['get'], 'nested type arguments, and a comparison that is not one');
  const t = scanFns('export function t(c: boolean) {\n  return c ? f(1) : g(2) || { a: 1 };\n}\n');
  assert.deepEqual(t.fns[0].calls.map((c) => c.n), ['f', 'g'], 'a call in a ternary is not a method with a return type');
});

test('cache: unchanged files are not rescanned; a changed one is', () => {
  const copy = join(dir, 'cached');
  cpSync(root, copy, { recursive: true });
  const cacheFile = join(dir, 'cache.json');
  assert.equal(scanAll(copy, { cacheFile }).fresh, 9);
  assert.equal(scanAll(copy, { cacheFile }).fresh, 0);
  writeFileSync(join(copy, 'cjs/lib.js'), `${readFileSync(join(copy, 'cjs/lib.js'), 'utf8')}\nfunction four() { return 4; }\n`);
  const again = scanAll(copy, { cacheFile });
  assert.equal(again.fresh, 1);
  assert.ok(again.scans.get('cjs/lib.js').fns.some((f) => f.q === 'four'));
  assert.equal(scanAll(copy, { cacheFile, deadline: 0 }).partial, false, 'nothing left to scan: complete from the cache');
});

test('cache: an entry whose hash matches but whose scan is broken is rescanned, not trusted', () => {
  const copy = join(dir, 'broken');
  cpSync(root, copy, { recursive: true });
  const cacheFile = join(dir, 'broken.json');
  scanAll(copy, { cacheFile });
  const c = JSON.parse(readFileSync(cacheFile, 'utf8'));
  for (const k of Object.keys(c.blobs)) c.blobs[k] = { ...c.blobs[k], fns: 'oops' };
  writeFileSync(cacheFile, JSON.stringify(c));
  const again = scanAll(copy, { cacheFile });
  assert.equal(again.fresh, 9);
  assert.ok(link(again).fns.has('src/b.ts#helper'));
});

test('time cap: past the deadline, uncached files are skipped and the result is partial; the unit\'s files are scanned first, whatever the cap', () => {
  const r = scanAll(root, { deadline: Date.now() - 1 });
  assert.equal(r.partial, true);
  assert.equal(r.scans.size, 0);
  const f = scanAll(root, { deadline: Date.now() - 1, first: ['src/b.ts'] });
  assert.deepEqual([...f.scans.keys()], ['src/b.ts']);
  assert.equal(f.partial, true);
});

test('jsx: <Component /> is a call, JSX text is not; inline queryFn and onSuccess belong to the hook; block scope; passed names keep their own line', () => {
  assert.deepEqual(scanFns(readFileSync(join(root, 'src/ui/Page.tsx'), 'utf8'), 'src/ui/Page.tsx').fns.map((f) => f.q), ['Page', 'Page>save'], 'no queryFn or onSuccess of their own');
  assert.deepEqual(to('src/ui/Page.tsx#Page'), ['src/b.ts#fmt', 'src/b.ts#fmt', 'src/ui/Card.tsx#Card', 'src/ui/Card.tsx#ui.Button', 'src/ui/Page.tsx#Page>save', 'src/ui/Page.tsx#Page>save', 'src/ui/Page.tsx#Page>save']);
  const page = fn('src/ui/Page.tsx#Page');
  assert.ok(!page.calls.some((c) => /notAFunction|twice/.test(c.n)), 'text between tags');
  assert.ok(page.calls.some((c) => c.n === 'fmt' && c.line === 13 && !c.to), 'the block-local fmt is a value');
  assert.deepEqual(page.calls.filter((c) => c.to === 'src/b.ts#fmt').map((c) => c.line), [7, 18], 'outside the block, fmt is the import');
  assert.deepEqual(page.calls.filter((c) => c.k === 'ref').map((c) => c.line), [9, 19], 'setTimeout(\\n save, …) is on the line of save; onClick={save}');
  assert.deepEqual(index.callers.get('src/ui/Card.tsx#Card').map((c) => [c.from, c.line, c.k]), [['src/ui/Page.tsx#Page', 18, 'jsx']]);
  assert.ok(!fn('src/ui/Card.tsx#Card').calls.some((c) => c.n === 'onClick'), 'a function type in a type literal is not a function');
});

// A git repo with a base commit and a head that edits one method and adds a function.
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const repo = join(dir, 'repo');
cpSync(root, repo, { recursive: true });
git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't'); git(repo, 'config', 'core.autocrlf', 'false');
git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
const base = git(repo, 'rev-parse', 'HEAD');
const svc = join(repo, 'src/svc/service.ts');
writeFileSync(svc, readFileSync(svc, 'utf8').replace('    this.count += helper(n);', '    this.count += helper(n) * 2;'));
git(repo, 'commit', '-qam', 'head');
const head = git(repo, 'rev-parse', 'HEAD');

test('unit: the functions a diff touched, what they call and what calls them, two levels', () => {
  assert.deepEqual([...diffRanges(repo, base, head)], [['src/svc/service.ts', [[22, 22]]]]);
  const r = unitCalls(repo, { unit: 'u1', base, head, now: '2026-11-07T00:00:00Z' });
  assert.equal(r.source, 'diff');
  assert.equal(r.ref, head);
  assert.deepEqual(r.touched.map((t) => t.id), ['src/svc/service.ts#Service.inner']);
  const t = r.touched[0];
  assert.deepEqual(t.calls.filter((c) => c.id).map((c) => c.id), ['src/b.ts#helper']);
  assert.deepEqual(t.calls[0].more.map((c) => c.id), ['src/b.ts#twice'], 'second level: what helper calls');
  assert.deepEqual(t.callers.map((c) => c.id), ['src/svc/service.ts#Service.run', 'src/svc/service.ts#Service.stop']);
  assert.deepEqual(t.callers[0].more.map((c) => c.id).sort(), ['src/app.ts#App.start', 'src/app.ts#main2'], 'second level: who calls run');
  assert.match(callsText(r), /Service\.inner src\/svc\/service\.ts:21-24\n {2}calls: helper/);
});

test('unit: every file is read at the head commit, so lines and links agree; a gone head is said', () => {
  const work = join(dir, 'work');
  cpSync(repo, work, { recursive: true });
  // Today's working tree moves App.start down three lines; the unit's head did not.
  const app = join(work, 'src/app.ts');
  writeFileSync(app, `// one\n// two\n// three\n${readFileSync(app, 'utf8')}`);
  const r = unitCalls(work, { unit: 'u1', base, head });
  const run = r.touched[0].callers[0].more.find((c) => c.id === 'src/app.ts#App.start');
  assert.equal(run.line, 18, 'App.start where the head has it, not where the working tree does');
  assert.equal(r.ref, head);
  const gone = unitCalls(work, { unit: 'u1', base: 'f'.repeat(40), head: 'e'.repeat(40), fallbackFiles: ['src/svc/service.ts'] });
  assert.equal(gone.ref, head, 'read at HEAD instead');
  assert.match(gone.note, /not in this repository/);
  assert.match(callsText(gone), /Note: The unit's commits/);
  assert.deepEqual(gone.touched.map((t) => t.q), ['Service.run', 'Service.stop', 'Service.inner']);
});

test('unit: a ref that looks like markup is resolved to its commit and escaped on the page', () => {
  const x = join(dir, 'xss');
  cpSync(repo, x, { recursive: true });
  writeFileSync(join(x, '.git', 'packed-refs'), `${base} refs/tags/<i>zz\n`); // a tag no file system would name: packed, as the critic's repo holds it
  const r = unitCalls(x, { unit: 'u1', base: '<i>zz', head: 'HEAD' });
  assert.equal(r.base, base, 'stored as the commit, not the name');
  const html = unitCallsHtml({ ...r, base: '<i>zz', head: '<b>hd' }, 'mindmakr/coordinator', 'run', 'u1');
  assert.ok(!html.includes('<i>') && !html.includes('<b>'));
  assert.match(html, /&lt;i&gt;zz…&lt;b&gt;hd/);
  const note = unitCallsHtml({ ...r, note: '<script>x</script>' }, null, 'run', 'u1');
  assert.ok(!note.includes('<script>'));
});

test('unit: whole files when no diff is recorded', () => {
  const r = unitCalls(repo, { unit: 'u2', files: ['cjs/lib.js', 'README.md'] });
  assert.equal(r.source, 'files');
  assert.deepEqual(r.touched.map((t) => t.q), ['one', 'two', 'three'], 'in file order');
});

test('view: names and paths are escaped, links go to the file and line', () => {
  const r = unitCalls(repo, { unit: 'u1', base, head });
  r.touched[0].calls.push({ n: '<img src=x onerror=alert(1)>', at: 1 });
  r.touched[0].file = 'src/<b>.ts';
  const html = unitCallsHtml(r, 'mindmakr/coordinator', 'run', 'u1');
  assert.ok(!html.includes('<img'), 'a name is text');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<b>.ts'));
  assert.match(html, new RegExp(`https://github.com/mindmakr/coordinator/blob/${head}/src/b.ts#L2`));
  assert.match(html, /Read from the code at one commit, never run/);
  const none = unitCallsHtml(null, null, 'run', 'u3');
  assert.match(none, /run\.mjs calls run u3/);
});

test('view: the maps page picks a unit with radio buttons, one panel each', () => {
  const r = unitCalls(repo, { unit: 'u1', base, head });
  const v = { id: 'run', repo: null, units: [{ id: 'u1' }, { id: 'u2' }] };
  const html = callsView(v, { calls: { list: () => [{ unit: 'u1', data: r }, { unit: 'gone', data: r }] }, unitHref: (id) => `units/${id}.html` });
  assert.equal((html.match(/type="radio"/g) ?? []).length, 1, 'only units of this run');
  assert.match(html, /#cv-0:checked\) \.cv-panel\.p0\{display:block\}/);
  assert.match(callsView(v, {}), /No unit has call data yet/);
});

test('cli: run.mjs calls records a unit, the unit page and the maps page show it', () => {
  const state = join(dir, 'state');
  mkdirSync(state);
  const env = { ...process.env, COORDINATOR_DIR: state };
  const run = (...a) => spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...a], { env, encoding: 'utf8' });
  assert.equal(run('init', 'r1', '--goal', 'calls', '--bar', 'b', '--fence', 'f', '--repo', 'mindmakr/coordinator').status, 0);
  assert.equal(run('add', 'r1', 'u1', '--bar', 'b').status, 0);
  assert.match(run('calls', 'r1', 'u1', '--root', repo).stderr, /nothing recorded says what u1 changed/);
  const out = run('calls', 'r1', 'u1', '--root', repo, '--base', base, '--head', head);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Service\.inner/);
  assert.match(run('calls', 'r1', 'u1', '--root', repo, '--base', '--upload-pack=x', '--head', head).stderr, /bad --base|--base/);
  const runDir = join(state, 'runs', 'r1');
  assert.ok(existsSync(join(runDir, 'map', 'calls', 'u1.json')));
  assert.ok(existsSync(join(runDir, 'map', 'calls-cache.json')));
  assert.match(readFileSync(join(runDir, 'units', 'u1.html'), 'utf8'), /Function calls[\s\S]*Service\.inner/);
  assert.match(readFileSync(join(runDir, 'maps.html'), 'utf8'), /id="map-calls"[\s\S]*Service\.inner/);
  const json = JSON.parse(run('calls', 'r1', 'u1', '--root', repo, '--base', base, '--head', head, '--json').stdout);
  assert.equal(json.touched[0].id, 'src/svc/service.ts#Service.inner');
  // map --unit: a build after the unit merged names the files it changed; their functions are the fallback.
  assert.equal(run('add', 'r1', 'u2', '--bar', 'b').status, 0);
  assert.equal(run('map', 'r1', '--root', repo).status, 0);
  writeFileSync(join(repo, 'cjs/use.js'), `${readFileSync(join(repo, 'cjs/use.js'), 'utf8')}\nexports.more = function () { return two(); };\n`);
git(repo, 'commit', '-qam', 'more'); // read at HEAD: the map build's files, at the commit the links name
  const built = run('map', 'r1', '--root', repo, '--unit', 'u2');
  assert.equal(built.status, 0, built.stderr);
  assert.equal(JSON.parse(built.stdout).calls.source, 'map build');
  const u2 = JSON.parse(readFileSync(join(runDir, 'map', 'calls', 'u2.json'), 'utf8'));
  assert.deepEqual(u2.touched.map((t) => t.q), ['go', 'more']);
});
