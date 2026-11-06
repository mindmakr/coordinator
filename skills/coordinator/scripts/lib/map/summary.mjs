// map.md: the map in a page anyone can read on github.com. Derived, never edited.
import { TEST } from './js.mjs';

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const code = (s) => `\`${cell(s).replace(/`/g, "'")}\``;
const table = (head, rows) => (rows.length ? [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') : '_None found._');

export function summary(snap, run) {
  const b = snap.build ?? {};
  const kinds = {};
  for (const s of snap.surfaces) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
  // Ranked by users outside tests, so fixtures do not crowd out the real shared code.
  const helpers = snap.helpers.map((h) => ({ ...h, real: h.usedBy.filter((f) => !TEST.test(f)).length })).filter((h) => h.real >= 2).sort((a, b2) => b2.real - a.real).slice(0, 15);
  const settings = snap.settings.map((s) => ({ ...s, n: s.reads.length + s.writes.length })).sort((a, b2) => b2.n - a.n).slice(0, 15);
  const written = snap.settings.filter((s) => s.writes.length).length;
  const out = [
    `# Project map: ${b.root ?? 'project'}`,
    '',
    `Run \`${run}\`, build ${b.n ?? 0}${b.at ? `, ${b.at.slice(0, 16).replace('T', ' ')} UTC` : ''}${b.commit ? `, commit ${b.commit.slice(0, 10)}` : ''}${b.unit ? `, after unit ${b.unit}` : ''}. Built from the code by \`run.mjs map\`; do not edit by hand.`,
    '',
    `- **Modules:** ${snap.modules.length} (${Object.entries(b.langs ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}), ${b.unresolved ?? 0} unresolved imports.`,
    `- **Shared helpers:** ${snap.helpers.length} exported functions or classes used by two or more files.`,
    `- **Settings:** ${snap.settings.filter((s) => s.kind === 'env').length} env vars and ${snap.settings.filter((s) => s.kind === 'key').length} settings or config keys; ${written} are written somewhere.`,
    `- **Surfaces:** ${Object.entries(kinds).map(([k, v]) => `${v} ${k}s`).join(', ') || 'none'}${b.messages ? `; ${b.messages.keys} message keys in all, ${b.messages.unused} not found in code, ${b.messages.unknownLookups} lookups that match no key${b.messages.from ? ` (counted in ${b.messages.from})` : ''}` : ''}.`,
    `- **Reuse candidates:** ${snap.reuse.length} groups of functions with the same shape.`,
    `- **Scan:** ${b.scanned ?? 0} of ${b.files ?? 0} files in ${((b.ms?.total ?? 0) / 1000).toFixed(1)} s${b.partial ? ' — **partial: stopped at the time cap**' : ''}.`,
    '',
    '## Most shared helpers',
    '',
    table(['Helper', 'Defined in', 'Used by (outside tests)'], helpers.map((h) => [code(h.name), code(`${h.file}:${h.line}`), h.real])),
    '',
    '## Most used settings',
    '',
    table(['Key', 'Reads', 'Writes'], settings.map((s) => [code(s.id), s.reads.length, s.writes.length])),
    '',
    '## Largest reuse candidates',
    '',
    table(['Lines', 'Same shape in'], snap.reuse.slice().sort((a, b2) => b2.lines * b2.fns.length - a.lines * a.fns.length).slice(0, 10).map((r) => [r.lines, r.fns.map(code).join(', ')])),
    '',
    `Everything else is in \`map.json\` (one record per line). Limits: \`references/map.md\` in the coordinator skill.`,
    '',
  ];
  return out.join('\n');
}
