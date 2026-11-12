// Alerts (design 9): who hears about what, on which channel, and when.
//
// - Recipients are the people who asked for alerts on a repo (alert_subscriptions),
//   checked against GitHub with their own token when they subscribed and again
//   whenever they open the alerts page, and before every alert and digest as the App
//   (their permission on the repo, cached at most ACCESS_TTL_SECONDS, design 7.1).
//   Someone who lost access is unsubscribed and hears nothing more; a check that
//   fails sends them nothing this time.
// - Content is minimal by default: repo, run, unit, what happened and a link.
//   A question's text is added only for people who opted in, and only while their
//   access was confirmed in the last TEXT_FRESH_MS. A GitHub mention never carries text.
// - One alert per thing: a repeat of the same trigger on the same unit within
//   COLLAPSE_MS bumps the earlier alert's count instead of sending again.
// - Quiet hours, in the person's time zone: low and normal alerts wait in a
//   digest sent when the quiet hours end; high alerts go at once.
// - A channel that is not configured (no SMTP, no VAPID keys) is skipped; the
//   rest still go out, and the alert records what happened on each.
import { unitRefs } from '../core.mjs';
import { refsOf } from '../ingest.mjs';
import { repoBase } from '../pages.mjs';
import { alertStore } from './store.mjs';
import { unsubscriber } from './unsubscribe.mjs';
import { TRIGGERS, isRed, quietSince, runTriggers } from './triggers.mjs';

export const COLLAPSE_MS = 15 * 60_000;
export const TEXT_FRESH_MS = 7 * 86_400_000;
export const DEFAULTS = { email: null, tz: 'UTC', quiet: null, includeText: false, channels: { push: true, email: true, github: true } };
const enc = encodeURIComponent;
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export const settingsOf = (raw) => ({ ...DEFAULTS, ...(raw ?? {}), channels: { ...DEFAULTS.channels, ...(raw?.channels ?? {}) } });

// The hour (0-23) in a time zone; an unknown zone counts as UTC.
export function hourIn(tz, ms) {
  try { return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(ms)); } catch { return new Date(ms).getUTCHours(); }
}
// quiet: { start, end } hours; start 22, end 7 spans midnight.
export function inQuiet(s, ms) {
  const q = s.quiet;
  if (!q || q.start === q.end) return false;
  const h = hourIn(s.tz, ms);
  return q.start < q.end ? h >= q.start && h < q.end : h >= q.start || h < q.end;
}

