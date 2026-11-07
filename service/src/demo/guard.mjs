// When the local demo may start. It is for one person's own machine: it listens on
// the loopback address only, and it refuses to start anywhere that looks like a real
// deployment (production named, or a real GitHub App's settings present), so it can
// never stand in for the real service or sit beside its secrets.
export const DEMO_HOSTS = ['127.0.0.1', '::1'];

// Settings only a real GitHub App has. Any of them set: this is not a demo machine.
export const APP_SETTINGS = ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY_FILE', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_WEBHOOK_SECRET'];

const set = (v) => v !== undefined && String(v).trim() !== '';

// Throws with the reason when the demo must not start.
export function demoGuard({ host, env = process.env }) {
  if (!DEMO_HOSTS.includes(String(host))) throw new Error(`refused: the demo listens on 127.0.0.1 or ::1 only, not ${host}`);
  for (const k of ['APP_ENV', 'NODE_ENV']) {
    if (String(env[k] ?? '').trim().toLowerCase() === 'production') throw new Error(`refused: ${k} is production; the demo is for a local machine`);
  }
  const app = APP_SETTINGS.filter((k) => set(env[k]));
  if (app.length) throw new Error(`refused: ${app.join(', ')} ${app.length === 1 ? 'is' : 'are'} set; the demo never runs beside a real GitHub App's settings (unset them, or use another shell)`);
}
