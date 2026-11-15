// Mechanical checks of a unit's diff before a critic sees it (run.mjs precheck; built refuses on a hit unless
// --skip-precheck --reason). Each one is a class of finding past critics kept making: a CHANGELOG edit in a unit
// (every merge then conflicted the other branches), invisible or text-direction characters, a URL's .pathname used
// as a file path (wrong on Windows and with spaces: fileURLToPath), a new test file the test command never runs,
// and a new module with no test. The rules come from "precheck" in .coordinator/coordinator.json; the project's
// facts (its test list, its module folders) live there, never here. Pure: the CLI reads git and passes the text in.

export const RULES = ['changelog', 'invisible', 'pathname', 'test-list', 'untested'];
export const DEFAULTS = { changelog: ['CHANGELOG.md'], invisible: true, pathname: true, tests: '\\.test\\.[cm]?[jt]sx?$', testList: [], modules: [], off: [] };

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim());

// The rules in force: the defaults, changed by the "precheck" setting. Throws on a setting that does not read.
export function precheckRules(setting) {
  if (setting === undefined) return { ...DEFAULTS };
  if (setting === false) return { ...DEFAULTS, off: [...RULES] };
  if (!isObj(setting)) throw new Error('precheck must be false or an object (references/precheck.md)');
  const out = { ...DEFAULTS };
  for (const k of ['changelog', 'testList', 'modules', 'off']) {
    if (setting[k] === undefined) continue;
    if (!strings(setting[k])) throw new Error(`precheck.${k} must be a list of strings`);
    out[k] = setting[k].map((x) => x.replace(/\\/g, '/'));
  }
  for (const k of out.off) if (!RULES.includes(k)) throw new Error(`precheck.off: no rule "${k}" (rules: ${RULES.join(', ')})`);
  if (setting.tests !== undefined) {
    if (typeof setting.tests !== 'string') throw new Error('precheck.tests must be a regular expression, as a string');
    try { new RegExp(setting.tests); } catch (e) { throw new Error(`precheck.tests: ${e.message}`); }
    out.tests = setting.tests;
  }
  return out;
}

// Zero-width, invisible and text-direction characters (U+200B-U+200F, U+202A-U+202E, U+2060-U+2064, U+2066-U+2069,
// U+FEFF, U+00AD, U+061C, U+180E): written as escapes they are fine, typed literally they hide what code says.
const INVISIBLE = /[­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/u;
// A URL's pathname where a file path is wanted: new URL(…, import.meta.url).pathname, or .pathname on a line that
// reads or names files. fileURLToPath() is the safe form.
const PATHNAME = /\bimport\.meta\.url\s*\)\s*\.pathname\b|\.pathname\b(?=.*\b(?:readFileSync|writeFileSync|existsSync|statSync|lstatSync|readdirSync|mkdirSync|rmSync|unlinkSync|createReadStream|createWriteStream|openSync|join|resolve|dirname|basename)\s*\()|\b(?:readFileSync|writeFileSync|existsSync|statSync|lstatSync|readdirSync|mkdirSync|rmSync|unlinkSync|createReadStream|createWriteStream|openSync|join|resolve|dirname|basename)\s*\([^)]*\.pathname\b/;
const CODE = /\.(?:[cm]?[jt]sx?)$/i;
const base = (p) => p.split('/').pop();
const hex = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
const clip = (s) => (s.length > 80 ? `${s.slice(0, 79)}…` : s).replace(INVISIBLE, (c) => `<${hex(c)}>`);

// A simple glob from a test command ("test/*.test.mjs") as a regular expression for a path relative to its folder.
const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '(?:.*/)?')}$`);

// Is a new test file run by one of the test lists? list: { file, text } (the list file's path and its text at the
// head). A file outside a list's folder is not that list's; a path or a glob in the text that matches it lists it.
function listed(path, lists) {
  const mine = lists.filter((l) => { const dir = l.file.includes('/') ? l.file.slice(0, l.file.lastIndexOf('/') + 1) : ''; return path.startsWith(dir); });
  if (!mine.length) return true; // no list covers this folder: nothing to check against
  return mine.some((l) => {
    const dir = l.file.includes('/') ? l.file.slice(0, l.file.lastIndexOf('/') + 1) : '';
    const rel = path.slice(dir.length);
    if (l.text.includes(rel) || l.text.includes(path)) return true;
    return [...l.text.matchAll(/[\w./*-]*\*[\w./*-]*/g)].some((m) => globRe(m[0]).test(rel));
  });
}

// files: parsed diff (lib/gaming.mjs parseDiff); added: paths the diff adds; lists: the test lists' text at the head;
// mentioned(name): whether a test file at the head names that module file. Returns [{ rule, file, detail }].
export function precheck({ files = [], added = [] }, rules, { lists = [], mentioned = () => true } = {}) {
  const on = (r) => !rules.off.includes(r);
  const hits = [];
  const hit = (rule, file, detail) => hits.push({ rule, file, detail });
  const tests = new RegExp(rules.tests);
  const names = rules.changelog.map((n) => n.toLowerCase());
  for (const f of files) {
    if (on('changelog') && names.some((n) => (n.includes('/') ? f.path.toLowerCase() === n : base(f.path).toLowerCase() === n))) hit('changelog', f.path, 'units never edit it: give the line with built --changelog "<line>"; the release PR writes them all (run.mjs changelog <run>)');
    for (const line of f.added) {
      const ch = on('invisible') ? line.match(INVISIBLE) : null;
      if (ch) hit('invisible', f.path, `${hex(ch[0])} in "${clip(line.trim())}": write it as an escape (\\u${ch[0].codePointAt(0).toString(16).padStart(4, '0')})`);
      if (on('pathname') && CODE.test(f.path) && PATHNAME.test(line)) hit('pathname', f.path, `a URL's .pathname used as a file path in "${clip(line.trim())}": use fileURLToPath()`);
    }
  }
  const lists2 = lists.filter((l) => rules.testList.includes(l.file));
  for (const p of added) {
    if (on('test-list') && lists2.length && tests.test(p) && !listed(p, lists2)) hit('test-list', p, `a new test file no test command runs: add it to ${lists2.map((l) => l.file).join(' or ')}`);
    if (on('untested') && rules.modules.some((m) => p.startsWith(m.endsWith('/') ? m : `${m}/`)) && CODE.test(p) && !tests.test(p) && !mentioned(base(p))) hit('untested', p, 'a new module that no test file names: add its tests');
  }
  return hits;
}
