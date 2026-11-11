// Reads the Markdown that reins saves for a session report (`reins_report`) or a before/after
// compare (`npx reins report --compare`): the title and the Findings, so a unit's page can show
// what reins measured without opening the file. Text in, plain data out: the coordinator stays
// dependency-free and never runs reins itself. https://github.com/mindmakr/reins
const MAX = 20;
const CUT = 300;
const clip = (s) => { const t = String(s).replace(/\s+/g, ' ').trim(); return t.length > CUT ? `${t.slice(0, CUT - 1)}…` : t; };
const bullets = (lines) => lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim());

// The lines under `heading`, up to the next heading of the same or a higher level; null without it.
function section(lines, heading, level) {
  const i = lines.findIndex((l) => l.trim() === heading);
  if (i < 0) return null;
  const stop = new RegExp(`^#{1,${level}} `);
  const out = [];
  for (const l of lines.slice(i + 1)) { if (stop.test(l)) break; out.push(l); }
  return out;
}

// { type: 'session', title, findings: [{ level: 'error'|'warn', text }], more }
// { type: 'compare', title, resolved: [text], added: [text], open: [text] }
// null when the text is not a reins report.
export function parseReinsReport(markdown) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const head = lines.find((l) => l.startsWith('# ')) ?? '';
  const found = section(lines, '## Findings', 2);
  if (!found) return null;
  const session = /^# reins session: (.+)$/.exec(head);
  if (session) {
    const all = bullets(found).filter((t) => !t.startsWith('✅'));
    const findings = all.slice(0, MAX).map((t) => ({ level: t.startsWith('❌') ? 'error' : 'warn', text: clip(t.replace(/^(?:❌|⚠️|⚠)\s*/u, '')) }));
    return { type: 'session', title: clip(session[1]), findings, more: Math.max(0, all.length - MAX) };
  }
  const compare = /^# reins compare: (.+)$/.exec(head);
  if (compare) {
    const part = (h) => bullets(section(found, h, 3) ?? []).filter((t) => t !== 'None.').slice(0, MAX).map(clip);
    return { type: 'compare', title: clip(compare[1]), resolved: part('### Resolved'), added: part('### New'), open: part('### Still open') };
  }
  return null;
}
