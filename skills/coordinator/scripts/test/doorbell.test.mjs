// watch --remote: the doorbell client (SSE over node:http) and the pull loop.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bellConfig, listen, repoName, sseParser } from '../lib/doorbell.mjs';
import { remoteWatch } from '../lib/remote.mjs';

const RUN = fileURLToPath(new URL('../run.mjs', import.meta.url));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); } };

test('sseParser: events split across chunks, comments skipped, CRLF accepted', () => {
  const got = [];
  const feed = sseParser((e, d) => got.push([e, d]));
  feed(': keepalive\n\nevent: chan'); feed('ged\ndata: {"run":"r1"}\n'); feed('\nevent: ready\r\ndata: {}\r\n\r\n');
  assert.deepEqual(got, [['changed', '{"run":"r1"}'], ['ready', '{}']]);
});

test('repoName and bellConfig: owner/name from a remote; the service must be https or localhost', () => {
  assert.equal(repoName('git@github.com:acme/web.git'), 'acme/web');
  assert.equal(repoName('https://github.com/acme/web'), 'acme/web');
  assert.equal(repoName('acme/web'), 'acme/web');
  assert.equal(repoName('https://gitlab.com/acme/web'), null);
  const base = mkdtempSync(join(tmpdir(), 'coord-bell-'));
  try {
    assert.match(bellConfig({ base, project: base, env: {} }).why, /no service/);
    assert.match(bellConfig({ base, project: base, env: { COORDINATOR_SERVICE: 'http://coord.example.com' } }).why, /https/);
    writeFileSync(join(base, 'coordinator.json'), JSON.stringify({ service: 'https://coord.example.com/x', stateRepo: 'acme/state' }));
    assert.deepEqual(bellConfig({ base, project: base, env: {} }), { service: 'https://coord.example.com', repo: 'acme/state' });
    assert.deepEqual(bellConfig({ base, project: base, env: { COORDINATOR_SERVICE: 'http://127.0.0.1:9' } }), { service: 'http://127.0.0.1:9', repo: 'acme/state' });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('remoteWatch: pulls at once, on every tick and on every ring; a failure is reported once', async () => {
  let pulls = 0; let fail = null; const said = []; let ring;
  const w = remoteWatch({ everyMs: 60_000, say: (x) => said.push(x), pullOnce: () => { pulls++; if (fail) throw new Error(fail); }, startBell: (r) => { ring = r; return { stop() {} }; } });
  try {
    assert.equal(pulls, 1, 'at start');
    ring(); assert.equal(pulls, 2, 'a ring pulls now');
    fail = 'no run r1 in coordinator-state\nmore';
    ring(); ring();
    assert.deepEqual(said, ['pull failed: no run r1 in coordinator-state'], 'once per distinct error');
    fail = null; ring();
    assert.equal(said.at(-1), 'pull works again');
  } finally { w.stop(); }
});

// A stand-in for the service's two doorbell routes.
function fakeService({ allow = true } = {}) {
  const streams = new Set(); const seen = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push([req.method, url.pathname, req.headers.authorization]);
    if (url.pathname === '/doorbell/token') {
      if (!allow) { res.writeHead(404); return res.end('{}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ token: 'bell-1', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: ready\ndata: {}\n\n');
    streams.add(res); req.on('close', () => streams.delete(res));
  });
  return { server, seen, streams, ring: (run) => { for (const s of streams) s.write(`event: changed\ndata: ${JSON.stringify({ run })}\n\n`); } };
}

test('listen: mints with the GitHub token, listens with the doorbell token, rings only for its run', async () => {
  const f = fakeService();
  await new Promise((ok) => f.server.listen(0, '127.0.0.1', ok));
  const said = []; let rings = 0;
  const l = listen({ service: `http://127.0.0.1:${f.server.address().port}`, repo: 'acme/web', run: 'r1', token: () => 'gh-secret', onRing: () => rings++, say: (x) => said.push(x) });
  try {
    await until(() => said.includes('doorbell on'));
    assert.deepEqual(f.seen.map((x) => x.slice(0, 2)), [['POST', '/doorbell/token'], ['GET', '/doorbell']]);
    assert.equal(f.seen[0][2], 'Bearer gh-secret');
    assert.equal(f.seen[1][2], 'Bearer bell-1', 'the GitHub token goes only to the mint');
    f.ring('r2'); f.ring('r1');
    await until(() => rings === 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(rings, 1, 'r2 is not ours');
  } finally { l.stop(); for (const s of f.streams) s.destroy(); f.server.close(); }
});

test('listen: with no token or no service, it says so once and leaves polling to do the work', async () => {
  const said = [];
  const l = listen({ service: 'http://127.0.0.1:9', repo: 'acme/web', run: 'r1', token: () => null, onRing: () => {}, say: (x) => said.push(x) });
  l.stop();
  assert.deepEqual(said, ['doorbell off: no GitHub token (gh auth login, or GH_TOKEN); polling only']);
  const said2 = [];
  const l2 = listen({ service: 'http://127.0.0.1:9', repo: 'acme/web', run: 'r1', token: () => 'x', onRing: () => {}, say: (x) => said2.push(x), minRetryMs: 10_000 });
  try { await until(() => said2.length === 1); assert.match(said2[0], /doorbell unreachable .*polling only/); } finally { l2.stop(); }
});

test('watch --remote: an answer pushed from another machine is printed within the poll interval, with no doorbell', { timeout: 60_000 }, async () => {
  const project = mkdtempSync(join(tmpdir(), 'coord-watch-'));
  const git = (...a) => spawnSync('git', a, { cwd: project, encoding: 'utf8' });
  const env = (dir) => ({ ...process.env, COORDINATOR_DIR: dir, COORDINATOR_SERVICE: '' });
  const cli = (dir, ...a) => { const r = spawnSync(process.execPath, [RUN, ...a], { cwd: project, env: env(dir), encoding: 'utf8' }); if (r.status !== 0) throw new Error(`${a.join(' ')}: ${r.stderr}`); return r.stdout; };
  let watch;
  try {
    git('init', '-q'); git('commit', '-q', '--allow-empty', '-m', 'x');
    const a = join(project, '.ca'); const b = join(project, '.cb');
    mkdirSync(a); mkdirSync(b);
    cli(a, 'init', 'r1', '--goal', 'g', '--bar', 'b', '--fence', 'f');
    cli(a, 'ask', 'r1', '--question', 'Which?', '--header', 'Which', '--option', 'x|first', '--option', 'y|second');
    cli(a, 'push', 'r1'); // no remote: the local coordinator-state branch
    cli(b, 'pull', 'r1');
    let out = '';
    watch = spawn(process.execPath, [RUN, 'watch', 'r1', '--remote', '--every', '10'], { cwd: project, env: env(a) });
    watch.stdout.on('data', (c) => { out += c; });
    await until(() => out.includes('remote: doorbell off'), 10_000);
    cli(b, 'answer', 'r1', 'q1', '--choice', 'y');
    cli(b, 'push', 'r1');
    const at = Date.now();
    await until(() => /answer q1 by person: y/.test(out), 30_000);
    assert.ok(Date.now() - at < 15_000, 'within one poll interval and a local tick');
  } finally {
    if (watch && watch.exitCode === null) { const gone = new Promise((ok) => watch.once('exit', ok)); watch.kill(); await gone; }
    rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('AGENTS.md names every skill file that opens a network connection', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const here = fileURLToPath(new URL('..', import.meta.url));
  const agents = readFileSync(join(here, '..', '..', '..', 'AGENTS.md'), 'utf8');
  const files = readdirSync(join(here, 'lib')).filter((f) => f.endsWith('.mjs'));
  const callers = files.filter((f) => /\b(https?)\.request\(|\bnode:net\b|execFileSync\('gh'|exec\('gh'|'ls-remote'|globalThis\.fetch\b|\bfetch\(/.test(readFileSync(join(here, 'lib', f), 'utf8')));
  assert.deepEqual(callers.sort(), ['doctor.mjs', 'doorbell.mjs', 'helpercall.mjs', 'statesync.mjs']);
  assert.match(agents, /scripts\/doctor\.mjs/);
  assert.match(agents, /lib\/doorbell\.mjs/);
  assert.match(agents, /lib\/helpercall\.mjs/);
  assert.match(agents, /run\.mjs push` and `pull`/);
});
