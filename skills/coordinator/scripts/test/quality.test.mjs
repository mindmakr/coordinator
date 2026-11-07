// Quality and compliance signals: each detector on fixture files, with true
// positives it must find and true negatives it must leave alone.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { duplication } from '../lib/quality/duplication.mjs';
import { quality, qualityText } from '../lib/quality/index.mjs';
import { naming, styleOf } from '../lib/quality/naming.mjs';
import { isPersonal, privacy } from '../lib/quality/privacy.mjs';
import { redundancy } from '../lib/quality/redundancy.mjs';
import { security } from '../lib/quality/security.mjs';
import { sourceFile } from '../lib/quality/source.mjs';
import { structure } from '../lib/quality/structure.mjs';

const src = (path, text) => sourceFile(path, text);
const lines = (sig) => sig.evidence.map((e) => `${e.file}:${e.line}`);
const pick = (signals, id) => signals.find((s) => s.id === id);

test('duplication: a repeated block is found with both places; boilerplate and tests are not', () => {
  const block = ['const total = items.reduce((a, b) => a + b.price, 0);', 'if (total > limit) throw new Error("over the limit");', 'const tax = Math.round(total * rate);', 'const net = total - discount;', 'log.info("charged", { total, tax, net });', 'return { total, tax, net };'];
  const a = src('src/a.js', ['function a(items) {', ...block, '}'].join('\n'));
  const b = src('src/b.js', ['import x from "y";', 'function b(items) {', ...block, '}'].join('\n'));
  const t = src('src/a.test.js', ['function c(items) {', ...block, '}'].join('\n'));
  const c = src('src/c.js', ['}', '}', '});', '', '// comment', '// comment', 'import a from "a";', 'import a from "a";'].join('\n'));
  const d = duplication([a, b, t, c]);
  assert.equal(d.duplicated, 12);
  assert.equal(d.sites, 2);
  assert.equal(d.top[0].lines, 6);
  assert.match(d.top[0].also, /^src\/[ab]\.js:\d+$/);
  // Only the run's files counted: b alone.
  assert.equal(duplication([a, b, t], { focus: new Set(['src/b.js']) }).duplicated, 6);
  // No repeat, no site.
  assert.equal(duplication([a, src('src/z.js', 'const unrelated = 1;\nconst other = 2;')]).sites, 0);
});

test('structure: long and deeply nested functions are found; object literals and JSX braces are not nesting', () => {
  const long = ['export function big(x) {', ...Array.from({ length: 90 }, (_, i) => `  const v${i} = x + ${i};`), '  return x;', '}'].join('\n');
  const deep = ['function deep(a) {', '  if (a) {', '    for (const b of a) {', '      while (b.c) {', '        if (b.d) {', '          return 1;', '        }', '      }', '    }', '  }', '}'].join('\n');
  const flat = ['function flat(a) {', '  const o = { a: { b: { c: { d: { e: 1 } } } } };', '  return <div>{a && <span>{o.a}</span>}</div>;', '}'].join('\n');
  const py = ['def deep_py(a):', '    if a:', '        for b in a:', '            while b:', '                if b.c:', '                    return 1', '    return 0', ''].join('\n');
  const s = structure([src('src/long.js', long), src('src/deep.js', deep), src('src/flat.jsx', flat), src('app/deep.py', py)]);
  assert.deepEqual(s.longFunctions.top.map((f) => f.name), ['big']);
  assert.deepEqual(s.deepNesting.top.map((f) => `${f.name}:${f.depth}`).sort(), ['deep:4', 'deep_py:4']);
  assert.equal(s.functions.n >= 4, true);
});

