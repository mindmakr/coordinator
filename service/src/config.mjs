// Settings come from the environment only (.env.example lists them). Secrets
// are never logged and never written to the database.
import { readFileSync } from 'node:fs';
import { alertConfig } from './alerts/config.mjs';
import { parseCidr } from './hooksource.mjs';

const need = (env, k) => {
  const v = env[k];
  if (!v || !String(v).trim()) throw new Error(`missing setting ${k} (see service/.env.example)`);
  return String(v).trim();
};
// A PEM in one env line usually arrives with "\n" escapes; *_FILE reads it from a mounted file.
const pem = (env) => (env.GITHUB_APP_PRIVATE_KEY_FILE ? readFileSync(env.GITHUB_APP_PRIVATE_KEY_FILE, 'utf8') : need(env, 'GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n'));
const int = (v, d, min, max) => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`setting out of range: ${v} (${min}-${max})`);
  return n;
};

const webhookSources = (v) => {
  const s = String(v ?? '').trim();
  if (!s || s === 'github') return 'github';
  if (s === 'any') return 'any';
  const list = s.split(',').map((x) => x.trim()).filter(Boolean);
  const bad = list.find((x) => !parseCidr(x));
  if (bad || !list.length) throw new Error(`WEBHOOK_SOURCES: github, any, or CIDRs like 192.0.2.0/24 (not ${bad ?? s})`);
  return list;
};

export function loadConfig(env = process.env) {
  const baseUrl = new URL(need(env, 'BASE_URL'));
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('BASE_URL must be http(s)');
  const secure = baseUrl.protocol === 'https:';
  if (!secure && !['localhost', '127.0.0.1'].includes(baseUrl.hostname)) throw new Error('BASE_URL must be https outside localhost');
  const sessionSecret = need(env, 'SESSION_SECRET');
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters (openssl rand -base64 48)');
  return {
    port: int(env.PORT, 3000, 0, 65_535),
    baseUrl: baseUrl.origin,
    secure,
    trustProxy: env.TRUST_PROXY === '1',
    // c14: proxies in front that each append to X-Forwarded-For (2: a CDN, then Traefik).
    trustedProxyHops: int(env.TRUSTED_PROXY_HOPS, 1, 1, 5),
    // c14: who may use the webhook reserve and the App header: github (GitHub's hook ranges,
    // fetched daily), any, or a comma-separated list of CIDRs.
    webhookSources: webhookSources(env.WEBHOOK_SOURCES),
    databaseUrl: env.DATABASE_URL || null,
    stateBranch: env.STATE_BRANCH || 'coordinator-state',
    // Every installation is re-read this often, so a missed webhook heals (0 turns it off).
    resyncMs: int(env.RESYNC_MINUTES, 15, 0, 1440) * 60_000,
    accessTtlMs: int(env.ACCESS_TTL_SECONDS, 60, 0, 60) * 1000, // design 10.3: at most 60 s
    sessionDays: int(env.SESSION_DAYS, 7, 1, 30),
    maxConnections: int(env.MAX_CONNECTIONS, 1000, 10, 100_000),
    sessionSecret,
    // The GitHub trail: tracker comments and board fields. "off" turns one off for every repo;
    // a repo turns its own off in coordinator.json ("trackers": false, or no "board").
    trail: { trackers: env.TRACKERS !== 'off', board: env.BOARD !== 'off' },
    // c12: alerts (SMTP, VAPID) and the doorbell; all optional.
    alerts: alertConfig(env),
    github: {
      appId: need(env, 'GITHUB_APP_ID'),
      appSlug: env.GITHUB_APP_SLUG || null,
      privateKey: pem(env),
      clientId: need(env, 'GITHUB_CLIENT_ID'),
      clientSecret: need(env, 'GITHUB_CLIENT_SECRET'),
      webhookSecret: need(env, 'GITHUB_WEBHOOK_SECRET'),
      api: env.GITHUB_API_URL || 'https://api.github.com',
      web: env.GITHUB_WEB_URL || 'https://github.com',
    },
  };
}
