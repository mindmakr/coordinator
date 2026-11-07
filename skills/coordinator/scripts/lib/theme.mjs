// The HUD's colours, fonts, radius and spacing: built in, or taken from the
// project's own design system. A theme is a CSS file with custom properties
// (shadcn's --background/--primary…, Tailwind 4 @theme, daisyUI theme blocks);
// only the values are read, checked one by one, and mapped onto the HUD's
// tokens. Nothing is loaded from it: no @import, url(), scripts or rules.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export const LIGHT = {
  bg: '#f6f6f3', card: '#ffffff', ink: '#1c1c1a', muted: '#62625c', line: '#e2e2dc',
  pass: '#1f7a3e', 'pass-bg': '#e3f3e8', fail: '#b3261e', 'fail-bg': '#fbe7e5',
  run: '#1d5fbf', 'run-bg': '#e5eefb', wait: '#8a5a00', 'wait-bg': '#fbf0d9', 'none-bg': '#ededea',
  bar: '#1d5fbf', 'bar-hot': '#b3261e', 'on-run': '#ffffff', note: '#6b4fbb', 'note-bg': '#efeafb', ev: '#0e7490',
  radius: '10px', gap: '12px', font: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', scheme: 'light',
};
export const DARK = {
  ...LIGHT,
  bg: '#141413', card: '#1e1e1c', ink: '#ecece6', muted: '#a2a29a', line: '#33332f',
  pass: '#6fd38f', 'pass-bg': '#18311f', fail: '#ff8a80', 'fail-bg': '#3a1a17',
  run: '#8ab4f8', 'run-bg': '#1a2638', wait: '#f2c46d', 'wait-bg': '#352a12', 'none-bg': '#2a2a27',
  bar: '#8ab4f8', 'bar-hot': '#ff8a80', 'on-run': '#141413', note: '#c4b5fd', 'note-bg': '#2a2340', ev: '#22d3ee', scheme: 'dark',
};

// HUD token ← the project's names, first found wins.
const MAP = {
  bg: ['background', 'color-background', 'color-base-200'],
  card: ['card', 'color-card', 'color-base-100'],
  ink: ['foreground', 'color-foreground', 'color-base-content'],
  muted: ['muted-foreground', 'color-muted-foreground'],
  line: ['border', 'color-border', 'color-base-300'],
  run: ['primary', 'color-primary'],
  'on-run': ['primary-foreground', 'color-primary-foreground', 'color-primary-content'],
  pass: ['success', 'color-success'],
  fail: ['destructive', 'color-destructive', 'color-error'],
  wait: ['warning', 'color-warning'],
  radius: ['radius', 'radius-box'],
  font: ['font-sans'],
  mono: ['font-mono'],
  spacing: ['spacing'],
};

const COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([^()]*\)|[a-z]{3,20})$/i;
const HSL_PARTS = /^-?[\d.]+(deg)?\s+[\d.]+%\s+[\d.]+%$/; // shadcn v3: "222 47% 11%"
const LENGTH = /^[\d.]+(px|rem|em)$/;
const SAFE = /^[^;{}<>\\@]*$/;

