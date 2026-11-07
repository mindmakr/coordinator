// Model routing (references/routing.md): mechanical builder work goes to a
// cheaper model, critics always get the strong one. On unless
// .coordinator/coordinator.json says "models": false. Recording which
// model built and judged each round works whether routing is on or off.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './store.mjs';

// Claude Code's Agent `model` families, cheapest first. A full id
// (claude-sonnet-4-5, claude-3-5-haiku-…) maps to its family; other names
// (Codex) are unranked: a judge may use one only when it is the declared strong.
const RANK = { haiku: 1, sonnet: 2, opus: 3 };
// Task classes the "mechanical" entry covers, and the ones pinned to strong.
export const MECHANICAL = ['docs', 'copy', 'translations', 'renames', 'fixtures', 'mirror'];
// A class is pinned when any word of it (split on anything but letters and digits)
// is one of PIN_WORDS or starts with one of PIN_STEMS, or it names personal data.
export const PINNED = ['security', 'money', 'migrations', 'auth', 'payments', 'billing', 'invoicing', 'authentication', 'authorization', 'permissions', 'secrets', 'crypto', 'pii', 'personal-data'];
const PIN_WORDS = new Set(['auth', 'authn', 'authz', 'money', 'pay', 'fee', 'fees', 'role', 'roles', 'pii', 'token', 'tokens', 'login', 'bill', 'bills', 'kyc']);
export const PIN_STEMS = ['secur', 'migrat', 'oauth', 'payment', 'payout', 'payroll', 'salar', 'ledger', 'refund', 'wallet', 'disburs', 'kyc', 'session', 'csrf', 'rbac', 'role', 'permission', 'iban', 'schema', 'authent', 'authori', 'billing', 'invoic', 'secret', 'crypt', 'encrypt', 'password', 'credential'];
export function pinned(cls) {
  const c = String(cls).toLowerCase();
  if (/personal[^a-z0-9]*data/.test(c)) return true;
  // "role" as a stem would catch "roleplay"; keep it a stem anyway: pinning too much costs money, not safety.
  return c.split(/[^a-z0-9]+/).filter(Boolean).some((w) => PIN_WORDS.has(w) || PIN_STEMS.some((s) => w.startsWith(s)));
}
export const UNSPECIFIED = 'unspecified';
const ROLES = ['builder', 'critic', 'specialist', 'visual-critic', 'integrator', 'researcher'];
export const JUDGES = ['critic', 'specialist', 'visual-critic', 'integrator'];
export const DEFAULT = Object.freeze({ strong: 'opus', mechanical: 'sonnet' });
const NAME = /^[A-Za-z0-9][\w.:/@-]{0,79}$/;
const KEY = /^[a-z][a-z0-9-]{0,39}$/;
const own = (o, k) => Object.hasOwn(o, k);

// Any name that mentions Claude in any spelling must parse to a family, or it is refused as a judge or strong.
export const claudeish = (name) => /claude|anthropic|haiku|sonnet|opus/i.test(String(name ?? ''));
// Provider wrappers around a Claude id: Bedrock (us./eu./apac./global. and anthropic. prefixes, -v1:0
// suffix) and Vertex (@20250805 suffix). Stripped before parsing, so real opus ids still rank.
const unwrap = (n) => n.replace(/^(?:us|eu|apac|global)\./, '').replace(/^anthropic\./, '').replace(/@\d{8}$/, '').replace(/-v\d+:\d+$/, '');

export function family(name) {
  const n = unwrap(String(name ?? '').toLowerCase());
  if (own(RANK, n)) return n;
  // Strict: exactly one family word, with only version or date parts (digits, "latest") around it.
  const m = /^claude-(?:\d+(?:\.\d+)?-){0,3}(haiku|sonnet|opus)(?:-(?:\d+(?:\.\d+)?|latest))*$/.exec(n);
  return m ? m[1] : null;
}
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
// Is `model` at least as strong as `strong`? Ranked families compare; an unranked name only by equality,
// and a Claude-looking name that does not parse never counts.
export function atLeast(model, strong) {
  if (claudeish(model) && !family(model)) return false;
  if (same(model, strong)) return true;
  const f = family(model); const s = family(strong);
  return Boolean(f && s && RANK[f] >= RANK[s]);
}

