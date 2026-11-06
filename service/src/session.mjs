// Sign-in with the GitHub App's user authorisation, and sessions.
// - The OAuth `state` is random, kept in a short-lived HttpOnly cookie and
//   compared in constant time on the way back (CSRF-safe sign-in).
// - The session cookie is a random id; the database keeps only its SHA-256.
// - The person's GitHub tokens are encrypted at rest (AES-256-GCM, key derived
//   from SESSION_SECRET) and refreshed when they expire.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const hash = (s) => createHash('sha256').update(s).digest('hex');
// Constant-time and total: the SHA-256 digests are compared, so any input (any length, multibyte) gives true or false, never a throw.
const digest = (s) => createHash('sha256').update(s, 'utf8').digest();
export const same = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(digest(a), digest(b));

export function sealer(secret) {
  const key = Buffer.from(hkdfSync('sha256', secret, 'coordinator-service', 'token-encryption', 32));
  return {
    seal(text) {
      if (text === null || text === undefined) return null;
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
      return ['v1', iv, c.getAuthTag(), ct].map((x) => (typeof x === 'string' ? x : x.toString('base64url'))).join('.');
    },
    open(sealed) {
      if (!sealed) return null;
      const [v, iv, tag, ct] = sealed.split('.');
      if (v !== 'v1') throw new Error('unknown token format');
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    },
  };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// After sign-in, only a page path of this service is a valid place to land.
const NEXT = /^\/(?:r\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9._/-]{0,200})?)?$/;
export const safeNext = (p) => (typeof p === 'string' && NEXT.test(p) && !p.includes('..') ? p : '/');

export function sessions({ db, gh, config, log, now = Date.now }) {
  const box = sealer(config.sessionSecret);
  const csrfKey = Buffer.from(hkdfSync('sha256', config.sessionSecret, 'coordinator-service', 'csrf', 32));
  const name = config.secure ? '__Host-coordinator' : 'coordinator';
  const stateName = config.secure ? '__Host-coordinator-oauth' : 'coordinator-oauth';
  const redirectUri = `${config.baseUrl}/auth/callback`;
  const cookie = (n, v, maxAge) => `${n}=${v}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secure ? '; Secure' : ''}`;

  async function current(cookies) {
    const id = cookies[name];
    if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const s = await db.session(hash(id));
    if (!s) return null;
    return { idHash: s.idHash, userId: s.userId, login: s.login, csrf: createHmac('sha256', csrfKey).update(s.idHash).digest('base64url'), token: () => token(s) };
  }

  // The person's access token, refreshed first when it has expired. null: sign in again.
  async function token(s) {
    if (!s.tokenExpiresAt || s.tokenExpiresAt > now() + 60_000) return box.open(s.tokenEnc);
    if (!s.refreshEnc || (s.refreshExpiresAt && s.refreshExpiresAt <= now())) { await db.dropSession(s.idHash); return null; }
    try {
      const t = await gh.refresh(box.open(s.refreshEnc));
      const sealed = { tokenEnc: box.seal(t.token), refreshEnc: box.seal(t.refresh), tokenExpiresAt: t.expiresAt, refreshExpiresAt: t.refreshExpiresAt };
      await db.updateSessionTokens(s.idHash, sealed);
      Object.assign(s, sealed);
      return t.token;
    } catch (e) {
      log?.warn('token refresh failed; signing out', { login: s.login, error: e });
      await db.dropSession(s.idHash);
      return null;
    }
  }

  return {
    cookieName: name,
    current,
    validCsrf: (s, value) => !!s && same(value, s.csrf),
    // Step 1: where to send the browser, and the cookie that remembers the state.
    begin(next) {
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const state = randomBytes(24).toString('base64url');
      const value = `${state}.${Buffer.from(safeNext(next)).toString('base64url')}.${verifier}`;
      return { location: gh.authorizeUrl(state, redirectUri, challenge), cookie: cookie(stateName, value, 600) };
    },
    // Step 2: GitHub sent the browser back. Throws on a missing or wrong state.
    async finish(query, cookies) {
      const [state, nextB64, verifier] = String(cookies[stateName] ?? '').split('.');
      if (!state || !same(query.get('state'), state)) throw Object.assign(new Error('sign-in expired or was not started here; try again'), { status: 400 });
      const code = query.get('code');
      if (!code || code.length > 100) throw Object.assign(new Error('GitHub did not return a code'), { status: 400 });
      if (!verifier || !/^[A-Za-z0-9_-]{43}$/.test(verifier)) throw Object.assign(new Error('sign-in expired or was not started here; try again'), { status: 400 });
      const t = await gh.exchangeCode(code, redirectUri, verifier);
      const user = await gh.user(t.token);
      // A new session every sign-in; any session this browser held before is dropped.
      const old = cookies[name];
      if (old && /^[A-Za-z0-9_-]{43}$/.test(old)) await db.dropSession(hash(old));
      const id = randomBytes(32).toString('base64url');
      const days = config.sessionDays * 86_400_000;
      await db.putSession({
        idHash: hash(id), userId: Number(user.id), login: String(user.login),
        tokenEnc: box.seal(t.token), refreshEnc: box.seal(t.refresh), tokenExpiresAt: t.expiresAt, refreshExpiresAt: t.refreshExpiresAt,
        expiresAt: now() + days,
      });
      await db.audit('sign-in', { login: String(user.login) });
      let next = '/';
      try { next = safeNext(Buffer.from(nextB64 ?? '', 'base64url').toString('utf8')); } catch { /* default */ }
      return { login: String(user.login), next, cookies: [cookie(name, id, config.sessionDays * 86_400), cookie(stateName, '', 0)] };
    },
    async end(s) { if (s) { await db.dropSession(s.idHash); await db.audit('sign-out', { login: s.login }); } return cookie(name, '', 0); },
  };
}
