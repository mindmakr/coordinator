// The three ways out: web push (VAPID), email (SMTP) and a GitHub mention.
// Push and email are optional: with their settings unset the sender is null
// and alerts simply skip that channel. Tests pass fakes of the same shape.
import nodemailer from 'nodemailer';
import webpush from 'web-push';
import { SCOPES } from '../github.mjs';

// { send({ to, subject, text, headers? }) } or null when SMTP_HOST is unset.
export function emailSender(smtp) {
  if (!smtp?.host) return null;
  const transport = nodemailer.createTransport({
    host: smtp.host, port: smtp.port, secure: smtp.secure,
    ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass } } : {}),
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  });
  return {
    async send({ to, subject, text, headers }) { await transport.sendMail({ from: smtp.from, to, subject, text, ...(headers ? { headers } : {}) }); },
    close: () => transport.close(),
  };
}

// { publicKey, send(subscription, payload) → 'sent' | 'gone' } or null when the VAPID keys are unset.
export function pushSender(vapid) {
  if (!vapid?.publicKey || !vapid?.privateKey) return null;
  const options = { vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 12 * 3600, timeout: 15_000 };
  return {
    publicKey: vapid.publicKey,
    async send(subscription, payload) {
      try { await webpush.sendNotification(subscription, JSON.stringify(payload), options); return 'sent'; } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) return 'gone'; // the browser dropped this subscription
        throw e;
      }
    },
  };
}

// A short comment on an issue or PR that @-mentions the person, so GitHub's own notifications carry it.
// Design 9 puts the mention in the unit's tracker comment. GitHub notifies a mention only when
// the comment holding it is created, never when an edit adds it, so a mention edited into the
// tracker comment would reach nobody. Instead: one short alert comment per person per issue,
// and the App's previous one for that person (found by its marker) is deleted first, so an
// issue never collects them.
const alertMarker = (appId, login) => `<!-- coordinator:alert app=${String(appId).replace(/\D/g, '')} for=${String(login).replace(/[^A-Za-z0-9-]/g, '')} -->`;
export function mentionSender({ gh, appId }) {
  return {
    async send(installationId, ref, login, body) {
      const token = await gh.installationToken(installationId, SCOPES.comments);
      const mark = alertMarker(appId, login);
      for await (const c of gh.issueComments(token, ref.repo, ref.n)) {
        if (String(c.body ?? '').endsWith(mark) && String(c.performed_via_github_app?.id ?? '') === String(appId)) await gh.deleteComment(token, ref.repo, c.id);
      }
      await gh.createComment(token, ref.repo, ref.n, `@${login} ${body}\n\n${mark}`);
    },
  };
}

export function senders({ config, gh }) {
  return {
    email: emailSender(config.alerts?.smtp),
    push: pushSender(config.alerts?.vapid),
    github: mentionSender({ gh, appId: config.github.appId }),
  };
}
