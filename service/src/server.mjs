// The HTTP side: webhook, sign-in, and the read-only pages. Node's own http
// server; every response carries a strict CSP and no-store, every POST from a
// browser needs the session's CSRF token and this site's Origin, and webhook
// and sign-in routes are rate limited per client address.
import { createServer } from 'node:http';
import { REPO, isSafeId, questions } from './core.mjs';
import { access as makeAccess } from './access.mjs';
import { ingester } from './ingest.mjs';
import { coordinatorPage, landing, messagePage, projectsPage, repoBase, runPage, runsPage, unitView } from './pages.mjs';
import { limiter } from './ratelimit.mjs';
import { parseCookies, sessions as makeSessions } from './session.mjs';
import { verifySignature, webhooks as makeWebhooks } from './webhook.mjs';

const MAX_WEBHOOK = 5 * 1024 * 1024;
const MAX_FORM = 4 * 1024;
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const ROUTE = /^\/r\/([^/]+)\/([^/]+)(?:\/(coordinator|sync)|\/run\/([^/]+)(?:\/unit\/([^/]+))?)?\/?$/;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function readBody(req, max) {
  return new Promise((ok, fail) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { fail(new HttpError(413, 'too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

export function createApp({ config, db, gh, log, now = Date.now }) {
  const ingest = ingester({ db, gh, branch: config.stateBranch, log });
  const hooks = makeWebhooks({ db, ingest, branch: config.stateBranch, log });
  const auth = makeSessions({ db, gh, config, log, now });
  const acl = makeAccess({ gh, db, ttlMs: config.accessTtlMs, now });
  const limits = {
    webhook: limiter({ max: 300, windowMs: 60_000, now }),
    auth: limiter({ max: 30, windowMs: 10 * 60_000, now }),
    sync: limiter({ max: 6, windowMs: 10 * 60_000, now }),
    pages: limiter({ max: 600, windowMs: 60_000, now }),
  };
  const pending = new Set();
  const background = (fn) => {
    const p = Promise.resolve().then(fn).catch((e) => log.error('background work failed', { error: e }));
    pending.add(p); p.finally(() => pending.delete(p));
  };

  const headers = (extra = {}) => ({
    'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store', 'Cross-Origin-Opener-Policy': 'same-origin',
    ...(config.secure ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}), ...extra,
  });
  const send = (res, status, body, extra = {}) => { res.writeHead(status, headers({ 'Content-Type': 'text/plain; charset=utf-8', ...extra })); res.end(body); };
  const html = (res, status, body, extra = {}) => send(res, status, body, { 'Content-Type': 'text/html; charset=utf-8', ...extra });
  const redirect = (res, status, location, cookies = []) => { res.writeHead(status, headers({ Location: location, ...(cookies.length ? { 'Set-Cookie': cookies } : {}) })); res.end(); };

  // Behind Dokploy's proxy (TRUST_PROXY=1) the last X-Forwarded-For entry is the one the proxy added.
  const clientIp = (req) => (config.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean).at(-1) : null) ?? req.socket.remoteAddress ?? '-';
  const limited = (res, which, key) => {
    const wait = limits[which].hit(key);
    if (!wait) return false;
    send(res, 429, 'too many requests', { 'Retry-After': String(wait) });
    return true;
  };
  // A browser POST: this site's origin, same-site fetch, a form body, and the session's CSRF token.
  async function form(req, user) {
    if (req.headers.origin !== config.baseUrl) throw new HttpError(403, 'cross-origin request refused');
    if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw new HttpError(403, 'cross-site request refused');
    if (!String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) throw new HttpError(415, 'form posts only');
    const f = new URLSearchParams((await readBody(req, MAX_FORM)).toString('utf8'));
    if (!auth.validCsrf(user, f.get('csrf'))) throw new HttpError(403, 'missing or wrong form token; reload the page');
    return f;
  }

  async function webhook(req, res) {
    if (limited(res, 'webhook', clientIp(req))) return;
    const raw = await readBody(req, MAX_WEBHOOK);
    if (!verifySignature(config.github.webhookSecret, raw, req.headers['x-hub-signature-256'])) {
      log.warn('webhook signature refused', { ip: clientIp(req) });
      return send(res, 401, 'bad signature');
    }
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, 'not JSON'); }
    const event = String(req.headers['x-github-event'] ?? '');
    const delivery = String(req.headers['x-github-delivery'] ?? '').slice(0, 100) || null;
    const r = await hooks.handle(event, delivery, payload);
    send(res, r.status, r.body);
    log.info('webhook', { event, delivery, status: r.status, result: r.body });
    if (r.work) background(r.work);
  }

  // A repo page: the person must be signed in and able to read the repo on GitHub; otherwise 404.
  async function repoRoute(req, res, url, m, user) {
    const [, owner, name, kind, runRaw, unitRaw] = m;
    const fullName = `${decodeURIComponent(owner)}/${decodeURIComponent(name)}`;
    const run = runRaw === undefined ? null : decodeURIComponent(runRaw);
    const unit = unitRaw === undefined ? null : decodeURIComponent(unitRaw);
    if (!REPO.test(fullName) || (run !== null && !isSafeId(run)) || (unit !== null && !isSafeId(unit))) return notFound(res, user);
    if (!user) {
      if (req.method !== 'GET') throw new HttpError(403, 'sign in first');
      return redirect(res, 302, `/login?next=${encodeURIComponent(url.pathname)}`);
    }
    const repo = await acl.readable(user, fullName);
    if (!repo) {
      await db.audit('access.refused', { login: user.login, detail: { repo: fullName } });
      return notFound(res, user);
    }
    if (kind === 'sync') {
      if (req.method !== 'POST') return notFound(res, user);
      await form(req, user);
      if (limited(res, 'sync', String(user.userId))) return;
      await ingest.syncRepo(repo.installationId, repo);
      return redirect(res, 303, repoBase(repo.fullName));
    }
    if (req.method !== 'GET') return notFound(res, user);
    const n = now();
    if (kind === 'coordinator') return html(res, 200, coordinatorPage(user, repo, await db.runs(repo.installationId, repo.id), n));
    if (run === null) return html(res, 200, runsPage(user, repo, await db.runs(repo.installationId, repo.id), n));
    const row = await db.run(repo.installationId, repo.id, run);
    if (!row?.state) return notFound(res, user);
    const out = unit === null ? runPage(user, repo, row, n) : unitView(user, repo, row, unit, n);
    return out === null ? notFound(res, user) : html(res, 200, out);
  }

  const notFound = (res, user) => html(res, 404, messagePage('Not found', 'There is nothing here, or you cannot read it on GitHub.', user));

  async function home(res, user) {
    if (!user) return html(res, 200, landing());
    const repos = await acl.projects(user);
    const counts = new Map();
    for (const r of repos) {
      const rows = await db.runs(r.installationId, r.id);
      const open = rows.filter((x) => x.state && !x.state.closed);
      const needs = open.reduce((k, x) => k + questions(x.state).filter((q) => q.open).length, 0);
      counts.set(`${r.installationId}:${r.id}`, { runs: rows.length, open: open.length, needs });
    }
    const installUrl = config.github.appSlug ? `${config.github.web}/apps/${encodeURIComponent(config.github.appSlug)}/installations/new` : null;
    return html(res, 200, projectsPage(user, repos, { counts, installUrl }));
  }

  async function handle(req, res) {
    let url;
    try { url = new URL(req.url, config.baseUrl); } catch { return send(res, 400, 'bad URL'); }
    const p = url.pathname;
    if (req.method === 'POST' && p === '/webhook') return webhook(req, res);
    if (req.method === 'GET' && p === '/healthz') return send(res, 200, 'ok');
    if (req.method === 'GET' && p === '/favicon.ico') return send(res, 204, '');
    if (limited(res, 'pages', clientIp(req))) return;
    if (req.method === 'GET' && p === '/login') {
      if (limited(res, 'auth', clientIp(req))) return;
      const b = auth.begin(url.searchParams.get('next'));
      return redirect(res, 302, b.location, [b.cookie]);
    }
    if (req.method === 'GET' && p === '/auth/callback') {
      if (limited(res, 'auth', clientIp(req))) return;
      try {
        const r = await auth.finish(url.searchParams, parseCookies(req.headers.cookie));
        log.info('signed in', { login: r.login });
        return redirect(res, 302, r.next, r.cookies);
      } catch (e) {
        log.warn('sign-in failed', { error: e });
        return html(res, e.status ?? 502, messagePage('Sign-in failed', e.status ? e.message : 'GitHub did not complete the sign-in; try again.'));
      }
    }
    const user = await auth.current(parseCookies(req.headers.cookie));
    if (req.method === 'POST' && p === '/logout') {
      if (user) await form(req, user);
      if (user) acl.forget(user.userId);
      return redirect(res, 303, '/', [await auth.end(user)]);
    }
    if (req.method === 'GET' && p === '/') return home(res, user);
    const m = ROUTE.exec(p);
    if (m) return repoRoute(req, res, url, m, user);
    return notFound(res, user);
  }

  const server = createServer((req, res) => {
    const t = now();
    handle(req, res).catch((e) => {
      const status = e instanceof HttpError ? e.status : e instanceof URIError ? 400 : 500;
      if (status === 500) log.error('request failed', { method: req.method, path: req.url.split('?')[0], error: e });
      if (res.headersSent) return res.end();
      return send(res, status, status === 500 ? 'server error' : e.message);
    }).finally(() => {
      if (req.url.split('?')[0] !== '/healthz') log.info('request', { method: req.method, path: req.url.split('?')[0].slice(0, 200), status: res.statusCode, ms: now() - t });
    });
  });

  return {
    server, ingest,
    // Resolves once every background sync started so far has finished (tests, shutdown).
    idle: async () => { while (pending.size) await Promise.all([...pending]); },
  };
}
