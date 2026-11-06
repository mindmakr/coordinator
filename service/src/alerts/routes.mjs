// The alerts pages: the person's settings, the repos they hear about, their
// devices for web push, and the alerts they were sent (design 7.2 "Alerts").
//
//   GET  /alerts             settings and the last 50 alerts (signed in)
//   POST /alerts/settings    email, time zone, quiet hours, channels, question text opt-in
//   POST /alerts/watch       repo=owner/name, on=1|0 (the person must be able to read it)
//   POST /alerts/push        a browser's push subscription (JSON, CSRF header)
//   GET  /alerts/confirm?t=  a page whose button (POST /alerts/confirm) confirms an email address
//   GET|POST /alerts/unsubscribe?u=&s=  stops alert email (signed link, RFC 8058 one-click; no sign-in)
//   GET  /alerts/sw.js, /alerts/push.js   the service worker and the page's one script
import { createHash, randomBytes } from 'node:crypto';
import { esc, page, blk } from '../core.mjs';
import { limiter } from '../ratelimit.mjs';
import { settingsOf } from './index.mjs';
import { TRIGGERS } from './triggers.mjs';
import { unsubscriber } from './unsubscribe.mjs';

const MAX_JSON = 4 * 1024;
const MAX_WATCHED = 50;
const CONFIRM_MS = 24 * 3600_000;
const MAX_LINK_FORM = 1024;
export const CONFIRMS_PER_DAY = 3; // confirmation emails per person, and per address
const EMAIL = /^[^\s@<>"',;]{1,64}@[^\s@<>"',;]{1,190}\.[A-Za-z]{2,24}$/;
const hash = (s) => createHash('sha256').update(s).digest('hex');
const META_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'";
export const PAGE_CSP = `${META_CSP}; frame-ancestors 'none'`;

// Push endpoints are posted to by this server, so only the browsers' own push services are accepted.
export const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
const ZONES = (() => { try { return new Set(Intl.supportedValuesOf('timeZone')); } catch { return new Set(['UTC']); } })();
const validTz = (tz) => tz === 'UTC' || ZONES.has(tz);

// The page's script: asks for notification permission, subscribes this browser and posts the subscription.
const PUSH_JS = `(() => {
  const btn = document.getElementById('push-on'); const out = document.getElementById('push-state');
  if (!btn) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { out.textContent = 'This browser cannot receive push alerts. On a phone, add this site to the home screen first.'; btn.disabled = true; return; }
  const key = btn.dataset.key; const csrf = btn.dataset.csrf;
  const bytes = (b64) => { const s = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
  btn.addEventListener('click', async () => {
    try {
      if (await Notification.requestPermission() !== 'granted') { out.textContent = 'Notifications are blocked for this site.'; return; }
      const reg = await navigator.serviceWorker.register('/alerts/sw.js', { scope: '/alerts/' });
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) });
      const r = await fetch('/alerts/push', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(sub) });
      out.textContent = r.ok ? 'This device will get push alerts.' : 'Could not save this device; reload and try again.';
    } catch (e) { out.textContent = 'Could not turn on push alerts here.'; }
  });
})();
`;
// Shows each push; a tap opens the alert's page on this site only.
const SW_JS = `self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data.json(); } catch {}
  e.waitUntil(self.registration.showNotification(String(d.title || 'Coordinator'), { body: String(d.body || ''), data: { url: String(d.url || '/alerts') }, tag: String(d.url || 'coordinator') }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  let u = '/alerts'; try { const x = new URL(e.notification.data.url, self.location.origin); if (x.origin === self.location.origin) u = x.href; } catch {}
  e.waitUntil(clients.openWindow(u));
});
`;
const MANIFEST = JSON.stringify({ name: 'Coordinator', short_name: 'Coordinator', start_url: '/', display: 'standalone', background_color: '#ffffff', theme_color: '#ffffff' });

// A one-button form posting hidden fields to this site (the CSP allows form-action 'self').
const button = (action, fields, label) => `<form method="post" action="${esc(action)}">${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}<p><button type="submit">${esc(label)}</button></p></form>`;

export function alertRoutes({ alerts, acl, db, config, send, now = Date.now, log }) {
  const store = alerts.store;
  const unsub = unsubscriber(config);
  // Nobody can use this service to mail an address over and over: a few confirmations a day, per person and per address.
  const confirms = { user: limiter({ max: CONFIRMS_PER_DAY, windowMs: 86_400_000, now }), address: limiter({ max: CONFIRMS_PER_DAY, windowMs: 86_400_000, now }) };
  const ctx = () => ({ live: null, theme: null, embed: null, pages: [{ path: '/', label: 'Projects', href: '/' }, { path: '/alerts', label: 'Alerts', href: '/alerts' }] });

  // Re-checks every repo the person watches with their own token: gone ones are dropped,
  // the rest are stamped, which keeps question text (opt-in) flowing for a week.
  async function recheck(user) {
    const t = now();
    for (const s of (await store.subscriptions(user.userId)).slice(0, MAX_WATCHED)) {
      const repo = (await db.repos(s.installationId)).find((r) => r.id === s.repoId);
      if (repo && await acl.readable(user, repo.fullName)) await store.subscribe(user.userId, user.login, s.installationId, s.repoId, t);
      else await store.unsubscribe(user.userId, s.installationId, s.repoId);
    }
  }

  async function settingsPage(user, notice = '') {
    await recheck(user);
    const s = settingsOf(await store.settings(user.userId));
    const raw = await store.settings(user.userId);
    const watched = new Set((await store.subscriptions(user.userId)).map((x) => `${x.installationId}:${x.repoId}`));
    const repos = await acl.projects(user);
    const csrf = `<input type="hidden" name="csrf" value="${esc(user.csrf)}">`;
    const check = (name, on, label) => `<label><input type="checkbox" name="${name}" value="1"${on ? ' checked' : ''}> ${esc(label)}</label><br>`;
    const hours = (name, v) => `<select name="${name}"><option value="">off</option>${Array.from({ length: 24 }, (_, h) => `<option value="${h}"${v === h ? ' selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select>`;
    const missing = [!send.email ? 'email is not set up on this service' : null, !send.push ? 'web push is not set up on this service' : null].filter(Boolean);
    const list = await store.alertsFor(user.userId, 50);
    const body = blk('head', '<header class="run"><h1>Alerts</h1></header>')
      + (notice ? `<section class="card"><p role="status">${esc(notice)}</p></section>` : '')
      + `<section class="card"><h2>Repos</h2><p class="meta">You hear about runs in the repos you tick. Each is checked with your GitHub access.</p>${repos.length ? repos.map((r) => `<form method="post" action="/alerts/watch" style="margin:.3em 0">${csrf}<input type="hidden" name="repo" value="${esc(r.fullName)}"><input type="hidden" name="on" value="${watched.has(`${r.installationId}:${r.id}`) ? '0' : '1'}">${esc(r.fullName)} <button type="submit">${watched.has(`${r.installationId}:${r.id}`) ? 'Stop alerts' : 'Alert me'}</button></form>`).join('') : '<p>No projects yet.</p>'}</section>`
      + `<section class="card"><h2>How and when</h2>${missing.length ? `<p class="meta">${esc(missing.join('; '))}.</p>` : ''}<form method="post" action="/alerts/settings">${csrf}`
      + `<p><label>Email <input type="email" name="email" value="${esc(raw?.emailPending ?? s.email ?? '')}" maxlength="254"></label> ${raw?.emailPending ? '<span class="meta">waiting for you to confirm it</span>' : s.email ? '<span class="meta">confirmed</span>' : ''}</p>`
      + `<p>${check('ch_push', s.channels.push, 'Web push')}${check('ch_email', s.channels.email, 'Email')}${check('ch_github', s.channels.github, 'GitHub mention (needs you and security only)')}</p>`
      + `<p><label>Time zone <input name="tz" value="${esc(s.tz)}" maxlength="64"></label></p>`
      + `<p>Quiet hours from ${hours('quiet_start', s.quiet?.start)} to ${hours('quiet_end', s.quiet?.end)}. Alerts in quiet hours wait for a digest when they end; security alerts never wait.</p>`
      + `<p>${check('include_text', s.includeText, "Include a question's text in push and email (off: only the run, unit and a link)")}</p>`
      + '<p><button type="submit">Save</button></p></form></section>'
      + (send.push ? `<section class="card"><h2>This device</h2><p><button type="button" id="push-on" data-key="${esc(send.push.publicKey)}" data-csrf="${esc(user.csrf)}">Send push alerts to this device</button></p><p id="push-state" class="meta" role="status"></p></section>` : '')
      + `<section class="card"><h2>Sent to you</h2>${list.length ? `<ul>${list.map((a) => `<li>${esc(new Date(a.createdAt).toISOString().slice(0, 16).replace('T', ' '))} · ${esc(TRIGGERS[a.trigger]?.label ?? a.trigger)}${a.count > 1 ? ` ×${a.count}` : ''} · ${esc(a.detail?.repo ?? '')} · run ${esc(a.runId)}${a.unitId ? ` · unit ${esc(a.unitId)}` : ''} · ${esc(a.status === 'queued' ? 'waiting for the digest' : a.status)}${a.detail?.channels ? ` (${esc(Object.entries(a.detail.channels).map(([k, v]) => `${k}: ${v}`).join(', '))})` : ''} <a href="${esc(a.detail?.url ?? '/')}">open</a></li>`).join('')}</ul>` : '<p>Nothing yet.</p>'}</section>`;
    // A settings page, not a run: no "Snapshot · read-only" chip and no theme switch (it follows the system).
    // frame-ancestors only works as a header (sent with the page), so the meta copy leaves it out.
    return page({ title: 'Alerts', body, ctx: ctx(), path: '/alerts' })
      .replace('<span class="live" data-state="snapshot">Snapshot · read-only</span>', '')
      .replace(/<fieldset class="themes">[\s\S]*?<\/fieldset>/, '')
      .replace("default-src 'none'; style-src 'unsafe-inline'; img-src data:", META_CSP)
      .replace('</head>', '<link rel="manifest" href="/manifest.webmanifest"></head>')
      .replace('</body>', '<script src="/alerts/push.js" defer></script></body>');
  }

  async function saveSettings(user, f) {
    const prev = (await store.settings(user.userId)) ?? {};
    const s = settingsOf(prev);
    const tz = String(f.get('tz') ?? 'UTC').trim() || 'UTC';
    if (!validTz(tz)) return `Unknown time zone ${tz}; use a name like Europe/London.`;
    const hour = (k) => { const v = f.get(k); return v === null || v === '' ? null : Math.min(23, Math.max(0, Math.trunc(Number(v)) || 0)); };
    const qs = hour('quiet_start'); const qe = hour('quiet_end');
    const next = { ...prev, tz, quiet: qs === null || qe === null ? null : { start: qs, end: qe }, includeText: f.get('include_text') === '1', channels: { push: f.get('ch_push') === '1', email: f.get('ch_email') === '1', github: f.get('ch_github') === '1' } };
    let notice = 'Saved.';
    const email = String(f.get('email') ?? '').trim();
    if (!email) Object.assign(next, { email: null, emailPending: null, emailTokenHash: null, emailTokenExp: null });
    else if (email !== s.email && email !== prev.emailPending) {
      if (!EMAIL.test(email) || email.length > 254) return 'That email address does not look right.';
      if (!send.email) return 'Email is not set up on this service, so the address cannot be confirmed.';
      const who = String(user.userId); const where = email.toLowerCase();
      if (confirms.user.blocked(who) || confirms.address.blocked(where)) return 'Too many confirmation emails today; try again tomorrow.';
      confirms.user.hit(who); confirms.address.hit(where);
      // A new address gets alerts only once its owner follows the link, so nobody can point alerts at someone else.
      const token = randomBytes(32).toString('base64url');
      Object.assign(next, { emailPending: email, emailTokenHash: hash(token), emailTokenExp: now() + CONFIRM_MS });
      try {
        await send.email.send({ to: email, subject: 'Coordinator: confirm your alert email', text: `${user.login} asked for Coordinator alerts at this address.\n\nConfirm: ${config.baseUrl}/alerts/confirm?t=${token}\n\nIgnore this email if it was not you; the link expires in 24 hours.\n` });
        notice = `Saved. We sent a link to ${email}; alerts go there once you follow it.`;
      } catch (e) {
        log?.warn('confirm email failed', { error: e });
        return 'Could not send the confirmation email; try again later.';
      }
    }
    await store.putSettings(user.userId, user.login, next);
    return notice;
  }

  return {
    // true when it handled the request. h: the server's helpers for this request.
    async route(req, res, url, h) {
      const p = url.pathname;
      if (p === '/alerts/push.js' && req.method === 'GET') { h.send(res, 200, PUSH_JS, { 'Content-Type': 'text/javascript; charset=utf-8' }); return true; }
      if (p === '/alerts/sw.js' && req.method === 'GET') { h.send(res, 200, SW_JS, { 'Content-Type': 'text/javascript; charset=utf-8' }); return true; }
      if (p === '/manifest.webmanifest' && req.method === 'GET') { h.send(res, 200, MANIFEST, { 'Content-Type': 'application/manifest+json' }); return true; }
      // Opening the link only shows a button: mail scanners fetch links, and a fetch must not confirm.
      if (p === '/alerts/confirm' && (req.method === 'GET' || req.method === 'POST')) {
        const t = req.method === 'GET' ? String(url.searchParams.get('t') ?? '') : String(new URLSearchParams((await h.readBody(req, MAX_LINK_FORM)).toString('utf8')).get('t') ?? '');
        const hit = /^[A-Za-z0-9_-]{43}$/.test(t) ? await store.userByEmailToken(hash(t)) : null;
        if (!hit || !hit.settings.emailPending || hit.settings.emailTokenExp < now()) { h.html(res, 400, h.message('Link expired', 'This confirmation link is wrong or has expired. Enter the address again on the alerts page.')); return true; }
        if (req.method === 'GET') {
          h.html(res, 200, h.message('Confirm your alert email', `${hit.login} asked for Coordinator alerts at ${hit.settings.emailPending}.`, button('/alerts/confirm', { t }, 'Confirm this address')));
          return true;
        }
        await store.putSettings(hit.userId, hit.login, { ...hit.settings, email: hit.settings.emailPending, emailPending: null, emailTokenHash: null, emailTokenExp: null });
        await db.audit('alerts.email-confirmed', { login: hit.login });
        h.html(res, 200, h.message('Email confirmed', 'Alerts will go to this address.'));
        return true;
      }
      // RFC 8058: a mail client POSTs to the link with List-Unsubscribe=One-Click; a person opening it gets a button.
      if (p === '/alerts/unsubscribe' && (req.method === 'GET' || req.method === 'POST')) {
        const body = req.method === 'POST' ? new URLSearchParams((await h.readBody(req, MAX_LINK_FORM)).toString('utf8')) : null;
        const u = Number(url.searchParams.get('u') ?? body?.get('u'));
        const sig = url.searchParams.get('s') ?? body?.get('s');
        const raw = Number.isSafeInteger(u) && u > 0 ? await store.settings(u) : null;
        if (!raw?.email || !unsub.valid(u, raw.email, sig)) { h.html(res, 400, h.message('Link expired', 'This link is wrong, or alert emails to this address have already stopped.')); return true; }
        if (req.method === 'GET') {
          h.html(res, 200, h.message('Stop alert emails', 'Coordinator alert emails to this address will stop.', button('/alerts/unsubscribe', { u: String(u), s: sig }, 'Stop alert emails')));
          return true;
        }
        const login = await store.loginOf(u);
        await store.putSettings(u, login ?? '', { ...raw, email: null, emailPending: null, emailTokenHash: null, emailTokenExp: null, channels: { ...settingsOf(raw).channels, email: false } });
        await db.audit('alerts.unsubscribed', { login });
        h.html(res, 200, h.message('Alert emails stopped', 'No more Coordinator alert emails go to this address.'));
        return true;
      }
      if (p !== '/alerts' && !p.startsWith('/alerts/')) return false;
      const user = h.user;
      if (!user) {
        if (req.method === 'GET' && p === '/alerts') h.redirect(res, 302, '/login');
        else h.send(res, 403, 'sign in first');
        return true;
      }
      if (req.method === 'GET' && p === '/alerts') { h.html(res, 200, await settingsPage(user), { 'Content-Security-Policy': PAGE_CSP }); return true; }
      if (req.method === 'POST' && p === '/alerts/settings') {
        const notice = await saveSettings(user, await h.form(req, user));
        h.html(res, 200, await settingsPage(user, notice), { 'Content-Security-Policy': PAGE_CSP });
        return true;
      }
      if (req.method === 'POST' && p === '/alerts/watch') {
        const f = await h.form(req, user);
        const repo = await acl.readable(user, String(f.get('repo') ?? ''));
        if (!repo) { h.html(res, 404, h.message('Not found', 'There is nothing here, or you cannot read it on GitHub.')); return true; }
        if (f.get('on') === '1') {
          if ((await store.subscriptions(user.userId)).length >= MAX_WATCHED) { h.html(res, 200, await settingsPage(user, `At most ${MAX_WATCHED} repos.`), { 'Content-Security-Policy': PAGE_CSP }); return true; }
          await store.subscribe(user.userId, user.login, repo.installationId, repo.id, now());
        } else await store.unsubscribe(user.userId, repo.installationId, repo.id);
        await db.audit('alerts.watch', { installationId: repo.installationId, login: user.login, detail: { repo: repo.fullName, on: f.get('on') === '1' } });
        h.redirect(res, 303, '/alerts');
        return true;
      }
      if (req.method === 'POST' && p === '/alerts/push') {
        if (req.headers.origin !== config.baseUrl || !h.validCsrf(user, req.headers['x-csrf-token'])) { h.send(res, 403, 'missing or wrong form token; reload the page'); return true; }
        let sub;
        try { sub = JSON.parse((await h.readBody(req, MAX_JSON)).toString('utf8')); } catch { h.send(res, 400, 'not JSON'); return true; }
        let ok = false;
        try { const u = new URL(sub?.endpoint); ok = u.protocol === 'https:' && !u.port && PUSH_HOSTS.test(u.hostname) && typeof sub.keys?.p256dh === 'string' && typeof sub.keys?.auth === 'string' && sub.keys.p256dh.length < 200 && sub.keys.auth.length < 100 && sub.endpoint.length < 1000; } catch { ok = false; }
        if (!ok) { h.send(res, 400, 'not a push subscription'); return true; }
        if ((await store.pushSubs(user.userId)).length >= 10) { h.send(res, 409, 'at most 10 devices'); return true; }
        if (!(await store.addPush(user.userId, { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }))) { h.send(res, 409, 'this device gets alerts for someone else'); return true; }
        h.send(res, 204, '');
        return true;
      }
      return false;
    },
  };
}
