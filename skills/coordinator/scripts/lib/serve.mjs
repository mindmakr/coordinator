// The live dashboard and answer page, on 127.0.0.1 only. Every request needs
// the token made at start (GET in the URL; POST in the form or a header); a
// POST also needs this page's own origin. Writes are callbacks (run.mjs passes
// its locked state code), so the page changes nothing the CLI could not.
// GET /                 the dashboard          GET /unit/<id>     a unit's page
// GET /coordinator      the coordinator's own page, across every run in the state folder
// GET /run/<run>[/unit/<id>]  another run's dashboard or unit page, read-only
// GET [/run/<run>]/map  a run's project map, when one is built
// GET /events?p=<path>  live updates (SSE)     GET [/run/<run>]/artifacts/<unit>/<file>  a stored screenshot or log
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { esc } from './links.mjs';
import { hub } from './live.mjs';
import { csp } from './parts.mjs';

export const HOST = '127.0.0.1';
const MAX_BODY = 64 * 1024;
const ID = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
const PAGE = new RegExp(`^/(?:coordinator|map|run/${ID}(?:/unit/${ID}|/map)?|unit/${ID})?const ID = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
const PAGE = new RegExp();
const ART = new RegExp(`^(?:/run/(${ID}))?/artifacts/([A-Za-z0-9_][A-Za-z0-9._-]{0,63})/([^/]+)$`);

const sameToken = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// same-origin, not no-referrer: under no-referrer a browser sends "Origin: null"
// on the form post, and the origin check would refuse every real answer.
function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((ok, fail) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { fail(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

const errorPage = (msg, back) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not saved</title>`
  + `<p>Not saved: ${esc(msg)}</p><p><a href="${esc(back)}">Back to the run</a></p>`;

const pathOf = (p) => { const m = PAGE.exec(p ?? ''); return m ? p : null; };

// page(path, { token, nonce }) returns the HTML or null; post[path](form) writes
// and returns the anchor to show next; file(target, name, run) returns { file, type }
// for an artifact the state names (run: null for the served run, else the run
// named in /run/<run>/…), or null; version() changes when any page's data does.
export function serve({ port = 0, page, post, file = () => null, version = () => '' }) {
  const token = randomBytes(24).toString('base64url');
  const live = hub({ version, render: (p) => page(p, { token, nonce: 'patch' }) });
  // No request can take the server down: every throw ends in a 400 or 500 for that request only.
  async function handle(req, res) {
    const { port: p } = server.address();
    const hosts = [`${HOST}:${p}`, `localhost:${p}`];
    if (!hosts.includes(req.headers.host)) return send(res, 403, 'wrong host');
    const home = `/?t=${token}`;
    let url;
    try { url = new URL(req.url, `http://${HOST}`); } catch { return send(res, 400, 'bad URL'); }
    try {
      if (req.method === 'GET' && url.pathname === '/favicon.ico') return send(res, 204, '');
      if (req.method === 'GET') {
        if (!sameToken(url.searchParams.get('t'), token)) return send(res, 403, 'missing or wrong token: open the link serve printed');
        if (url.pathname === '/events') {
          const at = pathOf(url.searchParams.get('p'));
          if (!at) return send(res, 400, 'bad page');
          return live.add(req, res, at);
        }
        const art = ART.exec(url.pathname);
        if (art) {
          const f = file(decodeURIComponent(art[2]), decodeURIComponent(art[3]), art[1] ?? null);
          if (!f) return send(res, 404, 'not found');
          return send(res, 200, readFileSync(f.file), { 'Content-Type': f.type, 'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox", 'Cache-Control': 'private, max-age=60' });
        }
        if (!pathOf(url.pathname)) return send(res, 404, 'not found');
        const nonce = randomBytes(16).toString('base64');
        const html = page(url.pathname, { token, nonce });
        if (html === null) return send(res, 404, 'not found');
        return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `${csp({ nonce })}; frame-ancestors 'none'` });
      }
      if (req.method !== 'POST' || !post[url.pathname]) return send(res, 404, 'not found');
      // Same origin only: a browser always sends Origin on a POST; anything else is refused.
      if (!hosts.map((h) => `http://${h}`).includes(req.headers.origin)) return send(res, 403, 'cross-origin request refused');
      if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return send(res, 403, 'cross-site request refused');
      if (!String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) return send(res, 415, 'form posts only');
      const form = new URLSearchParams(await readBody(req));
      if (!sameToken(req.headers['x-coordinator-token'] ?? form.get('t'), token)) return send(res, 403, 'missing or wrong token');
      let anchor;
      try { anchor = post[url.pathname](form); } catch (e) {
        return send(res, 400, errorPage(e.message, home), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'" });
      }
      const back = form.get('back');
      return send(res, 303, '', { Location: `${pathOf(back) && back !== '/' ? `${back}?t=${token}` : home}#${encodeURIComponent(anchor ?? '')}` });
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof URIError) return send(res, 400, 'bad URL'); // a malformed %-escape
      return send(res, e.message === 'too large' ? 413 : 500, e.message === 'too large' ? 'too large' : 'server error');
    }
  }
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(`serve: ${e?.message ?? e}`);
      try { if (res.headersSent) res.end(); else send(res, 500, 'server error'); } catch { /* the socket is gone */ }
    });
  });
  const close = server.close.bind(server);
  server.close = (cb) => { live.close(); return close(cb); }; // open event streams would hold it open
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, HOST, () => ok({ server, token, live, url: `http://${HOST}:${server.address().port}/?t=${token}` }));
  });
}
