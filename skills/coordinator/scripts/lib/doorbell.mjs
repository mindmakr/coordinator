// The doorbell's listening end (design 3.2, option C): `watch --remote` keeps an
// outbound Server-Sent Events stream open to the coordinator service, and when it
// says "run X changed" pulls the state branch at once instead of at the next poll.
// It carries no content; the repo stays the source of truth, and without the
// service (or with any error) polling still delivers. Node built-ins only.
//
// Settings: COORDINATOR_SERVICE (or "service" in .coordinator/coordinator.json) is
// the service's URL; the state repo is "stateRepo" there or the git remote. The
// person's own GitHub token (GH_TOKEN, GITHUB_TOKEN or `gh auth token`) is sent
// only to mint a short-lived doorbell token for that one repo.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

// owner/name from "owner/name", a GitHub URL or an ssh remote; null otherwise.
export function repoName(spec) {
  const s = String(spec ?? '').trim();
  if (REPO.test(s)) return s.replace(/\.git$/, '');
  const m = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(s);
  return m && REPO.test(m[1]) ? m[1] : null;
}

// { service, repo } when a doorbell is configured, else null with the reason in .why.
export function bellConfig({ base, project, env = process.env }) {
  let cfg = {};
  const file = join(base, 'coordinator.json');
  try { if (existsSync(file)) cfg = JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch { cfg = {}; }
  const service = env.COORDINATOR_SERVICE || cfg.service || null;
  if (!service) return { why: 'no service configured (COORDINATOR_SERVICE)' };
  let url;
  try { url = new URL(service); } catch { return { why: `not a URL: ${service}` }; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return { why: 'the service must be https (http only on localhost)' };
  let repo = repoName(cfg.stateRepo);
  if (!repo) {
    try { repo = repoName(execFileSync('git', ['remote', 'get-url', cfg.remote ?? 'origin'], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { repo = null; }
  }
  if (!repo) return { why: 'cannot tell the state repo (set "stateRepo" in .coordinator/coordinator.json)' };
  return { service: url.origin, repo };
}

// The person's GitHub token, or null.
export function ghToken(env = process.env) {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return env.GH_TOKEN || env.GITHUB_TOKEN;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim() || null; } catch { return null; }
}

// Feeds bytes in, calls onEvent(event, data) per complete Server-Sent Event.
export function sseParser(onEvent) {
  let buf = ''; let event = 'message'; let data = [];
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.search(/\r?\n/)) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + (buf[i] === '\r' ? 2 : 1));
      if (line === '') { if (data.length) onEvent(event, data.join('\n')); event = 'message'; data = []; continue; }
      if (line.startsWith(':')) continue;
      const c = line.indexOf(':'); const field = c < 0 ? line : line.slice(0, c); const value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
      if (field === 'event') event = value; else if (field === 'data') data.push(value);
    }
    if (buf.length > 64 * 1024) buf = ''; // a line this long is not ours
  };
}

function send(method, url, headers, timeout) {
  return new Promise((ok, fail) => {
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers: { 'User-Agent': 'coordinator-skill', ...headers }, timeout }, ok);
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', fail);
    req.end();
  });
}
const readAll = (res) => new Promise((ok) => { let s = ''; res.setEncoding('utf8'); res.on('data', (c) => { if (s.length < 65_536) s += c; }); res.on('end', () => ok(s)); res.on('error', () => ok(s)); });

// Starts listening; onRing() for every "changed" on `run`. say(line) reports a state change once
// (connected, lost, refused). Returns { stop() }. Reconnects with backoff; re-mints when the token expires.
export function listen({ service, repo, run, token = () => ghToken(), onRing, say = () => {}, minRetryMs = 1000, maxRetryMs = 60_000 }) {
  let stopped = false; let current = null; let timer = null; let fails = 0; let last = '';
  const tell = (line) => { if (line !== last) { last = line; say(line); } };
  const later = (ms) => { if (!stopped) timer = setTimeout(connect, ms); };
  const backoff = () => Math.min(maxRetryMs, minRetryMs * 2 ** Math.min(fails++, 10));

  async function connect() {
    if (stopped) return;
    try {
      const gh = token();
      if (!gh) { tell('doorbell off: no GitHub token (gh auth login, or GH_TOKEN); polling only'); return later(maxRetryMs); }
      const m = await send('POST', `${service}/doorbell/token?repo=${encodeURIComponent(repo)}`, { Authorization: `Bearer ${gh}`, Accept: 'application/json' }, 20_000);
      const body = await readAll(m);
      if (m.statusCode !== 200) { tell(`doorbell refused (HTTP ${m.statusCode}); polling only`); return later(m.statusCode === 429 ? maxRetryMs : Math.max(backoff(), m.statusCode < 500 ? maxRetryMs : 0)); }
      const { token: bellToken } = JSON.parse(body);
      const res = await send('GET', `${service}/doorbell?run=${encodeURIComponent(run)}`, { Authorization: `Bearer ${bellToken}`, Accept: 'text/event-stream' }, 0);
      if (res.statusCode !== 200) { res.resume(); tell(`doorbell refused (HTTP ${res.statusCode}); polling only`); return later(backoff()); }
      current = res;
      res.setEncoding('utf8');
      let expired = false;
      res.on('data', sseParser((event, data) => {
        if (event === 'ready') { fails = 0; tell('doorbell on'); }
        if (event === 'expired') expired = true;
        if (event === 'changed') { try { if (JSON.parse(data).run === run) onRing(); } catch { /* not ours */ } }
      }));
      // Idle for longer than two keepalives: the connection is dead even if no error says so.
      let idle = setTimeout(() => res.destroy(), 60_000);
      res.on('data', () => { clearTimeout(idle); idle = setTimeout(() => res.destroy(), 60_000); });
      res.on('close', () => {
        clearTimeout(idle); current = null;
        if (stopped) return;
        if (expired) return later(0); // a fresh token, and a fresh access check
        tell('doorbell lost; polling until it is back');
        later(backoff());
      });
    } catch (e) {
      tell(`doorbell unreachable (${e.message}); polling only`);
      later(backoff());
    }
  }
  connect();
  return { stop() { stopped = true; clearTimeout(timer); current?.destroy(); } };
}
