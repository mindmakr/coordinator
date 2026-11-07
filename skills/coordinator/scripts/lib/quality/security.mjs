// Security signals: lines a reviewer should look at, each with its file and
// line. Tests, fixtures and generated files are skipped. Each detector is a
// pattern with the checks that keep false positives low; references/quality.md
// lists what each one catches and misses.
import { secretKind } from './secretline.mjs';
import { at } from './source.mjs';

// A credential is shown by its file, line and kind only: never its value or its line.
function secrets(f) {
  const out = [];
  f.lines.forEach((l, i) => { const kind = secretKind(l); if (kind) out.push({ file: f.path, line: i + 1, text: kind }); });
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
    const py = f.lang === 'python' && (/\bf(["'])(?:(?!\1).)*\{/.test(l) || /["']\s*%\s*[(\w]|\.format\s*\(/.test(l));
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
