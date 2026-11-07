// The HTTP side: webhook, sign-in, and the read-only pages. Node's own http
// server; every response carries a strict CSP and no-store, every POST from a
// browser needs the session's CSRF token and this site's Origin, and webhook
// and sign-in routes are rate limited per client address.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { REPO, isSafeId, questions } from './core.mjs';
import { access as makeAccess } from './access.mjs';
import { ingester } from './ingest.mjs';
import { trail } from './trail.mjs';
import { REPO_PAGES, landing, mapsView, messagePage, projectsPage, repoBase, runPage, runsPage, unitView } from './pages.mjs';
import { refsOf } from './ingest.mjs';
import { limiter } from './ratelimit.mjs';
import { parseCookies, sessions as makeSessions } from './session.mjs';
import { verifySignature, webhooks as makeWebhooks } from './webhook.mjs';
import { groupOf, hookSources } from './hooksource.mjs';
import { WriteError, writer as makeWriter } from './writes.mjs';
import { commands as makeCommands } from './commands.mjs';
import { doorbell as makeDoorbell } from './doorbell.mjs';
import { alerts as makeAlerts } from './alerts/index.mjs';
import { alertRoutes } from './alerts/routes.mjs';
import { senders as makeSenders } from './alerts/senders.mjs';

const MAX_WEBHOOK = 5 * 1024 * 1024;
export const MAX_WEBHOOK_INFLIGHT = 32 * 1024 * 1024; // every webhook body being read at once, together
// c14: the bodies one address group (IPv4 /24, IPv6 /64) outside GitHub's hook ranges is sending at once.
// Sized so filling the budget takes 52 groups (26 MB outside the reserve), or 64 with WEBHOOK_SOURCES=any.
export const MAX_WEBHOOK_PER_IP = 512 * 1024;
export const WEBHOOK_RESERVE = 6 * 1024 * 1024; // c14: the part of the budget only GitHub's hook addresses may use
export const SMALL_WEBHOOK = 64 * 1024; // c14: WEBHOOK_SOURCES=any: a body declared this size or less may use the reserve
export const WEBHOOK_BODY_MS = 10_000; // c14: a webhook body must arrive in full this soon (GitHub waits 10 s)
const MAX_FORM = 4 * 1024;
const MAX_WRITE_FORM = 16 * 1024; // c12: an answer or note of 1000 characters, percent-encoded
const WRITE_ROUTES = new Set(['answer', 'note']); // c12: POST /r/<owner>/<repo>/run/<run>/answer|note
const BACK = /^\/unit\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_REPOS_PER_VIEW = 20; // distinct linked repos whose access is checked for one page view
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const ROUTE = /^\/r\/([^/]+)\/([^/]+)(?:\/([a-z][a-z-]{0,30})|\/run\/([^/]+)(?:\/unit\/([^/]+)|\/(maps)|\/([a-z][a-z-]{0,30}))?)?\/?$/;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// budget (webhooks): an account from webhookBudget().open(); a body that would take its client
// address or the whole budget past the limit is refused, so many large posts at once cannot fill
// the memory however few of them carry a valid signature.
// deadlineMs: the whole body must have arrived by then, else 408 (a stalled body holds nothing for long).
function readBody(req, max, budget = null, deadlineMs = 0) {
  return new Promise((ok, fail) => {
    let size = 0; let done = false; const chunks = [];
    let timer = null;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); budget?.release(); fn(v); };
    const refuse = (e) => { finish(fail, e); req.destroy(); };
    if (deadlineMs) timer = setTimeout(() => refuse(new HttpError(408, 'the body took too long')), deadlineMs);
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      const over = budget ? budget.add(c.length) : null;
      if (size > max) refuse(new HttpError(413, 'too large'));
      else if (over) refuse(over);
      else chunks.push(c);
    });
    req.on('end', () => finish(ok, Buffer.concat(chunks)));
    req.on('error', (e) => finish(fail, e));
    req.on('close', () => finish(fail, new HttpError(400, 'the request ended early')));
  });
}

