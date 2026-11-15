// The run's report (/report when served, report.html in the snapshot): the
// release notes the lead stored (run.mjs report --file), what the run can show
// by itself (units, PRs, merges, and the git-derived draft), and the code
// quality and compliance signals (run.mjs quality). Stored text is rendered
// escaped (lib/report/md.mjs). The shared shell and components (lib/ui.mjs); with Copy
// Markdown (live page) and Download (also in the snapshot and the hosted page, no script).
import { liveCtx, runCrumbs, staticCtx, unitLinks } from '../hud.mjs';
import { blk, cols, esc, heading, kpis, mdActions, page, panel, stamp, table, toggle, toneChip } from '../parts.mjs';
import { bySeverity } from '../quality/index.mjs';
import { draftMarkdown } from './draft.mjs';
import { markdown } from './md.mjs';

const code = (t) => `<code>${esc(t)}</code>`;
const SEV = { high: 'bad', medium: 'ask', low: '' };
const STATUS = { pass: 'ok', stopped: 'bad' };
// The closed rule for release notes, shown with them whether they are written or not.
const RULE = 'Release notes never carry credentials, tokens or one-time codes. Name the setting (e.g. API_TOKEN), never its value.';
const rule = `<p class="report-rule"><b>${esc(RULE)}</b></p>`;

function notes(v, report, run) {
  if (!report?.text) {
    return { tone: 'ask', meta: '', body: `<p><b>Not written yet.</b></p>${rule}<p class="muted">The lead writes these with the release-notes sub-skill (references/sub-skills/release-notes.md), starting from the draft, then stores them:</p>`
      + `<pre>run.mjs report ${esc(run)} --draft\nrun.mjs report ${esc(run)} --file notes.md</pre>` };
  }
  return { tone: '', meta: `Stored ${stamp(report.at)}${report.source ? ` from ${code(report.source)}` : ''}`, body: `<div class="doc md">${rule}${markdown(report.text, v.repo)}</div>` };
}

function changes(v, ctx) {
  const rows = v.units.map((u) => [{ html: `<a href="${esc(ctx.unitHref(u.id))}">${esc(u.id)}</a>` }, u.title ?? u.sentence, { html: toneChip(u.status, STATUS[u.status]) }, { html: unitLinks(u, v.repo) || '<span class="muted">none</span>' }]);
  return table({ cols: [{ label: 'Unit' }, { label: 'What' }, { label: 'Status' }, { label: 'Issues, PRs and merges' }], rows, min: 640, max: 340, empty: 'No units.' });
}

// Files the run changed, by file (with the units that changed each) and by unit, from the draft's
// per-unit paths (changes[].paths; a draft stored before it has the counts only).
function changedFiles(d, ctx) {
  const mono = (f) => ({ html: `<span class="mono">${esc(f)}</span>` });
  const link = (id) => `<a href="${esc(ctx.unitHref(id))}">${esc(id)}</a>`;
  const by = (f) => d.changes.filter((c) => c.paths?.includes(f)).map((c) => link(c.unit)).join(', ');
  const byFile = table({ cols: [{ label: 'File' }, { label: 'Units' }], rows: d.files.map((f) => [mono(f), { html: by(f) }]), max: 360, empty: 'No files recorded.' });
  const units = d.changes.filter((c) => (c.paths ? c.paths.length : c.files));
  if (!units.length) return byFile;
  const rows = units.map((c) => [{ html: link(c.unit) }, c.paths?.length ?? c.files, { html: c.paths ? c.paths.map((f) => `<span class="mono">${esc(f)}</span>`).join('<br>') : '<span class="muted">not stored; run.mjs report --draft again</span>' }]);
  return byFile + toggle('files-by-unit', `By unit · ${units.length}`, table({ cols: [{ label: 'Unit' }, { label: 'Files', num: true }, { label: 'Paths' }], rows, max: 360 }));
}

