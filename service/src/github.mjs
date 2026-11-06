// GitHub, as the App (installation tokens, minted per use and never stored)
// and as the signed-in person (their user-to-server token). `fetch` is
// injectable so tests run against a fake GitHub.
import { createSign } from 'node:crypto';

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const enc = (full) => full.split('/').map(encodeURIComponent).join('/');

export class GitHubError extends Error {
  constructor(status, what) { super(`GitHub ${what}: HTTP ${status}`); this.status = status; }
}

export function github({ appId, privateKey, clientId, clientSecret, api, web, fetch: f = globalThis.fetch }) {
  // The App's own JWT: RS256, issued a minute back for clock drift, valid 9 minutes.
  function appJwt(nowS = Math.floor(Date.now() / 1000)) {
    const data = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iat: nowS - 60, exp: nowS + 540, iss: String(appId) })}`;
    const sig = createSign('RSA-SHA256').update(data).sign(privateKey).toString('base64url');
    return `${data}.${sig}`;
  }

  async function call(token, method, path, body, what = path.split('?')[0]) {
    const res = await f(`${api}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'coordinator-service',
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, json, what };
  }
  const ok = (r) => { if (r.status >= 200 && r.status < 300) return r.json; throw new GitHubError(r.status, r.what); };

  // Read-only scope on every token minted here: the read model needs nothing more.
  const READ = { contents: 'read', metadata: 'read' };
  async function installationToken(installationId) {
    const r = await call(appJwt(), 'POST', `/app/installations/${Number(installationId)}/access_tokens`, { permissions: READ }, 'installation token');
    return ok(r).token;
  }

  async function* pages(token, path, key) {
    for (let p = 1; p <= 10; p++) {
      const r = ok(await call(token, 'GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${p}`));
      const items = key ? r[key] : r;
      yield* items;
      if (items.length < 100) return;
    }
  }

  async function oauth(params) {
    const res = await f(`${web}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'coordinator-service' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, ...params }),
      signal: AbortSignal.timeout(20_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) throw new GitHubError(res.status, 'sign-in');
    const now = Date.now();
    return {
      token: j.access_token, refresh: j.refresh_token ?? null,
      expiresAt: j.expires_in ? now + j.expires_in * 1000 : null,
      refreshExpiresAt: j.refresh_token_expires_in ? now + j.refresh_token_expires_in * 1000 : null,
    };
  }

  return {
    appJwt,
    authorizeUrl: (state, redirectUri) => `${web}/login/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state, allow_signup: 'false' })}`,
    exchangeCode: (code, redirectUri) => oauth({ code, redirect_uri: redirectUri }),
    refresh: (refreshToken) => oauth({ grant_type: 'refresh_token', refresh_token: refreshToken }),

    // As the App, for ingest.
    installationToken,
    installationRepos: (token) => pages(token, '/installation/repositories', 'repositories'),
    // The branch tip, or null when the branch does not exist.
    async ref(token, full, branch) {
      const r = await call(token, 'GET', `/repos/${enc(full)}/git/ref/heads/${encodeURIComponent(branch)}`);
      if (r.status === 404 || r.status === 409) return null; // 409: an empty repo
      return ok(r).object.sha;
    },
    tree: async (token, full, sha) => ok(await call(token, 'GET', `/repos/${enc(full)}/git/trees/${encodeURIComponent(sha)}?recursive=1`)),
    async blob(token, full, sha) {
      const j = ok(await call(token, 'GET', `/repos/${enc(full)}/git/blobs/${encodeURIComponent(sha)}`));
      if (j.encoding !== 'base64') throw new Error(`blob ${sha}: unexpected encoding`);
      return Buffer.from(j.content, 'base64');
    },

    // As the person.
    user: async (token) => ok(await call(token, 'GET', '/user')),
    // What this person may do on the repo: null when GitHub will not show it to them.
    async repoAccess(token, full) {
      const r = await call(token, 'GET', `/repos/${enc(full)}`);
      if ([401, 403, 404].includes(r.status)) return { status: r.status, repo: null };
      return { status: r.status, repo: ok(r) };
    },
    userInstallations: (token) => pages(token, '/user/installations', 'installations'),
    userInstallationRepos: (token, id) => pages(token, `/user/installations/${Number(id)}/repositories`, 'repositories'),
  };
}
