// Duplication (DRY): the same run of WINDOW significant lines in two places.
// Lines are normalised (trimmed, spaces collapsed); blank lines, comments,
// imports and bracket-only lines do not count, so boilerplate does not look
// like a copy. Measured over code files that are neither tests nor generated.
import { createHash } from 'node:crypto';
import { at } from './source.mjs';

export const WINDOW = 6;
const TRIVIAL = /^[\s{}()[\];,]*$|^(import|export \{|export \* from|from |package |using |#include|require\(|\} from )|^(\/\/|#|\/\*|\*|\*\/|--)/;

export function significant(f) {
  const out = [];
  f.lines.forEach((l, i) => {
    const t = l.trim().replace(/\s+/g, ' ');
    if (t.length < 4 || TRIVIAL.test(t)) return;
    out.push({ n: i + 1, t });
  });
  return out;
}

const key = (lines) => createHash('sha1').update(lines.join('\n')).digest('base64url');

// focus: the paths whose lines count (the run's changed files); null = all.
export function duplication(all, { focus = null } = {}) {
  const files = all.filter((f) => !f.test && !f.generated && f.lang !== 'sql');
  const sig = new Map(files.map((f) => [f, significant(f)]));
  const seen = new Map(); // window key → [{ f, i }]
  for (const [f, s] of sig) {
    for (let i = 0; i + WINDOW <= s.length; i++) {
      const k = key(s.slice(i, i + WINDOW).map((x) => x.t));
      if (!seen.has(k)) seen.set(k, []);
      seen.get(k).push({ f, i });
    }
  }
  const dup = new Map(); // file → Map(sig index → the window's places, and which one this is)
  for (const hits of seen.values()) {
    if (hits.length < 2) continue;
    for (const h of hits) {
      if (!dup.has(h.f)) dup.set(h.f, new Map());
      for (let j = h.i; j < h.i + WINDOW; j++) if (!dup.get(h.f).has(j)) dup.get(h.f).set(j, { hits, self: h });
    }
  }
  const inFocus = (f) => !focus || focus.has(f.path);
  let total = 0; let dupLines = 0; const sites = [];
  for (const [f, s] of sig) {
    if (!inFocus(f)) continue;
    total += s.length;
    const marks = dup.get(f);
    if (!marks) continue;
    dupLines += marks.size;
    // Contiguous duplicated lines make one site; it names one other place it also appears.
    const idx = [...marks.keys()].sort((a, b) => a - b);
    for (let a = 0; a < idx.length;) {
      let b = a;
      while (b + 1 < idx.length && idx[b + 1] === idx[b] + 1) b++;
      const { hits, self } = marks.get(idx[a]);
      const other = hits.find((o) => o !== self);
      const os = sig.get(other.f);
      sites.push({ ...at(f, s[idx[a]].n), end: s[idx[b]].n, lines: b - a + 1, also: `${other.f.path}:${os[other.i].n}` });
      a = b + 1;
    }
  }
  sites.sort((x, y) => y.lines - x.lines || x.file.localeCompare(y.file));
  return { total, duplicated: dupLines, pct: total ? Math.round((dupLines / total) * 1000) / 10 : 0, sites: sites.length, top: sites.slice(0, 10) };
}
