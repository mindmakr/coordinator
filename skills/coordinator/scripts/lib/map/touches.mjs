// "What this file touches", from a map snapshot, for a builder's brief: what
// it imports and who imports it (and how far that reaches), the shared helpers
// it defines or uses, the settings it reads or writes, the surfaces it sits
// behind and its reuse candidates.
const DEPTH = 3;
const LIST = 8;
const REACHED = 12;

// A path as the map spells it: relative to the mapped root, forward slashes.
export function locate(snap, raw) {
  const p = String(raw).replace(/\\/g, '/').replace(/^\.\//, '');
  const ids = snap.modules.map((m) => m.id);
  if (ids.includes(p)) return p;
  const tail = ids.filter((id) => p.endsWith(`/${id}`) || id.endsWith(`/${p}`));
  return tail.length === 1 ? tail[0] : tail.sort((a, b) => b.length - a.length)[0] ?? null;
}

export function touches(snap, raw) {
  const file = locate(snap, raw);
  if (!file) return null;
  const mod = snap.modules.find((m) => m.id === file);
  const importers = new Map();
  for (const m of snap.modules) for (const to of m.imports) { if (!importers.has(to)) importers.set(to, []); importers.get(to).push(m.id); }
  // Everything that reaches this file within DEPTH import steps.
  const reach = new Map(); let frontier = [file]; // file → import steps away
  for (let d = 1; d <= DEPTH; d++) {
    const next = [];
    for (const f of frontier) for (const up of importers.get(f) ?? []) if (up !== file && !reach.has(up)) { reach.set(up, d); next.push(up); }
    frontier = next;
  }
  const at = (refs) => refs.some((r) => r.slice(0, r.lastIndexOf(':')) === file);
  const helpersHere = snap.helpers.filter((h) => h.file === file).map((h) => ({ name: h.name, line: h.line, usedBy: h.usedBy }));
  const helpersUsed = snap.helpers.filter((h) => h.usedBy.includes(file)).map((h) => ({ name: h.name, file: h.file }));
  const settings = snap.settings.filter((s) => at(s.reads) || at(s.writes)).map((s) => ({ id: s.id, read: at(s.reads), written: at(s.writes) }));
  // Direct first (declared here, or this file is behind the handler), then by import distance.
  // A hub file is reached by hundreds: only the nearest REACHED are listed, with the total.
  const all = snap.surfaces.filter((s) => s.kind !== 'message' && (s.file === file || s.services?.includes(file) || reach.has(s.file)))
    .map((s) => ({ id: s.id, kind: s.kind, ...(s.method ? { method: s.method } : {}), path: s.path, file: s.file, direct: s.file === file || !!s.services?.includes(file), steps: s.file === file ? 0 : reach.get(s.file) ?? 1 }))
    .sort((a, b) => (b.direct - a.direct) || a.steps - b.steps || (a.id < b.id ? -1 : 1));
  const surfaces = [...all.filter((s) => s.direct), ...all.filter((s) => !s.direct).slice(0, REACHED)];
  const messages = snap.surfaces.filter((s) => s.kind === 'message' && s.usedBy.includes(file)).map((s) => s.id.slice('message:'.length));
  const reuse = snap.reuse.filter((r) => r.fns.some((f) => f.startsWith(`${file}#`))).map((r) => ({ lines: r.lines, fns: r.fns }));
  return { file, lang: mod.lang, lines: mod.lines, imports: mod.imports, ext: mod.ext, importedBy: (importers.get(file) ?? []).sort(), reach: reach.size, helpersHere, helpersUsed, settings, surfaces, reaching: all.filter((s) => !s.direct).length, messages, reuse };
}

const more = (list, n = LIST) => (list.length > n ? `${list.slice(0, n).join(', ')}, … ${list.length - n} more` : list.join(', '));

// Plain lines for a brief.
export function text(t) {
  if (!t) return '';
  const lines = [`What ${t.file} touches (project map):`];
  if (t.imports.length) lines.push(`- Imports ${t.imports.length}: ${more(t.imports)}`);
  if (t.ext.length) lines.push(`- Packages: ${more(t.ext)}`);
  lines.push(t.importedBy.length ? `- Imported by ${t.importedBy.length}: ${more(t.importedBy)}; ${t.reach} files reach it within ${DEPTH} steps` : '- Imported by no file in the map');
  for (const h of t.helpersHere) lines.push(`- Defines shared helper ${h.name} (line ${h.line}), used by ${h.usedBy.length}: ${more(h.usedBy, 5)}`);
  if (t.helpersUsed.length) lines.push(`- Uses shared helpers: ${more(t.helpersUsed.map((h) => `${h.name} (${h.file})`), 6)}`);
  const reads = t.settings.filter((s) => s.read).map((s) => s.id); const writes = t.settings.filter((s) => s.written).map((s) => s.id);
  if (reads.length) lines.push(`- Reads settings: ${more(reads, 10)}`);
  if (writes.length) lines.push(`- Writes settings: ${more(writes, 10)}`);
  const direct = t.surfaces.filter((s) => s.direct); const indirect = t.surfaces.filter((s) => !s.direct);
  const name = (s) => `${s.kind} ${s.method ? `${s.method} ` : ''}${s.path}`;
  if (direct.length) lines.push(`- Surfaces in or right behind it: ${more(direct.map(name), 10)}`);
  if (indirect.length) lines.push(`- Surfaces that reach it: ${t.reaching} in all; nearest: ${indirect.slice(0, 10).map((s) => `${name(s)} (${s.steps} step${s.steps === 1 ? '' : 's'})`).join(', ')}`);
  if (t.messages.length) lines.push(`- Message keys used: ${more(t.messages, 10)}`);
  for (const r of t.reuse) lines.push(`- Reuse candidate (${r.lines} lines, same shape): ${more(r.fns, 4)}`);
  return `${lines.join('\n')}\n`;
}
