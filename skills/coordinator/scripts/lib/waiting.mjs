// What waits on the person, across every run in the register (lib/registry.mjs), for the PC
// dashboard's "Waiting on you" and `run.mjs waiting` (design one-boss 5.5). Built from state on
// disk only: the registered runs and the last stored doctor result (lib/doctorrecord.mjs). No network.
// Each rule is the one its own module owns; nothing here matches text of its own:
//   question  an open question, with its label (lib/questions.mjs)
//   upstream  upstream proposals not yet filed, one item per run (lib/gaps.mjs, kind upstream, open)
//   unclosed  every unit decided, the run not closed, with a stopped unit or a final check not passed
//             (lib/progress.mjs isFinishing); says when its retro is pending too
//   retro     every unit decided, the run not closed, its retro pending (lib/retro.mjs retroPending)
//   paused    a run paused by hand (lib/pause.mjs openPause)
//   plugin    the last online doctor check found a newer release than the skill that runs now
// Each item: { kind, what, project, key, run, name, text, since, link, fix?, label?, items? }.
// since: an ISO time (how long it has waited); link: a path on the PC dashboard, or null.
import { ageText } from './age.mjs';
import { loadRun } from './events.mjs';
import { join } from 'node:path';
import { newer, readDoctorRecord, semver } from './doctorrecord.mjs';
import { gaps } from './gaps.mjs';
import { needsAnchor } from './pcanswer.mjs';
import { openPause, resumeStep } from './pause.mjs';
import { clip } from './plain.mjs';
import { isFinishing } from './progress.mjs';
import { projectName, questions, runName } from './questions.mjs';
import { byProject, registryHome } from './registry.mjs';
import { retroCommand, retroPending } from './retro.mjs';
import { decide } from './rules.mjs';
import { VERSION } from './version.mjs';

export const WHAT = { question: 'open question', upstream: 'upstream proposals not filed', unclosed: 'finished, not closed', retro: 'retro pending', paused: 'paused', plugin: 'plugin out of date' };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const valid = (iso) => typeof iso === 'string' && !Number.isNaN(Date.parse(iso));
const runPath = (key, run, sub = '') => `/p/${key}/run/${encodeURIComponent(run)}${sub}`;

// When the run's last unit or final check was decided: the latest time its units and integration logged.
export function lastDecidedAt(run) {
  const times = [
    ...(run.units ?? []).flatMap((u) => [...(u.rounds ?? []), ...(u.log ?? [])].map((x) => x?.at)),
    ...(run.integration?.rounds ?? []).map((r) => r?.at),
  ].filter(valid);
  return times.length ? times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : (valid(run.createdAt) ? run.createdAt : null);
}

// Why a finishing run is not closed: its stopped units, then its final check. Null when neither holds.
function unclosedCause(run) {
  const stopped = run.units.filter((u) => u.status === 'stopped').map((u) => u.id);
  const last = run.integration?.rounds?.at(-1);
  const check = !last ? 'the final check has not run' : last.verdict !== 'pass' ? 'the final check failed' : null;
  if (!stopped.length && !check) return null;
  return [stopped.length ? `${plural(stopped.length, 'unit')} stopped (${stopped.join(', ')})` : null, check].filter(Boolean).join('; ');
}

function runItems(p, s, nowMs, out) {
  const base = { project: p.name, key: p.key, run: s.id, name: runName(s) || null };
  if (!s.closed) {
    for (const q of questions(s, { project: p.name }).filter((x) => x.open)) {
      out.push({ ...base, kind: 'question', what: WHAT.question, label: q.label, text: clip(`${q.id} ${q.header ? `${q.header}: ` : ''}${q.text}`, 200), since: valid(q.at) ? q.at : null, link: `/#${needsAnchor(p.key, s.id)}` });
    }
    const pause = openPause(s);
    if (pause) out.push({ ...base, kind: 'paused', what: WHAT.paused, text: `paused${pause.reason ? `: ${clip(pause.reason, 160)}` : ''}`, since: valid(pause.from) ? pause.from : null, link: runPath(p.key, s.id), fix: resumeStep(s) });
    const plan = decide(s, nowMs);
    const retro = retroPending(s, plan.decision);
    const cause = isFinishing(s, plan) ? unclosedCause(s) : null;
    if (cause) {
      out.push({ ...base, kind: 'unclosed', what: WHAT.unclosed, text: `every unit decided, not closed: ${cause}${retro ? '; retro pending' : ''}`, since: lastDecidedAt(s), link: runPath(p.key, s.id), fix: retro ? `${retroCommand(s)}, then close` : `run.mjs close ${s.id} --outcome …` });
    } else if (retro) {
      out.push({ ...base, kind: 'retro', what: WHAT.retro, text: 'every unit decided; the run waits on its retro to close', since: lastDecidedAt(s), link: runPath(p.key, s.id, '/retro'), fix: retroCommand(s) });
    }
  }
}

