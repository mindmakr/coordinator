// A unit's calls as HTML (data from lib/map/calls.mjs, map/calls/<unit>.json):
// a small graph (callers → touched functions → what they call) and a compact
// table, each callee or caller expandable to its own callees or callers. Every
// name and path is escaped; links go to the file and line on GitHub when the
// repo is known. The maps page's "Calls" view picks a unit with radio buttons
// read by CSS, so the static snapshot needs no script.
import { esc } from '../links.mjs';
import { clip } from '../plain.mjs';
import { link } from '../mapsvg.mjs';

export const LIMITS = 'Read from the code at one commit, never run. Counted: direct calls, `new X()`, methods through `this`, imports and typed fields, names passed as arguments or JSX handlers (marked passed), and JSX elements (`<Card />`, marked JSX). Not counted: decorators, calls through computed names (`handlers[name]()`), `.call`/`.apply`/`.bind`, functions held in variables or passed on as callbacks under another name, and dependency injection by string; a name it cannot tie to a project function (an outside package, a global, a dynamic call) is listed as unresolved.';
const SHOW = 6;

// Links only at the commit every file was read at (r.ref); without one (not a git repository) there are none.
const blob = (r, repo, file, line) => (repo && file && r.ref ? `https://github.com/${repo}/blob/${encodeURIComponent(r.ref)}/${file.split('/').map(encodeURIComponent).join('/')}${line ? `#L${line}` : ''}` : null);
const nameOf = (x) => (x.kind === 'class' ? `new ${x.q}` : x.q === '(top)' ? `${x.file.split('/').pop()} (top level)` : x.q);
// A long name keeps its last part (the method), which says the most: `EwaVerif….assertApprovalKyc`.
export function short(name, n = 27) {
  if (name.length <= n) return name;
  const cut = Math.max(name.lastIndexOf('.'), name.lastIndexOf('>'));
  if (cut < 0) return clip(name, n);
  const last = name.slice(cut);
  return last.length >= n - 4 ? clip(last.slice(1), n) : `${name.slice(0, n - last.length - 1)}…${last}`;
}
const where = (x, line = x.line) => `${x.file}:${line}`;
// `line`: where the link lands: a definition, or for a caller the line that makes the call.
function fnLink(r, repo, x, label = nameOf(x), line = x.line) {
  const href = blob(r, repo, x.file, line);
  const text = `<code>${esc(label)}</code>`;
  return href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer" title="${esc(where(x, line))}">${text}</a>` : `<span title="${esc(where(x, line))}">${text}</span>`;
}
const passed = (x) => (x.k === 'ref' ? ' <span class="meta">(passed)</span>' : x.k === 'jsx' ? ' <span class="meta">(JSX)</span>' : '');

// One callee or caller, with its own (second level) behind a toggle.
function item(r, repo, x, more, dir) {
  // A caller links to its call site (line `at`); a callee to its definition.
  const line = dir === 'in' ? x.at ?? x.line : x.line;
  const head = `${fnLink(r, repo, x, nameOf(x), line)}${passed(x)} <span class="meta">${esc(x.file.split('/').pop())}:${esc(line)}${dir === 'in' ? ' (the call)' : ''}</span>`;
  if (!more?.length) return `<li>${head}</li>`;
  const sub = more.map((y) => `<li>${y.id ? fnLink(r, repo, y, nameOf(y), dir === 'in' ? y.at ?? y.line : y.line) : `<code>${esc(y.n)}</code>`}${passed(y)}</li>`).join('');
  return `<li><details class="cv-more"><summary>${head}</summary><p class="meta">${dir === 'out' ? 'which calls' : 'which is called by'}</p><ul>${sub}</ul></details></li>`;
}

function cell(r, repo, list, total, dir, unresolved = []) {
  if (!list.length && !unresolved.length) return `<span class="meta">${dir === 'out' ? 'no calls found' : 'no callers found'}</span>`;
  const items = list.map((x) => item(r, repo, x, x.more, dir));
  const head = items.slice(0, SHOW).join('');
  const rest = items.slice(SHOW).join('');
  const extra = total - list.length - unresolved.length;
  let out = `<ul class="cv-list">${head}</ul>`;
  if (rest) out += `<details class="cv-more"><summary>${items.length - SHOW} more</summary><ul class="cv-list">${rest}</ul></details>`;
  if (unresolved.length) {
    const names = [...new Set(unresolved.map((c) => c.n))];
    out += `<p class="meta">${unresolved.length} unresolved: ${names.slice(0, 8).map((n) => `<code>${esc(clip(n, 40))}</code>`).join(' ')}${names.length > 8 ? ' …' : ''}</p>`;
  }
  if (extra > 0) out += `<p class="meta">+${extra} not listed</p>`;
  return out;
}

export function callsTable(r, repo) {
  if (!r.touched.length) return '<p class="empty">No function in the changed lines.</p>';
  const rows = r.touched.map((t) => `<tr><th scope="row">${fnLink(r, repo, t)}<div class="meta">${esc(t.file)}:${esc(t.line)}–${esc(t.end)}</div></th>`
    + `<td data-h="Calls">${cell(r, repo, t.calls.filter((c) => c.id), t.callsTotal, 'out', t.calls.filter((c) => !c.id))}</td>`
    + `<td data-h="Called by">${cell(r, repo, t.callers, t.callersTotal, 'in')}</td></tr>`).join('');
  return `<div class="scroll"><table class="cv-table"><thead><tr><th>Function touched</th><th>Calls</th><th>Called by</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// Callers left, touched functions in the middle, what they call right. Capped per column.
const BW = 210; const BH = 28; const GX = 70; const GY = 8; const TOP = 30; const CAP = 8;
export function callsGraph(r, repo, label) {
  const mid = r.touched.slice(0, CAP);
  if (!mid.length) return '';
  const inMid = new Set(mid.map((m) => m.id));
  const left = new Map(); const right = new Map(); const edges = new Set(); // "col:id|col:id"
  for (const t of mid) {
    for (const c of t.callers) {
      if (inMid.has(c.id)) continue;
      if (!left.has(c.id) && left.size < CAP) left.set(c.id, c);
      if (left.has(c.id)) edges.add(`0:${c.id}|1:${t.id}`);
    }
    for (const c of t.calls) {
      if (!c.id || inMid.has(c.id)) continue;
      if (!right.has(c.id) && right.size < CAP) right.set(c.id, c);
      if (right.has(c.id)) edges.add(`1:${t.id}|2:${c.id}`);
    }
  }
  const cols = [[...left.values()], mid, [...right.values()]];
  const pos = new Map();
  const h = TOP + Math.max(...cols.map((c) => c.length), 1) * (BH + GY) + 6;
  const W = 3 * BW + 2 * GX + 8;
  const boxes = [];
  cols.forEach((col, ci) => col.forEach((x, i) => {
    const bx = 4 + ci * (BW + GX); const by = TOP + i * (BH + GY);
    pos.set(`${ci}:${x.id}`, [bx, by]);
    const inner = `<rect class="nd${ci === 1 ? ' st-working' : ''}" x="${bx}" y="${by}" width="${BW}" height="${BH}" rx="6"/><text x="${bx + 8}" y="${by + 18}" class="sm">${esc(x.q === '(top)' ? `${clip(x.file.split('/').pop(), 15)} (top level)` : short(nameOf(x)))}</text>`;
    boxes.push(link(blob(r, repo, x.file, x.line), `${nameOf(x)}, ${where(x)}`, inner, true));
  }));
  const lines = [];
  for (const e of edges) {
    const [p, q] = e.split('|').map((k) => pos.get(k));
    if (!p || !q) continue;
    const x1 = p[0] + BW; const y1 = p[1] + BH / 2; const x2 = q[0]; const y2 = q[1] + BH / 2;
    lines.push(`<path class="edge" d="M${x1} ${y1} C${x1 + GX / 2} ${y1} ${x2 - GX / 2} ${y2} ${x2 - 6} ${y2}"/><path class="arrow" d="M${x2 - 6} ${y2 - 4} L${x2} ${y2} L${x2 - 6} ${y2 + 4}z"/>`);
  }
  const heads = ['Called by', 'Touched', 'Calls'].map((t, i) => `<text class="h" x="${4 + i * (BW + GX)}" y="16">${t}</text>`).join('');
  const more = r.touched.length > CAP ? `<p class="meta">The graph shows the first ${CAP} of ${r.touched.length} touched functions; the table lists all.</p>` : '';
  return `<p class="map-hint" aria-hidden="true">↔ Scroll inside the graph to see all of it.</p><div class="map-scroll" tabindex="0" role="region" aria-label="${esc(label)}"><svg class="map" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" role="group" aria-label="${esc(label)}" xmlns="http://www.w3.org/2000/svg">${heads}${lines.join('')}${boxes.join('')}</svg></div>${more}`;
}

const STYLE = '<style>.cv-table td,.cv-table th{min-width:150px}.cv-list{list-style:none;padding:0;margin:0;display:grid;gap:4px}'
  + 'details.cv-more{margin:0;padding:0;border:0;background:none}.cv-more summary{cursor:pointer;font-weight:400}.cv-more ul{margin:4px 0 0;padding-left:14px;list-style:none}.cv-more p{margin:4px 0 0}'
  + '@media (max-width:640px){.cv-table thead{display:none}.cv-table tr,.cv-table th,.cv-table td{display:block;min-width:0}.cv-table td::before{content:attr(data-h);display:block;font-size:12px;color:var(--muted);margin-bottom:4px}}</style>';

const source = (r) => (r.head && !r.note ? `the diff ${esc(String(r.base).slice(0, 8))}…${esc(String(r.head).slice(0, 8))}` : r.source === 'map build' ? 'the files its map build changed (whole files)' : r.source === 'files' ? 'whole files (no diff recorded for the unit)' : esc(r.source));

// The unit page's section: the graph and the table, or how to compute them.
export function unitCalls(r, repo, run, unit) {
  if (!r) return `<p class="empty">No call data yet. <code>run.mjs calls ${esc(run)} ${esc(unit)}</code> computes it from the unit's diff.</p>`;
  const meta = `<p class="meta">From ${source(r)}: ${esc(r.touchedTotal)} function${r.touchedTotal === 1 ? '' : 's'} touched in ${r.files.length} JS/TS file${r.files.length === 1 ? '' : 's'}`
    + `${r.outside ? `, ${esc(r.outside)} changed line${r.outside === 1 ? '' : 's'} outside any function` : ''}; ${esc(r.functions)} functions indexed${r.ref ? ` at ${esc(String(r.ref).slice(0, 8))}` : ''}${r.partial ? ' (partial: the time cap stopped the scan)' : ''}.</p>`
    + (r.note ? `<div class="needs"><p>${esc(r.note)}</p></div>` : '') + `<p class="meta">${esc(LIMITS)}</p>`;
  return `${STYLE}${meta}${callsGraph(r, repo, `Calls around ${unit}`)}${callsTable(r, repo)}`;
}

// The maps page's Calls view: pick a unit, see its graph and table.
export function callsView(v, ctx) {
  const list = (ctx.calls?.list?.() ?? []).filter((x) => v.units.some((u) => u.id === x.unit));
  if (!list.length) return `<p class="empty">No unit has call data yet. <code>run.mjs calls ${esc(v.id)} &lt;unit&gt;</code> computes it from a unit's diff.</p>`;
  const css = list.map((_, i) => `section.maps:has(#cv-${i}:checked) .cv-panel.p${i}{display:block}`).join('');
  const pick = `<form class="cv-pick" aria-label="Pick a unit"><fieldset><legend>Unit</legend>${list.map((x, i) => `<label class="fchip"><input type="radio" name="cv" id="cv-${i}"${i === 0 ? ' checked' : ''}><span>${esc(x.unit)}</span></label>`).join('')}</fieldset></form>`;
  const panels = list.map((x, i) => `<div class="cv-panel p${i}"><h3 class="sub">${esc(x.unit)}${ctx.unitHref ? ` <a class="meta" href="${esc(ctx.unitHref(x.unit))}">unit page →</a>` : ''}</h3>${unitCalls(x.data, v.repo, v.id, x.unit)}</div>`).join('');
  return `<style>.cv-panel{display:none}.cv-pick fieldset{display:flex;flex-wrap:wrap;gap:6px;align-items:center;border:0;padding:0;margin:10px 0}.cv-pick legend{float:left;margin-right:6px;font-size:13px;color:var(--muted)}${css}</style>${pick}${panels}`;
}
