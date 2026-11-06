// One JSON line per entry. Callers pass fields, never headers, cookies, query
// strings or request bodies; every string still goes through the skill's
// secret masking as a second net.
import { maskSecrets } from './core.mjs';

const clean = (v) => (typeof v === 'string' ? maskSecrets(v).slice(0, 500) : v);

export function logger(out = process.stdout) {
  const write = (level, msg, fields = {}) => {
    const line = { at: new Date().toISOString(), level, msg: clean(msg) };
    for (const [k, v] of Object.entries(fields)) line[k] = clean(v instanceof Error ? v.message : v);
    out.write(`${JSON.stringify(line)}\n`);
  };
  return { info: (m, f) => write('info', m, f), warn: (m, f) => write('warn', m, f), error: (m, f) => write('error', m, f) };
}

export const silent = { info() {}, warn() {}, error() {} };
