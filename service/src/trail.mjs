// The GitHub trail of a run (design 6): one tracker comment per unit on each
// issue or PR it links, edited in place, and the unit's card on the board.
// Runs after a run's state changes on the state branch and after GitHub says
// a linked PR merged, closed or finished its checks, so the trail stays
// current when no lead is running.
//
// Only issues and PRs in the run's project are touched (src/project.mjs: the
// state repo, plus linked repos that opted in on their own default branch). A comment
// carries the last gap, cause and question headers only when it lands in the
// state repo itself and that repo is private; anywhere else it carries status
// only, so nothing from a private run leaks to another repo's readers.
// Unchanged text is never re-sent (a hash per comment and per card).
import { boardConfig, boardSession } from './board.mjs';
import { isTracker, sha256, trackerBody, unitRefs, unitState } from './core.mjs';
import { SCOPES } from './github.mjs';
import { limiter } from './ratelimit.mjs';
import { repoBase } from './pages.mjs';
import { projectFence } from './project.mjs';
import { MAX_REFS_PER_UNIT } from './ingest.mjs';

const enc = encodeURIComponent;

// What GitHub said about one issue or PR, as plain lines for the comment and as timeline rows.
export function githubLines(events) {
  const latest = (kinds) => events.filter((e) => kinds.includes(e.kind)).at(-1);
  const out = [];
  const close = latest(['merged', 'closed', 'reopened']);
  const checks = latest(['checks']);
  if (close) out.push(`${close.detail?.label ?? 'PR'} ${close.kind}`);
  if (checks) out.push(`${checks.detail?.label ?? 'PR'} checks ${checks.detail?.conclusion === 'success' ? 'passed' : checks.detail?.conclusion ?? 'finished'}`);
  return out;
}

// Caps on what one run log can make the App write: a hostile log is pusher-controlled.
export const CAPS = { units: 50, refsPerUnit: MAX_REFS_PER_UNIT, commentWritesPerInstallation: 200, windowMs: 10 * 60_000 };

export function trail({ db, gh, config, log, now = Date.now }) {
  const on = { trackers: config.trail?.trackers !== false, board: config.trail?.board !== false };
  const fence = projectFence({ gh, now });
  // Comment writes (create or edit) per installation per window; the rest wait for the next sync.
  const writes = limiter({ max: CAPS.commentWritesPerInstallation, windowMs: CAPS.windowMs, now });

  async function findOurs(token, ref, runId, unitId) {
    for await (const c of gh.issueComments(token, ref.repo, ref.n)) {
      if (isTracker(c.body, runId, unitId) && String(c.performed_via_github_app?.id ?? '') === String(config.github.appId)) return c.id;
    }
    return null;
  }

  async function comment(installationId, token, ref, runId, unitId, body) {
    const t = await db.tracker(installationId, ref.key, runId, unitId);
    const hash = sha256(body);
    if (t?.bodySha === hash) return 'unchanged';
    if (writes.hit(String(installationId))) return 'deferred'; // over this installation's write budget
    if (t?.commentId && await gh.updateComment(token, ref.repo, t.commentId, body)) {
      await db.putTracker(installationId, { refKey: ref.key, runId, unitId, commentId: t.commentId, bodySha: hash });
      return 'updated';
    }
    // No comment known, or someone deleted it: adopt this App's own comment if there is one, else post.
    let id = await findOurs(token, ref, runId, unitId);
    if (id) await gh.updateComment(token, ref.repo, id, body);
    else id = await gh.createComment(token, ref.repo, ref.n, body);
    await db.putTracker(installationId, { refKey: ref.key, runId, unitId, commentId: id, bodySha: hash });
    return 'created';
  }

  // repo: the state repo's row; runId: a run in it. Never throws: a failure is logged.
  async function refreshRun(installationId, repo, runId) {
    const out = { comments: [], board: [] };
    try {
      const row = await db.run(installationId, repo.id, runId);
      const state = row?.state;
      if (!state) return out;
      const board = on.board ? boardConfig(repo.config) : null;
      const trackersOn = on.trackers && repo.config?.trackers !== false;
      if (!board && !trackersOn) return out;
      let commentToken; let session; let readToken;
      const token = async () => (readToken ??= await gh.installationToken(installationId, SCOPES.read));
      for (const u of state.units.slice(0, CAPS.units)) {
        for (const ref of unitRefs(u).slice(0, CAPS.refsPerUnit)) {
          const target = await db.repoByName(ref.repo);
          if (!(await fence.allows(repo, target, token))) { out.skipped = [...(out.skipped ?? []), ref.key]; continue; } // outside the project: read-only
          const events = await db.ghEvents(installationId, [ref.key]);
          if (trackersOn) {
            const detail = target.id === repo.id && target.private === true;
            const url = `${config.baseUrl}${repoBase(repo.fullName)}/run/${enc(state.id)}/unit/${enc(u.id)}`;
            const body = trackerBody(state, u.id, { url, detail, github: githubLines(events) });
            commentToken ??= await gh.installationToken(installationId, SCOPES.comments);
            out.comments.push([ref.key, u.id, await comment(installationId, commentToken, ref, state.id, u.id, body)]);
          }
          if (board) {
            const st = unitState(state, u);
            const hash = sha256(`${board.owner}/${board.number}|${state.id}|${st}`);
            const t = await db.tracker(installationId, ref.key, state.id, u.id);
            if (t?.boardSha === hash) { out.board.push([ref.key, u.id, 'unchanged']); continue; }
            session ??= boardSession({ gh, token: await gh.installationToken(installationId, SCOPES.board), board });
            const r = await session.update(ref, { runId: state.id, state: st });
            if (r === 'set') await db.putTracker(installationId, { refKey: ref.key, runId: state.id, unitId: u.id, boardSha: hash });
            out.board.push([ref.key, u.id, r]);
          }
        }
      }
    } catch (e) {
      log?.warn('github trail not updated', { repo: repo.fullName, run: runId, error: e });
      out.error = e.message;
    }
    return out;
  }

  return { refreshRun };
}
