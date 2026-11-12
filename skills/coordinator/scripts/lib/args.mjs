// Argument parsing and input cleaning shared by the CLIs.
// Accepts `--key value`, `--key=value` and `--flag`. A value may start with
// dashes (`--- FAIL: TestX`): only `--name` shaped words are treated as flags.
// A flag listed in `repeat` may be given more than once and is read as a list.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { maskSecrets } from './secrets.mjs';

// A script's usage is the comment block at its top. This returns it as plain text.
export function headerText(metaUrl) {
  const out = [];
  for (const line of readFileSync(fileURLToPath(metaUrl), 'utf8').split(/\r?\n/)) {
    if (line.startsWith('#!')) continue;
    if (!line.startsWith('//')) break;
    out.push(line.replace(/^\/\/ ?/, ''));
  }
  return out.join('\n');
}

// `--help` or `-h` as the first argument prints the script's header and exits 0. Call it before parsing.
export function helpAndExit(metaUrl, argv = process.argv.slice(2)) {
  if (argv[0] !== '--help' && argv[0] !== '-h') return;
  console.log(headerText(metaUrl));
  process.exit(0);
}

const FLAG = /^--([a-z][a-z0-9-]*)(?:=([\s\S]*))?$/;

export function parse(argv, allowed = null, repeat = []) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(FLAG);
    if (!m) { pos.push(argv[i]); continue; }
    const [, key, inline] = m;
    if (allowed && !allowed.includes(key)) throw new Error(`unknown option --${key}${allowed.length ? ` (allowed: ${allowed.map((k) => `--${k}`).join(' ')})` : ''}`);
    if (key in opt && !repeat.includes(key)) throw new Error(`--${key} given twice`);
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || FLAG.test(next)) value = true;
      else { value = next; i++; }
    }
    opt[key] = repeat.includes(key) ? [...(opt[key] ?? []), value] : value;
  }
  return { pos, opt };
}

export function num(value, fallback, min = 1, max = 100_000) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error('a number option needs a value');
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`expected a whole number ${min}-${max}, got: ${value}`);
  return n;
}

export function score(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error('--score needs a value');
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 10) throw new Error(`score must be 0-10, got: ${value}`);
  return Math.round(n * 10) / 10;
}

// Cleans control characters and masks anything that looks like a secret.
export function text(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`missing --${name}`);
  return maskSecrets(value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()).slice(0, max);
}

export function optText(value, max = 2000) {
  return typeof value === 'string' && value.trim() ? text(value, 'value', max) : null;
}

export function oneOf(value, allowed, name) {
  if (!allowed.includes(value)) throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  return value;
}
