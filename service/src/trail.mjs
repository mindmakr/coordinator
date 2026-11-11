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
import { syncSettings } from './syncqueue.mjs';

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
// searchPages: pages of 100 comments read to find the App's own comment when no id is recorded;
// readsPerRefresh: GitHub reads one refresh may make, whatever the window has left (#42: the window
// resets every 10 minutes, so on its own it let one refresh run for an hour); notOnBoardMs: how long a
// "not on board" answer is trusted before the board is asked again.
export const CAPS = {
  units: 50, refsPerUnit: MAX_REFS_PER_UNIT, commentWritesPerInstallation: 200, windowMs: 10 * 60_000,
  searchPages: 2, readsPerRefresh: 100, notOnBoardMs: 24 * 3600_000,
};
// c14 round 5: GitHub reads the trail makes (comment pages, board queries, a linked repo's
// coordinator.json) are budgeted per installation too, TRAIL_READS per window; past it the run is left
// owed (out.deferred) and the next sync carries on, so one log cannot spend the installation's GitHub
// rate limit, or hours of a trail slot, in one refresh.
export class ReadsSpent extends Error { constructor() { super('the installation\'s trail read budget is spent for now'); } }

export function trail({ db, gh, config, log, now = Date.now }) {
  const readMax = config.trailReads ?? syncSettings().trailReads;
  const on = { trackers: config.trail?.trackers !== false, board: config.trail?.board !== false };
  const fence = projectFence({ gh, now });
  // Comment writes (create or edit) per installation per window; the rest wait for the next sync.
  const writes = limiter({ max: CAPS.commentWritesPerInstallation, windowMs: CAPS.windowMs, now });
  const reads = limiter({ max: readMax, windowMs: CAPS.windowMs, now });
  // One GitHub read for this installation, or ReadsSpent.
  // Also counted against this refresh's own cap, so one refresh cannot spend window after window.
  const reader = (installationId) => {
    let used = 0;
    const max = config.trailRefreshReads ?? CAPS.readsPerRefresh;
    return () => { if (++used > max || reads.hit(String(installationId))) throw new ReadsSpent(); };
  };

  // Every page fetched is charged (spend), and only the first CAPS.searchPages are read.
  async function findOurs(token, ref, runId, unitId, spend) {
    for await (const c of gh.issueComments(token, ref.repo, ref.n, { maxPages: CAPS.searchPages, spend })) {
      if (isTracker(c.body, runId, unitId) && String(c.performed_via_github_app?.id ?? '') === String(config.github.appId)) return c.id;
    }
    return null;
  }

  async function comment(installationId, token, ref, runId, unitId, body, spend) {
    const t = await db.tracker(installationId, ref.key, runId, unitId);
    const hash = sha256(body);
    if (t?.bodySha === hash) return 'unchanged';
    if (writes.hit(String(installationId))) return 'deferred'; // over this installation's write budget
    let id = null;
    if (t?.commentId) {
      if (await gh.updateComment(token, ref.repo, t.commentId, body)) {
        await db.putTracker(installationId, { refKey: ref.key, runId, unitId, commentId: t.commentId, bodySha: hash });
        return 'updated';
      }
      // Someone deleted it: a new one is posted, with no search (the recorded one was ours).
    } else {
      // No id recorded (a crash between posting and recording it): adopt this App's own comment if
      // it is on the first pages, else post.
      id = await findOurs(token, ref, runId, unitId, spend);
      if (id && !(await gh.updateComment(token, ref.repo, id, body))) id = null;
    }
    id ??= await gh.createComment(token, ref.repo, ref.n, body);
    await db.putTracker(installationId, { refKey: ref.key, runId, unitId, commentId: id, bodySha: hash });
    return 'created';
  }

  // repo: the state repo's row; runId: a run in it. Never throws: a failure is logged.
  // late (optional): true once the caller's job is out of time; the rest is left owed (out.deferred).
  // gone (optional): true once the installation was removed; nothing more is written (out.removed).
  async function refreshRun(installationId, repo, runId, { late = () => false, gone = () => false } = {}) {
    const out = { comments: [], board: [] };
    try {
      const row = await db.run(installationId, repo.id, runId, { map: false });
      const state = row?.state;
      if (!state) return out;
      const board = on.board ? boardConfig(repo.config) : null;
      const trackersOn = on.trackers && repo.config?.trackers !== false;
      if (!board && !trackersOn) return out;
      let commentToken; let session; let readToken;
      const token = async () => (readToken ??= await gh.installationToken(installationId, SCOPES.read));
      const spend = reader(installationId);
      for (const u of state.units.slice(0, CAPS.units)) {
        for (const ref of unitRefs(u).slice(0, CAPS.refsPerUnit)) {
          if (gone()) { out.removed = true; return out; }
          if (late()) { out.deferred = true; return out; } // left owed: the next sync carries on
          const target = await db.repoByName(installationId, ref.repo); // this installation's row only
          if (!(await fence.allows(repo, target, token, spend))) { out.skipped = [...(out.skipped ?? []), ref.key]; continue; } // outside the project: read-only
          const events = await db.ghEvents(installationId, [ref.key]);
          if (trackersOn) {
            const detail = target.id === repo.id && target.private === true;
            const url = `${config.baseUrl}${repoBase(repo.fullName)}/run/${enc(state.id)}/unit/${enc(u.id)}`;
            const body = trackerBody(state, u.id, { url, detail, github: githubLines(events) });
            commentToken ??= await gh.installationToken(installationId, SCOPES.comments);
            out.comments.push([ref.key, u.id, await comment(installationId, commentToken, ref, state.id, u.id, body, spend)]);
          }
          if (board) {
            const st = unitState(state, u);
            const hash = sha256(`${board.owner}/${board.number}|${state.id}|${st}`);
            const t = await db.tracker(installationId, ref.key, state.id, u.id);
            if (t?.boardSha === hash) { out.board.push([ref.key, u.id, 'unchanged']); continue; }
            // c14 round 5: a card found not on the board is remembered against the same hash, so it is
            // asked about again only when the unit's state (or the board) changes, not at every refresh,
            // or once the answer is a day old (#42: a card added to the board later is picked up).
            const off = /^off:([0-9a-f]+)@(\d+)$/.exec(t?.boardSha ?? '');
            if (off && off[1] === hash && now() - Number(off[2]) < CAPS.notOnBoardMs) { out.board.push([ref.key, u.id, 'not on board']); continue; }
            session ??= boardSession({ gh, token: await gh.installationToken(installationId, SCOPES.board), board, spend });
            const r = await session.update(ref, { runId: state.id, state: st });
            if (r === 'set' || r === 'not on board') await db.putTracker(installationId, { refKey: ref.key, runId: state.id, unitId: u.id, boardSha: r === 'set' ? hash : `off:${hash}@${now()}` });
            out.board.push([ref.key, u.id, r]);
          }
        }
      }
    } catch (e) {
      if (e instanceof ReadsSpent) { out.deferred = true; return out; } // left owed: the next sync carries on
      log?.warn('github trail not updated', { repo: repo.fullName, run: runId, error: e });
      out.error = e.message;
    }
    return out;
  }

  return { refreshRun };
}
