// Spot text that looks like a credential, so nothing secret is stored.
// Lessons refuse it; run state (goal, notes, evidence) gets it masked.
// Best-effort and tuned for evidence: "token: undefined in handler" is prose,
// "DB_PASSWORD=Sup3rS3cret!" is a secret. A named value counts only when it
// looks like a credential (mixed letters and digits/symbols, or quoted).
const NAME = '(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|secret|token|pass|passwo?r?d|pwd|private[_-]?key|access[_-]?key|client[_-]?secret|auth|stripe[_-]?key|jwt)(?:[_-][A-Za-z0-9]+)*';
// A file path (src/x.ts:42, ../config/secret.yaml) is evidence, not a credential.
const NOT_PATH = String.raw`(?![^\s"']*[/\\][^\s"']*(?:\.[A-Za-z]{1,5}\b|:\d+))`;
const VALUE = String.raw`(?:"[^"]{6,}"|'[^']{6,}'|${NOT_PATH}(?=[^\s"']*[0-9!@#$%^&*+/=])(?=[^\s"']*[A-Za-z])[^\s"',;)]{8,})`;

const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\b(sk|rk|pk)[-_](live|test|proj)?[-_]?[A-Za-z0-9]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bauthorization\s*:\s*[A-Za-z]+\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(bearer|basic)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s]+@/gi,
  new RegExp(String.raw`(?<![A-Za-z0-9])["']?${NAME}["']?\s*[:=]\s*${VALUE}`, 'gi'),
  new RegExp(String.raw`(?<![A-Za-z0-9])${NAME}\s+is\s+${VALUE}`, 'gi'),
];

// Long random-looking runs are likely keys. No '/' or '.', so paths survive.
const ENTROPIC = /(?<![A-Za-z0-9_/.-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_/.-])/g;
const looksRandom = (s) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s) && new Set(s).size >= 16;

export function findSecret(text) {
  for (const re of PATTERNS) { re.lastIndex = 0; if (re.test(text)) return true; }
  return (text.match(ENTROPIC) ?? []).some(looksRandom);
}

export function maskSecrets(text) {
  let out = text;
  for (const re of PATTERNS) { re.lastIndex = 0; out = out.replace(re, '[redacted]'); }
  return out.replace(ENTROPIC, (m) => (looksRandom(m) ? '[redacted]' : m));
}
