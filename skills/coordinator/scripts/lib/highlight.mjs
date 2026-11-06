// Search highlights on the timeline. Built from text nodes only (createTextNode,
// splitting the existing node), never from HTML, so state text stays escaped.
// Matching ignores case and accents, and Arabic and Urdu diacritics, by folding
// each character (NFD, marks removed, lower case) while keeping a map back to
// the original positions. The page runs these functions' source; the tests run
// them against a small fake DOM.

// [start, end) ranges in `text` where `q` matches.
export function findMatches(text, q) {
  const fold = (c) => c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const needle = fold(String(q ?? '').trim());
  if (!needle) return [];
  let folded = ''; const at = []; let i = 0;
  for (const ch of String(text)) { const f = fold(ch); for (let k = 0; k < f.length; k++) at.push(i); folded += f; i += ch.length; }
  at.push(String(text).length);
  const out = [];
  for (let p = folded.indexOf(needle); p >= 0; p = folded.indexOf(needle, p + needle.length)) out.push([at[p], at[p + needle.length]]);
  return out;
}

// Wraps each match inside `rows` (but not in <time>) in <mark class="hl">. Returns the count.
export function highlight(rows, q, doc) {
  let n = 0;
  const texts = [];
  const walk = (node) => { for (const c of [...node.childNodes]) { if (c.nodeType === 3) texts.push(c); else if (c.nodeType === 1 && c.tagName !== 'TIME' && c.tagName !== 'MARK') walk(c); } };
  for (const row of rows) walk(row);
  for (const t of texts) {
    const v = t.nodeValue; const ms = findMatches(v, q);
    if (!ms.length) continue;
    let last = 0;
    for (const [s, e] of ms) {
      if (s > last) t.parentNode.insertBefore(doc.createTextNode(v.slice(last, s)), t);
      const m = doc.createElement('mark'); m.setAttribute('class', 'hl'); m.appendChild(doc.createTextNode(v.slice(s, e)));
      t.parentNode.insertBefore(m, t); last = e; n++;
    }
    t.nodeValue = v.slice(last);
  }
  return n;
}

// Puts the text back as it was: marks unwrapped, neighbouring text nodes joined.
export function unhighlight(root) {
  const walk = (node) => {
    for (const c of [...node.childNodes]) {
      if (c.nodeType === 1 && c.tagName === 'MARK' && c.getAttribute('class') === 'hl') {
        for (const k of [...c.childNodes]) node.insertBefore(k, c);
        node.removeChild(c);
      } else if (c.nodeType === 1) walk(c);
    }
    for (let c = node.firstChild; c;) {
      const next = c.nextSibling;
      if (c.nodeType === 3 && next && next.nodeType === 3) { c.nodeValue += next.nodeValue; node.removeChild(next); } else c = next;
    }
  };
  walk(root);
}