// One labelled line of the devops panel: a list of items, or None.
const line = (label, xs, fn) => `<div><span class="lbl">${esc(label)} <span class="chip">${xs.length}</span></span><span class="val">${xs.length ? xs.map((x) => `<span>${fn(x)}</span>`).join('') : '<span class="muted">None found in the diffs</span>'}</span></div>`;
function devops(d, run) {
  if (!d) return { meta: '', count: undefined, body: `<p class="empty">Migrations, environment variables, scripts and jobs are read from git by <code>run.mjs report ${esc(run)} --draft</code>; not run yet.</p>` };
  const unread = d.diffs.filter((x) => !x.ok);
  const unit = (x) => ` <span class="cause">${esc(x.unit)}</span>`;
  return {
    count: d.migrations.length + d.env.length + d.scripts.length + d.jobs.length + d.copy.length,
    meta: `Read from git ${stamp(d.at)}`,
    body: `<p class="muted">Over ${d.files.length} changed files. A draft: the stored notes are what counts.</p><div class="rows">`
      + line('Migrations added', d.migrations, (m) => `${code(m.path)}${unit(m)}`)
      + line('Environment variables', d.env, (e) => `${code(e.name)} ${esc(e.change)}${e.file ? ` in ${code(e.file)}` : ''}${unit(e)}`)
      + line('Scripts added', d.scripts, (s) => `${code(s.path)}${unit(s)}`)
      + line('Jobs scheduled or queued', d.jobs, (j) => `${code(j.text)} in ${code(j.file ?? '?')}${unit(j)}`)
      + line('Copy awaiting approval', d.copy, (c) => esc(c.text))
      + '</div>'
      + (unread.length ? `<p class="hint">Not read from git: ${unread.map((x) => `${esc(x.unit)} (${esc(x.why)})`).join('; ')}.</p>` : ''),
  };
}

const evList = (ev) => `<ul class="ev">${ev.map((e) => `<li>${esc(e.file)}:${e.line}${e.end && e.end !== e.line ? `–${e.end}` : ''} ${e.text ? `<span class="cause">${esc(e.text)}</span>` : ''}${e.also ? ` <span class="cause">also ${esc(e.also)}</span>` : ''}</li>`).join('')}</ul>`;

// The measures of the changed files and the whole project, side by side.
function measures(q) {
  const t = q.thresholds;
  const one = (m) => {
    const d = m.duplication; const s = m.structure; const n = m.naming; const r = m.redundancy;
    return [
      [`${d.pct}%`, `${d.sites} sites`], [String(s.longFiles.count), `over ${t.longFile} lines`], [String(s.longFunctions.count), `over ${t.longFunction} lines`],
      [String(s.deepNesting.count), `${t.deepNesting}+ blocks deep`], [Object.entries(n.languages).map(([k, x]) => `${k} ${x.pct}%`).join(', ') || '–', ''],
      r.measured ? [String(r.deadFiles.count), ''] : ['–', ''],
    ];
  };
  const m = q.project;
  const help = [
    `Share of significant lines that repeat a run of ${t.duplicateWindow} lines found elsewhere.`,
    `Files: p50 ${m.structure.files.p50}, p90 ${m.structure.files.p90}, max ${m.structure.files.max} lines.`,
    `Functions: p50 ${m.structure.functions.p50}, p90 ${m.structure.functions.p90}, max ${m.structure.functions.max} lines.`,
    '', 'Declared names that follow the language’s usual convention.', m.redundancy.measured ? 'Code files no other file imports (entry points excluded).' : m.redundancy.why,
  ];
  const names = ['Duplication', 'Long files', 'Long functions', 'Deep nesting', 'Naming fits', 'Unused files'];
  const a = q.changed ? one(q.changed) : null; const b = one(m);
  const cell = ([v, s]) => ({ html: `${esc(v)}${s ? ` <span class="cause">${esc(s)}</span>` : ''}` });
  const rows = names.map((name, i) => [{ html: `<span${help[i] ? ` title="${esc(help[i])}"` : ''}>${esc(name)}</span>` }, ...(a ? [cell(a[i])] : []), cell(b[i])]);
  return table({ cols: [{ label: 'Measure' }, ...(a ? [{ label: 'Changed files' }] : []), { label: 'Whole project' }], rows, min: a ? 420 : 300 });
}

