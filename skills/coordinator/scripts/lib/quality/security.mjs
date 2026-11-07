// Security signals: lines a reviewer should look at, each with its file and
// line. Tests, fixtures and generated files are skipped. Each detector is a
// pattern with the checks that keep false positives low; references/quality.md
// lists what each one catches and misses.
import { findSecret } from '../secrets.mjs';
import { at } from './source.mjs';

// A quoted value that is a placeholder, a reference or an example, not a credential.
const PLACEHOLDER = /^(?:x{3,}|\*{3,}|changeme|change[-_ ]me|example|sample|dummy|placeholder|redacted|your[-_ ]|<[^>]*>|\$\{|%s|test|secret|password|todo)|abcdefghij|0123456789/i;
const SNAKE = /^[a-z][a-z0-9]*(?:[_.-][a-z0-9]+)+$/; // a storage key or event name: payday_session_token_v2
const CODE = /^[A-Z][A-Z0-9]*(?:[_.-][A-Z0-9]+)+$/; // an enum value or error code: AUTH_004 (an AWS key has no separator)
// A URL whose password is a stand-in (postgresql://user:password@localhost) is a local example.
const WEAK = /:\/\/([^:/@\s]+):(?:unused|password|pass|postgres|secret|user|test|example|changeme|admin|root|\1)@/i;
const ASSIGN = /([A-Za-z_$][\w$-]*)["']?\s*[:=]\s*(["'`])([^"'`\s]{6,})\2/g;

// Only string literals are read: code such as `token = randomBytes(32)` or a long type name is never a credential.
const LITERAL = /(["'`])((?:\\.|(?!\1).){8,}?)\1/g;
const CAMEL = /^[A-Za-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+[!?]?$/; // a type or identifier inside a query or a message
function secrets(f) {
  const out = [];
  f.lines.forEach((l, i) => {
    if (l.length > 400) return;
    let hit = false;
    // A credential shape inside a literal: the whole literal when it is one token, else each long word of it.
    for (const m of l.matchAll(LITERAL)) {
      const v = m[2];
      if (PLACEHOLDER.test(v) || CODE.test(v) || WEAK.test(v) || v.includes('${')) continue;
      const pieces = /\s/.test(v) ? v.split(/\s+/).filter((p) => p.length >= 16) : [v];
      if (/-----BEGIN [A-Z ]*PRIVATE KEY/.test(v) || pieces.some((p) => !CAMEL.test(p) && findSecret(p))) hit = true;
    }
    // A credential's name assigned a literal: password = "Sup3rS3cret!".
    for (const m of l.matchAll(ASSIGN)) if (!PLACEHOLDER.test(m[3]) && !CODE.test(m[3]) && !SNAKE.test(m[3]) && !WEAK.test(m[3]) && !m[3].includes('${') && findSecret(`${m[1]}=${m[3]}`)) hit = true;
    if (hit) out.push(at(f, i + 1));
  });
  return out;
}

// Per-line patterns, checked on the bare text (strings blanked) unless `onCode`.
const LINE = [
  { id: 'eval', langs: ['js'], re: /\beval\s*\(|\bnew\s+Function\s*\(/ },
  { id: 'eval', langs: ['python'], re: /(?<![.\w])(?:eval|exec)\s*\(/ },
  { id: 'eval', onCode: true, langs: ['js'], re: /\bexec(?:Sync)?\s*\(\s*(?:`[^`]*\$\{|["'][^"']*["']\s*\+)/ },
  { id: 'eval', onCode: true, langs: ['python'], re: /\bos\.system\s*\(|\bshell\s*=\s*True\b/ },
  { id: 'tls', onCode: true, re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED["']?\s*[\]=:]+\s*["']?0|\bverify\s*=\s*False\b|InsecureSkipVerify\s*:\s*true|strictSSL\s*:\s*false|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:false|0)/ },
  { id: 'cors', onCode: true, re: /Access-Control-Allow-Origin["']?\s*[,:]\s*["']\*["']|\borigin\s*:\s*(?:["']\*["']|true\b)|allow_origins\s*=\s*\[\s*["']\*["']\s*\]|AllowAnyOrigin\(\)/ },
];

// SQL text with a value pasted in: a string with SQL keywords joined with + or
// interpolated, outside a tagged template (sql`…`, Prisma.sql`…`), which parameterises.
const SQL = /\b(?:SELECT\s[\s\S]{0,200}?\sFROM|INSERT\s+INTO|UPDATE\s+[\w."`]+\s+SET|DELETE\s+FROM)\b/i;
// A table name interpolated after FROM, INTO, UPDATE, JOIN or TABLE (schema.table too) is an identifier, not a value.
const TABLE = /\b(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+\$\{[^}]*\}(?:\.\$\{[^}]*\}|\.\w+)?/gi;
function sqlConcat(f) {
  const out = []; const bare = f.lang === 'js' ? f.bare.split('\n') : f.lines;
  f.lines.forEach((l, i) => {
    if (!SQL.test(l)) return;
    const b = bare[i] ?? '';
    const tpl = /(?<![\w.$])`[^`]*\$\{/.test(l.replace(TABLE, 'T')) && !/\b(?:sql|Prisma\.sql|SQL|gql|css|html)(?:<[^`]*?>)?\s*`/.test(l);
    const plus = /["'`]\s*\+\s*[A-Za-z_$(]|[A-Za-z_$)\]]\s*\+\s*["'`]/.test(l) && /\+/.test(b);
    const py = f.lang === 'python' && (/\bf["'][^"']*\{/.test(l) || /["']\s*%\s*[(\w]|\.format\s*\(/.test(l));
    const raw = /\bsql\.raw\s*\(\s*`[^`]*\$\{|\.unsafe\s*\(\s*`[^`]*\$\{|\$queryRawUnsafe\s*\(/.test(l);
    if (tpl || plus || py || raw) out.push(at(f, i + 1));
  });
  return out;
}

// Write routes with no sign of an auth check on the route or in the file.
// Express, Fastify, Koa routers and Next.js route handlers; low severity: a
// parent plugin or a gateway may well guard them, which a line cannot see.
const ROUTE = /\b(?:app|router|server|fastify|api|routes?)\s*\.\s*(post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(\s*["'`]([^"'`]*)/i;
const AUTHY = /auth|guard|protect|session|jwt|token|permission|role|requireUser|currentUser|verify|signedIn|isLogged|preHandler|onRequest|preValidation|clerk|getServerSession/i;
const PUBLIC_FILE = /webhook|callback|public|health/i;
const PUBLIC_PATH = /login|log-in|sign-?in|sign-?up|register|webhook|callback|health|otp|public|reset|forgot|verify|token|refresh|logout|status|csp-report/i;
function openRoutes(f) {
  if (f.lang !== 'js' || PUBLIC_FILE.test(f.path)) return [];
  const fileGuard = /\.addHook\s*\(\s*["'](?:onRequest|preHandler|preValidation)["']|\.use\s*\([^)]*(?:auth|guard|protect|session|jwt)/i.test(f.text);
  if (fileGuard) return [];
  const out = [];
  f.lines.forEach((l, i) => {
    const m = ROUTE.exec(l);
    if (!m || PUBLIC_PATH.test(m[2])) return;
    const near = f.lines.slice(i, i + 4).join('\n');
    if (!AUTHY.test(near)) out.push(at(f, i + 1));
  });
  return out;
}

export function security(all, { focus = null } = {}) {
  const files = all.filter((f) => !f.test && !f.generated && (!focus || focus.has(f.path)));
  const hits = { secret: [], eval: [], sql: [], tls: [], cors: [], route: [] };
  for (const f of files) {
    if (!/\.env\.(example|sample|template)$/.test(f.path)) hits.secret.push(...secrets(f));
    const bare = f.bare.split('\n');
    for (const d of LINE) {
      if (d.langs && !d.langs.includes(f.lang)) continue;
      f.lines.forEach((l, i) => { if (d.re.test(d.onCode ? l : (bare[i] ?? ''))) hits[d.id].push(at(f, i + 1)); });
    }
    if (f.lang !== 'sql') hits.sql.push(...sqlConcat(f));
    hits.route.push(...openRoutes(f));
  }
  const signal = (id, title, severity, ev) => ({ id, area: 'security', title, severity, count: ev.length, evidence: ev.slice(0, 12) });
  return [
    signal('secret', 'Hard-coded credential or key', 'high', hits.secret),
    signal('eval', 'Dynamic code execution (eval, new Function, a shell command built from strings)', 'high', dedupe(hits.eval)),
    signal('sql', 'SQL built by joining strings (injection risk)', 'high', hits.sql),
    signal('tls', 'TLS certificate checks turned off', 'high', dedupe(hits.tls)),
    signal('cors', 'CORS open to any origin', 'medium', dedupe(hits.cors)),
    signal('route', 'Write route with no visible auth check (check the parent plugin or gateway)', 'low', hits.route),
  ].filter((s) => s.count);
}

const dedupe = (ev) => [...new Map(ev.map((e) => [`${e.file}:${e.line}`, e])).values()];
