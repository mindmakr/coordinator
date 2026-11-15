// Code-slop and workaround detectors (#162): shared line-level checks for
// raw useEffect, timer workarounds, and cross-boundary relative imports, plus
// Jev `noul` scoring (> 0.75) of multi-line workaround excuse comments.
import { basename, posix } from 'node:path';
import { askNoul } from '../helpers.mjs';
import { at } from './source.mjs';

export const WORKAROUND_THRESHOLD = 0.75;

const JS_EXT = /\.(?:[cm]?[jt]sx?)$/i;
const HOOK_PATH = /(^|\/)hooks?(\/|$)/i;
const HOOK_NAME = /^use[A-Z]/;

// True when `filePath` is a dedicated custom React hook module (e.g. src/hooks/useAuth.ts or useDebounced.ts).
export function isHookFile(filePath) {
  const norm = String(filePath ?? '').replace(/\\/g, '/');
  return HOOK_PATH.test(norm) || HOOK_NAME.test(basename(norm));
}

const RAW_USE_EFFECT = /\b(?:React\s*\.\s*)?useEffect\s*\(/;
const TIMER_WORKAROUND = /(?<![A-Za-z0-9_$.])(?:(?:window|globalThis)\s*\.\s*)?(?:setTimeout|setInterval|requestAnimationFrame)\s*\(/;
const REL_IMPORT_RE = [
  /\b(?:import|export)\b[^'"`\n]*?\bfrom\s*['"](\.\.[^'"]+)['"]/,
  /\bimport\s*\(\s*['"](\.\.[^'"]+)['"]\s*\)/,
  /\brequire\s*\(\s*['"](\.\.[^'"]+)['"]\s*\)/,
];
const IMPORT_KW = /^\s*(?:import|export)\b/;

function extractRelativeImportSpecifier(line) {
  for (const re of REL_IMPORT_RE) {
    const m = re.exec(line);
    if (m?.[1]) return m[1];
  }
  return null;
}

const SLICE_ROOT = /^(?:src\/)?(packages|apps|features|domains|modules|services|libs)\/([^/]+)/i;
const LAYER_ROOT = /^(?:.*\/)?(frontend|client|ui|web|components|views|pages|screens|widgets|backend|server|api|db|prisma)(?:\/|$)/i;
const FRONT_LAYERS = new Set(['frontend', 'client', 'ui', 'web', 'components', 'views', 'pages', 'screens', 'widgets']);
const BACK_LAYERS = new Set(['backend', 'server', 'api', 'db', 'prisma']);

function sliceTag(posixPath) {
  const m = SLICE_ROOT.exec(posixPath);
  return m ? `${m[1].toLowerCase()}:${m[2].toLowerCase()}` : null;
}

function layerGroup(posixPath) {
  const m = LAYER_ROOT.exec(posixPath);
  if (!m) return null;
  const g = m[1].toLowerCase();
  if (FRONT_LAYERS.has(g)) return 'frontend';
  if (BACK_LAYERS.has(g)) return 'backend';
  return g;
}

// True when a relative import climbs 3+ directory levels or crosses package/feature/frontend-backend boundaries.
export function isCrossBoundaryImport(filePath, specifier) {
  const src = String(filePath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const spec = String(specifier ?? '').replace(/\\/g, '/');
  if (!spec.startsWith('../')) return false;
  if (/^(?:\.\.\/){3,}/.test(spec)) return true;

  const srcDir = posix.dirname(src);
  const resolved = posix.normalize(srcDir === '.' ? spec : posix.join(srcDir, spec));
  if (resolved === '..' || resolved.startsWith('../')) return true;

  const s1 = sliceTag(src);
  const s2 = sliceTag(resolved);
  if (s1 && s2 && s1 !== s2) return true;

  const l1 = layerGroup(src);
  const l2 = layerGroup(resolved);
  if (l1 && l2 && l1 !== l2) return true;
  return false;
}

function stripSingleLineComment(line) {
  return String(line ?? '').replace(/(^|[^:])\/\/.*$/, '$1').replace(/(^|\s)#.*$/, '$1');
}

// Detects slop patterns on one added or existing source line:
// `raw-use-effect`, `timer-workaround`, and `cross-boundary-import`.
export function detectLineSlop(line, filePath) {
  const norm = String(filePath ?? '').replace(/\\/g, '/');
  const raw = String(line ?? '');
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('#')) {
    return [];
  }
  const code = stripSingleLineComment(raw);
  const hits = [];

  if (JS_EXT.test(norm) && !isHookFile(norm) && !IMPORT_KW.test(code) && RAW_USE_EFFECT.test(code)) {
    hits.push({ kind: 'raw-use-effect', detail: trimmed });
  }
  if (TIMER_WORKAROUND.test(code)) {
    hits.push({ kind: 'timer-workaround', detail: trimmed });
  }
  const spec = extractRelativeImportSpecifier(code);
  if (spec && isCrossBoundaryImport(norm, spec)) {
    hits.push({ kind: 'cross-boundary-import', detail: trimmed });
  }
  return hits;
}

// Static slop signals across source files (shared format with privacy/security modules).
export function slop(all, { focus = null } = {}) {
  const prod = all.filter((f) => !f.test && !f.generated);
  const files = prod.filter((f) => !focus || focus.has(f.path));
  const useEffectEv = [];
  const timerEv = [];
  const boundaryEv = [];

  for (const f of files) {
    let inBlockComment = false;
    f.lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (inBlockComment) {
        if (trimmed.includes('*/')) inBlockComment = false;
        return;
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlockComment = true;
        return;
      }
      for (const hit of detectLineSlop(line, f.path)) {
        const entry = at(f, idx + 1);
        if (hit.kind === 'raw-use-effect') useEffectEv.push(entry);
        else if (hit.kind === 'timer-workaround') timerEv.push(entry);
        else if (hit.kind === 'cross-boundary-import') boundaryEv.push(entry);
      }
    });
  }

  const sig = (id, title, severity, ev) => ({
    id,
    area: 'quality',
    title,
    severity,
    count: ev.length,
    evidence: ev.slice(0, 12),
  });

  return [
    sig('raw-use-effect', 'Raw useEffect call outside dedicated hook modules', 'medium', useEffectEv),
    sig('timer-workaround', 'Timer-based workaround (setTimeout / setInterval / requestAnimationFrame)', 'high', timerEv),
    sig('cross-boundary-import', 'Cross-boundary relative import', 'high', boundaryEv),
  ].filter((s) => s.count > 0);
}

// Extracts multi-line comments (/* ... */ spanning 2+ lines, or 2+ consecutive // or # lines)
// with the exact 1-based starting line number in each non-test file.
export function extractMultilineComments(all, { focus = null } = {}) {
  const prod = all.filter((f) => !f.test && !f.generated);
  const files = prod.filter((f) => !focus || focus.has(f.path));
  const out = [];

  for (const f of files) {
    let i = 0;
    while (i < f.lines.length) {
      const raw = f.lines[i];
      const trimmed = raw.trim();

      // 1. Block comment: /* ... */ spanning >= 2 lines
      if (trimmed.startsWith('/*')) {
        const startLine = i + 1;
        const parts = [];
        let endIdx = i;
        let closed = false;
        while (endIdx < f.lines.length) {
          const l = f.lines[endIdx];
          const closePos = l.indexOf('*/');
          const slice = closePos >= 0 ? l.slice(0, closePos) : l;
          const cleaned = slice.replace(/^\s*(?:\/\*\*?|\*)?\s?/, '').trim();
          if (cleaned) parts.push(cleaned);
          if (closePos >= 0) { closed = true; break; }
          endIdx++;
        }
        const span = endIdx - i + 1;
        if (closed && span >= 2 && parts.length > 0) {
          out.push({ file: f.path, line: startLine, endLine: endIdx + 1, text: parts.join(' ').slice(0, 600) });
        }
        i = endIdx + 1;
        continue;
      }

      // 2. Consecutive // or # comment lines (excluding triple-slash references and shebangs)
      const isLineComment = (s) => (s.startsWith('//') && !s.startsWith('///')) || (s.startsWith('#') && !s.startsWith('#!'));
      if (isLineComment(trimmed)) {
        const startLine = i + 1;
        const parts = [];
        let endIdx = i;
        while (endIdx < f.lines.length && isLineComment(f.lines[endIdx].trim())) {
          const cleaned = f.lines[endIdx].trim().replace(/^(?:\/\/+|#+)\s?/, '').trim();
          if (cleaned) parts.push(cleaned);
          endIdx++;
        }
        if (endIdx - i >= 2 && parts.length > 0) {
          out.push({ file: f.path, line: startLine, endLine: endIdx, text: parts.join(' ').slice(0, 600) });
        }
        i = endIdx;
        continue;
      }

      i++;
    }
  }
  return out;
}

// Scores multi-line comments with Jev `noul` and returns a high-severity `workaround-comment`
// signal for every comment whose probability strictly exceeds `threshold` (0.75).
export async function scoreWorkaroundComments(
  all,
  helpersCfg,
  { focus = null, askNoulFn = askNoul, threshold = WORKAROUND_THRESHOLD, concurrency = 4 } = {},
) {
  const comments = extractMultilineComments(all, { focus });
  if (!comments.length) return [];
  if (!helpersCfg?.on) return [];
  const usingDefaultAsk = askNoulFn === askNoul;
  const hasModel = Boolean(helpersCfg.models?.noul || helpersCfg.models?.decide);
  if (usingDefaultAsk && !hasModel) return [];

  const hits = [];
  const step = Math.max(1, Number(concurrency) || 4);
  for (let i = 0; i < comments.length; i += step) {
    const batch = comments.slice(i, i + step);
    const results = await Promise.all(batch.map(async (c) => {
      const safeSnippet = c.text.replace(/\?+/g, '.').replace(/\s+/g, ' ').trim().slice(0, 400);
      const proposition = `The comment at ${c.file}:${c.line} ("${safeSnippet}") excuses a workaround, hack, race-condition timer, or symptom bypass instead of fixing the root cause.`;
      const res = await askNoulFn(helpersCfg, { proposition, context: c.text });
      const p = typeof res?.probability === 'number'
        ? res.probability
        : (typeof res?.probabilities?.[0] === 'number' ? res.probabilities[0] : null);
      if (p !== null && Number.isFinite(p) && p > threshold) {
        return {
          file: c.file,
          line: c.line,
          score: Math.round(p * 1000) / 1000,
          text: `${c.text} (noul score: ${p.toFixed(2)})`,
        };
      }
      return null;
    }));
    for (const r of results) if (r) hits.push(r);
  }

  if (!hits.length) return [];
  return [{
    id: 'workaround-comment',
    area: 'quality',
    title: `Comments excusing a workaround or hack (Jev noul > ${threshold})`,
    severity: 'high',
    count: hits.length,
    evidence: hits.slice(0, 20),
  }];
}
