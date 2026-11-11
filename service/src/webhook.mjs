// GitHub webhooks: the HMAC is checked on the raw bytes before anything is
// parsed; a delivery id, or a body, seen before is acknowledged and skipped. Pushes to the
// state branch resync that repo; installation events add and remove repos.
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(secret, raw, header) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
  const got = Buffer.from(header);
  return got.length === want.length && timingSafeEqual(got, want);
}

const repoOf = (r) => ({ id: Number(r.id), fullName: String(r.full_name), ...(typeof r.private === 'boolean' ? { private: r.private } : {}) });
const refKey = (full, n) => `${String(full).toLowerCase()}#${Number(n)}`;

// handle(event, payload) → { status, body, work? }. `work` is the sync to run after replying.
// Pull request and check results become events on the read model (shown in the
// timelines and the tracker comments) and refresh the trail of every run in the
// same installation whose units link that PR, through the ingester's per-repo queue (ingest.refreshRuns).
// alerts (optional, c12): { github(inst, refKey, kind, detail), security(inst, repoName, detail) }.
export const SECURITY_EVENTS = { secret_scanning_alert: 'secret', code_scanning_alert: 'code', dependabot_alert: 'dependency' };

// forget (optional): (installationId) => after an uninstall, drops what lives outside the read model
// (alert rows, doorbell listeners, caches). Everything else goes with db.deleteInstallation.
export function webhooks({ db, ingest, branch = 'coordinator-state', log, commands = null, alerts = null, forget = null }) {
  // c12 alerts: a new secret, code scanning or dependency alert on a repo of this installation.
  async function securityEvent(event, p) {
    if (!['created', 'reopened', 'appeared_in_branch'].includes(p.action) || !(await db.installation(Number(p.installation.id)))) return { status: 202, body: `ignored: ${event} ${p.action}` };
    const detail = { kind: SECURITY_EVENTS[event], number: Number(p.alert?.number) || 0 };
    return { status: 202, body: 'security alert', work: () => alerts?.security(Number(p.installation.id), String(p.repository.full_name), detail) };
  }

  async function installationEvent(p) {
    const id = Number(p.installation?.id);
    if (p.action === 'deleted') {
      // Every row about the installation goes: repos, runs, links, events, trackers, commands, alerts
      // (sent and queued) and its audit trail. One audit row stays: that it was removed, and by whom.
      // c14 round 5: first its queued syncs and trail refreshes go, and running ones stop writing.
      ingest.forget?.(id);
      await db.deleteInstallation(id);
      if (forget) await forget(id);
      await db.audit('installation.deleted', { installationId: id, login: p.sender?.login ?? null });
      return { status: 200, body: 'removed' };
    }
    // c14: only "created" makes an installation. Any other event for one this service does not
    // know may be late, sent before an uninstall that was delivered first, and must not bring it back.
    if (p.action !== 'created' && !(await db.installation(id))) return { status: 202, body: 'ignored: unknown installation' };
    // c14: nor may a late "created": an uninstalled id is kept (GitHub never reuses one) and refused here.
    if (!(await db.upsertInstallation({ id, account: String(p.installation?.account?.login ?? '') }))) return { status: 202, body: 'ignored: uninstalled' };
    await db.audit(`installation.${p.action}`, { installationId: id, login: p.sender?.login ?? null });
    if (p.action === 'created' || p.action === 'new_permissions_accepted' || p.action === 'unsuspend') return { status: 202, body: 'syncing', work: () => ingest.syncInstallation(id) };
    return { status: 200, body: 'ok' };
  }

  async function reposEvent(p) {
    const id = Number(p.installation?.id);
    if (!(await db.installation(id))) return { status: 202, body: 'ignored: unknown installation' }; // c14: see installationEvent
    for (const r of p.repositories_removed ?? []) await db.removeRepo(id, Number(r.id));
    const added = (p.repositories_added ?? []).map(repoOf);
    for (const r of added) await db.upsertRepo({ installationId: id, ...r });
    await db.audit('installation.repositories', { installationId: id, login: p.sender?.login ?? null, detail: { added: added.length, removed: (p.repositories_removed ?? []).length } });
    return { status: 202, body: 'syncing', work: async () => { for (const r of added) await ingest.syncRepo(id, r); } };
  }

  async function pushEvent(p) {
    if (p.ref !== `refs/heads/${branch}`) return { status: 202, body: 'ignored: not the state branch' };
    if (!p.repository?.id || !p.repository.full_name) return { status: 202, body: 'ignored: no repository' };
    const id = Number(p.installation?.id);
    if (!(await db.installation(id))) return { status: 202, body: 'ignored: unknown installation' }; // c14: see installationEvent
    const repo = repoOf(p.repository);
    await db.upsertRepo({ installationId: id, ...repo });
    return { status: 202, body: 'syncing', work: () => ingest.syncRepo(id, { id: repo.id, fullName: repo.fullName }) };
  }

  // Records what happened to PR `n` of the payload's repo; returns the work that refreshes affected runs.
  async function record(p, n, kind, at, detail, id) {
    const inst = Number(p.installation.id);
    if (!(await db.installation(inst))) return null; // not installed here (yet): nothing to show it on
    const key = refKey(p.repository.full_name, n);
    await db.addGhEvent(inst, { id, refKey: key, kind, at, detail: { label: `PR ${p.repository.full_name}#${Number(n)}`, ...detail } });
    return async () => {
      // A held-back or failed write is flagged, so the next periodic resync lands it (and edits, never re-posts).
      for (const r of await db.runsReferencing(inst, key)) await ingest.refreshRuns(inst, r.repoId, [r.runId]);
      if (alerts) await alerts.github(inst, key, kind, detail); // c12
    };
  }

  async function pullRequestEvent(p) {
    const pr = p.pull_request ?? {};
    const kind = p.action === 'closed' ? (pr.merged ? 'merged' : 'closed') : p.action === 'reopened' ? 'reopened' : null;
    if (!kind || !Number.isSafeInteger(Number(pr.number))) return { status: 202, body: `ignored: pull_request ${p.action}` };
    const at = String((kind === 'merged' ? pr.merged_at : kind === 'closed' ? pr.closed_at : pr.updated_at) ?? new Date().toISOString());
    const work = await record(p, pr.number, kind, at, {}, `${kind}:${refKey(p.repository.full_name, pr.number)}:${at}`);
    return work ? { status: 202, body: kind, work } : { status: 202, body: 'ignored: unknown installation' };
  }

  async function checkSuiteEvent(p) {
    const cs = p.check_suite ?? {};
    if (p.action !== 'completed' || !Array.isArray(cs.pull_requests) || !cs.pull_requests.length) return { status: 202, body: 'ignored: check_suite' };
    const conclusion = String(cs.conclusion ?? 'finished').slice(0, 30);
    const works = [];
    for (const pr of cs.pull_requests.slice(0, 20)) {
      if (!Number.isSafeInteger(Number(pr.number))) continue;
      const w = await record(p, pr.number, 'checks', String(cs.updated_at ?? new Date().toISOString()), { conclusion, sha: String(cs.head_sha ?? '').slice(0, 40) }, `checks:${refKey(p.repository.full_name, pr.number)}:${Number(cs.id)}`);
      if (w) works.push(w);
    }
    return works.length ? { status: 202, body: `checks ${conclusion}`, work: async () => { for (const w of works) await w(); } } : { status: 202, body: 'ignored: unknown installation' };
  }

  return {
    // bodyKey (optional): a digest of the raw body, so a signed body replayed under a new delivery id is skipped too.
    async handle(event, delivery, payload, bodyKey = null) {
      if (event === 'ping') return { status: 200, body: 'pong' };
      if (!Number.isSafeInteger(Number(payload?.installation?.id)) || Number(payload.installation.id) <= 0) return { status: 202, body: 'ignored: no installation' };
      if ((delivery && await db.seenDelivery(delivery)) || (bodyKey && await db.seenDelivery(bodyKey))) return { status: 200, body: 'duplicate delivery' };
      const r = event === 'push' ? await pushEvent(payload)
        : event === 'installation' ? await installationEvent(payload)
          : event === 'installation_repositories' ? await reposEvent(payload)
            : event === 'pull_request' && payload.repository ? await pullRequestEvent(payload)
              : event === 'check_suite' && payload.repository ? await checkSuiteEvent(payload)
                // c12: comment commands (commands.mjs)
                : event === 'issue_comment' && payload.repository && commands ? await commands.handle(payload)
                : Object.hasOwn(SECURITY_EVENTS, event) && payload.repository ? await securityEvent(event, payload)
                : { status: 202, body: `ignored: ${event}` };
      const done = async () => { if (delivery) await db.recordDelivery(delivery); if (bodyKey) await db.recordDelivery(bodyKey); };
      if (!r.work) { await done(); return r; }
      // Recorded only once the sync succeeds, so GitHub's redelivery of a failed one is not skipped.
      return { ...r, work: async () => { try { await r.work(); await done(); } catch (e) { log?.error('webhook sync failed', { event, error: e }); } } };
    },
  };
}
