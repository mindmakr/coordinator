// The HUD's colours, fonts, radius and spacing: built in, or taken from the
// project's own design system. A theme is a CSS file with custom properties
// (shadcn's --background/--primary…, Tailwind 4 @theme, daisyUI theme blocks);
// only the values are read, checked one by one, and mapped onto the HUD's
// tokens. Nothing is loaded from it: no @import, url(), scripts or rules.
//
// Tokens (the approved canvas): surfaces bg, surface, surface2; lines line, line2;
// text text, text2, muted; accent, accent-bg, on-accent; the four tones ask, ok,
// retry and bad, each with -bg and -bd; heat0..heat4 for heat maps; shadow,
// radius, gap, font, mono. The older names (card, ink, run, pass, fail, wait…)
// are aliases of these in hud.template.html, for the pages not rebuilt yet.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export const LIGHT = {
  bg: '#f4f5f7', surface: '#ffffff', surface2: '#f7f8fa', line: '#e1e4e9', line2: '#eef0f3',
  text: '#14171c', text2: '#3d4552', muted: '#5b6370', accent: '#1f4fc4', 'accent-bg': '#eef3fe', 'on-accent': '#ffffff',
  ask: '#8a3b00', 'ask-bg': '#fff1e2', 'ask-bd': '#f0b57a', ok: '#1a6b43', 'ok-bg': '#e8f6ee', 'ok-bd': '#a6dbbe',
  retry: '#5b34b0', 'retry-bg': '#f2edfc', 'retry-bd': '#cdbdf2', bad: '#b42318', 'bad-bg': '#fdecea', 'bad-bd': '#f3b4ad',
  heat0: '#f0f2f5', heat1: '#d6e2fb', heat2: '#9db8f2', heat3: '#3f6ad6', heat4: '#1f4fc4', shadow: '0 1px 2px rgba(20,23,28,.06)',
  radius: '12px', gap: '16px', font: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', scheme: 'light',
};
export const DARK = {
  ...LIGHT,
  bg: '#0e1013', surface: '#161a1f', surface2: '#1b2027', line: '#2a3039', line2: '#222830',
  text: '#e7eaee', text2: '#c2c8d0', muted: '#98a1ae', accent: '#8db1ff', 'accent-bg': '#1b2642', 'on-accent': '#0e1013',
  ask: '#ffb46b', 'ask-bg': '#2c1d0d', 'ask-bd': '#6e4519', ok: '#6dd49b', 'ok-bg': '#11261a', 'ok-bd': '#2b5b40',
  retry: '#c3a9ff', 'retry-bg': '#221a39', 'retry-bd': '#4b3a82', bad: '#ff8b80', 'bad-bg': '#2d1513', 'bad-bd': '#6b2b25',
  heat0: '#1b2027', heat1: '#1e2d4f', heat2: '#2d4c8f', heat3: '#3b5fb8', heat4: '#8db1ff', shadow: 'none', scheme: 'dark',
};

// HUD token ← the project's names, first found wins.
const MAP = {
  bg: ['background', 'color-background', 'color-base-200'],
  surface: ['card', 'color-card', 'color-base-100'],
  text: ['foreground', 'color-foreground', 'color-base-content'],
  muted: ['muted-foreground', 'color-muted-foreground'],
  line: ['border', 'color-border', 'color-base-300'],
  accent: ['primary', 'color-primary'],
  'on-accent': ['primary-foreground', 'color-primary-foreground', 'color-primary-content'],
  ok: ['success', 'color-success'],
  bad: ['destructive', 'color-destructive', 'color-error'],
  ask: ['warning', 'color-warning'],
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
  const mix = (c, pct) => `color-mix(in oklab, ${c} ${pct}%, ${t.surface})`;
  const has = (k) => !!pick(props, k);
  for (const k of Object.keys(MAP)) { const v = pick(props, k); if (v) t[k] = v; }
  if (t.spacing) { t.gap = `calc(${t.spacing} * 4)`; delete t.spacing; }
  // The shades the project does not name come from the ones it does.
  if (has('bg') || has('surface') || has('text')) {
    if (!has('muted')) t.muted = mix(t.text, 64);
    Object.assign(t, { surface2: mix(t.text, 3), line2: mix(t.text, 6), text2: mix(t.text, 82), heat0: mix(t.text, 5) });
    if (!has('line')) t.line = mix(t.text, 12);
  }
  for (const k of ['ok', 'bad', 'ask']) if (has(k)) Object.assign(t, { [`${k}-bg`]: mix(t[k], 12), [`${k}-bd`]: mix(t[k], 40) });
  if (has('accent')) Object.assign(t, { 'accent-bg': mix(t.accent, 10), heat1: mix(t.accent, 18), heat2: mix(t.accent, 40), heat3: mix(t.accent, 75), heat4: t.accent });
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
