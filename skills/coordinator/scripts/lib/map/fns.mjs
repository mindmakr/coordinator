// Functions and the calls inside them, for one JS/TS file: a small tolerant
// scanner over the lexed text (lib/map/lex.mjs), not a parser, never run.
// Comments, string contents and JSX text are blanked first, so a call in any
// of them is not a call. Records each function or method with its line range
// and the calls in its body; lib/map/calls.mjs resolves them across files.
// The result is plain JSON, cached by blob hash. Limits: references/map.md.
//   fn-syntax.mjs  brackets, what a `{` opens, bodies, type arguments, receivers
//   fn-defs.mjs    definitions, qualified names, classes, parameter scopes
//   fn-locals.mjs  local names and their scope (a call to one is a value)
//   fn-jsx.mjs     components used in JSX, JSX text blanked
//   fn-module.mjs  imports, re-exports, exports, typed locals
import { lex, lines } from './lex.mjs';
import { definitions } from './fn-defs.mjs';
import { jsx } from './fn-jsx.mjs';
import { locals } from './fn-locals.mjs';
import { modulePart } from './fn-module.mjs';
import { afterTypeArgs, bodyAfter, braces, chainBefore, kindOf, KEYWORDS, pairs } from './fn-syntax.mjs';

export const SCAN_VERSION = 13;
export const JSX_FILE = /\.[cm]?[jt]sx$/;

export function scanFns(src, file = '') {
  const { code, bare: lexed } = lex(src);
  const lineOf = lines(src);
  const view = JSX_FILE.test(file) ? jsx(lexed, pairs(lexed)) : { bare: lexed, tags: [] };
  const { bare } = view;
  const br = braces(bare);
  const mt = pairs(bare);
  const kinds = new Map();
  const kind = (open) => { if (open < 0) return { kind: 'top' }; if (!kinds.has(open)) kinds.set(open, kindOf(bare, open)); return kinds.get(open); };
  const defs = definitions({ bare, br, mt, kind, lineOf });
  const out = defs.fns;
  const isLocal = locals({ bare, br, params: defs.params, defNames: defs.defNames });

  // Each call goes to its innermost function (or the file's top level). `sh`: the name, or the
  // receiver's root, is a local in scope there, so it is a value, not the file's function or an import.
  const owners = out.map((f, i) => [f.open, f.close, i]);
  const ownerAt = (off) => { let best = -1; for (const [o, c, i] of owners) if (o <= off && off < c && (best < 0 || o >= owners[best][0])) best = i; return best; };
  const calls = out.map(() => []); const top = [];
  const push = (off, c) => {
    const root = c.r ? (/^[\w$]+$/.test(c.r) ? c.r : null) : c.n;
    const o = ownerAt(off);
    (o < 0 ? top : calls[o]).push({ ...c, ...(root && isLocal(root, off) ? { sh: 1 } : {}) });
  };
  for (const m of bare.matchAll(/(#?[\w$]+)\s*(?:\?\.\s*)?(?=[<(])/g)) {
    const name = m[1];
    const at = m.index;
    if (/[\w$]/.test(bare[at - 1] ?? '') || /^\d/.test(name) || defs.defNames.has(at)) continue;
    const pre = bare.slice(Math.max(0, at - 40), at);
    const isNew = /\bnew\s+$/.test(pre);
    const member = /(?<!\.)\??\.\s*$/.test(pre); // after a dot any name is a method: map.get(), x.delete()
    if (!member && ((KEYWORDS.has(name) && name !== 'get' && name !== 'set') || /\bfunction\s*\*?\s*$/.test(pre))) continue;
    let paren = at + m[0].length;
    if (bare[paren] === '<') { paren = afterTypeArgs(bare, paren); if (paren < 0) continue; }
    const close = mt(paren);
    // A definition (`name(a): T {`) starts a statement or a member; after `?`, `=`, `(` or `return` it is a call (`c ? f(x) : g(y)`).
    const startsMember = /(?:^|[\n{};,*]|\b(?:async|static|get|set|public|private|protected|override|readonly))\s*$/.test(pre);
    if (close > 0 && startsMember && !isNew && bodyAfter(bare, close, mt) >= 0) continue;
    const hk = kind(br.inner(at)).kind;
    if (hk === 'type') continue;
    if (hk === 'class' && !/[=(,:?]\s*$/.test(pre)) continue; // a member signature
    const dot = /(?<!\.)\??\.\s*$/.exec(pre); // not a spread: ...f()
    const recv = dot ? chainBefore(bare, at - dot[0].length) : null;
    push(at, { n: name, ...(recv ? { r: recv } : {}), ...(isNew ? { k: 'new' } : {}), line: lineOf(at) });
    // Bare identifiers (or this.x) passed as arguments: maybe callbacks.
    if (close > 0 && close - paren < 2000) {
      const args = bare.slice(paren + 1, close - 1);
      for (const a of args.matchAll(/(?:^|,)\s*((?:this\.)?[A-Za-z_$][\w$]*)\s*(?=,|$)/g)) {
        if (KEYWORDS.has(a[1])) continue;
        const off = paren + 1 + a.index + a[0].indexOf(a[1]); // the name's own line, not the comma's
        push(off, { ...(a[1].startsWith('this.') ? { n: a[1].slice(5), r: 'this' } : { n: a[1] }), k: 'ref', line: lineOf(off) });
      }
    }
  }
  // JSX handlers: onClick={handleSubmit}, onChange={this.update}.
  for (const m of bare.matchAll(/[\w$-]+=\{\s*((?:this\.)?[A-Za-z_$][\w$]*)\s*\}/g)) {
    if (KEYWORDS.has(m[1])) continue;
    const at = m.index + m[0].indexOf(m[1], m[0].indexOf('{'));
    push(at, { ...(m[1].startsWith('this.') ? { n: m[1].slice(5), r: 'this' } : { n: m[1] }), k: 'ref', line: lineOf(at) });
  }
  // JSX elements: <Card /> renders Card; <ui.Button> renders ui's Button.
  for (const t of view.tags) {
    const dot = t.name.lastIndexOf('.');
    push(t.at, { n: dot < 0 ? t.name : t.name.slice(dot + 1), ...(dot < 0 ? {} : { r: t.name.slice(0, dot) }), k: 'jsx', line: lineOf(t.at) });
  }

  // A passed identifier counts only when it can name a function: one of this file's, or an import.
  const mod = modulePart(code, bare);
  const known = new Set([...out.map((f) => f.name), ...mod.imports.flatMap((i) => Object.keys(i.locals))]);
  const keep = (c) => c.k !== 'ref' || c.r === 'this' || (known.has(c.n) && !c.sh);
  const byLine = (a, b) => a.line - b.line;
  return {
    v: SCAN_VERSION, ...mod,
    classes: defs.classes,
    fns: out.map((f, i) => ({ q: f.q, name: f.name, line: f.line, end: f.end, ...(f.parent >= 0 ? { parent: out[f.parent].q } : {}), ...(f.cls ? { cls: f.cls } : {}), calls: calls[i].filter(keep).sort(byLine) })),
    top: top.filter(keep).sort(byLine),
  };
}

// A cached scan is used only when it has the shape link() reads; anything else is rescanned.
export const validScan = (s) => !!s && s.v === SCAN_VERSION && Array.isArray(s.fns) && Array.isArray(s.top) && Array.isArray(s.imports) && Array.isArray(s.classes)
  && !!s.exports && typeof s.exports === 'object' && !!s.types && typeof s.types === 'object'
  && s.fns.every((f) => f && typeof f.q === 'string' && typeof f.line === 'number' && Array.isArray(f.calls));