test('naming: off-convention names per language; one-word names and conventions that fit are not flagged', () => {
  assert.equal(styleOf('userName'), 'camel'); assert.equal(styleOf('user_name'), 'snake'); assert.equal(styleOf('MAX_ROWS'), 'upper');
  assert.equal(styleOf('UserCard'), 'pascal'); assert.equal(styleOf('parseURL'), 'camel'); assert.equal(styleOf('name'), 'word');
  const js = src('src/a.ts', 'const user_name = 1;\nconst userName = 2;\nconst MAX_ROWS = 3;\nfunction get_user() {}\nclass userThing {}\nconst UserCard = () => null;\nconst x = 1;');
  const py = src('app/a.py', 'def getUser():\n    pass\ndef get_user():\n    pass\nclass user_thing:\n    pass\nMAX_ROWS = 3\n');
  const n = naming([js, py]);
  assert.deepEqual(n.outliers.top.map((o) => o.name).sort(), ['getUser', 'get_user', 'userThing', 'user_name', 'user_thing']);
  assert.equal(n.languages.js.names, 6); // x is one word: not counted
  assert.equal(n.languages.js.fit, 3);
});

test('redundancy: files nothing imports, never entry points; reuse groups; no map says how to get one', () => {
  assert.equal(redundancy(null).measured, false);
  const map = {
    modules: [
      { id: 'src/a.ts', lang: 'ts', imports: ['src/b.ts'] }, { id: 'src/b.ts', lang: 'ts', imports: [] },
      { id: 'src/orphan.ts', lang: 'ts', imports: [], lines: 40 }, { id: 'src/index.ts', lang: 'ts', imports: [] },
      { id: 'app/users/page.tsx', lang: 'tsx', imports: [] }, { id: 'scripts/backfill.ts', lang: 'ts', imports: [] },
      { id: 'src/x.test.ts', lang: 'ts', imports: [] }, { id: 'src/routes/users.ts', lang: 'ts', imports: [] },
    ],
    surfaces: [{ file: 'src/routes/users.ts' }],
    reuse: [{ lines: 12, fns: ['src/a.ts#f:3', 'src/b.ts#g:9'] }],
  };
  const r = redundancy(map);
  assert.deepEqual(r.deadFiles.top.map((d) => d.file), ['src/a.ts', 'src/orphan.ts']);
  assert.equal(r.reuse.count, 1);
  assert.equal(redundancy(map, { focus: new Set(['src/orphan.ts']) }).reuse.count, 0);
});

test('security: true positives with file:line; placeholders, env reads, tagged SQL and tests are left alone', () => {
  const bad = src('src/bad.ts', [
    'const password = "Sup3rS3cret!Value";', // 1 named credential
    'const key = "AKIAIOSFODNN7EXAMPL3";', // 2 key shape
    'eval(userInput);', // 3
    'db.query("SELECT * FROM users WHERE id = " + id);', // 4
    'await db.query(`DELETE FROM users WHERE id = ${id}`);', // 5
    'const agent = new https.Agent({ rejectUnauthorized: false });', // 6
    'app.use(cors({ origin: "*" }));', // 7
    "app.post('/payouts', async (req, reply) => {", // 8 no auth
    '});',
  ].join('\n'));
  const good = src('src/good.ts', [
    'const password = process.env.DB_PASSWORD;',
    'const token = randomBytes(32).toString("base64url");',
    'const API_KEY = "your-api-key-here";',
    'const TOKEN_INVALID = "AUTH_004";',
    'const STORAGE_KEY = "app_session_token_v2";',
    'const url = "postgresql://user:password@localhost:5432/db";',
    'const rows = await db.execute(sql`SELECT * FROM users WHERE id = ${id}`);',
    'const n = sql<number>`(SELECT COUNT(*) FROM t WHERE x = ${y})`;',
    'await q.query(`SELECT * FROM ${this.t.users} WHERE username = $1`, [u]);',
    '// eval(x) in a comment',
    'const msg = "do not eval( this";',
    'app.use(cors({ origin: ["https://app.example.com"] }));',
    "app.post('/login', handler);",
    "app.post('/orders', { preHandler: [requireAuth] }, handler);",
    'const t = "ProjectV2SingleSelectFieldOptionInput is a type name";',
  ].join('\n'));
  const fixture = src('test/fixtures.ts', 'const password = "Sup3rS3cret!Value";\neval(x);');
  const s = security([bad, good, fixture]);
  assert.deepEqual(lines(pick(s, 'secret')), ['src/bad.ts:1', 'src/bad.ts:2']);
  assert.deepEqual(lines(pick(s, 'eval')), ['src/bad.ts:3']);
  assert.deepEqual(lines(pick(s, 'sql')), ['src/bad.ts:4', 'src/bad.ts:5']);
  assert.deepEqual(lines(pick(s, 'tls')), ['src/bad.ts:6']);
  assert.deepEqual(lines(pick(s, 'cors')), ['src/bad.ts:7']);
  assert.deepEqual(lines(pick(s, 'route')), ['src/bad.ts:8']);
  // A file-wide auth hook covers its routes.
  assert.equal(pick(security([src('src/r.ts', "fastify.addHook('onRequest', fastify.authenticate);\nfastify.post('/payouts', h);")]), 'route'), undefined);
  // Python: shell=True and verify=False.
  const py = security([src('app/x.py', 'subprocess.run(cmd, shell=True)\nrequests.get(u, verify=False)\ncur.execute(f"SELECT * FROM t WHERE id = {i}")\n')]);
  assert.deepEqual(py.map((x) => x.id).sort(), ['eval', 'sql', 'tls']);
});

