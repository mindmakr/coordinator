// The doorbell (design 3.2, option C): an outbound Server-Sent Events stream
// that tells a waiting `run.mjs watch` "run X changed", so it pulls the state
// branch now instead of at its next poll. It carries no content: only the run
// id, which the listener already knows. The repo stays the one source of truth;
// with no doorbell, polling still delivers.
//
// - POST /doorbell/token, with the person's GitHub token as a Bearer and
//   ?repo=owner/name: GitHub, asked with that token, must say they can read the
//   repo. The reply is a doorbell token for that one repo, valid TOKEN_MS. The
//   GitHub token is used for those two calls and never kept.
// - GET /doorbell?run=r1 with the doorbell token as a Bearer: the stream. It
//   ends when the token expires, so access is checked again at least that often.
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { REPO, isSafeId } from './core.mjs';
import { limiter } from './ratelimit.mjs';

export const TOKEN_MS = 15 * 60_000;
export const KEEPALIVE_MS = 25_000;
export const MAX_STREAMS_PER_USER = 10;

export function doorbell({ config, db, gh, log, now = Date.now }) {
  const key = Buffer.from(hkdfSync('sha256', config.sessionSecret, 'coordinator-service', 'doorbell', 32));
  const mac = (s) => createHmac('sha256', key).update(s).digest('base64url');
  const maxStreams = config.alerts?.doorbellStreams ?? 500;
  const mints = limiter({ max: 30, windowMs: 10 * 60_000, now });
  const streams = new Set(); // { res, inst, repo, run, user, timer, end }

  function sign(claims) {
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${body}.${mac(body)}`;
  }
  // The claims of a valid, unexpired token, else null.
  function verify(token) {
    const [body, sig] = String(token ?? '').split('.');
    if (!body || !sig || sig.length !== 43) return null;
    const want = Buffer.from(mac(body));
    if (!timingSafeEqual(want, Buffer.from(sig))) return null;
    try {
      const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return Number.isFinite(c.exp) && c.exp > now() ? c : null;
    } catch { return null; }
  }

  const bearer = (req) => /^Bearer ([^\s]{1,2000})$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? null;
  const reply = (res, status, body, headers) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }); res.end(JSON.stringify(body)); };

  async function mint(req, res, url, ip) {
    const wait = mints.hit(ip);
    if (wait) return reply(res, 429, { error: 'too many requests' }, { 'Retry-After': String(wait) });
    const ghToken = bearer(req);
    const full = String(url.searchParams.get('repo') ?? '');
    if (!ghToken) return reply(res, 401, { error: 'send your GitHub token as a Bearer' });
    if (!REPO.test(full)) return reply(res, 400, { error: 'repo must be owner/name' });
    const repo = await db.repoForPage(full); // the request names no installation; GitHub's answer below checks the id
    let user = null; let ok = false;
    try {
      user = await gh.user(ghToken);
      const r = await gh.repoAccess(ghToken, repo?.fullName ?? full);
      ok = !!repo && !!r.repo && Number(r.repo.id) === repo.id && r.repo.permissions?.pull === true;
    } catch { ok = false; }
    if (!ok) {
      if (user) await db.audit('doorbell.refused', { login: String(user.login), detail: { repo: full } });
      return reply(res, 404, { error: 'no such repo here, or you cannot read it' });
    }
    const exp = now() + TOKEN_MS;
    return reply(res, 200, { token: sign({ u: Number(user.id), l: String(user.login), i: repo.installationId, r: repo.id, exp }), expiresAt: new Date(exp).toISOString(), repo: repo.fullName });
  }

  function listen(req, res, url) {
    const c = verify(bearer(req));
    if (!c) return reply(res, 401, { error: 'missing, wrong or expired doorbell token' });
    const run = url.searchParams.get('run');
    if (run !== null && !isSafeId(run)) return reply(res, 400, { error: 'bad run id' });
    const mine = [...streams].filter((s) => s.user === c.u);
    if (mine.length >= MAX_STREAMS_PER_USER) mine[0].end(); // the oldest gives way: a restarted watch is not locked out
    if (streams.size >= maxStreams) return reply(res, 503, { error: 'too many listeners; poll instead' }, { 'Retry-After': '60' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`retry: 5000\nevent: ready\ndata: {}\n\n`);
    const s = { res, inst: c.i, repo: c.r, run, user: c.u };
    const keep = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);
    const expire = setTimeout(() => { res.write('event: expired\ndata: {}\n\n'); s.end(); }, Math.max(0, c.exp - now()));
    s.end = () => { clearInterval(keep); clearTimeout(expire); streams.delete(s); res.end(); };
    req.on('close', () => { clearInterval(keep); clearTimeout(expire); streams.delete(s); });
    streams.add(s);
    log?.info('doorbell open', { login: c.l, run: run ?? '*' });
  }

  return {
    verify, sign,
    // Handles /doorbell routes; false for any other path.
    async route(req, res, url, ip) {
      if (url.pathname === '/doorbell/token' && req.method === 'POST') { await mint(req, res, url, ip); return true; }
      if (url.pathname === '/doorbell' && req.method === 'GET') { listen(req, res, url); return true; }
      return false;
    },
    // "Run X changed" to every listener on that repo (and that run, when they named one).
    ring(installationId, repoId, runIds) {
      let n = 0;
      for (const s of streams) {
        if (s.inst !== installationId || s.repo !== repoId) continue;
        for (const run of runIds) if (s.run === null || s.run === run) { s.res.write(`event: changed\ndata: ${JSON.stringify({ run })}\n\n`); n++; }
      }
      return n;
    },
    size: () => streams.size,
    close() { for (const s of [...streams]) s.end(); },
  };
}
