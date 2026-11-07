// The run's report (/report when served, report.html in the snapshot): the
// release notes the lead stored (run.mjs report --file), what the run can show
// by itself (units, PRs, merges, and the git-derived draft), and the code
// quality and compliance signals (run.mjs quality). Stored text is rendered
// escaped (lib/report/md.mjs). Same shell, theme and print styles as the dashboard.
import { liveCtx, staticCtx, unitLinks } from '../hud.mjs';
import { blk, chip, esc, page, stamp, toggle } from '../parts.mjs';
import { bySeverity } from '../quality/index.mjs';
import { markdown } from './md.mjs';

const code = (t) => `<code>${esc(t)}</code>`;
const SEV = { high: 'fail', medium: 'not-yet', low: '' };
const STYLE = '<style>.md{overflow-wrap:anywhere}.md h2,.md h3,.md h4,.md h5{margin:16px 0 6px}.md ul,.md ol{padding-left:20px}.md table{margin:6px 0}.report-note{border-left:4px solid var(--wait)}.ev{font:12px var(--mono);overflow-wrap:anywhere}.ev li{margin:2px 0}@media (max-width:560px){.changes table,.changes tbody,.changes tr,.changes th,.changes td{display:block}.changes thead{display:none}.changes tr{border-top:1px solid var(--line);padding:6px 0}.changes tr:first-child{border-top:0}.changes th,.changes td{border:0;padding:2px 12px;min-width:0}}</style>';

function notes(v, report, run) {
  if (!report?.text) {
    return `<section class="card report-note"><h3>Not written yet</h3><p>The lead writes these with the release-notes sub-skill (references/sub-skills/release-notes.md), starting from the draft, then stores them:</p>`
      + `<pre>run.mjs report ${esc(run)} --draft\nrun.mjs report ${esc(run)} --file notes.md</pre></section>`;
  }
  return `<section class="card md">${markdown(report.text, v.repo)}<p class="meta">Stored ${stamp(report.at)}${report.source ? ` from ${code(report.source)}` : ''}.</p></section>`;
}