const signalList = (m, key) => {
  const sig = bySeverity(m.signals);
  const item = (x) => `<li>${toneChip(x.severity, SEV[x.severity])} ${toneChip(x.area)} <b>${esc(x.title)}</b> <span class="cause">${x.count}</span>`
    + `${toggle(`q-${key}-${x.id}`, `Where · ${Math.min(x.count, x.evidence.length)} of ${x.count}`, evList(x.evidence))}</li>`;
  return sig.length ? `<ul class="plain">${sig.map(item).join('')}</ul>` : '<p class="empty">No security or privacy signal.</p>';
};

function details(m, key) {
  const d = m.duplication; const s = m.structure; const n = m.naming; const r = m.redundancy;
  return [
    d.top.length && toggle(`q-${key}-dup`, `Largest repeated blocks · ${d.top.length}`, evList(d.top.map((x) => ({ ...x, text: `${x.lines} lines` })))),
    s.longFunctions.top.length && toggle(`q-${key}-fn`, `Longest functions · ${s.longFunctions.top.length}`, evList(s.longFunctions.top.map((x) => ({ ...x, text: `${x.name}, ${x.lines} lines` })))),
    s.deepNesting.top.length && toggle(`q-${key}-deep`, `Deepest nesting · ${s.deepNesting.top.length}`, evList(s.deepNesting.top.map((x) => ({ ...x, text: `${x.name}, ${x.depth} deep` })))),
    n.outliers.count && toggle(`q-${key}-names`, `Names off convention · ${n.outliers.count}`, evList(n.outliers.top.map((x) => ({ ...x, text: `${x.name}: ${x.style} ${x.kind}` })))),
    r.measured && r.deadFiles.count && toggle(`q-${key}-dead`, `Files nothing imports · ${r.deadFiles.count}`, evList(r.deadFiles.top)),
    r.measured && r.reuse.count && toggle(`q-${key}-reuse`, `Same function shape in several places · ${r.reuse.count}`, evList(r.reuse.top)),
  ].filter(Boolean);
}

// The quality measurement as three panels (quality, security, where to look), or one saying it is not measured.
function qualityPanels(q, run) {
  if (!q) return blk('quality', panel({ id: 'quality', title: 'Code quality and compliance', bodyHtml: `<p class="empty">Not measured yet: <code>run.mjs quality ${esc(run)}</code> (Node built-ins only, read-only on the project).</p>` }));
  const p = q.project.privacy;
  const scope = (title, m, key) => `<h3 class="sub">${esc(title)}</h3>${signalList(m, key)}`;
  const quality = panel({
    id: 'quality', title: 'Code quality and compliance',
    metaHtml: `Measured ${stamp(q.at)}`,
    bodyHtml: `<p class="muted"><b>Signals, not a verdict.</b> ${esc(q.disclaimer)}</p>`
      + `<p class="muted">${q.changed ? `${q.changed.files} code files changed; ` : 'No changed files recorded (no unit has a gaming-check diff), so only the whole project is measured; '}whole project ${q.project.files} code files, ${q.project.lines} lines${q.skipped ? `; ${q.skipped} ${q.skipped === 1 ? 'file' : 'files'} skipped (too large, minified or unreadable)` : ''}. Thresholds: references/quality.md.</p>`
      + measures(q),
  });
  const sigCount = (q.changed?.signals.length ?? 0) + q.project.signals.length;
  const security = panel({
    id: 'security', title: 'Security and privacy', count: sigCount,
    bodyHtml: (q.changed ? scope('Files the run changed', q.changed, 'changed') : '') + scope('Whole project', q.project, 'project')
      + `<p class="muted">Personal-data fields found: ${p.personalFields}. Deletion or retention path: ${p.retention ? esc(`${p.retention.file}:${p.retention.line}`) : 'none found'}. Consent or privacy-notice text: ${p.consent ? esc(`${p.consent.file}:${p.consent.line}`) : 'none found'}.</p>`,
  });
  const look = [...(q.changed ? details(q.changed, 'changed').map((x) => ['Files the run changed', x]) : []), ...details(q.project, 'project').map((x) => ['Whole project', x])];
  const where = look.length ? panel({
    id: 'look', title: 'Where to look', count: look.length, open: false,
    bodyHtml: [...new Set(look.map(([s]) => s))].map((s) => `<h3 class="sub">${esc(s)}</h3>${look.filter(([x]) => x === s).map(([, x]) => x).join('')}`).join(''),
  }) : '';
  return blk('quality', quality) + blk('security', security) + (where ? blk('look', where) : '');
}

