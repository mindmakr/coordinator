// Code quality and compliance signals (`run.mjs quality`): duplication,
// structure, naming, redundancy, security and privacy, on the whole project and
// on the files a run changed. Node built-ins only. Signals for a person to
// review, with file:line evidence; not a compliance certification or legal
// advice. Thresholds and limits: references/quality.md.
import { duplication, WINDOW } from './duplication.mjs';
import { naming } from './naming.mjs';
import { privacy } from './privacy.mjs';
import { redundancy } from './redundancy.mjs';
import { security } from './security.mjs';
import { readSources } from './source.mjs';
import { DEEP, FILE_LONG, FN_LONG, structure } from './structure.mjs';

export const DISCLAIMER = 'Signals for a person to review, found by patterns: not a compliance certification, an audit or legal advice. Each one names the file and line to check; some will be false positives.';
export const THRESHOLDS = { duplicateWindow: WINDOW, longFile: FILE_LONG, longFunction: FN_LONG, deepNesting: DEEP };

function measure(files, focus, map) {
  const sec = security(files, { focus });
  const priv = privacy(files, { focus });
  const scoped = focus ? files.filter((f) => focus.has(f.path)) : files;
  const langs = {};
  for (const f of scoped) langs[f.lang] = (langs[f.lang] ?? 0) + 1;
  return {
    files: scoped.length, lines: scoped.reduce((n, f) => n + f.lines.length, 0), languages: langs,
    duplication: duplication(files, { focus }), structure: structure(files, { focus }), naming: naming(files, { focus }),
    redundancy: redundancy(map, { focus }),
    signals: [...sec, ...priv.signals], privacy: priv.found,
  };
}

// root: the project; changed: relative paths the run changed (or null); map: the run's map snapshot (or null).
export function quality({ root, changed = null, map = null, now = new Date() }) {
  const { files, skipped } = readSources(root);
  const focus = changed ? new Set(changed.filter((p) => files.some((f) => f.path === p))) : null;
  return {
    v: 1, at: now.toISOString(), root, disclaimer: DISCLAIMER, thresholds: THRESHOLDS, skipped,
    project: measure(files, null, map),
    ...(focus ? { changed: { listed: changed.length, ...measure(files, focus, map) } } : {}),
  };
}

const SEV = { high: 0, medium: 1, low: 2 };
export const bySeverity = (signals) => [...signals].sort((a, b) => SEV[a.severity] - SEV[b.severity] || b.count - a.count);

// The command's text output: the headline figures, then each signal with its first evidence lines.
export function qualityText(q, { evidence = 3 } = {}) {
  const part = (title, m) => {
    const d = m.duplication; const s = m.structure; const n = m.naming; const r = m.redundancy;
    const lines = [
      `${title}: ${m.files} files, ${m.lines} lines (${Object.entries(m.languages).map(([k, v]) => `${k} ${v}`).join(', ') || 'no code'})`,
      `  duplication  ${d.pct}% of ${d.total} significant lines repeat elsewhere (${d.sites} sites)${d.top[0] ? `; largest ${d.top[0].file}:${d.top[0].line} (${d.top[0].lines} lines, also ${d.top[0].also})` : ''}`,
      `  structure    files p50 ${s.files.p50} / p90 ${s.files.p90} / max ${s.files.max} lines, ${s.longFiles.count} over ${FILE_LONG}; functions p50 ${s.functions.p50} / p90 ${s.functions.p90} / max ${s.functions.max}, ${s.longFunctions.count} over ${FN_LONG}; ${s.deepNesting.count} nested ${DEEP}+ deep`,
      `  naming       ${Object.entries(n.languages).map(([k, v]) => `${k} ${v.pct}% of ${v.names} names fit`).join(', ') || 'no names'}; ${n.outliers.count} outliers`,
      `  redundancy   ${r.measured ? `${r.deadFiles.count} files nothing imports, ${r.reuse.count} repeated function shapes${r.partial ? ' (partial map)' : ''}` : r.why}`,
    ];
    const sig = bySeverity(m.signals);
    lines.push(`  signals      ${sig.length ? sig.map((x) => `${x.id} ${x.count}`).join(', ') : 'none'}`);
    for (const x of sig) {
      lines.push(`  [${x.severity}] ${x.title} (${x.count})`);
      for (const e of x.evidence.slice(0, evidence)) lines.push(`      ${e.file}:${e.line}  ${e.text}`);
    }
    return lines;
  };
  return [...part('Project', q.project), ...(q.changed ? ['', ...part(`Changed by the run (${q.changed.listed} files listed)`, q.changed)] : []), '', q.disclaimer, ''].join('\n');
}
