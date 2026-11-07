// The local demo: the real service (createApp, the in-memory database, the parse worker,
// masking and caps) in front of a GitHub that lives in memory, fed with copies of real
// run folders. Two pretend people sign in, one who can answer and one who can only read;
// alerts land in an outbox page; a few controls play GitHub's and the lead's part by
// sending signed webhooks to the service's own /webhook. Nothing leaves the machine:
// the server listens on loopback only and no code path here reaches for the network.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guard } from '../db/index.mjs';
import { memoryDb } from '../db/memory.mjs';
import { refsOf } from '../ingest.mjs';
import { logger } from '../log.mjs';
import { createApp } from '../server.mjs';
import { fakeGitHub, fakeGitWrites } from './fakegithub.mjs';
import { demoGuard } from './guard.mjs';
import { copyRuns, leadAsks, pitStop, pullFrom, readFolder, writeFolder } from './runs.mjs';
import { controlsPage, outboxPage, signInPage, withBanner } from './ui.mjs';

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const APP_ID = '4242';
export const USERS = [
  { id: 101, login: 'ana', label: 'Ana, who can answer', can: 'Can push to every demo repo: the answer and note forms work, and write to the demo\'s pretend state branch.', push: true },
  { id: 102, login: 'ben', label: 'Ben, who can only read', can: 'Can read every demo repo but not push: the forms show, disabled, with the reason.', push: false },
];
const QUESTION = { question: 'Demo: should the lead keep going with the next unit?', header: 'Demo', options: ['go|keep going', 'wait|wait for me first'] };
const DEMO_PATH = /^\/demo(?:\/|$)/;

export async function freePort(host) {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, host, () => { const { port } = s.address(); s.close(() => ok(port)); });
  });
}

// Writes through html responses: the banner goes on every page, and the alerts page's
// "push to this device" (a real browser push service) gives way to a note about the outbox.
const PUSH_SECTION = /<section class="card"><h2>This device<\/h2>[\s\S]*?<\/section>/;
const demoize = (html) => withBanner(html.replace(PUSH_SECTION, '<section class="card"><h2>This device</h2><p class="meta">In the demo, push alerts go to the <a href="/demo/outbox">outbox</a>.</p></section>'));
function bannered(res) {
  const head = res.writeHead; let html = false;
  res.writeHead = function writeHead(status, ...rest) {
    const h = rest.find((x) => x && typeof x === 'object');
    html = /text\/html/i.test(String((h && (h['Content-Type'] ?? h['content-type'])) ?? res.getHeader('content-type') ?? ''));
    if (html && h) { delete h['Content-Length']; delete h['content-length']; }
    return head.call(this, status, ...rest);
  };
  const end = res.end;
  res.end = function endWithBanner(body, ...rest) {
    if (html && body !== undefined && body !== null && typeof body !== 'function') body = demoize(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
    return end.call(this, body, ...rest);
  };
}

// runs: run folders to copy. env: checked by demoGuard. → { url, close(), outbox, projects, app, gh }
// The copies hold raw logs, so they never outlive the demo: removed on close, on exit, and,
// after a hard kill, at the next start (a folder whose recorded pid is no longer running).
const PREFIX = 'coordinator-demo-';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export function sweepStale(root = tmpdir()) {
  const gone = [];
  for (const name of readdirSync(root)) {
    if (!name.startsWith(PREFIX)) continue;
    let pid;
    try { pid = Number(readFileSync(join(root, name, 'pid'), 'utf8').trim()); } catch { continue; }
    if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid && !alive(pid)) { rmSync(join(root, name), { recursive: true, force: true }); gone.push(name); }
  }
  return gone;
}

