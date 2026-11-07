// Privacy and compliance signals (PDPL, GDPR, general cybersecurity): where
// personal data may leak or be kept without a way out. Signals for a person to
// review, never a compliance verdict. Personal data here means a national id
// or iqama, email, phone, IBAN, date of birth, passport or social security
// number, recognised by the words of an identifier (nationalId, user_email,
// phoneNumber), not by any text in strings.
import { match } from '../map/lex.mjs';
import { at } from './source.mjs';

// Words that make a name personal data, and endings that make it about the data, not the data itself.
const PII = [['national', 'id'], ['iqama'], ['email'], ['e', 'mail'], ['phone'], ['mobile'], ['msisdn'], ['iban'], ['dob'], ['birth'], ['passport'], ['ssn']];
const ABOUT = new Set(['verified', 'sent', 'enabled', 'valid', 'validation', 'count', 'status', 'type', 'template', 'templates', 'length', 'exists', 'changed', 'required', 'error', 'errors', 'key', 'keys', 'format', 'regex', 'pattern', 'label', 'field', 'mask', 'masked', 'hash', 'hashed', 'domain', 'provider', 'providers', 'channel', 'config', 'service', 'client', 'queue', 'job', 'otp', 'input', 'schema', 'settings', 'enabled', 'url', 'link', 'subject', 'body', 'html', 'text', 'event', 'events', 'log', 'redirect', 'sender', 'from', 'transport', 'mode', 'id', 'ids', 'at', 'on', 'by']);
export const words = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
export function isPersonal(name) {
  const w = words(name);
  if (!w.length || ABOUT.has(w.at(-1)) && !(w.at(-1) === 'id' && w.includes('national'))) return false;
  return PII.some((p) => w.some((_, i) => p.every((x, j) => w[i + j] === x)));
}
const idents = (code) => code.match(/[A-Za-z_$][\w$]*/g) ?? [];
const SAFE = /mask|redact|hash|last4|lastFour|anonymi[sz]|truncat|\*\*\*/i;