test('privacy: personal data in logs and URLs, plain sensitive columns, browser storage; booleans, masks and prose are not', () => {
  assert.equal(isPersonal('nationalId'), true); assert.equal(isPersonal('user_email'), true); assert.equal(isPersonal('phoneNumber'), true);
  assert.equal(isPersonal('emailVerified'), false); assert.equal(isPersonal('emailTemplate'), false); assert.equal(isPersonal('userId'), false); assert.equal(isPersonal('phonetic'), false);
  const app = src('src/svc.ts', [
    'logger.info({ email: user.email }, "sent");', // 1
    'console.log(`welcome ${user.nationalId}`);', // 2
    'logger.info({ emailChanged: !!changed.email }, "contact changed");', // 3 boolean: no
    'logger.info("email sent to the user");', // 4 prose: no
    'logger.info({ phone: maskPhone(user.phone) });', // 5 masked: no
    'fetch(`/api/users?email=${email}`);', // 6 URL
    'router.get("/users/:nationalId", h);', // 7 URL
    'localStorage.setItem("authToken", token);', // 8 storage
    'localStorage.setItem("theme", "dark");', // 9 no
  ].join('\n'));
  const schema = src('backend/src/db/schema.ts', 'export const users = pgTable("users", {\n  nationalId: text("national_id").notNull(),\n  email: text("email"),\n  displayName: text("display_name"),\n});');
  const seed = src('backend/src/db/seed.ts', 'console.log(`seeded ${nationalId}`);');
  const p = privacy([app, schema, seed]);
  assert.deepEqual(lines(pick(p.signals, 'pii-log')), ['src/svc.ts:1', 'src/svc.ts:2']);
  assert.deepEqual(lines(pick(p.signals, 'pii-url')), ['src/svc.ts:6', 'src/svc.ts:7']);
  assert.deepEqual(lines(pick(p.signals, 'web-storage')), ['src/svc.ts:8']);
  assert.deepEqual(lines(pick(p.signals, 'plain-column')), ['backend/src/db/schema.ts:2']);
  assert.equal(p.found.personalFields, 2);
  assert.ok(pick(p.signals, 'no-retention'), 'no deletion path anywhere');
  assert.ok(pick(p.signals, 'no-consent'));
  // A deletion path and consent text clear both; encryption in the file clears the column.
  const fixed = privacy([schema, src('src/erase.ts', 'export async function anonymiseUser(id) {}\n// shown with the privacy notice'), src('backend/src/db/crypto.ts', '')]);
  assert.equal(pick(fixed.signals, 'no-retention'), undefined);
  assert.equal(pick(fixed.signals, 'no-consent'), undefined);
  assert.equal(pick(privacy([src('backend/src/db/schema.ts', 'import { encrypt } from "./crypto";\n  nationalId: text("national_id"),')]).signals, 'plain-column'), undefined);
});

