// The coordinator's view of itself, across every run in the state folder: how
// old it is, what it learned, what it remembers, how well it works, what it
// did, what it is doing, what it proposes and what it studied. Pure: the CLI
// (lib/selfdata.mjs) loads the inputs; `run.mjs self` and the /coordinator
// page both read this one model.
import { answerText, questions } from './questions.mjs';
import { decide, stats } from './rules.mjs';
import { clip } from './plain.mjs';

const MINUTE = 60_000;
export const STUDY_AREAS = ['security', 'design', 'stack', 'other'];
export const DEFAULT_STUDY_BUDGET = 2;
export const studyCap = (run) => run.budget?.maxStudies ?? DEFAULT_STUDY_BUDGET;

const round1 = (n) => Math.round(n * 10) / 10;
const pctOf = (a, b) => (b ? Math.round((a / b) * 100) : null);
function quantile(sorted, p) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null;
}

// Every timestamp the run holds: its last one is when it last did anything.
function lastActivity(run) {
  const at = [run.createdAt, run.closed?.at, ...(run.notes ?? []).map((n) => n.at), ...(run.integration?.rounds ?? []).map((r) => r.at), ...(run.studies ?? []).map((s) => s.at)];
  for (const u of run.units) at.push(...u.rounds.map((r) => r.at), ...(u.log ?? []).map((e) => e.at), u.heartbeatAt);
  return at.filter(Boolean).sort().at(-1);
}

// Minutes a finished unit took: from its first start (else the run's start) to its last verdict.
function unitMinutes(run, u) {
  const end = u.rounds.at(-1)?.at;
  if (!end || !['pass', 'stopped'].includes(u.status)) return null;
  const start = (u.log ?? []).find((e) => e.kind === 'start')?.at ?? run.createdAt;
  const m = (Date.parse(end) - Date.parse(start)) / MINUTE;
  return m >= 0 ? m : null;
}

function runStats(run) {
  const finished = run.units.filter((u) => ['pass', 'stopped'].includes(u.status));
  const passed = run.units.filter((u) => u.status === 'pass');
  const rounds = passed.map((u) => u.rounds.length).sort((a, b) => a - b);
  const mins = finished.map((u) => unitMinutes(run, u)).filter((m) => m !== null).sort((a, b) => a - b);
  return {
    run: run.id, at: run.createdAt, units: run.units.length, finished: finished.length, passed: passed.length,
    passRate: pctOf(passed.length, finished.length), medianRounds: quantile(rounds, 0.5),
    minutesPerUnit: mins.length ? Math.round(quantile(mins, 0.5)) : null,
  };
}

// The same figures as `run.mjs stats` (closed runs only; stopped share over all their units).
function closedStats(runs) {
  const s = stats(runs);
  const finished = runs.flatMap((r) => r.units.filter((u) => ['pass', 'stopped'].includes(u.status)));
  return {
    runs: s.runs, units: s.units, passRate: pctOf(finished.filter((u) => u.status === 'pass').length, finished.length),
    medianRoundsToPass: s.medianRoundsToPass, p80RoundsToPass: s.p80RoundsToPass,
    stoppedShare: s.stoppedShare === null ? null : Math.round(s.stoppedShare * 100),
  };
}

// Who or what each unfinished unit waits on, in words.
function waitsOn(d, u, openQs) {
  if (openQs.some((q) => q.unit === u.id)) return 'you (a question)';
  switch (d.action) {
    case 'wait': return d.reason?.startsWith('after ') ? d.reason.slice(6) : 'its builder';
    case 'judge': return 'a critic';
    case 'build': return 'the lead (send a builder)';
    case 'change-strategy': return 'the lead (a new approach)';
    case 'check-stale': return 'the lead (a quiet agent)';
    default: return 'the lead';
  }
}

function plan(run, nowMs) {
  const p = decide(run, nowMs);
  const qs = questions(run).filter((q) => q.open);
  const left = run.units.filter((u) => !['pass', 'stopped'].includes(u.status));
  const byId = new Map(p.units.map((d) => [d.id, d]));
  return {
    run: run.id, tag: run.tag, decision: p.decision, goal: clip(run.goal, 200),
    done: run.units.length - left.length, total: run.units.length,
    next: p.units.filter((d) => ['build', 'judge', 'change-strategy', 'check-stale'].includes(d.action)).map((d) => `${d.action} ${d.id}`),
    left: left.map((u) => ({ id: u.id, title: u.title ?? null, status: u.status, waitsOn: waitsOn(byId.get(u.id) ?? {}, u, qs) })),
    needsYou: qs.map((q) => ({ id: q.id, text: clip(q.header || q.text, 140) })),
  };
}

// A follow-up or retro note that names the skill itself (or links its repo) is an upstream proposal.
const UPSTREAM = /^\s*upstream\s*:|github\.com\/mindmakr\/coordinator\b|mindmakr\/coordinator#\d/i;

