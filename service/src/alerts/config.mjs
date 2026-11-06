// Alert and doorbell settings from the environment (.env.example lists them).
// Every one is optional: without SMTP_HOST there is no email, without the
// VAPID keys no web push, and alerts still go out on the channels that are left.
const int = (v, d, min, max, name) => {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} out of range: ${v} (${min}-${max})`);
  return n;
};

export function alertConfig(env = process.env) {
  const smtp = env.SMTP_HOST ? {
    host: String(env.SMTP_HOST).trim(),
    port: int(env.SMTP_PORT, 587, 1, 65_535, 'SMTP_PORT'),
    secure: env.SMTP_SECURE === '1',
    user: env.SMTP_USER || null,
    pass: env.SMTP_PASS || null,
    from: env.SMTP_FROM || 'Coordinator <coordinator@localhost>',
  } : null;
  const vapid = env.VAPID_PUBLIC_KEY || env.VAPID_PRIVATE_KEY ? {
    publicKey: String(env.VAPID_PUBLIC_KEY ?? '').trim(),
    privateKey: String(env.VAPID_PRIVATE_KEY ?? '').trim(),
    subject: env.VAPID_SUBJECT || 'mailto:coordinator@localhost',
  } : null;
  if (vapid && (!vapid.publicKey || !vapid.privateKey)) throw new Error('set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or neither');
  if (vapid && !/^(mailto:|https:)/.test(vapid.subject)) throw new Error('VAPID_SUBJECT must be a mailto: or https: URL');
  return {
    smtp, vapid,
    sweepMs: int(env.ALERT_SWEEP_SECONDS, 60, 10, 3600, 'ALERT_SWEEP_SECONDS') * 1000,
    doorbellStreams: int(env.DOORBELL_MAX_STREAMS, 500, 0, 100_000, 'DOORBELL_MAX_STREAMS'),
  };
}