// The run's report as Markdown, for Copy and Download: the stored notes, else the draft from git.
export function reportMarkdown(v, data = {}) {
  if (data.report?.text) return data.report.text;
  if (data.draft) { try { return draftMarkdown(data.draft, { id: v.id }); } catch { /* falls through to the not-written state */ } }
  return `# Report · ${v.id}\n\nNot written yet. Run \`run.mjs report ${v.id} --draft\`, then store the release notes with \`run.mjs report ${v.id} --file notes.md\`.`;
}

// Signals of the changed files, else of the whole project: the KPI.
const signalsKpi = (q) => {
  if (!q) return { k: 'Signals', v: '–', s: 'not measured' };
  const list = (q.changed ?? q.project).signals;
  const high = list.filter((x) => x.severity === 'high').length;
  return { k: 'Signals', v: String(list.length), s: `${high} high · ${q.changed ? 'changed files' : 'whole project'}` };
};

// data: { report: run.report, draft, quality } (draft and quality from the run folder, or null).
export function reportPage(v, nowMs = Date.now(), ctx = null, data = {}) {
  ctx ??= staticCtx('', 0);
  if (ctx.token) ctx = liveCtx(ctx, v.id);
  const links = v.units.flatMap((u) => u.links ?? []);
  // A PR linked again on a later try counts once.
  const distinct = (kind) => new Set(links.filter((l) => l.kind === kind).map((l) => l.url)).size;
  const passed = v.units.filter((u) => u.status === 'pass').length; const stopped = v.units.filter((u) => u.status === 'stopped').length;
  const n = notes(v, data.report, v.id); const dv = devops(data.draft, v.id);
  const md = reportMarkdown(v, data);
  const head = heading('Report', '', {
    inlineHtml: `${toneChip(v.phase.replace(/^closed: /, ''), v.open ? '' : 'done')}<span class="muted">updated ${stamp(new Date(nowMs).toISOString())}</span>`,
    actionsHtml: `${ctx.retro && !ctx.pages?.length ? `<a class="open" href="${esc(ctx.retro)}">Retro →</a>` : ''}${mdActions(md, `report-${v.id}.md`, { copy: !!ctx.live })}`,
  });
  const strip = kpis([
    { k: 'Units', v: `${passed} of ${v.units.length}`, s: stopped ? `${stopped} stopped` : 'passed' },
    { k: 'Pull requests', v: distinct('pr'), s: `${distinct('merge')} merged` },
    { k: 'Files changed', v: data.draft ? data.draft.files.length : '–', s: data.draft ? `${data.draft.migrations.length} migrations · ${data.draft.env.length} variables` : 'not read from git' },
    signalsKpi(data.quality),
  ]);
  const files = data.draft ? blk('files', panel({ id: 'files', title: 'Files the run changed', count: data.draft.files.length, bodyHtml: changedFiles(data.draft, ctx), flush: data.draft.files.length > 0 })) : '';
  const main = blk('changes', panel({ id: 'changes', title: 'Changes, from the run', count: v.units.length, bodyHtml: changes(v, ctx), flush: v.units.length > 0 }))
    + blk('notes', panel({ id: 'notes', title: 'Release notes', metaHtml: n.meta, bodyHtml: n.body, tone: n.tone, scroll: n.tone ? undefined : 420 }))
    + files
    + blk('devops', panel({ id: 'devops', title: 'For devops, from git', count: dv.count, metaHtml: dv.meta, bodyHtml: dv.body, open: false }));
  const body = `<div class="stack">${[blk('head', head), blk('kpis', strip), cols(main, qualityPanels(data.quality, v.id))].join('\n')}</div>`;
  return page({ title: `Report · ${v.id}`, body, ctx, path: `${ctx.base ?? ''}/report`, closed: !v.open, crumbs: runCrumbs(v, ctx, 'Report') });
}