export async function startDemo({ runs = [], host = '127.0.0.1', port = 0, env = process.env, log = null, now = Date.now } = {}) {
  demoGuard({ host, env });
  if (!runs.length) throw new Error('give at least one run folder: --runs <project>/.coordinator/runs/<run>');
  const swept = sweepStale();
  const tmp = mkdtempSync(join(tmpdir(), PREFIX));
  writeFileSync(join(tmp, 'pid'), `${process.pid}\n`);
  const onExit = () => rmSync(tmp, { recursive: true, force: true });
  process.on('exit', onExit);
  try {
    const demo = await boot({ runs, host, port, log, now, tmp });
    const close = demo.close;
    return Object.assign(demo, { swept, async close() { await close(); process.off('exit', onExit); } });
  } catch (e) { onExit(); process.off('exit', onExit); throw e; }
}

async function boot({ runs, host, port, log, now, tmp }) {
  const { projects, skipped } = copyRuns(runs, tmp);
  if (!projects.length) throw new Error(`no run could be loaded: ${skipped.join('; ')}`);
  port ||= await freePort(host);
  const baseUrl = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const webhookSecret = randomBytes(24).toString('hex');
  const quiet = log ?? (() => { const l = logger(process.stderr); return { info() {}, warn: l.warn, error: l.error }; })();
  const config = {
    port, baseUrl, secure: false, trustProxy: false, trustedProxyHops: 1, databaseUrl: null, stateBranch: 'coordinator-state',
    accessTtlMs: 60_000, sessionDays: 1, maxConnections: 200, sessionSecret: randomBytes(48).toString('base64url'), resyncMs: 0,
    trail: { trackers: true, board: false }, webhookSources: 'any',
    // No fetch of GitHub's hook addresses: every delivery here comes from this process.
    hookSources: { any: true, trusted: () => false, start() {}, stop() {} },
    alerts: { smtp: null, vapid: null, sweepMs: 60_000, doorbellStreams: 50 },
    github: { appId: APP_ID, appSlug: null, webhookSecret, clientId: 'demo', clientSecret: 'demo', api: 'http://demo.invalid', web: 'https://github.com' },
  };

  // The pretend GitHub: one installation per owner, every repo private, both people can read all of them.
  const gh = fakeGitWrites(fakeGitHub());
  gh.authorizeUrl = (state) => `${baseUrl}/demo/sign-in?${new URLSearchParams({ state })}`;
  const installs = new Map();
  projects.forEach((p, i) => {
    const owner = p.repo.split('/')[0].toLowerCase();
    if (!installs.has(owner)) installs.set(owner, installs.size + 1);
    Object.assign(p, { installationId: installs.get(owner), repoId: 500 + i });
    gh.addRepo(p.repo, { id: p.repoId, installationId: p.installationId, files: {}, private: true });
  });
  for (const u of USERS) {
    gh.addUser(`tok-${u.login}`, { id: u.id, login: u.login, read: projects.map((p) => p.repo) });
    if (u.push) for (const p of projects) gh.allowPush(u.login, p.repo);
  }

  // Alerts land here instead of going out.
  const outbox = [];
  const keep = (channel, to, title, body) => { outbox.unshift({ at: now(), channel, to, title, body }); if (outbox.length > 500) outbox.pop(); };
  const senders = {
    email: { async send({ to, subject, text }) { keep('email', to, subject, text); } },
    push: { publicKey: 'demo', async send(sub, msg) { keep('web push', sub.endpoint.split('/').pop(), msg.title, `${msg.body}\n${msg.url}`); return 'sent'; } },
    github: { async send(inst, ref, login, body) { keep('GitHub mention', `@${login} on ${ref.repo}#${ref.n}`, 'A comment that mentions them', body); } },
  };

  const db = guard(memoryDb());
  const app = createApp({ config, db, gh, log: quiet, now, senders });
  const store = app.alerts.store;
  for (const u of USERS) {
    await store.putSettings(u.id, u.login, { email: `${u.login}@demo.invalid`, tz: 'UTC', quiet: null, includeText: true, channels: { push: true, email: true, github: true } });
    await store.addPush(u.id, { endpoint: `https://push.demo.invalid/${u.login}`, keys: { p256dh: 'demo', auth: 'demo' } });
    for (const p of projects) await store.subscribe(u.id, u.login, p.installationId, p.repoId, now());
  }
  for (const [owner, id] of installs) await db.upsertInstallation({ id, account: owner });

  // The first pit stop of every copied run, then the service reads the branches the normal way.
  const warnings = [...skipped];
  for (const p of projects) {
    for (const run of p.runs) { try { pitStop(p, run); } catch (e) { warnings.push(`${run.id}: ${e.message}`); } }
    gh.setFiles(p.repo, readFolder(p.branch));
  }
  for (const id of installs.values()) await app.ingest.syncInstallation(id);
  await app.idle();
  // What the service itself refused (a cap, a log that fails validation), as the hosted App would.
  for (const p of projects) for (const run of p.runs) {
    const row = await db.run(p.installationId, p.repoId, run.id);
    if (!row?.state) warnings.push(`${run.id}: the service did not load it${row?.error ? `: ${row.error}` : ''}`);
    else if (row.error) warnings.push(`${run.id}: the service kept an older copy: ${row.error}`);
  }

  const sign = (body) => `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`;
  let deliveries = 0;
  // Each delivery has its own id, in the header and in the body: the service skips a body it has seen
  // before (a replay), so two pushes or merges in a row must differ, as GitHub's own do.
  async function deliver(event, payload) {
    const id = `demo-${++deliveries}-${randomUUID()}`;
    const body = JSON.stringify({ ...payload, demo_delivery: id });
    const r = await fetch(`${baseUrl}/webhook`, { method: 'POST', body, headers: {
      'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': id, 'X-Hub-Signature-256': sign(body),
      'X-GitHub-Hook-Installation-Target-Type': 'integration', 'X-GitHub-Hook-Installation-Target-ID': APP_ID,
    } });
    const text = await r.text();
    await app.idle();
    return `${event}: ${r.status} ${text}`;
  }

  // The lead's loop on every copy: pull the web's answers and notes, (act), pit stop; then GitHub's push event.
  async function leadPush(act = null) {
    const out = [];
    for (const p of projects) {
      const before = await gh.ref(null, p.repo);
      writeFolder(p.branch, gh.repos.get(p.repo).files);
      for (const run of p.runs) {
        try { pullFrom(p, run); if (act) act(p, run); pitStop(p, run); } catch (e) { out.push(`${run.id}: ${e.message}`); }
      }
      gh.setFiles(p.repo, readFolder(p.branch));
      const after = await gh.ref(null, p.repo);
      out.push(await deliver('push', { ref: 'refs/heads/coordinator-state', before, after, head_commit: { id: after, timestamp: new Date(now()).toISOString() }, installation: { id: p.installationId }, repository: { id: p.repoId, full_name: p.repo, private: true } }));
    }
    return out.join(' · ');
  }

  async function states() {
    const out = [];
    for (const p of projects) for (const run of p.runs) out.push({ p, run, state: (await db.run(p.installationId, p.repoId, run.id))?.state ?? null });
    return out;
  }
  // 'owner/repo#n' → the installations whose runs link it.
  async function linked() {
    const refs = new Map();
    for (const { p, state } of await states()) for (const { key } of state ? refsOf(state) : []) refs.set(key, new Set([...(refs.get(key) ?? []), p.installationId]));
    return refs;
  }
  let checkId = 0;
  async function githubSays(kind, f) {
    const ref = String(f.get('ref') ?? '');
    const insts = (await linked()).get(ref);
    const m = /^([^#]+)#(\d+)$/.exec(ref);
    if (!insts || !m) return 'No run links that pull request.';
    const out = [];
    for (const id of insts) {
      const at = new Date(now()).toISOString();
      const base = { installation: { id }, repository: { id: 0, full_name: m[1] } };
      out.push(kind === 'merge'
        ? await deliver('pull_request', { ...base, action: 'closed', pull_request: { id: deliveries + 1, number: Number(m[2]), merged: f.get('how') !== 'closed', merged_at: at, closed_at: at, updated_at: at } })
        : await deliver('check_suite', { ...base, action: 'completed', check_suite: { id: ++checkId, conclusion: f.get('conclusion') === 'success' ? 'success' : 'failure', head_sha: 'demo', updated_at: at, pull_requests: [{ number: Number(m[2]) }] } }));
    }
    return out.join(' · ');
  }
  async function ask(f) {
    const [repo, id] = String(f.get('run') ?? '').split(' ');
    const p = projects.find((x) => x.repo === repo);
    const run = p?.runs.find((r) => r.id === id);
    if (!run) return 'No such run.';
    let asked = null;
    const said = await leadPush((pp, r) => { if (r === run) asked = leadAsks(pp, r, QUESTION); });
    return asked ? `The lead asked ${asked} on ${id}. ${said}` : said;
  }

  let flash = null;
  const ACTIONS = { '/demo/push': () => leadPush(), '/demo/merge': (f) => githubSays('merge', f), '/demo/checks': (f) => githubSays('checks', f), '/demo/ask': ask };
  const headers = (type = 'text/html; charset=utf-8') => ({ 'Content-Type': type, 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' });
  const readForm = (req) => new Promise((ok, fail) => {
    let s = ''; req.setEncoding('utf8');
    req.on('data', (c) => { s += c; if (s.length > 4096) { fail(new Error('too large')); req.destroy(); } });
    req.on('end', () => ok(new URLSearchParams(s))); req.on('error', fail);
  });
  async function demoRoute(req, res, url) {
    const p = url.pathname;
    if (req.method === 'GET' && p === '/demo/sign-in') {
      const state = url.searchParams.get('state') ?? '';
      res.writeHead(200, headers()); return res.end(signInPage(USERS, `${baseUrl}/auth/callback`, state));
    }
    if (req.method === 'GET' && (p === '/demo' || p === '/demo/')) {
      const open = (await states()).filter((x) => x.state && !x.state.closed).map((x) => [x.p.repo, x.run.id]);
      const html = controlsPage({ refs: [...(await linked()).keys()].sort(), open, flash });
      flash = null;
      res.writeHead(200, headers()); return res.end(html);
    }
    if (req.method === 'GET' && p === '/demo/outbox') { res.writeHead(200, headers()); return res.end(outboxPage(outbox)); }
    if (req.method === 'POST' && Object.hasOwn(ACTIONS, p)) {
      if (req.headers.origin !== baseUrl) { res.writeHead(403, headers('text/plain; charset=utf-8')); return res.end('cross-origin request refused'); }
      try { flash = await ACTIONS[p](await readForm(req)); } catch (e) { flash = `That did not work: ${e.message}`; }
      res.writeHead(303, { Location: '/demo', 'Cache-Control': 'no-store' }); return res.end();
    }
    res.writeHead(404, headers('text/plain; charset=utf-8')); return res.end('not found');
  }

  const inner = app.server.listeners('request')[0];
  app.server.removeAllListeners('request');
  app.server.on('request', (req, res) => {
    bannered(res);
    let url;
    try { url = new URL(req.url, baseUrl); } catch { return inner(req, res); }
    if (!DEMO_PATH.test(url.pathname)) return inner(req, res);
    demoRoute(req, res, url).catch((e) => { quiet.error('demo request failed', { error: e }); if (!res.headersSent) { res.writeHead(500, headers('text/plain; charset=utf-8')); } res.end('demo error'); });
  });
  await new Promise((ok, fail) => {
    app.server.once('error', (e) => fail(e.code === 'EADDRINUSE' ? new Error(`port ${port} is in use; pick another with --port`) : e));
    app.server.listen(port, host, ok);
  });
  app.startAlerts(config.alerts.sweepMs);

  let closed = false;
  return {
    url: baseUrl, outbox, projects, app, gh, db, warnings, tmp, deliver, leadPush,
    async close() {
      if (closed) return; closed = true;
      app.stopAlerts();
      await new Promise((ok) => { app.server.close(ok); app.server.closeAllConnections?.(); });
      await app.idle(); await app.ingest.close(); await db.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
