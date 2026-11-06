// GitHub webhooks: the HMAC is checked on the raw bytes before anything is
// parsed; a delivery id seen before is acknowledged and skipped. Pushes to the
// state branch resync that repo; installation events add and remove repos.
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(secret, raw, header) {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
  const got = Buffer.from(header);
  return got.length === want.length && timingSafeEqual(got, want);
}

const repoOf = (r) => ({ id: Number(r.id), fullName: String(r.full_name) });

// handle(event, payload) → { status, body, work? }. `work` is the sync to run after replying.
export function webhooks({ db, ingest, branch = 'coordinator-state', log }) {
  async function installationEvent(p) {
    const id = Number(p.installation?.id);
    if (p.action === 'deleted') {
      await db.deleteInstallation(id);
      await db.audit('installation.deleted', { installationId: id, login: p.sender?.login ?? null });
      return { status: 200, body: 'removed' };
    }
    await db.upsertInstallation({ id, account: String(p.installation?.account?.login ?? '') });
    await db.audit(`installation.${p.action}`, { installationId: id, login: p.sender?.login ?? null });
    if (p.action === 'created' || p.action === 'new_permissions_accepted' || p.action === 'unsuspend') return { status: 202, body: 'syncing', work: () => ingest.syncInstallation(id) };
    return { status: 200, body: 'ok' };
  }

  async function reposEvent(p) {
    const id = Number(p.installation?.id);
    await db.upsertInstallation({ id, account: String(p.installation?.account?.login ?? '') });
    for (const r of p.repositories_removed ?? []) await db.removeRepo(id, Number(r.id));
    const added = (p.repositories_added ?? []).map(repoOf);
    for (const r of added) await db.upsertRepo({ installationId: id, ...r });
    await db.audit('installation.repositories', { installationId: id, login: p.sender?.login ?? null, detail: { added: added.length, removed: (p.repositories_removed ?? []).length } });
    return { status: 202, body: 'syncing', work: async () => { for (const r of added) await ingest.syncRepo(id, r); } };
  }

  async function pushEvent(p) {
    if (p.ref !== `refs/heads/${branch}`) return { status: 202, body: 'ignored: not the state branch' };
    const id = Number(p.installation?.id);
    if (!(await db.installation(id))) await db.upsertInstallation({ id, account: String(p.repository?.owner?.login ?? '') });
    const repo = repoOf(p.repository);
    await db.upsertRepo({ installationId: id, ...repo });
    return { status: 202, body: 'syncing', work: () => ingest.syncRepo(id, repo) };
  }

  return {
    async handle(event, delivery, payload) {
      if (event === 'ping') return { status: 200, body: 'pong' };
      if (!Number.isSafeInteger(Number(payload?.installation?.id)) || Number(payload.installation.id) <= 0) return { status: 202, body: 'ignored: no installation' };
      if (delivery && await db.seenDelivery(delivery)) return { status: 200, body: 'duplicate delivery' };
      const r = event === 'push' ? await pushEvent(payload)
        : event === 'installation' ? await installationEvent(payload)
          : event === 'installation_repositories' ? await reposEvent(payload)
            : { status: 202, body: `ignored: ${event}` };
      const done = async () => { if (delivery) await db.recordDelivery(delivery); };
      if (!r.work) { await done(); return r; }
      // Recorded only once the sync succeeds, so GitHub's redelivery of a failed one is not skipped.
      return { ...r, work: async () => { try { await r.work(); await done(); } catch (e) { log?.error('webhook sync failed', { event, error: e }); } } };
    },
  };
}