const file = (base) => join(base, 'coordinator.json');
function readCfg(base, strict = false) {
  if (!existsSync(file(base))) return {};
  try { return JSON.parse(readFileSync(file(base), 'utf8')) ?? {}; } catch (e) {
    if (strict) throw new Error(`${file(base)} is not valid JSON (${e.message}); fix or remove it first`);
    return {};
  }
}

// "models" in coordinator.json: absent (or true) is on with DEFAULT; false is off;
// an object maps a role or task class to a model name over DEFAULT, with "strong"
// the model judges never go below. { on, table, strong, warnings }.
export function normalize(raw) {
  if (raw === false) return { on: false, table: { ...DEFAULT }, strong: DEFAULT.strong, warnings: [] };
  if (raw !== undefined && raw !== true && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('"models" must be false or an object of role or task class → model name');
  const warnings = [];
  const table = { ...DEFAULT };
  for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (!KEY.test(k)) throw new Error(`"models": bad key ${JSON.stringify(k)} (a role such as critic or builder, or a task class such as mechanical)`);
    if (typeof v !== 'string' || !NAME.test(v)) throw new Error(`"models".${k} must be a model name, got: ${JSON.stringify(v)}`);
    table[k] = v;
  }
  const strong = table.strong;
  if (claudeish(strong) && family(strong) !== 'opus') throw new Error(`"models".strong = ${strong} is below opus or not a recognised opus id: judges and pinned work would run on it. Leave strong out (opus), or name an unranked model for another harness`);
  for (const k of Object.keys(table).filter((k) => JUDGES.includes(k) || pinned(k))) {
    if (own(table, k) && !atLeast(table[k], strong)) {
      warnings.push(`"models".${k} = ${table[k]} ignored: ${JUDGES.includes(k) ? 'critics are never routed' : `${k} work is never routed`} below the strong model (${strong})`);
      table[k] = strong;
    }
  }
  return { on: true, table, strong, warnings };
}

export const routing = (base) => normalize(readCfg(base).models);

// --models on|off: off writes false; on removes false (absent is on) and keeps a custom table.
// A malformed coordinator.json is refused, never overwritten.
export function setRouting(base, on) {
  const cfg = readCfg(base, true);
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error(`${file(base)} must hold a JSON object; fix it first`);
  if (!on) cfg.models = false;
  else if (cfg.models === false || cfg.models === true) delete cfg.models;
  normalize(cfg.models);
  writeAtomic(file(base), `${JSON.stringify(cfg, null, 2)}\n`);
  return cfg.models ?? 'on (built-in defaults)';
}

// One class's choice for a builder, with a strength used to pick between classes.
function forClass(cfg, cls) {
  if (pinned(cls)) return { model: cfg.strong, why: `${cls} (always strong)`, w: 100 };
  if (own(cfg.table, cls)) return { model: cfg.table[cls], why: cls, w: atLeast(cfg.table[cls], cfg.strong) ? 90 : (RANK[family(cfg.table[cls])] ?? 0) };
  if (MECHANICAL.includes(cls) && own(cfg.table, 'mechanical')) return { model: cfg.table.mechanical, why: `${cls} (mechanical)`, w: RANK[family(cfg.table.mechanical)] ?? 0 };
  return { model: own(cfg.table, 'builder') ? cfg.table.builder : null, why: 'default', w: 50 };
}

// The model for a role and its task classes (one, a list, or "a,b"): { model, why }.
// model null means the harness's default. A unit in several classes gets the strongest choice.
export function route(cfg, role, classes = []) {
  if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
  if (!cfg.on) return { model: null, why: 'routing off' };
  if (JUDGES.includes(role)) return { model: own(cfg.table, role) ? cfg.table[role] : cfg.strong, why: 'review depth is not where to save' };
  const list = (Array.isArray(classes) ? classes : String(classes ?? '').split(',')).map((c) => String(c).trim().toLowerCase()).filter(Boolean);
  if (role === 'builder' && list.length) {
    const { model, why } = list.map((c) => forClass(cfg, c)).reduce((a, b) => (b.w > a.w ? b : a));
    return { model, why };
  }
  return { model: own(cfg.table, role) ? cfg.table[role] : null, why: 'default' };
}

