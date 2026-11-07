// Test fixtures: a real run made with the skill's own CLI, a fake GitHub that
// serves a coordinator-state branch and answers permission questions, and an
// app wired to the in-memory database.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guard } from '../src/db/index.mjs';
import { fakeGitHub } from '../src/demo/fakegithub.mjs';
import { memoryDb } from '../src/db/memory.mjs';
import { silent } from '../src/log.mjs';
import { createApp } from '../src/server.mjs';

const RUN_MJS = fileURLToPath(new URL('../../skills/coordinator/scripts/run.mjs', import.meta.url));
export const XSS = '<script>alert("x")</script>';

// Builds run `id` with the CLI and returns its events.jsonl bytes.
// links: GitHub refs for u1 ('acme/web#12' or a URL; a /pull/ URL is a PR); file: attach an evidence file to u1.
// mapOut: an object that gets .map, the run's project map log (run.mjs map --pit-stop over a tiny project).
export function makeRun(id = 'r1', { goal = `Totals match ${XSS}`, closed = false, issues = [], prs = [], file = false, mapOut = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'coord-svc-'));
  const cli = (...a) => {
    const r = spawnSync(process.execPath, [RUN_MJS, ...a], { cwd: dir, env: { ...process.env, COORDINATOR_DIR: dir }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`run.mjs ${a.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  try {
    cli('init', id, '--goal', goal, '--bar', 'tests pass', '--fence', 'web only', '--repo', 'acme/web');
    cli('add', id, 'u1', '--bar', `the total is right <img src=x onerror=alert(1)>`, '--title', 'Totals');
    cli('ask', id, '--question', `Which total? ${XSS}`, '--header', 'Total', '--option', 'server|use the server total', '--option', 'client|sum on the client');
    for (const x of issues) cli('link', id, 'u1', '--issue', x);
    for (const x of prs) cli('link', id, 'u1', '--pr', x);
    if (file) { const f = join(dir, 'run-log.txt'); writeFileSync(f, 'log'); cli('evidence', id, 'u1', '--file', f, '--kind', 'log', '--label', 'full log'); }
    cli('freeze', id);
    cli('start', id, 'u1');
    cli('built', id, 'u1', '--report', 'done');
    cli('verdict', id, 'u1', 'fail', '--evidence', 'test red', '--gap', `still wrong ${XSS}`, '--cause', 'stale cache', '--score', '4');
    if (mapOut) {
      const root = join(dir, 'project', 'src');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'a.ts'), "import { b } from './b';\nexport const a = () => b() + process.env.API_TOKEN_NAME;\n");
      writeFileSync(join(root, 'b.ts'), "export function b() { return '<script>alert(1)</script>'; }\n");
      cli('map', id, '--root', join(dir, 'project'), '--pit-stop');
      mapOut.map = readFileSync(join(dir, 'runs', id, 'pit-stop', 'map', 'events.jsonl'));
    }
    if (closed) cli('close', id, '--outcome', 'stopped', '--reason', 'test');
    return readFileSync(join(dir, 'runs', id, 'events.jsonl'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Appends one valid event to a log (seq follows on).
export function appendEvent(buf, kind, payload, unit) {
  const seq = buf.toString('utf8').trim().split('\n').length + 1;
  return Buffer.concat([buf, Buffer.from(`${JSON.stringify({ v: 1, seq, at: new Date().toISOString(), kind, ...(unit ? { unit } : {}), payload })}\n`)]);
}

// The fake GitHub moved to src/demo/fakegithub.mjs, so the local demo can use it too.
export { fakeGitHub };

export const stateFiles = (runs, config = null) => ({
  '.coordinator-state': Buffer.from('v1\n'),
  'README.md': Buffer.from('# state\n'),
  ...Object.fromEntries(Object.entries(runs).map(([id, buf]) => [`runs/${id}/events.jsonl`, buf])),
  ...(config ? { 'coordinator.json': Buffer.from(JSON.stringify(config)) } : {}),
});

export const config = (over = {}) => ({
  port: 0, baseUrl: 'http://localhost:3999', secure: false, trustProxy: false, databaseUrl: null, stateBranch: 'coordinator-state',
  accessTtlMs: 60_000, sessionDays: 7, sessionSecret: 'x'.repeat(48),
  github: { appId: '1', appSlug: 'coordinator-test', webhookSecret: 'hook-secret', clientId: 'cid', clientSecret: 'csec', api: 'x', web: 'https://github.example' },
  ...over,
});

// With TEST_DATABASE_URL set, every app gets Postgres in a throwaway schema of its own; else memory.
let schemas = 0;
async function testDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return guard(memoryDb());
  const { postgresDb } = await import('../src/db/postgres.mjs');
  return guard(await postgresDb(url, { max: 3, schema: `t_${process.pid}_${++schemas}_${Date.now() % 100000}` }));
}

// senders (c12): fake alert senders { email, push, github }; without them email and push are off (no settings).
export async function startApp({ gh = fakeGitHub(), db = null, over = {}, now, senders } = {}) {
  db ??= await testDb();
  const cfg = config(over);
  const app = createApp({ config: cfg, db, gh, log: silent, now: now ?? Date.now, senders });
  await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, gh, db, cfg, base, close: async () => { await new Promise((ok) => app.server.close(ok)); await app.idle(); await app.ingest.close(); await db.close(); } };
}

// Signs in through the real OAuth routes against the fake GitHub; returns the cookie header.
export async function signIn(t, code) {
  const start = await fetch(`${t.base}/login`, { redirect: 'manual' });
  const oauth = start.headers.get('set-cookie').split(';')[0];
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const back = await fetch(`${t.base}/auth/callback?code=${code}&state=${state}`, { headers: { Cookie: oauth }, redirect: 'manual' });
  assert.equal(back.status, 302, await back.text());
  return back.headers.getSetCookie().find((c) => c.startsWith('coordinator=')).split(';')[0];
}