const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// Every block with its custom properties, light or dark by its own header or an ancestor's.
export function parse(css) {
  const out = { light: {}, dark: {} };
  const stack = [];
  let buf = '';
  for (const ch of strip(String(css))) {
    if (ch === '{') {
      const head = buf.trim(); buf = '';
      const dark = /\.dark\b|data-theme=["']?dark|prefers-color-scheme:\s*dark/i.test(head);
      stack.push({ dark: dark || !!stack.at(-1)?.dark, props: {} });
    } else if (ch === '}') {
      const top = stack.pop(); decl(buf, top); buf = '';
      if (!top) continue;
      const dark = top.dark || /^dark$/i.test(top.props['@name'] ?? '') || /dark/i.test(top.props['@color-scheme'] ?? '');
      delete top.props['@name']; delete top.props['@color-scheme'];
      Object.assign(dark ? out.dark : out.light, top.props);
    } else if (ch === ';') { decl(buf, stack.at(-1)); buf = ''; } else buf += ch;
  }
  return out;
}

function decl(text, block) {
  if (!block) return;
  const m = /^\s*(--[\w-]+|name|color-scheme)\s*:\s*([\s\S]+?)\s*$/.exec(text);
  if (m) block.props[m[1].startsWith('--') ? m[1].slice(2) : `@${m[1]}`] = m[2].replace(/\s+/g, ' ');
}

// Resolves var(--x) against the same set; drops values that are unsafe or unresolved.
function value(props, name, depth = 0) {
  let v = props[name];
  if (v === undefined || depth > 4 || v.length > 300 || !SAFE.test(v) || /url\s*\(|expression|javascript:/i.test(v)) return null;
  v = v.replace(/var\(\s*--([\w-]+)\s*(?:,[^()]*)?\)/g, (_, n) => value(props, n, depth + 1) ?? '\u0000');
  return v.includes('\u0000') ? null : v.trim();
}

function font(props, name) {
  const raw = props[name];
  if (!raw || !SAFE.test(raw) || /url\s*\(/i.test(raw)) return null;
  const list = raw.split(',').map((f) => f.trim()).filter((f) => f && !/var\(/.test(f) && /^["']?[\w .-]+["']?$/.test(f));
  return list.length ? list.join(', ') : null;
}

function pick(props, token) {
  for (const name of MAP[token]) {
    if (token === 'font' || token === 'mono') { const f = font(props, name); if (f) return f; continue; }
    const v = value(props, name);
    if (!v) continue;
    if (token === 'radius' || token === 'spacing') { if (LENGTH.test(v)) return v; continue; }
    if (HSL_PARTS.test(v)) return `hsl(${v})`;
    if (COLOR.test(v)) return v;
  }
  return null;
}

// Theme tokens for one mode: what the project defines, the rest from `base`.
function tokens(props, base) {
  const t = { ...base };
  const mix = (c, pct) => `color-mix(in oklab, ${c} ${pct}%, ${t.card})`;
  for (const k of Object.keys(MAP)) { const v = pick(props, k); if (v) t[k] = v; }
  if (t.spacing) { t.gap = `calc(${t.spacing} * 3)`; delete t.spacing; }
  if (!pick(props, 'muted')) t.muted = `color-mix(in oklab, ${t.ink} 64%, ${t.card})`;
  for (const k of ['pass', 'fail', 'wait']) if (pick(props, k)) t[`${k}-bg`] = mix(t[k], 16);
  if (pick(props, 'run')) { t['run-bg'] = mix(t.run, 14); t.bar = t.run; }
  if (pick(props, 'fail')) t['bar-hot'] = t.fail;
  if (pick(props, 'bg') || pick(props, 'card')) t['none-bg'] = `color-mix(in oklab, ${t.ink} 9%, ${t.card})`;
  return t;
}

// { light, dark } token sets from a CSS text; a project without dark values keeps the built-in dark.
export function fromCss(css) {
  const p = parse(css);
  const light = tokens(p.light, LIGHT);
  const dark = Object.keys(p.dark).length ? tokens({ ...pickFonts(p.light), ...p.dark }, DARK) : { ...DARK, font: light.font, mono: light.mono, radius: light.radius, gap: light.gap };
  return { light, dark, source: true };
}
const pickFonts = (props) => Object.fromEntries(Object.entries(props).filter(([k]) => /^(font-|radius|spacing)/.test(k)));

const block = (t) => Object.entries(t).filter(([k]) => k !== 'source').map(([k, v]) => (k === 'scheme' ? `color-scheme:${v}` : `--${k}:${v}`)).join(';');

// The page's token CSS: system choice by default, overridden by the toggle
// (the checked radio, with or without a script) or a remembered choice.
export function css(theme = { light: LIGHT, dark: DARK }) {
  const L = block(theme.light); const D = block(theme.dark);
  return `:root{${L}}@media (prefers-color-scheme: dark){:root{${D}}}`
    + `:root:has(#theme-light:checked),:root[data-theme="light"]{${L}}:root:has(#theme-dark:checked),:root[data-theme="dark"]{${D}}`
    // Print (Export PDF) is always light, whatever the screen shows.
    + `@media print{:root,:root:has(#theme-dark:checked),:root[data-theme="dark"]{${L}}}`;
}

// The run's theme file: --theme at init, else a `Theme:` line in COORDINATOR.md.
const MAX = 512 * 1024;
export function themeFile(run, projectRoot) {
  if (run.theme) return run.theme;
  const doc = join(projectRoot, 'COORDINATOR.md');
  if (!existsSync(doc)) return null;
  const m = /^\s*[-*]?\s*Theme:\s*`?([^`\n]+?)`?\s*$/im.exec(readFileSync(doc, 'utf8'));
  return m ? (isAbsolute(m[1]) ? m[1] : resolve(projectRoot, m[1])) : null;
}

export function load(file) {
  try {
    if (!file || !existsSync(file) || !statSync(file).isFile() || statSync(file).size > MAX) return { light: LIGHT, dark: DARK };
    return fromCss(readFileSync(file, 'utf8'));
  } catch { return { light: LIGHT, dark: DARK }; }
}
