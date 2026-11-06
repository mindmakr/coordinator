// The local answer page: the HUD plus forms, served on 127.0.0.1 only.
// Every request needs the token made at start; a POST also needs this page's
// own origin. The writes are callbacks (run.mjs passes its locked state code),
// so the page changes nothing the CLI could not.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { esc } from './hud.mjs';

export const HOST = '127.0.0.1';
const MAX_BODY = 64 * 1024;

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

// page({ token, nonce }) returns the HTML; post[path](form) writes and returns
// the anchor to show next. Resolves with the server and its URL once listening.
export function serve({ port = 0, page, post }) {
  const token = randomBytes(24).toString('base64url');
  const server = createServer(async (req, res) => {
    const { port: p } = server.address();
    const hosts = [`${HOST}:${p}`, `localhost:${p}`];
    if (!hosts.includes(req.headers.host)) return send(res, 403, 'wrong host');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const home = `/?t=${token}`;
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        if (!sameToken(url.searchParams.get('t'), token)) return send(res, 403, 'missing or wrong token: open the link serve printed');
        const nonce = randomBytes(16).toString('base64');
        return send(res, 200, page({ token, nonce }), {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
        });
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
      return send(res, 303, '', { Location: `${home}#${encodeURIComponent(anchor ?? '')}` });
    } catch (e) {
      return send(res, e.message === 'too large' ? 413 : 500, e.message === 'too large' ? 'too large' : 'server error');
    }
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, HOST, () => ok({ server, token, url: `http://${HOST}:${server.address().port}/?t=${token}` }));
  });
}
