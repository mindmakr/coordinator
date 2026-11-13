// Reads the gate report Prism writes, `.prism/gate-report.json` (references/prism.md): whether the
// visual gate passed, for which commit, against which tokens, and what it found. Text in, plain data
// out: the coordinator stays dependency-free and never runs Prism itself. Unknown fields are ignored,
// so a newer report still reads; a report that contradicts itself is refused.
import { createHash } from 'node:crypto';
import { maskSecrets } from './secrets.mjs';

export const SCHEMA = 1;
export const STATUSES = ['PASS', 'FAIL'];
const MAX = 20;
const CUT = 300;
const LIST_MAX = 5000;
const HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const HASH = /^[0-9a-f]{64}$/;

const clip = (s, n = CUT) => { const t = maskSecrets(String(s)).replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const str = (v, n) => (typeof v === 'string' && v.trim() ? clip(v, n) : null);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const tokensHash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Where one check or violation applies: "settings · empty · 390x844", from whichever parts it names.
const where = (x) => ['target', 'state', 'viewport'].map((k) => str(x[k], 80)).filter(Boolean).join(' · ') || null;

// { status, head, tokensSha256, round, tool, checks: { total, failed }, violations: [...], more }.
// Throws with the reason in plain words when the text is not a gate report this coordinator can trust.
export function parsePrismReport(text) {
  let r;
  try { r = JSON.parse(String(text)); } catch { throw new Error('the file is not JSON'); }
  if (!isObj(r)) throw new Error('the file is not a gate report (a JSON object with schema, status, head and tokensSha256)');
  if (r.schema !== SCHEMA) throw new Error(`schema ${JSON.stringify(r.schema ?? null)} is not one this coordinator reads (it reads ${SCHEMA})`);
  if (!STATUSES.includes(r.status)) throw new Error(`status must be PASS or FAIL, got: ${JSON.stringify(r.status ?? null)}`);
  if (typeof r.head !== 'string' || !HEAD.test(r.head)) throw new Error('head must be the full commit id the gate checked (40 or 64 lowercase hex characters)');
  if (typeof r.tokensSha256 !== 'string' || !HASH.test(r.tokensSha256)) throw new Error('tokensSha256 must be the sha256 of the .prism/tokens.json the gate checked against (64 lowercase hex characters)');
  if (r.round !== undefined && !(Number.isInteger(r.round) && r.round >= 1 && r.round <= 100)) throw new Error('round must be a whole number from 1');
  for (const k of ['checks', 'violations']) {
    if (r[k] !== undefined && !Array.isArray(r[k])) throw new Error(`${k} must be a list`);
    if ((r[k] ?? []).length > LIST_MAX) throw new Error(`${k} has more than ${LIST_MAX} entries`);
    if ((r[k] ?? []).some((x) => !isObj(x))) throw new Error(`every entry of ${k} must be an object`);
  }
  const checks = r.checks ?? [];
  if (checks.some((c) => !STATUSES.includes(c.status))) throw new Error('every check needs a status of PASS or FAIL');
  const failed = checks.filter((c) => c.status === 'FAIL').length;
  const all = (r.violations ?? []).map((v) => ({ rule: str(v.rule, 80) ?? 'unnamed', where: where(v), detail: str(v.detail), fixable: v.fixable !== false }));
  const fixable = all.filter((v) => v.fixable).length;
  // A report that contradicts itself is refused rather than read either way.
  if (r.status === 'PASS' && (failed || fixable)) {
    const parts = [failed ? `${failed} failed check${failed === 1 ? '' : 's'}` : null, fixable ? `${fixable} fixable violation${fixable === 1 ? '' : 's'}` : null].filter(Boolean);
    throw new Error(`the report says PASS but lists ${parts.join(' and ')}`);
  }
  if (r.status === 'FAIL' && !failed && !all.length) throw new Error('the report says FAIL but names no failed check and no violation');
  const tool = isObj(r.tool) ? { name: str(r.tool.name, 40), version: str(r.tool.version, 40) } : null;
  return {
    status: r.status,
    head: r.head,
    tokensSha256: r.tokensSha256,
    ...(r.round !== undefined ? { round: r.round } : {}),
    ...(tool?.name ? { tool } : {}),
    checks: { total: checks.length, failed },
    violations: all.slice(0, MAX),
    more: Math.max(0, all.length - MAX),
  };
}

// True when a commit id the coordinator recorded (7 or more hex characters) names the report's head.
export const sameHead = (recorded, head) => typeof recorded === 'string' && recorded.length >= 7 && head.startsWith(recorded.toLowerCase());

// The commit the unit's build is being judged at: this round's detect head, else the head the builder reported.
export function judgedHead(u) {
  const round = (u.rounds?.length ?? 0) + 1;
  return (u.detect?.round === round && u.detect.head) || u.builtHead || null;
}

// The Prism report that decides this build: the latest one attached while the unit was being judged, in
// the round under way. A run of the gate while the unit was still building is kept as evidence and never counts.
export function prismGate(u) {
  const round = (u.rounds?.length ?? 0) + 1;
  return (u.evidence ?? []).filter((e) => e?.kind === 'prism' && e.round === round && e.prism?.counts === true).at(-1) ?? null;
}

// Why this verdict may not pass, or null. `specialist` is a specialist critic's name, or null for the unit's
// critic. Any pass is refused while the deciding report says FAIL; the `prism` specialist passes only on a
// deciding report that says PASS.
export function prismRefusal(u, specialist = null) {
  const gate = prismGate(u);
  if (gate?.prism.status === 'FAIL') {
    const n = gate.prism.violations.length + gate.prism.more || gate.prism.checks.failed;
    return `pass refused: the Prism gate report on this build (${gate.id}) says FAIL, with ${n} finding${n === 1 ? '' : 's'} on the unit page`;
  }
  if (specialist === 'prism' && !gate) return 'pass refused: the prism specialist passes only on a Prism gate report for this build that says PASS, attached while the unit is being judged (evidence <run> <unit> --kind prism --file <worktree>/.prism/gate-report.json)';
  return null;
}