// c14: the bytes of every webhook body being read at once: all together at most max, of which the
// last `reserve` bytes take only bodies from GitHub's hook addresses. A source is { group, github }:
// a group outside GitHub holds at most perGroup bytes, so stalling bodies from a few addresses (or
// every address of one IPv6 /64) cannot fill the budget, and nothing outside GitHub reaches the
// reserve. With WEBHOOK_SOURCES=any nobody is known to be GitHub: every group is capped, and the
// reserve takes bodies declared `small` or less from anyone.
export function webhookBudget({ max = MAX_WEBHOOK_INFLIGHT, perGroup = MAX_WEBHOOK_PER_IP, reserve = WEBHOOK_RESERVE, small = SMALL_WEBHOOK, any = false } = {}) {
  const total = { used: 0, peak: 0, max };
  const byGroup = new Map(); // group → bytes
  const mayReserve = (src, declared) => (any ? Number.isFinite(declared) && declared <= small : src.github);
  // Why `bytes` more cannot be taken now (an HttpError), or null.
  const refusal = (src, bytes, declared) => {
    if (!src.github && (byGroup.get(src.group) ?? 0) + bytes > perGroup) return new HttpError(429, 'too many bodies at once from this address; try again');
    if (total.used + bytes > max - (mayReserve(src, declared) ? 0 : reserve)) return new HttpError(503, 'busy; try again');
    return null;
  };
  return {
    stats: () => ({ ...total, addresses: byGroup.size }),
    // Before reading: whether a body of the declared length could be taken at all.
    refusal(src, declared) {
      if (!Number.isFinite(declared)) return null;
      if (!src.github && declared > perGroup) return new HttpError(413, 'too large from this address');
      return refusal(src, declared, declared);
    },
    open(src, declared) {
      let held = 0;
      return {
        add(n) {
          const no = refusal(src, n, declared);
          held += n; total.used += n; total.peak = Math.max(total.peak, total.used);
          if (!src.github) byGroup.set(src.group, (byGroup.get(src.group) ?? 0) + n);
          return no;
        },
        release() {
          total.used -= held;
          if (!src.github) { const left = (byGroup.get(src.group) ?? 0) - held; if (left > 0) byGroup.set(src.group, left); else byGroup.delete(src.group); }
          held = 0;
        },
      };
    },
  };
}

