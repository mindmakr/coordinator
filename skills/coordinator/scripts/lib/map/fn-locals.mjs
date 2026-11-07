// Local names and where they hold, for the function scanner (lib/map/fns.mjs):
// parameters scope their function's body; `const`/`let`/`var` (plain or
// destructured) and `catch (e)` scope their innermost block. A call to a local
// is a call to a value, so it must not resolve to a same-named function of the
// file or an import. Module-level declarations, function definitions and names
// bound by `require`/`import()` are not locals here.
import { KEYWORDS, MODS } from './fn-syntax.mjs';

const ids = (text) => [...text.replace(/=\s*[^,()]*(?:\([^()]*\))?/g, '').replace(/:\s*[^,(){}]*/g, '').matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]).filter((x) => !KEYWORDS.has(x) && !MODS.test(x));

// isLocal(name, offset): a local named `name` is in scope at `offset`.
export function locals({ bare, br, params, defNames }) {
  const decls = new Map();
  const add = (name, from, to) => { if (to <= from) return; if (!decls.has(name)) decls.set(name, []); decls.get(name).push([from, to]); };
  const block = (at) => { const b = br.inner(at); return b < 0 ? null : [b, br.close.get(b) ?? bare.length]; };
  for (const p of params) for (const name of ids(p.text)) add(name, p.open, p.end);
  const bound = (end) => /^\s*=\s*(?:await\s+)?(?:require|import)\s*\(/.test(bare.slice(end, end + 40));
  for (const m of bare.matchAll(/\b(?:const|let|var)\s+([\w$]+)/g)) {
    const at = m.index + m[0].length - m[1].length;
    const b = block(m.index);
    if (b && !defNames.has(at) && !defNames.has(m.index) && !bound(m.index + m[0].length)) add(m[1], ...b); // a def is named at its name or its keyword
  }
  for (const m of bare.matchAll(/\b(?:const|let|var)\s*([{[])([^}\]=]*)[}\]]/g)) {
    const b = block(m.index);
    if (!b || bound(m.index + m[0].length)) continue;
    for (const x of m[2].split(',')) { const id = /([\w$]+)\s*$/.exec(x.replace(/=.*$/, '').trim()); if (id) add(id[1], ...b); }
  }
  for (const m of bare.matchAll(/\bcatch\s*\(\s*([\w$]+)\s*\)\s*\{/g)) { const open = m.index + m[0].length - 1; add(m[1], open, br.close.get(open) ?? bare.length); }
  return (name, at) => (decls.get(name) ?? []).some(([from, to]) => from <= at && at < to);
}