export function alerts({ db, gh = null, config, log, now = Date.now, send, audit = true }) {
  const store = alertStore(db);
  const unsub = unsubscriber(config);
  // Every alert email: the stop link in the text and in the RFC 8058 headers.
  const mail = (userId, to, subject, body) => send.email.send({
    to, subject, headers: unsub.headers(userId, to),
    text: `${body}\n\nStop alert emails to this address: ${unsub.url(userId, to)}\nAlert settings: ${config.baseUrl}/alerts\n`,
  });
  const ttl = Math.min(config.accessTtlMs ?? 60_000, 60_000);
  const access = new Map(); // `${userId}:${inst}:${repoId}` → { ok, at }

  // Whether this person may still read the repo: true, false (lost: unsubscribed) or null (not known now).
  async function canRead(user, installationId, repoId, fullName) {
    const k = `${user.userId}:${installationId}:${repoId}`;
    const hit = access.get(k);
    if (hit && now() - hit.at < ttl) return hit.ok;
    let ok;
    try {
      if (!gh) return null;
      const token = await gh.installationToken(installationId);
      ok = (await gh.userPermission(token, fullName, user.login)) !== 'none';
    } catch (e) { log?.warn('alerts: access check failed', { login: user.login, repo: fullName, error: e }); return null; }
    access.set(k, { ok, at: now() });
    if (access.size > 10_000) access.delete(access.keys().next().value);
    if (!ok) {
      await store.unsubscribe(user.userId, installationId, repoId);
      if (audit) await db.audit('alerts.access-lost', { installationId, login: user.login, detail: { repo: fullName } });
    }
    return ok;
  }
  const link = (repo, runId, unitId) => `${config.baseUrl}${repoBase(repo.fullName)}/run/${enc(runId)}${unitId ? `/unit/${enc(unitId)}` : ''}`;

  // The unit's (or, with no unit, the run's) first issue or PR in the state repo itself: where a mention may go.
  function mentionRef(state, unitId, repo) {
    const units = state ? state.units.filter((u) => !unitId || u.id === unitId) : [];
    for (const u of units) for (const r of unitRefs(u)) if (r.repo.toLowerCase() === repo.fullName.toLowerCase()) return r;
    return null;
  }

  function message(a, { text = null } = {}) {
    const t = TRIGGERS[a.trigger];
    const where = [a.repo, `run ${a.runId}`, ...(a.unitId ? [`unit ${a.unitId}`] : [])].join(' · ');
    return { title: `Coordinator: ${t.label}`, body: text ? `${where}\n${clip(text, 200)}` : where, url: a.url, urgency: t.urgency };
  }

  async function deliver(user, s, a, msg, ref) {
    const out = {};
    const wants = TRIGGERS[a.trigger].channels;
    for (const ch of ['push', 'email', 'github']) {
      if (!wants.includes(ch)) continue;
      if (!s.channels[ch]) { out[ch] = 'off'; continue; }
      try {
        if (ch === 'push') {
          if (!send.push) { out.push = 'not configured'; continue; }
          const subs = await store.pushSubs(user.userId);
          if (!subs.length) { out.push = 'no device'; continue; }
          let sent = 0;
          for (const sub of subs) { const r = await send.push.send(sub, msg); if (r === 'gone') await store.dropPush(sub.endpoint); else sent++; }
          out.push = sent ? 'sent' : 'no device';
        } else if (ch === 'email') {
          if (!send.email) { out.email = 'not configured'; continue; }
          if (!s.email) { out.email = 'no address'; continue; }
          await mail(user.userId, s.email, msg.title, `${msg.body}\n\n${msg.url}`);
          out.email = 'sent';
        } else {
          // A mention is a public comment on a public repo; that a security alert exists is not for everyone.
          if (a.trigger === 'security' && a.private !== true) { out.github = 'public repo'; continue; }
          if (!ref) { out.github = 'no linked issue'; continue; }
          await send.github.send(a.installationId, ref, user.login, `coordinator: ${TRIGGERS[a.trigger].label} (${a.repo} · run ${a.runId}${a.unitId ? ` · unit ${a.unitId}` : ''}): ${msg.url}`);
          out.github = 'sent';
        }
      } catch (e) {
        out[ch] = 'failed';
        log?.warn('alert not delivered', { channel: ch, login: user.login, trigger: a.trigger, error: e });
      }
    }
    return out;
  }

  // One trigger on one run, to everyone subscribed to the repo.
  // once: collapse with any earlier alert of the same key, not only one in the last 15 minutes.
  async function dispatch(installationId, repo, { runId, unit = null, trigger, question = null, key = '', once = false, state = null }) {
    const t = TRIGGERS[trigger];
    const n = now();
    const collapseKey = `${installationId}:${repo.id}:${runId}:${unit ?? '-'}:${trigger}${key ? `:${key}` : ''}`;
    const out = [];
    for (const user of await store.subscribers(installationId, repo.id)) {
      const prev = await store.recent(user.userId, collapseKey, once ? 0 : n - COLLAPSE_MS);
      if (prev) { if (!once) await store.bump(prev.id); out.push([user.login, 'collapsed']); continue; }
      const may = await canRead(user, installationId, repo.id, repo.fullName);
      if (!may) { out.push([user.login, may === false ? 'no access' : 'not checked']); continue; }
      const s = settingsOf(await store.settings(user.userId));
      const a = { userId: user.userId, installationId, repoId: repo.id, repo: repo.fullName, private: repo.private, runId, unitId: unit, trigger, urgency: t.urgency, collapseKey, createdAt: n, url: link(repo, runId, unit) };
      const text = trigger === 'needs-you' && s.includeText && question && n - (user.checkedAt ?? 0) < TEXT_FRESH_MS ? question : null;
      const row = { ...a, detail: { url: a.url, repo: repo.fullName } };
      if (t.urgency !== 'high' && inQuiet(s, n)) {
        await store.addAlert({ ...row, status: 'queued' });
        out.push([user.login, 'queued']);
        continue;
      }
      const channels = await deliver(user, s, a, message(a, { text }), mentionRef(state, unit, repo));
      await store.addAlert({ ...row, status: 'sent', sentAt: n, detail: { ...row.detail, channels } });
      if (audit) await db.audit('alert.sent', { installationId, login: user.login, detail: { trigger, run: runId, unit, channels } });
      out.push([user.login, 'sent', channels]);
    }
    return out;
  }

  const safely = (what, fn) => fn().catch((e) => { log?.warn(`alerts: ${what} failed`, { error: e }); return []; });

  return {
    store, dispatch, send,

    // The installation was removed: its alerts (sent and waiting for a digest), subscriptions and cached answers go.
    async forgetInstallation(installationId) {
      await store.deleteInstallation(installationId);
      for (const k of [...access.keys()]) if (k.split(':')[1] === String(installationId)) access.delete(k);
    },

    // From a sync: [{ runId, before, after }] for every run whose state changed.
    runsChanged: (installationId, repo, changes) => safely('run change', async () => {
      const out = [];
      for (const c of changes) {
        for (const tr of runTriggers(c.before, c.after, now())) {
          out.push(...await dispatch(installationId, repo, { runId: c.runId, unit: tr.unit, trigger: tr.trigger, question: tr.question, key: tr.ref ?? '', state: c.after }));
        }
      }
      return out;
    }),

    // From a webhook: a PR the runs link was merged, or its checks went red.
    github: (installationId, refKey, kind, detail = {}) => safely('github event', async () => {
      const trigger = kind === 'merged' ? 'merged' : kind === 'checks' && isRed(detail.conclusion) ? 'checks-red' : null;
      if (!trigger) return [];
      const out = [];
      const repos = await db.repos(installationId);
      for (const r of await db.runsReferencing(installationId, refKey)) {
        const repo = repos.find((x) => x.id === r.repoId);
        const state = (await db.run(installationId, r.repoId, r.runId, { map: false }))?.state;
        if (!repo || !state || state.closed) continue;
        for (const unit of new Set(refsOf(state).filter((x) => x.key === refKey).map((x) => x.unit))) {
          out.push(...await dispatch(installationId, repo, { runId: r.runId, unit, trigger, key: refKey, state }));
        }
      }
      return out;
    }),

    // From a webhook: a secret, code or dependency alert on a repo that open runs live in or link.
    security: (installationId, repoName, detail = {}) => safely('security event', async () => {
      const name = repoName.toLowerCase();
      const out = [];
      for (const repo of await db.repos(installationId)) {
        for (const row of await db.runSummaries(installationId, repo.id, { state: true, open: true })) {
          const st = row.state;
          if (!st || st.closed) continue;
          const linked = refsOf(st).find((x) => x.key.startsWith(`${name}#`));
          if (repo.fullName.toLowerCase() !== name && !linked) continue;
          out.push(...await dispatch(installationId, repo, { runId: st.id, unit: linked?.unit ?? null, trigger: 'security', key: `${detail.kind}:${detail.number}`, state: st, once: true }));
        }
      }
      return out;
    }),

    // Every ALERT_SWEEP_SECONDS: leads gone quiet, and digests whose quiet hours have ended.
    sweep: () => safely('sweep', async () => {
      const n = now();
      const out = { quiet: [], digests: [] };
      // Only a repo someone watches can alert anyone: the others are not read.
      const watched = new Map();
      for (const w of await store.watchedRepos()) watched.set(w.installationId, (watched.get(w.installationId) ?? new Set()).add(w.repoId));
      for (const [inst, ids] of watched) {
        for (const repo of (await db.repos(inst)).filter((r) => ids.has(r.id))) {
          // Only an open run can have gone quiet (quietSince): closed and unreadable ones are not read.
          for (const row of await db.runSummaries(inst, repo.id, { state: true, open: true })) {
            const since = quietSince(row.state, n);
            if (since) out.quiet.push(...await dispatch(inst, repo, { runId: row.runId, trigger: 'lead-quiet', key: String(since), once: true, state: row.state }));
          }
        }
      }
      for (const userId of await store.queuedUsers()) {
        const s = settingsOf(await store.settings(userId));
        if (inQuiet(s, n)) continue;
        const queued = await store.queued(userId);
        if (!queued.length) continue;
        // Only what the person may still read; the rest is cleared without being sent.
        // An alert whose check failed stays queued for the next sweep.
        const login = await store.loginOf(userId);
        const list = []; const gone = [];
        for (const a of queued) {
          const may = login ? await canRead({ userId, login }, a.installationId, a.repoId, a.detail?.repo ?? '') : null;
          if (may) list.push(a); else if (may === false) gone.push(a);
        }
        if (gone.length) await store.markSent(gone.map((a) => a.id), n);
        if (!list.length) continue;
        const lines = list.map((a) => `- ${TRIGGERS[a.trigger]?.label ?? a.trigger}${a.count > 1 ? ` (×${a.count})` : ''}: ${a.detail?.repo ?? ''} · run ${a.runId}${a.unitId ? ` · unit ${a.unitId}` : ''}\n  ${a.detail?.url ?? ''}`);
        const title = `Coordinator: ${list.length} alert${list.length > 1 ? 's' : ''} while you were away`;
        const sent = {};
        if (s.channels.email && s.email && send.email) {
          try { await mail(userId, s.email, title, lines.join('\n')); sent.email = 'sent'; } catch (e) { sent.email = 'failed'; log?.warn('digest email failed', { error: e }); }
        }
        if (s.channels.push && send.push) {
          for (const sub of await store.pushSubs(userId)) {
            try { if (await send.push.send(sub, { title, body: `${list.length} waiting`, url: `${config.baseUrl}/alerts`, urgency: 'low' }) === 'gone') await store.dropPush(sub.endpoint); else sent.push = 'sent'; } catch (e) { sent.push = 'failed'; log?.warn('digest push failed', { error: e }); }
          }
        }
        await store.markSent(list.map((a) => a.id), n);
        out.digests.push([userId, list.length, sent]);
      }
      return out;
    }),
  };
}