function changes(v, ctx) {
  if (!v.units.length) return '<p class="empty">No units.</p>';
  const rows = v.units.map((u) => `<tr><th><a href="${esc(ctx.unitHref(u.id))}">${esc(u.id)}</a></th><td>${esc(u.title ?? u.sentence)}</td><td>${chip(u.status, u.status)}</td><td>${unitLinks(u, v.repo) || '<span class="cause">none</span>'}</td></tr>`).join('');
  return `<div class="scroll changes"><table><thead><tr><th>Unit</th><th>What</th><th>Status</th><th>Issues, PRs and merges</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function devops(d, run) {
  if (!d) return `<p class="empty">Migrations, environment variables, scripts and jobs are read from git by <code>run.mjs report ${esc(run)} --draft</code>; not run yet.</p>`;
  const part = (title, xs, fn) => `<section class="card"><h3>${esc(title)} <span class="chip">${xs.length}</span></h3>${xs.length ? `<ul>${xs.map((x) => `<li>${fn(x)}</li>`).join('')}</ul>` : '<p class="empty">None found in the diffs.</p>'}</section>`;
  const unread = d.diffs.filter((x) => !x.ok);
  return `<p class="meta">Read from git ${stamp(d.at)}, over ${d.files.length} changed files. A draft: the stored notes above are what counts.</p><div class="lists">`
    + part('Migrations added', d.migrations, (m) => `${code(m.path)} <span class="cause">${esc(m.unit)}</span>`)
    + part('Environment variables', d.env, (e) => `${code(e.name)} ${esc(e.change)}${e.file ? ` in ${code(e.file)}` : ''} <span class="cause">${esc(e.unit)}</span>`)
    + part('Scripts added', d.scripts, (s) => `${code(s.path)} <span class="cause">${esc(s.unit)}</span>`)
    + part('Jobs scheduled or queued', d.jobs, (j) => `${code(j.text)} in ${code(j.file ?? '?')} <span class="cause">${esc(j.unit)}</span>`)
    + part('Copy awaiting approval', d.copy, (c) => esc(c.text))
    + '</div>'
    + (unread.length ? `<p class="hint">Not read from git: ${unread.map((x) => `${esc(x.unit)} (${esc(x.why)})`).join('; ')}.</p>` : '');
}

const stat = (label, value, help = '') => `<div class="card stat"${help ? ` title="${esc(help)}"` : ''}><span>${esc(label)}</span><b>${value}</b></div>`;
const evList = (ev) => `<ul class="ev">${ev.map((e) => `<li>${esc(e.file)}:${e.line}${e.end && e.end !== e.line ? `–${e.end}` : ''} ${e.text ? `<span class="cause">${esc(e.text)}</span>` : ''}${e.also ? ` <span class="cause">also ${esc(e.also)}</span>` : ''}</li>`).join('')}</ul>`;

function measured(m, key, t) {
  const d = m.duplication; const s = m.structure; const n = m.naming; const r = m.redundancy;
  const names = Object.entries(n.languages).map(([k, x]) => `${esc(k)} ${x.pct}%`).join(', ') || '–';
  const cards = `<div class="budget">${stat('Duplication', `${d.pct}% <span class="cause">${d.sites} sites</span>`, `Share of significant lines that repeat a run of ${t.duplicateWindow} lines found elsewhere.`)}`
    + stat('Long files', `${s.longFiles.count} <span class="cause">over ${t.longFile} lines</span>`, `Files: p50 ${s.files.p50}, p90 ${s.files.p90}, max ${s.files.max} lines.`)
    + stat('Long functions', `${s.longFunctions.count} <span class="cause">over ${t.longFunction} lines</span>`, `Functions: p50 ${s.functions.p50}, p90 ${s.functions.p90}, max ${s.functions.max} lines.`)
    + stat('Deep nesting', `${s.deepNesting.count} <span class="cause">${t.deepNesting}+ blocks deep</span>`)
    + stat('Naming fits', names, 'Declared names that follow the language’s usual convention.')
    + stat('Unused files', r.measured ? String(r.deadFiles.count) : '–', r.measured ? 'Code files no other file imports (entry points excluded).' : r.why)
    + '</div>';
  const sig = bySeverity(m.signals);
  const item = (x) => `<li>${chip(x.severity, SEV[x.severity])} ${chip(x.area)} <b>${esc(x.title)}</b> <span class="cause">${x.count}</span>`
    + `${toggle(`q-${key}-${x.id}`, `Where · ${Math.min(x.count, x.evidence.length)} of ${x.count}`, evList(x.evidence))}</li>`;
  const signals = sig.length ? `<ul class="plain">${sig.map(item).join('')}</ul>` : '<p class="empty">No security or privacy signal.</p>';
  const detail = [
    d.top.length && toggle(`q-${key}-dup`, `Largest repeated blocks · ${d.top.length}`, evList(d.top.map((x) => ({ ...x, text: `${x.lines} lines` })))),
    s.longFunctions.top.length && toggle(`q-${key}-fn`, `Longest functions · ${s.longFunctions.top.length}`, evList(s.longFunctions.top.map((x) => ({ ...x, text: `${x.name}, ${x.lines} lines` })))),
    s.deepNesting.top.length && toggle(`q-${key}-deep`, `Deepest nesting · ${s.deepNesting.top.length}`, evList(s.deepNesting.top.map((x) => ({ ...x, text: `${x.name}, ${x.depth} deep` })))),
    n.outliers.count && toggle(`q-${key}-names`, `Names off convention · ${n.outliers.count}`, evList(n.outliers.top.map((x) => ({ ...x, text: `${x.name}: ${x.style} ${x.kind}` })))),
    r.measured && r.deadFiles.count && toggle(`q-${key}-dead`, `Files nothing imports · ${r.deadFiles.count}`, evList(r.deadFiles.top)),
    r.measured && r.reuse.count && toggle(`q-${key}-reuse`, `Same function shape in several places · ${r.reuse.count}`, evList(r.reuse.top)),
  ].filter(Boolean).join('');
  return `${cards}<h3 class="sub">Security and privacy signals</h3>${signals}${detail ? `<h3 class="sub">Where to look</h3>${detail}` : ''}`;
}

function qualityBlock(q, run) {
  if (!q) return `<p class="empty">Not measured yet: <code>run.mjs quality ${esc(run)}</code> (Node built-ins only, read-only on the project).</p>`;
  const p = q.project.privacy;
  const found = `<p class="meta">Personal-data fields found: ${p.personalFields}. Deletion or retention path: ${p.retention ? esc(`${p.retention.file}:${p.retention.line}`) : 'none found'}. Consent or privacy-notice text: ${p.consent ? esc(`${p.consent.file}:${p.consent.line}`) : 'none found'}.</p>`;
  return `<div class="needs calm"><b>Signals, not a verdict.</b> ${esc(q.disclaimer)}</div><p class="meta">Measured ${stamp(q.at)}${q.skipped ? `; ${q.skipped} ${q.skipped === 1 ? 'file' : 'files'} skipped (too large, minified or unreadable)` : ''}. Thresholds: references/quality.md.</p>`
    + (q.changed ? `<h3 class="sub">Files the run changed · ${q.changed.files} code files</h3>${measured(q.changed, 'changed', q.thresholds)}` : '<p class="hint">No changed files recorded (no unit has a gaming-check diff), so only the whole project is measured.</p>')
    + `<h3 class="sub">Whole project · ${q.project.files} code files, ${q.project.lines} lines</h3>${measured(q.project, 'project', q.thresholds)}${found}`;
}

// data: { report: run.report, draft, quality } (draft and quality from the run folder, or null).
export function reportPage(v, nowMs = Date.now(), ctx = null, data = {}) {
  ctx ??= staticCtx('', 0);
  if (ctx.token) ctx = liveCtx(ctx, v.id);
  const toc = '<nav class="toc" aria-label="Sections"><a href="#notes">Release notes</a><a href="#changes">Changes</a><a href="#devops">For devops</a><a href="#quality">Code quality and compliance</a></nav>';
  const body = [
    STYLE,
    `<a class="back" href="${esc(ctx.home)}">← ${esc(v.id)} dashboard</a>`,
    blk('head', `<header class="run"><h1>Report · ${esc(v.id)}</h1>${chip(v.phase, v.phase.replace(/^closed: /, ''))}<span class="meta">release notes for devops and testers · updated ${stamp(new Date(nowMs).toISOString())}</span>${ctx.retro ? `<a class="open" href="${esc(ctx.retro)}">Retro →</a>` : ''}</header>`),
    toc,
    '<h2 id="notes">Release notes</h2>', blk('notes', notes(v, data.report, v.id)),
    '<h2 id="changes">Changes, from the run</h2>', blk('changes', changes(v, ctx)),
    '<h2 id="devops">For devops, from git</h2>', blk('devops', devops(data.draft, v.id)),
    '<h2 id="quality">Code quality and compliance signals</h2>', blk('quality', qualityBlock(data.quality, v.id)),
  ].join('\n');
  return page({ title: `Report · ${v.id}`, body, ctx, path: `${ctx.base ?? ''}/report`, closed: !v.open });
}
