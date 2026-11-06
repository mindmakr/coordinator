// Test fixtures: a real run made with the skill's own CLI, a fake GitHub that
// serves a coordinator-state branch and answers permission questions, and an
// app wired to the in-memory database.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guard } from '../src/db/index.mjs';
import { memoryDb } from '../src/db/memory.mjs';
import { silent } from '../src/log.mjs';
import { createApp } from '../src/server.mjs';

const RUN_MJS = fileURLToPath(new URL('../../skills/coordinator/scripts/run.mjs', import.meta.url));
export const XSS = '<script>alert("x")</script>';

// Builds run `id` with the CLI and returns its events.jsonl bytes.
export function makeRun(id = 'r1', { goal = `Totals match ${XSS}`, closed = false } = {}) {
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
    cli('freeze', id);
    cli('start', id, 'u1');
    cli('built', id, 'u1', '--report', 'done');
    cli('verdict', id, 'u1', 'fail', '--evidence', 'test red', '--gap', `still wrong ${XSS}`, '--cause', 'stale cache', '--score', '4');
    if (closed) cli('close', id, '--outcome', 'stopped', '--reason', 'test');
    return readFileSync(join(dir, 'runs', id, 'events.jsonl'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Appends one valid event to a log (seq follows on).
export function appendEvent(buf, kind, payload, unit) {
  const seq = buf.toString('utf8').trim().split('\n').length + 1;
  return Buffer.concat([buf, Buffer.from(`${JSON.stringify({ v: 1, seq, at: new Date().toISOString(), kind, ...(unit ? { unit } : {}), payload })}\n`)]);
}

const sha = (b) => createHash('sha1').update(b).digest('hex');

// A fake GitHub at the level of src/github.mjs's interface. Each repo has the
// files of its state branch; each user token maps to a login and the repos it can read.
export function fakeGitHub() {
  const repos = new Map(); // fullName -> { id, installationId, files: Map(path -> Buffer) | null }
  const users = new Map(); // token -> { id, login, read: Set(fullName) }
  const calls = [];
  const blobs = new Map();
  const head = (r) => (r.files ? sha([...r.files].map(([p, b]) => `${p}:${sha(b)}`).sort().join('|')) : null);
  const repoOf = (full) => repos.get(full);
  const userOf = (t) => users.get(t);
  const it = async function* (xs) { yield* xs; };
  return {
    calls, repos, users,
    addRepo(fullName, { id, installationId, files = null }) { repos.set(fullName, { id, installationId, files: files && new Map(Object.entries(files)) }); },
    setFiles(fullName, files) { repoOf(fullName).files = new Map(Object.entries(files)); },
    addUser(token, { id, login, read = [] }) { users.set(token, { id, login, read: new Set(read) }); },

    authorizeUrl: (state, redirect) => `https://github.example/login/oauth/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirect)}`,
    async exchangeCode(code) { calls.push(['exchangeCode']); return { token: `tok-${code}`, refresh: `ref-${code}`, expiresAt: Date.now() + 8 * 3600_000, refreshExpiresAt: null }; },
    async refresh(r) { return { token: r.replace('ref-', 'tok-'), refresh: r, expiresAt: Date.now() + 8 * 3600_000, refreshExpiresAt: null }; },
    async installationToken(id) { calls.push(['installationToken', id]); return `inst-${id}`; },
    installationRepos(token) { const id = Number(token.slice(5)); return it([...repos].filter(([, r]) => r.installationId === id).map(([full_name, r]) => ({ id: r.id, full_name }))); },
    async ref(token, full) { calls.push(['ref', full]); const r = repoOf(full); return r ? head(r) : null; },
    async tree(token, full) {
      calls.push(['tree', full]);
      const r = repoOf(full);
      return { truncated: false, tree: [...r.files].map(([path, b]) => { blobs.set(sha(b), b); return { path, type: 'blob', sha: sha(b), size: b.length }; }) };
    },
    async blob(token, full, s) { calls.push(['blob', full, s]); return blobs.get(s); },
    async user(token) { const u = userOf(token); if (!u) throw new Error('bad token'); return { id: u.id, login: u.login }; },
    async repoAccess(token, full) {
      calls.push(['repoAccess', token, full]);
      const u = userOf(token); const r = repoOf(full);
      if (!u || !r || !u.read.has(full)) return { status: 404, repo: null };
      return { status: 200, repo: { id: r.id, full_name: full, permissions: { pull: true, push: false } } };
    },
    userInstallations(token) { const u = userOf(token); return it(u ? [...new Set([...u.read].map((f) => repoOf(f)?.installationId).filter(Boolean))].map((id) => ({ id })) : []); },
    userInstallationRepos(token, id) { const u = userOf(token); return it(u ? [...u.read].filter((f) => repoOf(f)?.installationId === id).map((f) => ({ id: repoOf(f).id, full_name: f, permissions: { pull: true } })) : []); },
  };
}

export const stateFiles = (runs) => ({
  '.coordinator-state': Buffer.from('v1\n'),
  'README.md': Buffer.from('# state\n'),
  ...Object.fromEntries(Object.entries(runs).map(([id, buf]) => [`runs/${id}/events.jsonl`, buf])),
});

export const config = (over = {}) => ({
  port: 0, baseUrl: 'http://localhost:3999', secure: false, trustProxy: false, databaseUrl: null, stateBranch: 'coordinator-state',
  accessTtlMs: 60_000, sessionDays: 7, sessionSecret: 'x'.repeat(48),
  github: { appId: '1', appSlug: 'coordinator-test', webhookSecret: 'hook-secret', clientId: 'cid', clientSecret: 'csec', api: 'x', web: 'https://github.example' },
  ...over,
});

export async function startApp({ gh = fakeGitHub(), db = guard(memoryDb()), over = {}, now } = {}) {
  const cfg = config(over);
  const app = createApp({ config: cfg, db, gh, log: silent, now });
  await new Promise((ok) => app.server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, gh, db, cfg, base, close: () => new Promise((ok) => app.server.close(ok)) };
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