function proposals(runs, lessons) {
  const out = [];
  for (const run of runs) for (const n of run.notes ?? []) {
    if (!['follow-up', 'retro'].includes(n.kind)) continue;
    out.push({ kind: UPSTREAM.test(n.text) ? 'upstream' : n.kind, text: n.text, run: run.id, at: n.at });
  }
  for (const l of lessons.filter((x) => x.seen >= 3)) {
    out.push({ kind: 'promote', text: `Promote lesson ${l.id} into the references: ${l.text}`, run: l.from?.at(-1) ?? null, at: l.lastAt });
  }
  return out.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
}

// Lessons from both scopes, one entry per id (the project's copy wins), best first.
function mergeLessons(global = [], project = []) {
  const all = new Map();
  for (const [scope, list] of [['global', global], ['project', project]]) for (const l of list ?? []) {
    if (!l || typeof l.id !== 'string') continue;
    all.set(l.id, { id: l.id, tag: l.tag ?? 'general', text: String(l.text ?? ''), seen: l.seen ?? 1, used: l.used ?? 0, promote: (l.seen ?? 1) >= 3, from: l.from ?? [], sources: l.sources ?? [], firstAt: l.firstAt ?? null, lastAt: l.lastAt ?? null, scope });
  }
  return [...all.values()].sort((a, b) => (b.seen * 2 + b.used) - (a.seen * 2 + a.used) || String(b.lastAt).localeCompare(String(a.lastAt)));
}

// COORDINATOR.md as sections of one-line facts; `Theme:` and other loose lines go under "Other".
export function parseContext(md) {
  if (typeof md !== 'string' || !md.trim()) return [];
  const out = []; let cur = null;
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^##\s+(.+)$/.exec(line);
    if (h) { cur = { title: h[1].trim(), facts: [] }; out.push(cur); continue; }
    if (!line || line.startsWith('#') || line.startsWith('```')) continue;
    if (!cur) continue; // the intro above the first section
    cur.facts.push(line.replace(/^[-*]\s+/, ''));
  }
  return out.filter((s) => s.facts.length);
}

