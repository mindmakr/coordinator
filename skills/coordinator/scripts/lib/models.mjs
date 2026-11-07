// Model routing (references/routing.md): mechanical builder work goes to a
// cheaper model, critics always get the strong one. On unless
// .coordinator/coordinator.json says "models": false. Recording which
// model built and judged each round works whether routing is on or off.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './store.mjs';

// Claude Code's Agent `model` names, cheapest first. Other names (Codex) are
// recorded as given and never ranked.
const RANK = { haiku: 1, sonnet: 2, opus: 3 };
// Task classes the "mechanical" entry covers.
export const MECHANICAL = ['docs', 'copy', 'translations', 'renames', 'fixtures', 'mirror'];
const ROLES = ['builder', 'critic', 'specialist', 'visual-critic', 'integrator', 'researcher'];
const JUDGES = ['critic', 'specialist', 'visual-critic', 'integrator'];
export const DEFAULT = Object.freeze({ critic: 'opus', mechanical: 'sonnet' });
const NAME = /^[A-Za-z0-9][\w.:/-]{0,79}$/;
const KEY = /^[a-z][a-z0-9-]{0,39}$/;

const file = (base) => join(base, 'coordinator.json');
function readCfg(base) {
  try { return existsSync(file(base)) ? (JSON.parse(readFileSync(file(base), 'utf8')) ?? {}) : {}; } catch { return {}; }
}

// "models" in coordinator.json: absent (or true) is on with DEFAULT; false is off;
// an object maps a role or task class to a model name, over DEFAULT.
// { on, table, strong, warnings }. A critic below the strongest model is warned about and ignored.
export function normalize(raw) {
  if (raw === false) return { on: false, table: { ...DEFAULT }, strong: DEFAULT.critic, warnings: [] };
  if (raw !== undefined && raw !== true && (!raw || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('"models" must be false or an object of role or task class → model name');
  const warnings = [];
  const table = { ...DEFAULT };
  for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (!KEY.test(k)) throw new Error(`"models": bad key ${JSON.stringify(k)} (a role such as critic or builder, or a task class such as mechanical)`);
    if (typeof v !== 'string' || !NAME.test(v)) throw new Error(`"models".${k} must be a model name, got: ${JSON.stringify(v)}`);
    table[k] = v;
  }
  const ranked = Object.values(table).filter((m) => m in RANK).sort((x, y) => RANK[y] - RANK[x]);
  const strong = ranked[0] ?? table.critic;
  for (const role of JUDGES) {
    if (table[role] in RANK && RANK[table[role]] < RANK[strong]) {
      warnings.push(`"models".${role} = ${table[role]} ignored: critics are never routed below the strongest model (${strong})`);
      table[role] = strong;
    }
  }
  return { on: true, table, strong, warnings };
}

export const routing = (base) => normalize(readCfg(base).models);

// --models on|off: off writes false; on removes false (absent is on) and keeps a custom table.
export function setRouting(base, on) {
  const cfg = readCfg(base);
  if (!on) cfg.models = false;
  else if (cfg.models === false || cfg.models === true) delete cfg.models;
  normalize(cfg.models);
  writeAtomic(file(base), `${JSON.stringify(cfg, null, 2)}
`);
  return cfg.models ?? 'on (built-in defaults)';
}

// The model for a role and task class: { model, why }. model null means the harness's default.
export function route(cfg, role, cls = null) {
  if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
  if (!cfg.on) return { model: null, why: 'routing off' };
  if (JUDGES.includes(role)) return { model: cfg.table[role] ?? cfg.strong, why: 'review depth is not where to save' };
  if (role === 'builder' && cls) {
    if (cfg.table[cls]) return { model: cfg.table[cls], why: cls };
    if (MECHANICAL.includes(cls) && cfg.table.mechanical) return { model: cfg.table.mechanical, why: `${cls} (mechanical)` };
  }
  return { model: cfg.table[role] ?? null, why: 'default' };
}

// A judging model ranked below the strongest one is refused while routing is on.
export function judgeAllowed(cfg, model) {
  if (!cfg.on || !(model in RANK) || !(cfg.strong in RANK)) return true;
  return RANK[model] >= RANK[cfg.strong];
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

// Rounds and pass rate per builder model, and rounds per judging model, so the
// person sees whether cheaper builders fail more.
export function byModel(runs) {
  const built = new Map(); const judged = new Map();
  for (const run of runs) for (const u of run.units) for (const r of u.rounds) {
    const b = built.get(r.builtBy ?? '(not recorded)') ?? { model: r.builtBy ?? '(not recorded)', rounds: 0, passed: 0 };
    b.rounds++; if (r.verdict === 'pass') b.passed++;
    built.set(b.model, b);
    const jm = r.judgedBy ?? '(not recorded)';
    judged.set(jm, (judged.get(jm) ?? 0) + 1);
  }
  const sort = (a, b) => a.model.localeCompare(b.model);
  return {
    roundsByBuilderModel: [...built.values()].map((b) => ({ ...b, passRate: Math.round((b.passed / b.rounds) * 100) / 100 })).sort(sort),
    roundsByJudgeModel: [...judged].map(([model, rounds]) => ({ model, rounds })).sort(sort),
  };
}