// A log call's arguments (the whole call for JS, the line otherwise), with string contents blanked.
const LOG = /\b(?:console\s*\.\s*(?:log|info|warn|error|debug|trace)|(?:logger|log|fastify\.log|request\.log|req\.log|this\.logger|logging)\s*\.\s*(?:info|warn|warning|error|debug|trace|fatal|log|critical|exception)|print)\s*\(/g;
// Seeds and operator scripts print to a terminal, not to a stored log: their console output is not counted.
const TERMINAL = /(^|\/)(scripts?|tools|bin|seeds?)\/|(^|\/)seed[^/]*$/i;
// Booleans and lengths about the data are not the data: !!user.email, phone.length, typeof email.
const ABOUT_DATA = /!+\s*[\w$.?]+|[\w$.?]+\s*\.\s*length\b|\btypeof\s+[\w$.?]+/g;
function piiInLogs(f) {
  const out = [];
  for (const m of f.bare.matchAll(LOG)) {
    if (TERMINAL.test(f.path) && /^(?:console|print)/.test(m[0])) continue;
    const open = m.index + m[0].length - 1;
    const end = f.lang === 'js' ? match(f.bare, open) : f.bare.indexOf('\n', open);
    const args = f.bare.slice(open, end < 0 ? open + 400 : Math.min(end, open + 1500)).replace(ABOUT_DATA, ' ');
    if (SAFE.test(args)) continue;
    const hit = idents(args).find(isPersonal);
    if (hit) out.push({ ...at(f, f.lineOf(m.index)), name: hit });
  }
  return out;
}

// Personal data in a URL: a query parameter or a route parameter by that name.
const URL_PII = /[?&](?:email|phone|mobile|msisdn|national_?id|nationalId|iqama|iban|dob|ssn|passport)=|\/:(?:email|phone|mobile|nationalId|national_id|iqama|iban|dob|passport)\b|searchParams\.(?:set|append)\s*\(\s*["'](?:email|phone|mobile|nationalId|national_id|iqama|iban|dob)["']/i;
const piiInUrls = (f) => f.lines.flatMap((l, i) => (URL_PII.test(l) ? [at(f, i + 1)] : []));

// Columns that hold personal data: in database files (db/, models/, entities/, prisma/, migrations/,
// schema.*, .prisma, .sql), a name followed by a storage type on the same line. A validation schema is not storage.
const SCHEMA_FILE = /(^|\/)(db|database|models?|entities|prisma|migrations?)\/|(^|\/)schema\.[a-z]+$|\.prisma$|\.sql$/i;
const COLUMN = /^\s*["'\x60]?([A-Za-z_]\w*)["'\x60]?\s*[:=(]?[^\n]*?\b(?:text|varchar|char|String|bigint|integer|date|timestamp|Column|CharField|TextField|DateField|mapped_column)\b/;
function personalColumns(f) {
  if (!SCHEMA_FILE.test(f.path) || /(^|\/)seeds?(\/|[^/]*$)/i.test(f.path)) return [];
  const out = [];
  f.lines.forEach((l, i) => { const m = COLUMN.exec(l); const n = m?.[1]; if (n && isPersonal(n)) out.push({ ...at(f, i + 1), name: n }); });
  return out;
}
const ENCRYPT = /encrypt|cipher|pgp_sym|kms|vault|sealed|aes|crypto\.create(?:Cipher|Hash)/i;

// Browser storage holding personal data or a token: readable by any script on the page.
const STORAGE = /\b(?:localStorage|sessionStorage)\s*\.\s*setItem\s*\(\s*["'`]?([^"'`,)]+)/;
function webStorage(f) {
  const out = [];
  f.lines.forEach((l, i) => { const m = STORAGE.exec(l); if (m && (isPersonal(m[1]) || /token|jwt|session|secret|password/i.test(m[1]))) out.push(at(f, i + 1)); });
  return out;
}

// A name may go on in camelCase: anonymiseUser, eraseAccount.
const RETENTION = /(?<![a-z])(?:eras(?:e|ure)|anonymi[sz]|retention|purge|right[-_ ]to[-_ ]be[-_ ]forgotten|data[-_ ]subject|delete_?account|delete_?user|forget_?user)/i;
const CONSENT = /\bconsent|privacy (?:policy|notice)|سياسة الخصوصية|موافق/i;

export function privacy(all, { focus = null } = {}) {
  const prod = all.filter((f) => !f.test && !f.generated);
  const files = prod.filter((f) => !focus || focus.has(f.path));
  const logs = []; const urls = []; const plain = []; const store = [];
  for (const f of files) {
    if (f.lang !== 'sql') logs.push(...piiInLogs(f));
    urls.push(...piiInUrls(f));
    if (!ENCRYPT.test(f.text)) plain.push(...personalColumns(f).filter((c) => /national|iqama|iban|passport|ssn|dob|birth/i.test(c.name)));
    store.push(...webStorage(f));
  }
  // Project-wide: is there any way to delete or anonymise personal data, and any consent text?
  const columns = prod.flatMap(personalColumns);
  const first = (re) => { for (const f of prod) { const i = f.lines.findIndex((l) => re.test(l)); if (i >= 0) return at(f, i + 1); } return null; };
  const retention = columns.length ? first(RETENTION) : null;
  const consent = columns.length ? first(CONSENT) : null;
  const signal = (id, title, severity, ev) => ({ id, area: 'privacy', title, severity, count: ev.length, evidence: ev.slice(0, 12) });
  return {
    signals: [
      signal('pii-log', 'Personal data passed to a log call', 'high', logs),
      signal('pii-url', 'Personal data in a URL (query string or route parameter; URLs end up in logs and browser history)', 'medium', urls),
      signal('plain-column', 'Sensitive personal data stored with no sign of encryption in the file', 'low', plain),
      signal('web-storage', 'Personal data or a token in browser storage (readable by any script on the page)', 'medium', store),
      ...(columns.length && !retention ? [signal('no-retention', 'Personal data is stored but no deletion, anonymisation or retention path was found', 'medium', columns)] : []),
      ...(columns.length && !consent ? [signal('no-consent', 'Personal data is stored but no consent or privacy-notice text was found', 'low', columns)] : []),
    ].filter((s) => s.count),
    found: { personalFields: columns.length, retention, consent },
  };
}
