// Naming: declared names against each language's usual convention. JS/TS:
// functions and variables camelCase (PascalCase allowed for components,
// classes and schemas; UPPER_SNAKE for constants), classes PascalCase.
// Python: functions and variables snake_case, classes PascalCase. Go:
// camelCase or PascalCase (exported), never snake_case. One-word names fit
// every style and are not counted. A name with a leading _ or $ is judged
// without it.
import { at } from './source.mjs';

export const STYLES = {
  camel: /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/,
  pascal: /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)*$|^[A-Z][a-z0-9]*(?:[A-Z]{2,}[a-z0-9]*)+$/,
  upper: /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/,
  snake: /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/,
};
export function styleOf(raw) {
  const n = raw.replace(/^[_$]+|_+$/g, '');
  if (!n || /^[a-z][a-z0-9]*$/.test(n) || /^[A-Z][A-Z0-9]*$/.test(n)) return 'word';
  if (/^[A-Z][a-z0-9]*$/.test(n)) return 'pascal';
  for (const [k, re] of Object.entries(STYLES)) if (re.test(n)) return k;
  // camelCase with an acronym inside (parseURL, userID) is still camelCase.
  if (/^[a-z][a-zA-Z0-9]*$/.test(n)) return 'camel';
  if (/^[A-Z][a-zA-Z0-9]*$/.test(n)) return 'pascal';
  return 'mixed';
}

// kind → the styles that fit, per language.
const RULES = {
  js: { function: ['camel', 'pascal'], variable: ['camel', 'pascal', 'upper'], class: ['pascal'] },
  python: { function: ['snake'], variable: ['snake', 'upper'], class: ['pascal'] },
  go: { function: ['camel', 'pascal'], variable: ['camel', 'pascal'], class: ['camel', 'pascal'] },
};
const DECL = {
  js: [[/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g, 'function'], [/\bclass\s+([A-Za-z_$][\w$]*)/g, 'class'], [/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:]/g, 'variable']],
  python: [[/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, 'function'], [/^\s*class\s+([A-Za-z_]\w*)/gm, 'class'], [/^([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)/gm, 'variable']],
  go: [[/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, 'function'], [/^type\s+([A-Za-z_]\w*)/gm, 'class'], [/\b([A-Za-z_]\w*)\s*:=/g, 'variable']],
};

export function naming(all, { focus = null } = {}) {
  const per = {}; const odd = [];
  for (const f of all) {
    if (f.generated || !RULES[f.lang] || (focus && !focus.has(f.path))) continue;
    const p = (per[f.lang] ??= { names: 0, fit: 0, styles: {} });
    for (const [re, kind] of DECL[f.lang]) {
      for (const m of f.bare.matchAll(re)) {
        const st = styleOf(m[1]);
        if (st === 'word' || (f.lang === 'python' && /^__\w+__$/.test(m[1]))) continue;
        p.names++; p.styles[st] = (p.styles[st] ?? 0) + 1;
        if (RULES[f.lang][kind].includes(st)) p.fit++;
        else if (!f.test) odd.push({ ...at(f, f.lineOf(m.index + m[0].indexOf(m[1]))), name: m[1], kind, style: st, lang: f.lang });
      }
    }
  }
  for (const p of Object.values(per)) p.pct = p.names ? Math.round((p.fit / p.names) * 1000) / 10 : 100;
  return { languages: per, outliers: { count: odd.length, top: odd.slice(0, 15) } };
}