// While routing is on, a judge must be at least the strong model (an unranked name only if it is the strong one).
export const judgeAllowed = (cfg, model) => !cfg.on || atLeast(model, cfg.strong);

// Escalation: after a round that failed on a model below strong, the next try uses strong.
// Returns { model, why } to suggest, or null.
// Any fail on a named model below strong since the last strong build counts.
export const cheap = (cfg, m) => Boolean(m) && m !== UNSPECIFIED && !atLeast(m, cfg.strong);
export function escalation(cfg, u) {
  if (!cfg.on) return null;
  for (const r of [...u.rounds].reverse()) {
    if (r.builtBy && atLeast(r.builtBy, cfg.strong)) return null;
    if (r.verdict === 'fail' && cheap(cfg, r.builtBy)) return { model: cfg.strong, why: `retry after ${r.builtBy} failed` };
  }
  return null;
}

export const modelName = (v, flag) => {
  if (v === undefined) return null;
  if (typeof v !== 'string' || !NAME.test(v)) throw new Error(`--${flag} must be a model name (e.g. sonnet, opus, or a Codex model)`);
  return v;
};

// "built by sonnet (docs-only) · judged by opus", for a round or a unit in progress.
const by = (m, why) => `${m}${why ? ` (${why})` : ''}`;
export function whoRound(r) {
  const parts = [r.builtBy && `built by ${by(r.builtBy, r.builtWhy)}`, r.judgedBy && `judged by ${r.judgedBy}`].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}
export function whoUnit(u) {
  if (u.status === 'building' && u.builtBy) return `building on ${by(u.builtBy, u.builtWhy)}`;
  if (u.status === 'judging' && u.builtBy) return `built by ${by(u.builtBy, u.builtWhy)} · being judged`;
  const last = u.rounds.at(-1);
  return last ? whoRound(last) : null;
}

// "sonnet 1/2 passed · opus 3/3 passed · 1 round with no model recorded".
export const modelLine = (list, none = 0) => [...list.map((m) => `${m.model} ${m.passed}/${m.rounds} passed`), ...(none ? [`${none} round${none === 1 ? '' : 's'} with no model recorded`] : [])].join(' · ');
// One row per family: opus, OPUS and claude-opus-4-5 are one model here.
const groupKey = (m) => (m ? (family(m) ?? String(m).toLowerCase()) : '(not recorded)');
// Rounds with no model: never recorded (old state, routing off) or recorded as unspecified.
export const unrecorded = (run) => run.units.reduce((n, u) => n + u.rounds.filter((r) => !r.builtBy || r.builtBy === UNSPECIFIED).length, 0);

// Rounds and pass rate per builder model, and rounds per judging model, so the
// person sees whether cheaper builders fail more.
export function byModel(runs) {
  const built = new Map(); const judged = new Map();
  for (const run of runs) for (const u of run.units) for (const r of u.rounds) {
    const key = groupKey(r.builtBy);
    const b = built.get(key) ?? { model: key, rounds: 0, passed: 0 };
    b.rounds++; if (r.verdict === 'pass') b.passed++;
    built.set(key, b);
    const jm = groupKey(r.judgedBy);
    judged.set(jm, (judged.get(jm) ?? 0) + 1);
  }
  const sort = (a, b) => a.model.localeCompare(b.model);
  return {
    roundsByBuilderModel: [...built.values()].map((b) => ({ ...b, passRate: Math.round((b.passed / b.rounds) * 100) / 100 })).sort(sort),
    roundsByJudgeModel: [...judged].map(([model, rounds]) => ({ model, rounds })).sort(sort),
  };
}
