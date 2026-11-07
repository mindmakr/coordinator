// Credentials in one line of code: what kind, if any (the secrets detector),
// and the line with them masked (every evidence line, lib/quality/source.mjs).
// Only string literals are read: code such as `token = randomBytes(32)` or a
// long type name is never a credential. Builds on lib/secrets.mjs.
import { findSecret, maskSecrets } from '../secrets.mjs';

// A quoted value that is a placeholder, a reference or an example, not a credential.
const PLACEHOLDER = /^(?:x{3,}|\*{3,}|changeme|change[-_ ]me|example|sample|dummy|placeholder|redacted|your[-_ ]|<[^>]*>|\$\{|%s|test|secret|password|todo)|abcdefghij|0123456789/i;
// A storage key or event name (payday_session_token_v2): short lowercase words joined by underscores.
const SNAKE = /^[a-z][a-z0-9]{0,11}(?:_[a-z0-9]{1,12})+$/;
const CODE = /^[A-Z][A-Z0-9]*(?:[_.-][A-Z0-9]+)+$/; // an enum value or error code: AUTH_004 (an AWS key has no separator)
// A URL whose password is a stand-in (postgresql://user:password@localhost) is a local example.
const WEAK = /:\/\/([^:/@\s]+):(?:unused|password|pass|postgres|secret|user|test|example|changeme|admin|root|\1)@/i;
const ASSIGN = /([A-Za-z_$][\w$-]*)["']?\s*[:=]\s*(["'`])([^"'`\s]{6,})\2/g;
const LITERAL = /(["'`])((?:\\.|(?!\1).){6,}?)\1/g;
const CAMEL = /^[A-Za-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+[!?]?$/; // a type or identifier inside a query or a message
const skip = (v) => PLACEHOLDER.test(v) || CODE.test(v) || WEAK.test(v) || v.includes('${');
// dbPassword → db_Password, so lib/secrets.mjs sees the credential word in a camelCase name.
const snaked = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');

// 'private key', 'key or token', 'named credential', or null.
export function secretKind(line) {
  if (line.length > 400) return null;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY/.test(line)) return 'private key';
  for (const m of line.matchAll(LITERAL)) {
    const v = m[2];
    if (v.length < 8 || skip(v)) continue;
    const pieces = /\s/.test(v) ? v.split(/\s+/).filter((p) => p.length >= 16) : [v];
    if (pieces.some((p) => !CAMEL.test(p) && findSecret(p))) return 'key or token literal';
  }
  for (const m of line.matchAll(ASSIGN)) {
    if (!skip(m[3]) && !SNAKE.test(m[3]) && findSecret(`${snaked(m[1])}=${m[3]}`)) return 'credential assigned a literal';
  }
  return null;
}

// The line safe to show: known shapes masked, and every literal masked when the line holds a credential.
export function maskLine(line) {
  const out = maskSecrets(line);
  return secretKind(line) ? out.replace(LITERAL, (_, q) => `${q}[redacted]${q}`) : out;
}
