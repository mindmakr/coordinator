// A GitHub that lives in memory, at the level of src/github.mjs's interface: the
// tests' stand-in, and the local demo's (src/demo.mjs). Each repo has the files of
// its state branch; each user token maps to a login and the repos it can read.
// fakeGitWrites adds what answers and notes need: the Git Data API (blobs, trees,
// commits, a branch that only moves forward), push access per user, collaborator
// permissions and comment reactions. Nothing here touches the network.
import { createHash } from 'node:crypto';

const sha = (b) => createHash('sha1').update(b).digest('hex');

// A fake GitHub at the level of src/github.mjs's interface. Each repo has the
// files of its state branch; each user token maps to a login and the repos it can read.
export function fakeGitHub() {
  const repos = new Map(); // fullName -> { id, installationId, files: Map(path -> Buffer) | null }
  const users = new Map(); // token -> { id, login, read: Set(fullName) }
  const calls = [];
  const comments = new Map(); // 'owner/repo#n' -> [{ id, body, performed_via_github_app }]
  let nextComment = 1000;
  const board = { project: null, items: new Map(), values: [] }; // a fake Projects v2 board
  const blobs = new Map();
  const head = (r) => (r.files ? sha([...r.files].map(([p, b]) => `${p}:${sha(b)}`).sort().join('|')) : null);
  const repoOf = (full) => repos.get(full);
  const userOf = (t) => users.get(t);
  const it = async function* (xs) { yield* xs; };
  return {
    calls, repos, users, comments, board,
    // An org board with a Status field; items: 'owner/repo#n' keys on the board.
    makeBoard({ items = [], fields = [] } = {}) {
      board.project = { id: 'P1', fields: { nodes: [{ id: 'F-status', name: 'Status', dataType: 'SINGLE_SELECT', options: [{ id: 'o-prog', name: 'In progress' }, { id: 'o-done', name: 'Done' }] }, ...fields] } };
      for (const k of items) board.items.set(k, `I-${k}`);
    },
    async graphql(token, query, v) {
      calls.push(['graphql', /(?:query|mutation) (\w+)/.exec(query)[1], token]);
      if (query.includes('CoordinatorProject')) return { organization: { projectV2: board.project } };
      if (query.includes('CoordinatorItems')) {
        const item = board.items.get(`${v.owner}/${v.name}#${v.number}`.toLowerCase());
        return { repository: { issueOrPullRequest: { projectItems: { nodes: item ? [{ id: item, project: { id: 'P1' } }] : [] } } } };
      }
      if (query.includes('CoordinatorField')) {
        board.project.fields.nodes.push({ id: `F-${v.name}`, name: v.name, dataType: v.type, ...(v.options ? { options: v.options.map((o) => ({ id: `o-${o.name}`, name: o.name })) } : {}) });
        return {};
      }
      if (query.includes('CoordinatorSet')) { board.values.push([v.item, v.field, v.value]); return {}; }
      throw new Error(`unexpected graphql ${query.slice(0, 40)}`);
    },
    async defaultBranchFile(token, full, path) {
      calls.push(['defaultBranchFile', full, path]);
      const f = repoOf(full)?.defaultFiles?.[path];
      return f === undefined ? null : Buffer.from(typeof f === 'string' ? f : JSON.stringify(f));
    },
    issueComments(token, full, n) { calls.push(['issueComments', full, n]); return it(comments.get(`${full}#${n}`) ?? []); },
    async createComment(token, full, n, body) {
      calls.push(['createComment', full, n, token]);
      const c = { id: nextComment++, body, performed_via_github_app: { id: 1 } };
      comments.set(`${full}#${n}`, [...(comments.get(`${full}#${n}`) ?? []), c]);
      return c.id;
    },
    async deleteComment(token, full, id) {
      calls.push(['deleteComment', full, id]);
      for (const [k, list] of comments) comments.set(k, list.filter((c) => c.id !== id));
    },
    async updateComment(token, full, id, body) {
      calls.push(['updateComment', full, id]);
      for (const list of comments.values()) { const c = list.find((x) => x.id === id); if (c) { c.body = body; return true; } }
      return false;
    },
    addRepo(fullName, { id, installationId, files = null, private: priv = true, defaultFiles = {} }) { repos.set(fullName, { id, installationId, private: priv, defaultFiles, files: files && new Map(Object.entries(files)) }); },
    setFiles(fullName, files) { repoOf(fullName).files = new Map(Object.entries(files)); },
    // calls of one kind since index `from`
    count: (kind, from = 0) => calls.slice(from).filter((c) => c[0] === kind).length,
    addUser(token, { id, login, read = [] }) { users.set(token, { id, login, read: new Set(read) }); },

    authorizeUrl: (state, redirect, challenge) => `https://github.example/login/oauth/authorize?state=${state}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${challenge}&code_challenge_method=S256`,
    async exchangeCode(code, redirect, verifier) { calls.push(['exchangeCode', code, verifier]); return { token: `tok-${code}`, refresh: `ref-${code}`, expiresAt: Date.now() + 8 * 3600_000, refreshExpiresAt: null }; },
    async refresh(r) { return { token: r.replace('ref-', 'tok-'), refresh: r, expiresAt: Date.now() + 8 * 3600_000, refreshExpiresAt: null }; },
    async installationToken(id, perms, opts) { calls.push(['installationToken', id, perms, ...(opts ? [opts] : [])]); return `inst-${id}`; },
    installationRepos(token) { const id = Number(token.slice(5)); return it([...repos].filter(([, r]) => r.installationId === id).map(([full_name, r]) => ({ id: r.id, full_name, private: r.private ?? true }))); },
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
    async userPermission(token, full, login) {
      calls.push(['userPermission', full, login]);
      const u = [...users.values()].find((x) => x.login === login);
      return u && u.read.has(full) ? 'read' : 'none';
    },
    revoke(token, full) { userOf(token)?.read.delete(full); },
    userInstallations(token) { const u = userOf(token); return it(u ? [...new Set([...u.read].map((f) => repoOf(f)?.installationId).filter(Boolean))].map((id) => ({ id })) : []); },
    userInstallationRepos(token, id) { const u = userOf(token); return it(u ? [...u.read].filter((f) => repoOf(f)?.installationId === id).map((f) => ({ id: repoOf(f).id, full_name: f, permissions: { pull: true } })) : []); },
  };
}