// senders (tests): { email, push, github } in place of the ones built from the settings.
export function createApp({ config, db, gh, log, now = Date.now, senders = null }) {
  const github = trail({ db, gh, config, log, now });
  // c12: the doorbell rings and alerts are worked out for every run a sync changed.
  const bell = makeDoorbell({ config, db, gh, log, now, ...(config.doorbellRecheckMs ? { recheckMs: config.doorbellRecheckMs } : {}) });
  const alerts = makeAlerts({ db, gh, config, log, now, send: senders ?? makeSenders({ config, gh }) });
  const onChange = (installationId, repo, changes) => {
    bell.ring(installationId, repo.id, changes.map((c) => c.runId));
    background(() => alerts.runsChanged(installationId, repo, changes));
  };
  const ingest = ingester({ db, gh, branch: config.stateBranch, log, trail: github, onChange });
  const acl = makeAccess({ gh, db, ttlMs: config.accessTtlMs, now });
  // c12: answers and notes, from the HUD and from comment commands.
  const writes = makeWriter({ db, gh, config, ingest, acl, log, now });
  const commands = makeCommands({ db, gh, writes, log, now });
  const forget = async (id) => { await alerts.forgetInstallation(id); bell.forgetInstallation(id); };
  const hooks = makeWebhooks({ db, ingest, branch: config.stateBranch, log, commands, alerts, forget });
  const auth = makeSessions({ db, gh, config, log, now });
  const alertPages = alertRoutes({ alerts, acl, db, config, send: alerts.send, now, log });
  const limits = {
    webhookFailures: limiter({ max: 30, windowMs: 60_000, now }),
    auth: limiter({ max: 30, windowMs: 10 * 60_000, now }),
    sync: limiter({ max: 6, windowMs: 10 * 60_000, now }),
    pages: limiter({ max: 600, windowMs: 60_000, now }),
  };
  // c14: GitHub's hook addresses (WEBHOOK_SOURCES); tests may pass their own.
  const sources = config.hookSources ?? hookSources({ mode: config.webhookSources ?? 'github', api: config.github.api, log });
  const inflight = webhookBudget({
    max: config.webhookInflightBytes ?? MAX_WEBHOOK_INFLIGHT,
    perGroup: config.webhookPerIpBytes ?? MAX_WEBHOOK_PER_IP,
    reserve: config.webhookReserveBytes ?? WEBHOOK_RESERVE,
    any: sources.any,
  });
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
  // c14: behind a CDN and then the proxy (TRUSTED_PROXY_HOPS=2) each appended one, so the client's is
  // that many from the end. Fewer entries than hops: the request skipped a hop, and the first entry is
  // the address the first proxy saw.
  const clientIp = (req) => {
    if (config.trustProxy) {
      const list = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      const ip = list.at(-(config.trustedProxyHops ?? 1)) ?? list[0];
      if (ip) return ip;
    }
    return req.socket.remoteAddress ?? '-';
  };
  // c14: the key every per-address limit counts under: one IPv6 /64 is one client.
  const clientKey = (req) => groupOf(clientIp(req));
  const limited = (res, which, key) => {
    const wait = limits[which].hit(key);
    if (!wait) return false;
    send(res, 429, 'too many requests', { 'Retry-After': String(wait) });
    return true;
  };
  // A browser POST: this site's origin, same-site fetch, a form body, and the session's CSRF token.
  async function form(req, user, max = MAX_FORM) {
    if (req.headers.origin !== config.baseUrl) throw new HttpError(403, 'cross-origin request refused');
    if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw new HttpError(403, 'cross-site request refused');
    if (!String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) throw new HttpError(415, 'form posts only');
    const f = new URLSearchParams((await readBody(req, max)).toString('utf8'));
    if (!auth.validCsrf(user, f.get('csrf'))) throw new HttpError(403, 'missing or wrong form token; reload the page');
    return f;
  }

  // The signature is always checked first (5 MB cap, constant-time compare). A delivery that
  // verifies is never rate limited: GitHub sends every App's hooks from a few shared addresses,
  // so refused deliveries from one of them (someone else's hook pointed here) must never block
  // ours. Only refused requests are counted and limited.
  //
  // An address whose refusals are over the limit is answered before its body is read, unless the
  // request names this App as its target (X-GitHub-Hook-Installation-Target-ID, which GitHub sets on
  // every App delivery): someone else's App delivering here from GitHub's shared addresses is
  // turned away unread, ours still gets through. c14: the header counts only from GitHub's hook
  // addresses, so from anywhere else it skips nothing (with WEBHOOK_SOURCES=any it buys a read within
  // the address group's share of the budget and a signature check). A body not in full within
  // WEBHOOK_BODY_MS, cut short, or too large counts as a refusal for its address, like a bad signature.
  async function webhook(req, res) {
    const addr = clientIp(req);
    const ip = groupOf(addr); // the refusal limiter's key
    const src = { group: groupOf(addr, { v4Bits: 24 }), github: sources.trusted(addr) }; // the budget's
    const close = { Connection: 'close' };
    const length = Number(req.headers['content-length']);
    if (length > MAX_WEBHOOK) return send(res, 413, 'too large', close);
    // c14: the header is believed only from GitHub's hook addresses (from anyone with WEBHOOK_SOURCES=any).
    const ours = (src.github || sources.any) && String(req.headers['x-github-hook-installation-target-id'] ?? '') === String(config.github.appId);
    const wait = ours ? 0 : limits.webhookFailures.blocked(ip);
    if (wait) return send(res, 429, 'too many requests', { ...close, 'Retry-After': String(wait) });
    const full = inflight.refusal(src, length);
    if (full) {
      if (full.status === 413) limits.webhookFailures.hit(ip);
      return send(res, full.status, full.message, { ...close, ...(full.status === 413 ? {} : { 'Retry-After': '5' }) });
    }
    let raw;
    try {
      raw = await readBody(req, MAX_WEBHOOK, inflight.open(src, length), config.webhookBodyMs ?? WEBHOOK_BODY_MS);
    } catch (e) {
      if (e instanceof HttpError && e.status !== 503) limits.webhookFailures.hit(ip);
      if (e instanceof HttpError && e.status === 408) log.warn('webhook body too slow', { ip });
      throw e;
    }
    if (!verifySignature(config.github.webhookSecret, raw, req.headers['x-hub-signature-256'])) {
      if (limited(res, 'webhookFailures', ip)) return;
      log.warn('webhook signature refused', { ip });
      return send(res, 401, 'bad signature');
    }
    let payload;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, 'not JSON'); }
    const event = String(req.headers['x-github-event'] ?? '');
    const delivery = String(req.headers['x-github-delivery'] ?? '').slice(0, 100) || null;
    // A signed body sent again under a new delivery id is a replay: it is skipped like a redelivery.
    const r = await hooks.handle(event, delivery, payload, `sha256:${createHash('sha256').update(raw).digest('hex')}`);
    send(res, r.status, r.body);
    log.info('webhook', { event, delivery, status: r.status, result: r.body });
    if (r.work) background(r.work);
  }

  // A repo page: the person must be signed in and able to read the repo on GitHub; otherwise 404.
  async function repoRoute(req, res, url, m, user) {
    const [, owner, name, kind, runRaw, unitRaw, maps, runKind] = m;
    if (kind && kind !== 'sync' && REPO_PAGES[kind]?.scope !== 'repo') return notFound(res, user);
    if (runKind && !WRITE_ROUTES.has(runKind) && (!Object.hasOwn(REPO_PAGES, runKind) || REPO_PAGES[runKind].scope !== 'run')) return notFound(res, user);
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
    if (run !== null && WRITE_ROUTES.has(runKind)) return writeRoute(req, res, user, repo, run, runKind);
    if (req.method !== 'GET') return notFound(res, user);
    const n = now();
    if (kind) return html(res, 200, REPO_PAGES[kind].render(user, repo, await db.runs(repo.installationId, repo.id), n));
    if (run === null) return html(res, 200, runsPage(user, repo, await db.runs(repo.installationId, repo.id), n));
    const row = await db.run(repo.installationId, repo.id, run);
    if (!row?.state) return notFound(res, user);
    if (runKind) return REPO_PAGES[runKind].has(row) ? html(res, 200, REPO_PAGES[runKind].render(user, repo, row, n)) : notFound(res, user);
    const gh = await githubEvents(user, repo, row.state);
    // c12: the run and unit pages carry the answer and note forms, disabled with the reason for readers.
    const viewer = !maps && !row.state.closed ? { ...user, write: await writes.canWrite(user, repo) } : user;
    const out = maps ? mapsView(user, repo, row, n, gh) : unit === null ? runPage(viewer, repo, row, n, gh) : unitView(viewer, repo, row, unit, n, gh);
    return out === null ? notFound(res, user) : html(res, 200, out);
  }

  // c12: an answer or a note from the HUD, committed to the state branch with the person's own token.
  async function writeRoute(req, res, user, repo, run, kind) {
    if (req.method !== 'POST') return notFound(res, user);
    const f = await form(req, user, MAX_WRITE_FORM);
    const runBase = `${repoBase(repo.fullName)}/run/${encodeURIComponent(run)}`;
    const back = BACK.test(f.get('back') ?? '') ? `${runBase}${f.get('back')}` : runBase;
    try {
      await writes.fromHud(user, repo, run, kind, f);
    } catch (e) {
      if (!(e instanceof WriteError)) throw e;
      return html(res, e.status, messagePage(kind === 'answer' ? 'Answer not saved' : 'Note not saved', e.message, user, back), e.status === 429 ? { 'Retry-After': '60' } : {});
    }
    const q = f.get('q');
    return redirect(res, 303, kind === 'answer' && back === runBase && /^q\d{1,4}$/.test(q ?? '') ? `${back}#${q}` : back);
  }

  // GitHub's events for the issues and PRs the run's units link, from this installation only,
  // and only for repos this viewer can read too (a linked repo may be more private than the run's).
  // Access is checked only for repos that have events, and for at most MAX_REPOS_PER_VIEW of them;
  // the rest show no GitHub lines rather than cost the viewer's token one call each.
  async function githubEvents(user, repo, state) {
    const refs = refsOf(state);
    if (!refs.length) return [];
    const events = await db.ghEvents(repo.installationId, [...new Set(refs.map((r) => r.key))]);
    const byKey = new Map();
    for (const e of events) byKey.set(e.refKey, [...(byKey.get(e.refKey) ?? []), e]);
    const home = repo.fullName.toLowerCase();
    const allowed = new Map([[home, true]]);
    let checked = 0;
    const out = [];
    for (const { unit, key } of refs) {
      const list = byKey.get(key);
      if (!list) continue;
      const name = key.split('#')[0];
      if (!allowed.has(name)) allowed.set(name, checked++ < MAX_REPOS_PER_VIEW && !!(await acl.readable(user, name)));
      if (allowed.get(name)) out.push({ unit, events: list });
    }
    return out;
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
    if (p.startsWith('/doorbell') && await bell.route(req, res, url, clientKey(req))) return; // c12: its own limits
    if (limited(res, 'pages', clientKey(req))) return;
    if (req.method === 'GET' && p === '/login') {
      if (limited(res, 'auth', clientKey(req))) return;
      const b = auth.begin(url.searchParams.get('next'));
      return redirect(res, 302, b.location, [b.cookie]);
    }
    if (req.method === 'GET' && p === '/auth/callback') {
      if (limited(res, 'auth', clientKey(req))) return;
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
    // c12: the alerts pages (src/alerts/routes.mjs).
    if (await alertPages.route(req, res, url, { user, form, html, send, redirect, readBody, validCsrf: auth.validCsrf, message: (t, x, action) => messagePage(t, x, user, null, action) })) return;
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

  // One slow or idle client cannot hold the process: bounded connections and request time.
  server.maxConnections = config.maxConnections ?? 1000;
  server.requestTimeout = 30_000;
  server.headersTimeout = 20_000;

  // Every installation re-read from GitHub: a missed or failed delivery heals at the next pass.
  // Unchanged branch tips cost one ref read each.
  async function resyncAll() {
    const out = [];
    for (const id of await db.installationIds()) {
      try { out.push({ installation: id, repos: await ingest.syncInstallation(id) }); } catch (e) {
        log.warn('resync failed', { installation: id, error: e });
        out.push({ installation: id, error: e.message });
      }
    }
    return out;
  }
  let timer = null;
  let running = false;
  let alertTimer = null;
  let sweeping = false;
  return {
    server, ingest, resyncAll, alerts, doorbell: bell,
    webhookBytes: () => inflight.stats(), // tests: the in-flight budget, and its high-water mark
    // c14: fetches GitHub's hook addresses now and once a day (WEBHOOK_SOURCES=github).
    startHookSources() { sources.start(); },
    stopHookSources() { sources.stop(); },
    // c12: the alerts sweep (leads gone quiet, digests due), every ALERT_SWEEP_SECONDS.
    startAlerts(everyMs) {
      alertTimer = setInterval(() => { if (!sweeping) { sweeping = true; background(() => alerts.sweep().finally(() => { sweeping = false; })); } }, everyMs);
      alertTimer.unref?.();
    },
    stopAlerts() { if (alertTimer) clearInterval(alertTimer); alertTimer = null; bell.close(); },
    // Starts the periodic resync (main.mjs; RESYNC_MINUTES, default 15). One pass at a time.
    startResync(everyMs) {
      timer = setInterval(() => {
        if (running) return;
        running = true;
        background(() => resyncAll().finally(() => { running = false; }));
      }, everyMs);
      timer.unref?.();
    },
    stopResync() { if (timer) clearInterval(timer); timer = null; },
    // Resolves once every background sync started so far has finished (tests, shutdown).
    idle: async () => { while (pending.size) await Promise.all([...pending]); },
  };
}
