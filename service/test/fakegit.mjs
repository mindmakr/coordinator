// The fake GitHub of helpers.mjs, plus what c12 writes need: the Git Data API
// (blobs, trees, commits, a branch that only moves forward), push access per
// user, collaborator permissions and comment reactions.
import { createHash } from 'node:crypto';
import { fakeGitHub } from './helpers.mjs';

const sha = (b) => createHash('sha1').update(b).digest('hex');

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

// The log on the fake branch, as text.
export const branchLog = (gh, full, run) => gh.repos.get(full).files.get(`runs/${run}/events.jsonl`).toString('utf8');