// writers: { login: ['owner/repo', …] } may push. beforeMove(full): runs once per move, e.g. to race a push.
export function fakeGitWrites(gh = fakeGitHub()) {
  const blobs = new Map(); const trees = new Map(); const commits = new Map();
  const writers = new Map(); // login -> Set(fullName)
  const reactions = []; const moves = [];
  const files = (full) => new Map(gh.repos.get(full).files ?? []);
  const base = { tree: gh.tree, repoAccess: gh.repoAccess, blob: gh.blob };
  Object.assign(gh, {
    writers, reactions, moves, beforeMove: null,
    allowPush(login, full) { writers.set(login, new Set([...(writers.get(login) ?? []), full])); },
    async tree(token, full, head) {
      const t = await base.tree(token, full, head);
      const id = `tree-${head}`;
      trees.set(id, files(full));
      return { ...t, sha: id };
    },
    async blob(token, full, s) { return blobs.get(s) ?? base.blob(token, full, s); },
    async repoAccess(token, full) {
      const r = await base.repoAccess(token, full);
      const u = gh.users.get(token);
      if (r.repo && u) r.repo.permissions.push = !!writers.get(u.login)?.has(full);
      return r;
    },
    async createBlob(token, full, buf) { gh.calls.push(['createBlob', full, token]); const s = sha(buf); blobs.set(s, Buffer.from(buf)); return s; },
    async createTree(token, full, baseTree, entries) {
      gh.calls.push(['createTree', full, token]);
      const m = new Map(trees.get(baseTree));
      for (const e of entries) m.set(e.path, blobs.get(e.sha));
      const id = `tree-${sha([...m].map(([p, b]) => `${p}:${sha(b)}`).sort().join('|'))}`;
      trees.set(id, m);
      return id;
    },
    async createCommit(token, full, c) {
      gh.calls.push(['createCommit', full, token]);
      const id = sha(JSON.stringify(c));
      commits.set(id, c);
      return id;
    },
    async moveBranch(token, full, branch, s) {
      gh.calls.push(['moveBranch', full, branch, token]);
      if (gh.beforeMove) { const f = gh.beforeMove; gh.beforeMove = null; await f(full); }
      const c = commits.get(s);
      if (c.parents[0] !== await gh.ref(token, full)) return false;
      gh.setFiles(full, Object.fromEntries(trees.get(c.tree)));
      moves.push({ full, branch, token, commit: c });
      return true;
    },
    async permission(token, full, login) { gh.calls.push(['permission', full, login, token]); return { push: !!writers.get(login)?.has(full), permission: writers.get(login)?.has(full) ? 'write' : 'read' }; },
    async react(token, full, id, content) { reactions.push({ full, id, content, token }); },
  });
  return gh;
}