// The person's decisions: their answers, and the lead's decision notes that close a question.
function decisions(runs) {
  const out = [];
  for (const run of runs) {
    for (const q of questions(run)) {
      if (q.answer?.by === 'person') out.push({ run: run.id, id: q.id, question: clip(q.header ? `${q.header}: ${q.text}` : q.text, 200), answer: answerText(q.answer), at: q.answer.at });
    }
    for (const n of run.notes ?? []) {
      if (n.kind === 'decision' && n.answers) out.push({ run: run.id, id: n.answers, question: null, answer: n.text, at: n.at });
    }
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/**
 * runs: every readable state; lessons: { global, project }; context: COORDINATOR.md text or null;
 * current: the run being served (or null). Returns the page and text model.
 */
export function selfModel({ runs, lessons = {}, context = null, current = null, nowMs = Date.now() }) {
  const sorted = [...runs].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const units = sorted.reduce((n, r) => n + r.units.length, 0);
  const minutes = sorted.reduce((n, r) => {
    const end = r.closed ? Date.parse(r.closed.at) : Date.parse(lastActivity(r) ?? r.createdAt);
    return n + Math.max(0, (end - Date.parse(r.createdAt)) / MINUTE);
  }, 0);
  const all = mergeLessons(lessons.global, lessons.project);
  const s = stats(sorted);
  const perRun = sorted.map(runStats);
  const finishedUnits = sorted.flatMap((r) => r.units.filter((u) => ['pass', 'stopped'].includes(u.status)));
  const mins = sorted.flatMap((r) => r.units.map((u) => unitMinutes(r, u))).filter((m) => m !== null).sort((a, b) => a - b);
  const ids = new Set(sorted.map((r) => r.id));
  return {
    current,
    runIds: [...ids],
    age: {
      firstRun: sorted[0]?.createdAt ?? null, firstRunId: sorted[0]?.id ?? null,
      runs: sorted.length, open: sorted.filter((r) => !r.closed).length, units, hours: round1(minutes / 60),
    },
    learning: { lessons: all, promoted: all.filter((l) => l.promote).length, tags: [...new Set(all.map((l) => l.tag))].sort() },
    memory: {
      context: parseContext(context), hasContext: typeof context === 'string' && !!context.trim(),
      decisions: decisions(sorted),
    },
    stats: {
      units: finishedUnits.length,
      passRate: pctOf(finishedUnits.filter((u) => u.status === 'pass').length, finishedUnits.length),
      medianRoundsToPass: s.medianRoundsToPass, p80RoundsToPass: s.p80RoundsToPass,
      stoppedShare: pctOf(finishedUnits.filter((u) => u.status === 'stopped').length, finishedUnits.length),
      minutesPerUnit: mins.length ? Math.round(quantile(mins, 0.5)) : null,
      suggestedMaxRounds: s.suggestedMaxRounds,
      trend: perRun.filter((r) => r.finished),
      // The figures above count every run, open ones included; `run.mjs stats` counts closed runs only.
      basis: 'all runs, open included',
      closed: closedStats(sorted.filter((r) => r.closed)),
    },
    history: sorted.filter((r) => r.closed).reverse().map((r) => ({
      run: r.id, tag: r.tag, outcome: r.closed.outcome, started: r.createdAt, closed: r.closed.at, goal: clip(r.goal, 160),
      passed: r.units.filter((u) => u.status === 'pass').length, stopped: r.units.filter((u) => u.status === 'stopped').length, units: r.units.length,
    })),
    plans: sorted.filter((r) => !r.closed).reverse().map((r) => plan(r, nowMs)),
    proposals: proposals(sorted, all),
    study: {
      runs: sorted.filter((r) => (r.studies ?? []).length || !r.closed).map((r) => ({ run: r.id, used: (r.studies ?? []).length, cap: studyCap(r), open: !r.closed })),
      log: sorted.flatMap((r) => (r.studies ?? []).map((x) => ({ ...x, run: r.id }))).sort((a, b) => String(b.at).localeCompare(String(a.at))),
    },
  };
}

export const count = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
const n = (v, unit = '') => (v === null || v === undefined ? '–' : `${v}${unit}`);
const day = (iso) => (iso ? iso.slice(0, 16).replace('T', ' ') : '–');

// `run.mjs self`: the same model as a few lines per section.
export function selfText(m) {
  const L = [];
  const a = m.age;
  L.push(`coordinator · ${count(a.runs, 'run')} (${a.open} open) · ${count(a.units, 'unit')} · ${a.hours} h · first run ${day(a.firstRun)}${a.firstRunId ? ` (${a.firstRunId})` : ''}`);
  const st = m.stats;
  L.push('', `stats     pass rate ${n(st.passRate, '%')} · rounds to pass median ${n(st.medianRoundsToPass)}, p80 ${n(st.p80RoundsToPass)} · stopped ${n(st.stoppedShare, '%')} · ${n(st.minutesPerUnit, ' min')} per unit (median) · ${count(st.units, 'finished unit')} (${st.basis})`);
  const c = st.closed;
  L.push(`closed    ${c.runs ? `pass rate ${n(c.passRate, '%')} · rounds to pass median ${n(c.medianRoundsToPass)}, p80 ${n(c.p80RoundsToPass)} · stopped ${n(c.stoppedShare, '%')} · ${count(c.units, 'unit')} in ${count(c.runs, 'closed run')} (as run.mjs stats)` : 'no closed run yet (run.mjs stats counts closed runs only)'}`);
  if (st.trend.length) L.push(`trend     ${st.trend.map((r) => `${r.run} ${n(r.passRate, '%')}`).join(' → ')}`);
  L.push('', `learning  ${count(m.learning.lessons.length, 'lesson')} · ${m.learning.promoted} ready to promote${m.learning.tags.length ? ` · tags ${m.learning.tags.join(', ')}` : ''}`);
  for (const l of m.learning.lessons.slice(0, 8)) L.push(`  ${l.id} [${l.tag}] seen ${l.seen} used ${l.used}${l.promote ? ' PROMOTE' : ''}  ${clip(l.text, 110)}${l.from.length ? ` (from ${l.from.join(', ')})` : ''}${l.sources.length ? ` ${l.sources[0]}` : ''}`);
  L.push('', `memory    ${m.memory.decisions.length ? `${count(m.memory.decisions.length, 'decision')} of yours · ` : ''}${m.memory.hasContext ? `COORDINATOR.md: ${m.memory.context.map((s) => `${s.title} ${s.facts.length}`).join(' · ')}` : 'no COORDINATOR.md (run init)'}`);
  for (const d of m.memory.decisions.slice(0, 5)) L.push(`  ${d.run} ${d.id}: ${clip(d.answer, 120)}`);
  L.push('', `plans     ${m.plans.length ? count(m.plans.length, 'open run') : 'no open run'}`);
  for (const p of m.plans) {
    L.push(`  ${p.run} [${p.decision}] ${p.done}/${p.total} done${p.next.length ? ` · next ${p.next.join(', ')}` : ''}${p.needsYou.length ? ` · needs you ${p.needsYou.map((q) => q.id).join(', ')}` : ''}`);
    for (const u of p.left) L.push(`    ${u.id} ${u.status} · waits on ${u.waitsOn}`);
  }
  L.push('', `history   ${m.history.length ? count(m.history.length, 'closed run') : 'no closed run'}`);
  for (const h of m.history.slice(0, 10)) L.push(`  ${h.run} ${h.outcome} · ${h.passed}/${h.units} passed${h.stopped ? `, ${h.stopped} stopped` : ''} · ${day(h.started)} → ${day(h.closed)}`);
  L.push('', `proposals ${m.proposals.length}`);
  for (const p of m.proposals.slice(0, 8)) L.push(`  [${p.kind}] ${clip(p.text, 130)}${p.run ? ` (${p.run})` : ''}`);
  L.push('', `study     ${count(m.study.log.length, 'study', 'studies')}${m.study.runs.filter((r) => r.open).map((r) => ` · ${r.run} ${r.used}/${r.cap}`).join('')}`);
  for (const x of m.study.log.slice(0, 5)) L.push(`  ${x.run} [${x.area}] ${clip(x.topic, 80)}: ${clip(x.text, 100)}`);
  return `${L.join('\n')}\n`;
}
