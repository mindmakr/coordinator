// A small, safe Markdown renderer for stored release notes: headings, lists,
// tables, fenced code, paragraphs, **bold** and `code`. Every piece of text is
// escaped first (lib/links.mjs linkify), and only http(s) URLs and GitHub refs
// become links; no raw HTML ever passes through.
import { esc, linkify } from '../links.mjs';

// `code` and **bold** only in the text between tags, never inside a tag or across one, so an href is never touched.
const inline = (t, repo) => linkify(t, repo).split(/(<[^>]*>)/).map((part, i) => (i % 2 ? part : part
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>'))).join('');
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

export function markdown(src, repo = null) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = []; let para = [];
  const flush = () => { if (para.length) out.push(`<p>${inline(para.join(' '), repo)}</p>`); para = []; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^```/.test(l)) {
      flush();
      const body = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      out.push(`<pre>${esc(body.join('\n'))}</pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) { flush(); const n = Math.min(6, h[1].length + 1); out.push(`<h${n} class="md">${inline(h[2], repo)}</h${n}>`); continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-')) {
      flush();
      const head = cells(l); const rows = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      out.push(`<div class="scroll"><table><thead><tr>${head.map((c) => `<th>${inline(c, repo)}</th>`).join('')}</tr></thead>`
        + `<tbody>${rows.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? '', repo)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      flush();
      const ordered = /^\s*\d+\./.test(l); const items = [];
      for (; i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]); i++) items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      i--;
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag} class="md">${items.map((t) => `<li>${inline(t, repo)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (!l.trim()) { flush(); continue; }
    para.push(l.trim());
  }
  flush();
  return out.join('\n');
}
