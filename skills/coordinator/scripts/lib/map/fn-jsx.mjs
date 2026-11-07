// JSX in .jsx/.tsx files, for the function scanner (lib/map/fns.mjs): the
// components each element uses (`<Card>`, `<ui.Button>`), and the text between
// tags blanked, so `<p>Call fn(x)</p>` is not a call. An element starts where
// an expression can: after `(`, `,`, `=`, `?`, `:`, `[`, `{`, `;`, `&&`, `||`,
// `return` or `=>`; never after a name (`useState<T>(…)` is a generic).
const START = /(?:^|[(,=?:[{};&|>]|\breturn|=>)\s*$/; // `}` and `>`: a child after an {expression} or a tag, when its parent did not parse

export function jsx(bare, mt) {
  const chars = bare.split('');
  const tags = []; const seen = new Set(); const done = new Set();
  const blank = (from, to, list) => { for (let i = from; i < to; i++) if (chars[i] !== '\n') list.push(i); };

  // The element at `i` (a `<`): its end, or -1 when it does not parse; text to blank goes in `list`, components in `ts`.
  function element(i, list, ts, depth = 0) {
    if (depth > 60) return -1;
    (ts.starts ??= []).push(i); // marked done only if the outermost element parses
    let j = i + 1;
    const name = /^[A-Za-z_$][\w$.:-]*/.exec(bare.slice(j, j + 120))?.[0] ?? '';
    if (!name && bare[j] !== '>') return -1;
    j += name.length;
    if (name && !/[\s/>]/.test(bare[j] ?? '')) return -1;
    if (name && (/^[A-Z]/.test(name) || name.includes('.')) && !seen.has(i + 1)) ts.push({ name, at: i + 1 });
    // Attributes, to `>` or `/>`.
    for (const stop = Math.min(bare.length, j + 5000); j < stop; j++) {
      const c = bare[j];
      if (c === '{') { const e = mt(j); if (e < 0) return -1; j = e - 1; } else if (c === '"' || c === "'") { const e = bare.indexOf(c, j + 1); if (e < 0) return -1; j = e; } else if (c === '/' && bare[j + 1] === '>') return j + 2;
      else if (c === '>') break;
      else if (c === '<' || c === ';') return -1;
    }
    if (bare[j] !== '>') return -1;
    // Children: text (blanked), {expressions} (kept), elements (nested), then the closing tag.
    j++;
    for (const stop = Math.min(bare.length, j + 200_000); j < stop;) {
      const c = bare[j];
      if (c === '{') { const e = mt(j); if (e < 0) return -1; j = e; continue; }
      if (c === '<' && bare[j + 1] === '/') { const e = bare.indexOf('>', j); return e < 0 ? -1 : e + 1; }
      if (c === '<') { const e = element(j, list, ts, depth + 1); if (e < 0) return -1; j = e; continue; }
      let k = j;
      while (k < stop && bare[k] !== '{' && bare[k] !== '<') k++;
      blank(j, k, list);
      j = k;
    }
    return -1;
  }

  for (let i = bare.indexOf('<'); i >= 0; i = bare.indexOf('<', i + 1)) {
    if (done.has(i) || bare[i + 1] === '/' || !START.test(bare.slice(Math.max(0, i - 12), i))) continue;
    const list = []; const ts = [];
    const end = element(i, list, ts);
    if (end < 0) continue;
    for (const k of list) chars[k] = ' ';
    for (const t of ts) if (!seen.has(t.at)) { seen.add(t.at); tags.push(t); }
    for (const k of ts.starts ?? []) done.add(k);
    // no skip to the end: elements inside {expressions} are found by this loop
  }
  return { bare: chars.join(''), tags };
}
