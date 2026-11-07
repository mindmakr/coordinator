// The run's maps as data: a mind map (goal → units → behaviours → evidence),
// a flow map (stacking, linked issues and PRs, follow-ups, the critical path)
// and goal relevance. Built from the view model (lib/view.mjs) only, never
// from files, so it reads whatever the state store gives the view. Pure: the
// pictures are drawn by lib/mapsvg.mjs; the heatmaps are in lib/heat.mjs.
import { REPO, webUrl } from './links.mjs';

const MIN = 60_000;
const DEFAULT_MINUTES = 30;
const EVIDENCE_MAX = 6; // per parent in the mind map; the rest is counted

// A GitHub issue or pull URL as { key, repo, n, kind }, else null. #n names an issue and a PR alike.
export function ghRef(url) {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)\/?(?:[#?].*)?$/.exec(webUrl(url) ?? '');
  if (!m || !REPO.test(m[1])) return null;
  return { key: `${m[1].toLowerCase()}#${m[3]}`, repo: m[1], n: m[3], kind: m[2] === 'pull' ? 'pr' : 'issue', url: `https://github.com/${m[1]}/${m[2]}/${m[3]}` };
}

// GitHub references in a text: URLs, owner/repo#n, and #n against the run's repo.
export function refsIn(text, repo) {
  const out = []; const s = String(text ?? '');
  for (const m of s.matchAll(/https:\/\/github\.com\/[^\s<>"'`)]+/g)) { const r = ghRef(m[0]); if (r) out.push(r); }
  for (const m of s.matchAll(/(?<![\w/.-])([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})?#(\d{1,7})\b/g)) {
    const r = m[1] ?? repo;
    if (r && REPO.test(r) && !(m.index > 0 && s[m.index - 1] === '/')) out.push(ghRef(`https://github.com/${r}/issues/${m[2]}`));
  }
  const seen = new Set();
  return out.filter((r) => r && !seen.has(r.key) && seen.add(r.key));
}

// Every GitHub issue or PR a unit links to (its --link and each `link`).
export const unitRefs = (u) => [u.link, ...(u.links ?? []).map((l) => l.url)].map(ghRef).filter(Boolean);

const FINISHED = ['pass', 'stopped'];
const WORK = /^(start|beat|built|strategy|reset|verdict )/;

// Minutes a unit has worked: its first start (or first work event) to its last verdict, or to now while it runs.
export function spent(u, nowMs) {
  const work = (u.timeline ?? []).filter((e) => WORK.test(e.label));
  if (!work.length) return 0;
  const from = Date.parse(work[0].at);
  const to = FINISHED.includes(u.status) || !['building', 'judging'].includes(u.status) ? Date.parse(work.at(-1).at) : nowMs;
  return Math.max(0, Math.round((to - from) / MIN));
}

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

// The chain of stacked units (--after) with the most work in it. A finished unit
// weighs the minutes it took; an unfinished one the median a finished unit took
// (30 if none), or its minutes so far once past that: spent + max(0, median − spent).
// Each unit stacks on at most one other, so every chain is a walk back through `after`.
// With no stacking there is no path (stacked: false): every unit can run at once.
export function criticalPath(units, nowMs = Date.now()) {
  if (!units.length) return { path: [], minutes: 0, left: 0, estimate: DEFAULT_MINUTES, stacked: false };
  const byId = new Map(units.map((u) => [u.id, u]));
  const estimate = Math.round(median(units.filter((u) => FINISHED.includes(u.status)).map((u) => spent(u, nowMs)).filter((m) => m > 0)) ?? DEFAULT_MINUTES);
  const weight = (u) => { const s = spent(u, nowMs); return FINISHED.includes(u.status) ? s : s + Math.max(0, estimate - s); };
  if (!units.some((u) => u.after && byId.has(u.after) && u.after !== u.id)) return { path: [], minutes: 0, left: 0, estimate, stacked: false };
  const chain = (u) => { const out = []; const seen = new Set(); for (let c = u; c && !seen.has(c.id); c = byId.get(c.after)) { seen.add(c.id); out.unshift(c); } return out; };
  let best = null;
  for (const u of units) {
    const c = chain(u);
    const w = c.reduce((n, x) => n + weight(x), 0);
    if (!best || w > best.minutes || (w === best.minutes && c.length > best.path.length)) best = { path: c.map((x) => x.id), minutes: w, left: c.filter((x) => !FINISHED.includes(x.status)).length };
  }
  return { ...best, estimate, stacked: true };
}

// Goal at the centre, then units, behaviours and evidence. Evidence hangs off its behaviour, else its unit.
export function mindGraph(v) {
  const g = v.goalCheck;
  const nodes = [{ id: 'goal', kind: 'goal', label: 'Goal', status: g.met ? 'met' : 'not-yet', text: v.goal, parent: null }];
  const edges = [];
  const add = (n) => { nodes.push(n); edges.push({ from: n.parent, to: n.id }); };
  for (const u of v.units) {
    const uid = `u:${u.id}`;
    add({ id: uid, kind: 'unit', unit: u.id, label: u.id, status: u.dot, text: u.title ?? u.bar ?? '', parent: 'goal' });
    for (const b of u.behaviours) add({ id: `b:${u.id}:${b.id}`, kind: 'behaviour', unit: u.id, label: b.id, status: b.status, text: b.text, parent: uid });
    const groups = new Map();
    for (const e of u.evidenceItems) {
      const parent = e.behaviour && u.behaviours.some((b) => b.id === e.behaviour) ? `b:${u.id}:${e.behaviour}` : uid;
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(e);
    }
    for (const [parent, list] of groups) {
      list.slice(0, EVIDENCE_MAX).forEach((e) => add({ id: `e:${u.id}:${e.id}`, kind: 'evidence', unit: u.id, label: e.kind, status: 'evidence', text: e.label ?? e.text ?? e.url ?? e.file ?? '', url: e.url ?? null, file: e.file ?? null, parent }));
      if (list.length > EVIDENCE_MAX) add({ id: `e:${u.id}:more:${parent}`, kind: 'more', unit: u.id, label: `+${list.length - EVIDENCE_MAX}`, status: 'evidence', text: `${list.length - EVIDENCE_MAX} more evidence items`, parent });
    }
  }
  return { nodes, edges };
}

// Units in layers by stacking depth, the GitHub issues and PRs they link (one
// node per issue, so a shared issue shows), and follow-ups attached to the unit
// they name (its id, its note's unit, or an issue it links).
export function flowGraph(v, nowMs = Date.now()) {
  const byId = new Map(v.units.map((u) => [u.id, u]));
  const depth = new Map();
  const depthOf = (u, seen = new Set()) => {
    if (depth.has(u.id)) return depth.get(u.id);
    const up = byId.get(u.after);
    const d = up && !seen.has(up.id) ? depthOf(up, new Set([...seen, u.id])) + 1 : 0;
    depth.set(u.id, d);
    return d;
  };
  const crit = criticalPath(v.units, nowMs);
  const onPath = new Set(crit.path);
  const nodes = []; const edges = [];
  for (const u of v.units) nodes.push({ id: `u:${u.id}`, kind: 'unit', unit: u.id, label: u.id, title: u.title ?? '', status: u.dot, depth: depthOf(u), crit: onPath.has(u.id) });
  for (const u of v.units) {
    const up = byId.get(u.after);
    if (up) edges.push({ from: `u:${up.id}`, to: `u:${u.id}`, kind: 'after', crit: onPath.has(u.id) && onPath.has(up.id) });
  }
  const refs = new Map();
  for (const u of v.units) {
    for (const r of unitRefs(u)) {
      if (!refs.has(r.key)) refs.set(r.key, { ...r, units: [] });
      const node = refs.get(r.key);
      if (r.kind === 'pr') node.kind = 'pr';
      if (!node.units.includes(u.id)) { node.units.push(u.id); edges.push({ from: `u:${u.id}`, to: `r:${r.key}`, kind: 'link', crit: false }); }
    }
  }
  // Other runs that hold the same work (#36): the run a unit continues, and the run that continued it.
  const others = new Map();
  for (const u of v.units) for (const [dir, list] of [['before', u.chain?.before ?? []], ['after', u.chain?.after ?? []]]) for (const l of list) {
    const id = `c:${l.run}`;
    if (!others.has(id)) others.set(id, { id, kind: 'run', run: l.run, label: l.run, known: l.known, units: [], says: [] });
    const node = others.get(id);
    if (!node.units.includes(u.id)) node.units.push(u.id);
    node.says.push(`${dir === 'before' ? `${u.id} continues it` : `${u.id} continued in it`}${l.known ? ` (${l.rounds.length} ${l.rounds.length === 1 ? 'try' : 'tries'}, ${l.status})` : ''}`);
    edges.push({ from: `u:${u.id}`, to: id, kind: 'chain', dir, crit: false });
  }
  nodes.push(...others.values());
  const home = (v.repo ?? '').toLowerCase();
  for (const r of refs.values()) nodes.push({ id: `r:${r.key}`, kind: r.kind, label: r.repo.toLowerCase() === home ? `#${r.n}` : `${r.repo.split('/')[1]}#${r.n}`, repo: r.repo, url: r.url, cross: !!home && r.repo.toLowerCase() !== home, units: r.units });
  (v.followUpNotes ?? []).forEach((f, i) => {
    const found = refsIn(f.text, v.repo);
    const keys = new Set(found.map((r) => r.key));
    const units = v.units.filter((u) => u.id === f.unit || new RegExp(`(^|[^\\w-])${u.id.replace(/[.]/g, '\\.')}([^\\w-]|$)`).test(f.text) || unitRefs(u).some((r) => keys.has(r.key))).map((u) => u.id);
    nodes.push({ id: `f:${i}`, kind: 'follow-up', label: `follow-up ${i + 1}`, text: f.text, url: found[0]?.url ?? null, units });
    for (const id of units) edges.push({ from: `u:${id}`, to: `f:${i}`, kind: 'follow-up', crit: false });
  });
  return { nodes, edges, critical: crit };
}

const STOP = new Set('the and for with from that this into when then than they them their its are was were has have had not but all any can each per via one two our out use used uses should will would must given which what who how why also more most only over under after before about across where while shows show run runs unit units page pages'.split(' '));
export const words = (t) => new Set(String(t ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').match(/[\p{L}\p{N}]{3,}/gu)?.filter((w) => !STOP.has(w)) ?? []);
// Shared words over the smaller set; three shared words at least.
export function overlap(a, b) {
  const A = words(a); const B = words(b);
  const shared = [...A].filter((w) => B.has(w)).length;
  return shared >= 3 ? shared / Math.min(A.size, B.size) : 0;
}
const INFERRED = 0.2;

// Which of the goal's behaviours each unit serves: named (the unit's bar, title
// or behaviours name the behaviour's id; or, with no goal behaviours, the goal
// names the unit or an issue it links) or inferred (shared words). A unit that
// serves none is off goal.
export function relevance(v) {
  const gb = v.goalCheck.behaviours;
  const targets = gb.length ? gb.map((b) => ({ id: b.id, label: b.id, text: b.text, status: b.status })) : [{ id: 'goal', label: 'Goal', text: v.goal, status: v.goalCheck.met ? 'met' : 'not-yet' }];
  const goalRefs = new Set(refsIn(v.goal, v.repo).map((r) => r.key));
  const units = v.units.map((u) => {
    const text = [u.title, u.bar, ...u.behaviours.map((b) => b.text)].filter(Boolean).join(' \n');
    const serves = [];
    for (const t of targets) {
      const named = gb.length
        ? new RegExp(`\\b${t.id}\\b`).test(text)
        : new RegExp(`(^|[^\\w-])${u.id.replace(/[.]/g, '\\.')}([^\\w-]|$)`).test(v.goal) || unitRefs(u).some((r) => goalRefs.has(r.key)) || refsIn(text, v.repo).some((r) => goalRefs.has(r.key));
      const score = overlap(text, t.text);
      if (named) serves.push({ target: t.id, how: 'named', score: 1 });
      else if (score >= INFERRED) serves.push({ target: t.id, how: 'inferred', score: Math.round(score * 100) / 100 });
    }
    const distance = serves.some((s) => s.how === 'named') ? 0 : serves.length ? 1 : null;
    return { unit: u.id, title: u.title ?? '', status: u.dot, serves, distance, off: distance === null };
  });
  return { targets, units, off: units.filter((u) => u.off).map((u) => u.unit) };
}