// Upstream proposals not filed (lib/gaps.mjs), one item per run, oldest proposal's time as since.
function upstreamItems(p, out) {
  let all = [];
  try { all = gaps(p.runs); } catch { return; }
  const byRun = new Map();
  for (const g of all.filter((x) => x.kind === 'upstream' && x.status === 'open')) {
    if (!byRun.has(g.run)) byRun.set(g.run, []);
    byRun.get(g.run).push(g);
  }
  for (const [id, list] of byRun) {
    const s = p.runs.find((r) => r.id === id);
    const times = list.map((g) => g.at).filter(valid).sort((a, b) => Date.parse(a) - Date.parse(b));
    out.push({
      project: p.name, key: p.key, run: id, name: s ? runName(s) || null : null, kind: 'upstream', what: WHAT.upstream,
      text: `${plural(list.length, 'upstream proposal')} not filed: ${clip(list[0].text.replace(/\s+/g, ' '), 140)}${list.length > 1 ? ` (and ${list.length - 1} more)` : ''}`,
      items: list.map((g) => ({ id: g.id, text: clip(g.text.replace(/\s+/g, ' '), 300) })),
      since: times[0] ?? null, link: runPath(p.key, id, '/retro'), fix: 'file them upstream (references/upstream.md), then note "filed upstream: <links>" on the run',
    });
  }
}

/**
 * Pure: what waits on the person. projects: [{ key, name, runs: [run state] }] (the registered runs
 * of each project, read); doctor: the stored check ({ checkedAt, mine, latest }) or null; version: the
 * skill that runs now (a check older than an update is not an item). Oldest first; no time last.
 */
export function waitingFrom(projects, { doctor = null, version = VERSION, nowMs = Date.now() } = {}) {
  const out = [];
  for (const p of projects) {
    for (const s of p.runs) { try { runItems(p, s, nowMs, out); } catch { /* an unreadable shape: the run list says so */ } }
    upstreamItems(p, out);
  }
  const latest = semver(doctor?.latest);
  if (latest.length === 3 && newer(latest, semver(doctor.mine)) && (semver(version).length !== 3 || newer(latest, semver(version)))) {
    out.push({ project: null, key: null, run: null, name: null, kind: 'plugin', what: WHAT.plugin, text: `the coordinator plugin is ${doctor.mine}; ${doctor.latest} is out (doctor, ${doctor.checkedAt.slice(0, 10)})`, since: doctor.checkedAt, link: null, fix: 'update the plugin (/plugin in Claude Code), or git pull your skill copy' });
  }
  const t = (x) => (valid(x.since) ? Date.parse(x.since) : Infinity);
  return out.map((x, i) => [x, i]).sort((a, b) => t(a[0]) - t(b[0]) || a[1] - b[1]).map(([x]) => x);
}

// Reads the register's runs (entries: readRegistry()) and the stored doctor check, then waitingFrom.
export function waitingList(entries, { nowMs = Date.now(), home = registryHome(), load = loadRun, version = VERSION } = {}) {
  const projects = byProject(entries).map((g) => ({
    key: g.key, name: projectName(g.stateDir),
    runs: g.runs.map((e) => { try { const s = load(join(e.stateDir, 'runs', e.run)); return s && Array.isArray(s.units) ? s : null; } catch { return null; } }).filter(Boolean),
  }));
  return waitingFrom(projects, { doctor: readDoctorRecord(home), version, nowMs });
}

// `run.mjs waiting`: one line per item, oldest first, then the count.
export function waitingText(items, nowMs = Date.now()) {
  if (!items.length) return 'Nothing waits on you.\n';
  const lines = items.map((x) => {
    const where = x.run ? `${x.project} · ${x.name ? `${x.name} ` : ''}(${x.run})` : 'this PC';
    const ago = x.since ? `${ageText(nowMs - Date.parse(x.since))} ago` : 'since unknown';
    return `${ago.padEnd(14)} ${where}  [${x.what}] ${x.text}${x.fix ? `  → ${x.fix}` : ''}`;
  });
  return `${lines.join('\n')}\n${plural(items.length, 'item')} waiting on you\n`;
}
