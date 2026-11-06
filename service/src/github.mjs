// GitHub, as the App (installation tokens, minted per use and never stored)
// and as the signed-in person (their user-to-server token). `fetch` is
// injectable so tests run against a fake GitHub.
import { createSign } from 'node:crypto';

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const enc = (full) => full.split('/').map(encodeURIComponent).join('/');

export class GitHubError extends Error {
  constructor(status, what) { super(`GitHub ${what}: HTTP ${status}`); this.status = status; }
}

export const SCOPES = {
  read: { contents: 'read', metadata: 'read' },                     // ingest
  comments: { issues: 'write', pull_requests: 'write', metadata: 'read' }, // tracker comments
  board: { organization_projects: 'write', issues: 'read', pull_requests: 'read', metadata: 'read' }, // board fields
  // c12: answers and notes from comment commands, committed to the state branch only (writes.mjs),
  // always minted for the state repo's id alone (repositoryIds).
  write: { contents: 'write', metadata: 'read' },
};

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

  // Each token is narrowed to the one job it is minted for (SCOPES), whatever the App holds,
  // and, given repositoryIds, to those repos only (a write token: the state repo alone).
  async function installationToken(installationId, permissions = SCOPES.read, { repositoryIds = null } = {}) {
    const body = { permissions, ...(repositoryIds ? { repository_ids: repositoryIds.map(Number) } : {}) };
    const r = await call(appJwt(), 'POST', `/app/installations/${Number(installationId)}/access_tokens`, body, 'installation token');
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
    // PKCE (S256): the challenge goes out with the browser, the verifier only with the exchange.
    authorizeUrl: (state, redirectUri, challenge) => `${web}/login/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state, allow_signup: 'false', code_challenge: challenge, code_challenge_method: 'S256' })}`,
    exchangeCode: (code, redirectUri, verifier) => oauth({ code, redirect_uri: redirectUri, code_verifier: verifier }),
    refresh: (refreshToken) => oauth({ grant_type: 'refresh_token', refresh_token: refreshToken }),

    // As the App, for ingest.
    installationToken,
    // c12 alerts: a person's permission on a repo, asked as the App ('admin', 'write', 'read' or 'none'; a 404 is 'none').
    async userPermission(token, fullName, login) {
      const r = await call(token, 'GET', `/repos/${fullName.split('/').map(encodeURIComponent).join('/')}/collaborators/${encodeURIComponent(login)}/permission`, null, 'user permission');
      if (r.status === 404) return 'none';
      return String(ok(r)?.permission ?? 'none');
    },
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

    // A file on the repo's default branch, or null (the project fence reads coordinator.json there).
    async defaultBranchFile(token, full, path) {
      const r = await call(token, 'GET', `/repos/${enc(full)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`);
      if (r.status === 404) return null;
      const j = ok(r);
      if (j?.type !== 'file' || j.encoding !== 'base64') return null;
      return Buffer.from(j.content, 'base64');
    },

    // Tracker comments (an issue's or a PR's conversation).
    issueComments: (token, full, n) => pages(token, `/repos/${enc(full)}/issues/${Number(n)}/comments`),
    createComment: async (token, full, n, body) => ok(await call(token, 'POST', `/repos/${enc(full)}/issues/${Number(n)}/comments`, { body }, 'create comment')).id,
    // false when the comment is gone (deleted by someone), so a new one is made.
    async updateComment(token, full, id, body) {
      const r = await call(token, 'PATCH', `/repos/${enc(full)}/issues/comments/${Number(id)}`, { body }, 'update comment');
      if (r.status === 404) return false;
      ok(r);
      return true;
    },
    // c12 alerts: removes the App's previous alert comment (a 404, already gone, is fine).
    async deleteComment(token, full, id) {
      const r = await call(token, 'DELETE', `/repos/${enc(full)}/issues/comments/${Number(id)}`, null, 'delete comment');
      if (r.status !== 404) ok(r);
    },
    async graphql(token, query, variables = {}) {
      const r = ok(await call(token, 'POST', '/graphql', { query, variables }, 'graphql'));
      if (r?.errors?.length) throw Object.assign(new Error(`GitHub graphql: ${String(r.errors[0].message).slice(0, 200)}`), { errors: r.errors });
      return r.data;
    },

    // c12 writes: the Git Data API, for one commit on the state branch (writes.mjs is the only caller).
    createBlob: async (token, full, buf) => ok(await call(token, 'POST', `/repos/${enc(full)}/git/blobs`, { content: Buffer.from(buf).toString('base64'), encoding: 'base64' }, 'create blob')).sha,
    createTree: async (token, full, baseTree, entries) => ok(await call(token, 'POST', `/repos/${enc(full)}/git/trees`, { base_tree: baseTree, tree: entries.map(({ path, sha }) => ({ path, mode: '100644', type: 'blob', sha })) }, 'create tree')).sha,
    createCommit: async (token, full, { message, tree, parents, author }) => ok(await call(token, 'POST', `/repos/${enc(full)}/git/commits`, { message, tree, parents, ...(author ? { author } : {}) }, 'create commit')).sha,
    // Moves a branch forward, never by force. false: the branch moved meanwhile (not a fast forward).
    async moveBranch(token, full, branch, sha) {
      const r = await call(token, 'PATCH', `/repos/${enc(full)}/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force: false }, 'update ref');
      if (r.status === 422 || r.status === 409) return false;
      ok(r);
      return true;
    },
    // c12 comment commands: what a user may do on a repo, and reactions on an issue or PR comment.
    async permission(token, full, login) {
      const r = await call(token, 'GET', `/repos/${enc(full)}/collaborators/${encodeURIComponent(login)}/permission`, null, 'permission');
      if (r.status === 404) return { push: false, permission: 'none' };
      const j = ok(r);
      return { push: j?.user?.permissions?.push === true || ['admin', 'maintain', 'write'].includes(j?.role_name ?? j?.permission), permission: String(j?.role_name ?? j?.permission ?? 'none') };
    },
    react: async (token, full, commentId, content) => { ok(await call(token, 'POST', `/repos/${enc(full)}/issues/comments/${Number(commentId)}/reactions`, { content }, 'reaction')); },

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