// A fixture repo: the command measures the project and the files a run changed.
const root = mkdtempSync(join(tmpdir(), 'coord-quality-'));
after(() => rmSync(root, { recursive: true, force: true }));
const put = (p, t) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), t); };

test('quality(): project and changed scopes, evidence on every signal, the disclaimer, and text output', () => {
  spawnSync('git', ['init', '-q'], { cwd: root });
  put('src/ok.js', 'export const add = (a, b) => a + b;\n');
  put('src/bad.js', 'const password = "Sup3rS3cret!Value";\nlogger.info({ iban: account.iban });\n');
  put('node_modules/x/index.js', 'eval(x);\n');
  const q = quality({ root, changed: ['src/bad.js', 'gone.js'] });
  assert.equal(q.project.files, 2);
  assert.equal(q.changed.files, 1);
  assert.equal(q.changed.listed, 2);
  assert.deepEqual(q.project.signals.map((s) => s.id).sort(), ['pii-log', 'secret']);
  for (const s of q.project.signals) for (const e of s.evidence) assert.match(`${e.file}:${e.line}`, /^src\/bad\.js:\d+$/);
  assert.match(q.disclaimer, /not a compliance certification/);
  const t = qualityText(q);
  assert.match(t, /src\/bad\.js:1/);
  assert.match(t, /Changed by the run/);
  assert.equal(quality({ root }).changed, undefined);
});

test('round 2 misses: camelCase and Django-style names, f-string SQL, a log call that masks one argument but not another', () => {
  const py = src('app/settings.py', ['SECRET_KEY = "django-insecure-9x7f2k3m4n5b6v7c8x9z0q1w2e3r4t5y"', 'cur.execute(f"SELECT * FROM t WHERE email = \'{email}\'")'].join('\n'));
  const s = security([src('src/k.ts', "const dbPassword = 'Tr0ub4dor&3xK9';\nconst storageKey = \"app_session_token_v2\";"), py]);
  assert.deepEqual(lines(pick(s, 'secret')), ['src/k.ts:1', 'app/settings.py:1']);
  assert.deepEqual(lines(pick(s, 'sql')), ['app/settings.py:2']);
  const p = privacy([src('src/l.ts', "logger.info({ to: maskRecipient(user.phone), email: user.email }, 'sent');\nlogger.info({ to: maskRecipient(user.phone) }, 'sent');")]);
  assert.deepEqual(lines(pick(p.signals, 'pii-log')), ['src/l.ts:1']);
});

test('evidence never carries a secret: the secrets signal shows file, line and kind only; other evidence lines are masked', () => {
  const planted = 'Zq9!synthetic-Pw-7731';
  const f = src('src/p.ts', [`const adminPassword = '${planted}';`, `eval(input, { password: '${planted}' });`].join('\n'));
  const s = security([f]);
  const all = JSON.stringify(s);
  assert.doesNotMatch(all, /synthetic-Pw/);
  assert.equal(pick(s, 'secret').evidence[0].text, 'credential assigned a literal');
  assert.match(pick(s, 'eval').evidence[0].text, /\[redacted\]/);
});

test('round 3: a credential on a line over 400 characters is found, and that line never reaches evidence', () => {
  const planted = 'Zq9!synthLong-Pw-4410';
  const long = `const pad = [${'"c", '.repeat(90)}]; const q = \`SELECT * FROM t WHERE id = \${id}\`; const dbPassword = '${planted}';`;
  assert.ok(long.length > 400);
  const s = security([src('src/long.ts', long)]);
  assert.deepEqual(lines(pick(s, 'secret')), ['src/long.ts:1']);
  assert.deepEqual(lines(pick(s, 'sql')), ['src/long.ts:1']);
  assert.doesNotMatch(JSON.stringify(s), /synthLong/);
  assert.equal(pick(s, 'sql').evidence[0].text, '[line withheld: it holds a credential]');
});
