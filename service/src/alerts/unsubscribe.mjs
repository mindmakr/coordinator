// One-click unsubscribe for alert email (RFC 8058). Every alert and digest email carries a link
// signed for that person and that address, in the text and in the List-Unsubscribe and
// List-Unsubscribe-Post headers, so a mail client's own "unsubscribe" button works without a
// sign-in. The link stops email to that address only, and only while it is still the address
// on file: once the person changes it, old links do nothing.
import { createHmac, hkdfSync } from 'node:crypto';
import { same } from '../session.mjs';

export function unsubscriber({ sessionSecret, baseUrl }) {
  const key = Buffer.from(hkdfSync('sha256', sessionSecret, 'coordinator-service', 'alerts-unsubscribe', 32));
  const sig = (userId, email) => createHmac('sha256', key).update(`${Number(userId)}\n${String(email).toLowerCase()}`).digest('base64url');
  const url = (userId, email) => `${baseUrl}/alerts/unsubscribe?u=${Number(userId)}&s=${sig(userId, email)}`;
  return {
    url,
    headers: (userId, email) => ({ 'List-Unsubscribe': `<${url(userId, email)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }),
    valid: (userId, email, s) => typeof email === 'string' && Number.isSafeInteger(Number(userId)) && same(sig(userId, email), String(s ?? '')),
  };
}
