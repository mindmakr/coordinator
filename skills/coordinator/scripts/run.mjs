#!/usr/bin/env node
// The coordinator's run state: one JSON file per run, written only through here.
// Each step is refused unless the loop asked for it (see allows() in lib/rules.mjs).
//
//   run.mjs init <run> --goal G --bar B --fence F [--paths a,b] [--tag T] [--max-rounds 4]
//                      [--max-minutes 240] [--max-units 6] [--max-added 2] [--stale-minutes 45]
//                      [--repo owner/name] (resolves #123 and shas; else the project's git remote) [--theme file.css]
//                      [--study-budget 2] (side studies allowed while waiting, 0-10)
//   run.mjs add <run> <unit> --bar B [--after U] [--reason R] [--title T] [--link URL] [--specialist a,b] (critics that must also pass)
//                  [--issue owner/repo#n|URL …] [--pr …] [--behaviour "Given … when … then …" …]   (--reason required after freeze)
//   run.mjs behave <run> <unit>|--goal [--id B1] --text T | --id B1 --remove   add, reword (back to unchecked) or remove
//   run.mjs behaviours <run>        every behaviour of the goal and the units, with status and evidence
//   run.mjs evidence <run> <unit>|--goal [--behaviour B1] (--text T | --file path | --url U) --kind test|screenshot|log|link [--label L]
//   run.mjs link <run> <unit> [--issue … ] [--pr …] [--merge URL] [--url U --label L]   GitHub issues, PRs and merges for the unit
//   run.mjs freeze <run>
//   run.mjs start <run> <unit>      only when next says build, or check-stale with phase building
//   run.mjs beat <run> <unit> [--text T]     builder or critic still working (T: the milestone, e.g. "pushed")
//   run.mjs built <run> <unit> [--report R]  builder finished (R: its report in short): the unit waits for a critic
//   run.mjs reset <run> <unit> --reason R     in-progress unit with no artifact goes back to build (after a crash)
//   run.mjs verdict <run> <unit> pass|fail --evidence E [--gap G] [--cause C] --score 0-10   only after built;
//                  score and gap required on fail; cause is the critic's root-cause tag (drives same-gap);
//                  on a run with --paths, pass needs a clean detect.mjs --unit result;
//                  [--behaviour B1=pass:"evidence" | B1=fail:"gap" …]: a pass needs every behaviour passing
//                  [--critic SETUP] who judged (e.g. "review skill high + security"): stats groups escapes by it
//                  [--specialist NAME] a required second critic's verdict on this build (add --specialist a,b);
//                  the unit stays judging, and its pass is refused until every required specialist passed
//   run.mjs strategy <run> <unit> --text T                          only when next says change-strategy
//   run.mjs integrate <run> pass|fail --evidence E [--gap G] [--cause C] [--behaviour G1=pass:"…" …]
//                  only when next says integrate; a pass needs every goal behaviour passing
//   run.mjs note <run> --kind situation|decision|follow-up|retro|question|bar|info|person|escape --text T
//                  escape: --unit U, a passed unit where a defect turned up later (a later review, verify, test, a person); counted by stats
//                  [--recommend R] (question: the lead's pick) [--answers qN] (decision: closes question N)
//                  [--unit U] (person: a note from the person about one unit)
//   run.mjs brief <run> [<unit>] --role builder|critic|integrator [--quote file … --source label …] [--where W] [--playbook P]
//                  prints the brief; each quoted file is fenced as data, and the goal, bar and fence follow it
//   run.mjs ask <run> --question Q --header H --option "label|description" (2-4, recommended first) [--multi] [--unit U]
//   run.mjs answer <run> qN [--choice label …] [--other T] [--by person|lead]   changeable until used
//   run.mjs use-answer <run> qN     the lead acted on the answer: it can no longer change
//   run.mjs questions <run>         every question with its options, answer, history and status
//   run.mjs study <run> --topic T --area security|design|stack|other --text "what it learned" --source URL … [--lesson id …] [--by agent]
//                  one side study while the run waits (capped per run by --study-budget); lessons it added go in with lessons.mjs add --source
//   run.mjs self [--json] [--html]  the coordinator's own view across every run here (age, learning, memory, stats,
//                  history, plans, proposals, side study); --html writes coordinator.html in the state folder
//   run.mjs serve <run> [--port P]  the live dashboard (forms, unit pages, live updates) on 127.0.0.1, behind a per-start token;
//                  /maps the run's maps, /coordinator the self view, /run/<other> another run read-only
//   run.mjs watch <run> [--remote [--every S]]   one line per new or changed answer and per note from the person; never exits.
//                  --remote also pulls the run from its state branch every S seconds (10-60, default 30), and at once
//                  when the service's doorbell rings (COORDINATOR_SERVICE); lines starting "remote:" are about that link
//   run.mjs next <run>     prints what to do and records any stops
//   run.mjs show <run>     prints the compact text HUD (situation, needs you, time left, units, budget, next step)
//   run.mjs hud <run>      rewrites hud.html, maps.html and units/<unit>.html beside state.json now and prints its path
//                          (every change rewrites it too, with workbench.md)
//   run.mjs close <run> --outcome done|partial|stopped [--reason R]   reason required when closing before the rules end the run;
//                  warns when files the run mentions are not adopted yet
//   run.mjs adopt <run> [--dry-run]  copy files the run mentions by path (screenshots, PDFs, logs, json and md reports in
//                  worktrees or scratch folders) into the run folder as evidence, so deleting a worktree loses nothing
//   run.mjs map <run> [--root dir] [--max-seconds 60] [--unit U] [--fresh | --reset-stage] [--force] [--pit-stop [--dest dir]]
//                  the project map (modules, helpers, settings, surfaces, reuse) into the run's map/ and map.html;
//                  --fresh starts a new log (the old map/ is kept aside); --reset-stage also replaces the staged and pushed
//                  map history (a map.reset event push and pull accept); --force records a build cut short by the cap;
//                  --pit-stop stages the log and summary in the run's pit-stop/map (push carries them), or copies them to --dest
//   run.mjs touches <run> <path> [--json]   what that file touches, from the map, for a builder's brief
//   run.mjs list | stats [--tag T] | where      where prints the state folder for briefs (COORDINATOR_DIR)
//   run.mjs push <run> [--to branch|./folder] [--message M]   pit stops only (a unit merged, a decision
//                  recorded, the run closed): the run's events, snapshot and README, project lessons and
//                  stats, masked, to the coordinator-state branch (never main; a public repo needs a
//                  private companion repo, references/durability.md)
//   run.mjs pull <run> [--from branch|./folder]   restores the run on another machine, or appends the
//                  copy's newer events; never overwrites local events the copy lacks. After the lead's own
//                  later events, it replays the copy's extra answers and person notes (nothing else) on top
// Every change appends one event to the run's events.jsonl; state.json is a snapshot derived from it.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { num, oneOf, optText, parse, score, text } from './lib/args.mjs';
import { behave, mark, reopen } from './lib/behaviours.mjs';
import { addEvidence, artifact } from './lib/evidence.mjs';
import { adopt, table } from './lib/adopt.mjs';
import { homedir } from 'node:os';
import { buildBrief } from './lib/briefs.mjs';
import { allows, decide, decideUnit, stats } from './lib/rules.mjs';
import { EVENTS, loadRun, updateRun } from './lib/events.mjs';
import { pull, push } from './lib/statesync.mjs';
import { bellConfig, listen } from './lib/doorbell.mjs';
import { remoteWatch } from './lib/remote.mjs';
import { baseDir, isSafeId, projectDir, safeId, withLock, writeAtomic } from './lib/store.mjs';
import { hud, liveCtx, staticCtx } from './lib/hud.mjs';
import { githubRef, inferRepo, REPO, repoFromText, webUrl } from './lib/links.mjs';
import { readSettings } from './lib/settings.mjs';
import { load as loadTheme, themeFile } from './lib/theme.mjs';
import { log } from './lib/timeline.mjs';
import { unitPage } from './lib/unitpage.mjs';
import { mapsPage } from './lib/mapspage.mjs';
import { answer, ask, events, find, fromForm, personNote, questions, useAnswer } from './lib/questions.mjs';
import { serve } from './lib/serve.mjs';
import { selfModel, selfText } from './lib/self.mjs';
import { loadSelf, selfVersion } from './lib/selfdata.mjs';
import { selfPage } from './lib/selfpage.mjs';
import { addStudy } from './lib/study.mjs';
import { text as textView, view } from './lib/view.mjs';
import { render } from './lib/workbench.mjs';
import { build as buildMap, defaultDest, hasMap, mapAttach, mapHtml, mapNav, mapRestore, mapView, pitStop, touchesOf } from './lib/map/index.mjs';

const FLAGS = {
  init: ['goal', 'bar', 'fence', 'paths', 'tag', 'max-rounds', 'max-minutes', 'max-units', 'max-added', 'stale-minutes', 'repo', 'theme', 'study-budget'],
  study: ['topic', 'area', 'text', 'source', 'lesson', 'by'], self: ['json', 'html'],
  add: ['bar', 'after', 'reason', 'title', 'link', 'issue', 'pr', 'behaviour', 'specialist'], verdict: ['evidence', 'gap', 'cause', 'score', 'behaviour', 'critic', 'specialist'], strategy: ['text'],
  integrate: ['evidence', 'gap', 'cause', 'behaviour'], beat: ['text'], built: ['report'],
  behave: ['goal', 'id', 'text', 'remove', 'reason'], evidence: ['goal', 'behaviour', 'text', 'file', 'url', 'kind', 'label'],
  link: ['issue', 'pr', 'merge', 'url', 'label'], note: ['kind', 'text', 'recommend', 'answers', 'unit'],
  ask: ['question', 'header', 'option', 'multi', 'unit'], answer: ['choice', 'other', 'by'], serve: ['port'], watch: ['remote', 'every'], map: ['root', 'max-seconds', 'unit', 'pit-stop', 'dest', 'fresh', 'force', 'reset-stage'], touches: ['json'], close: ['outcome', 'reason'], adopt: ['dry-run'], stats: ['tag'], reset: ['reason'],
  brief: ['role', 'quote', 'source', 'where', 'playbook'],
  push: ['to', 'message'], pull: ['from'],
};
const REPEAT = { study: ['source', 'lesson'], ask: ['option'], answer: ['choice'], add: ['behaviour', 'issue', 'pr'], verdict: ['behaviour'], integrate: ['behaviour'], link: ['issue', 'pr', 'merge'], brief: ['quote', 'source'] };

// Stops cascade (a stopped unit stops the units stacked on it): apply until nothing changes.
function applyStops(st) {
  const stopped = new Map();
  for (let changed = true; changed;) {
    changed = false;
    for (const u of decide(st).units) if (u.action === 'stop') {
      const unit = st.units.find((x) => x.id === u.id); unit.status = 'stopped'; unit.stopReason = u.reason; log(unit, 'stop', u.reason);
      stopped.set(u.id, u); changed = true;
    }
  }
  return stopped;
}

const runsDir = () => join(baseDir('project'), 'runs');
const stateFile = (run) => join(runsDir(), safeId(run, 'run'), 'state.json');
const now = () => new Date().toISOString();
const hudFile = (run) => join(runsDir(), safeId(run, 'run'), 'hud.html');

const runDir = (run) => join(runsDir(), safeId(run, 'run'));
// The run's repo: --repo, else the project's GitHub remote, else the GitHub links already in the state.
const repoFor = (s) => s.repo ?? inferRepo(projectDir()) ?? repoFromText(JSON.stringify(s));
// Settings from .coordinator/coordinator.json; a broken file means defaults here (doctor reports it).
const asArg = (v) => (Number.isInteger(v) ? String(v) : undefined);
const settings = () => readSettings(baseDir('project')).settings;
const themeFor = (s) => { const t = settings().theme; return loadTheme(themeFile(s, projectDir()) ?? (typeof t === 'string' && t ? resolve(projectDir(), t) : null)); };

// The files people read: rewritten inside the state's lock after every change.
// hud.html and units/<unit>.html are static snapshots: no script, no network.
function derived(s) {
  const plan = decide(s);
  writeAtomic(join(runsDir(), s.id, 'workbench.md'), render(s, plan));
  const v = view(s, plan, Date.now(), { repo: repoFor(s) });
  const theme = themeFor(s);
  writeAtomic(hudFile(s.id), hud(v, Date.now(), staticCtx(runDir(s.id), 0, theme)));
  writeAtomic(join(runDir(s.id), 'maps.html'), mapsPage(v, Date.now(), staticCtx(runDir(s.id), 0, theme)));
  for (const u of s.units) writeAtomic(join(runDir(s.id), 'units', `${u.id}.html`), unitPage(v, u.id, Date.now(), staticCtx(runDir(s.id), 1, theme)));
}

// --issue and --pr values (owner/repo#n, #n or a URL) as unit links.
function refLinks(s, kind, values = []) {
  return values.map((raw) => {
    const url = githubRef(String(raw), repoFor(s), kind);
    if (!url) throw new Error(`--${kind} must be owner/repo#n, #n (with a known repo) or an http(s) URL, got: ${raw}`);
    return { kind, url, label: null, at: now() };
  });
}
const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean) : []);

const exists = (run) => existsSync(stateFile(run)) || existsSync(join(runDir(run), EVENTS));
function load(run) {
  if (!exists(run)) throw new Error(`no run: ${run}`);
  return loadRun(runDir(run));
}

// Every change: one event of `kind` in the run's log, locked and atomic, refused
// on a closed run, with the snapshot and workbench refreshed in the same lock.
function change(run, kind, mutate, { closedOk = false, unit = null } = {}) {
  if (!exists(run)) throw new Error(`no run: ${run}`);
  return updateRun(runDir(run), { kind, unit }, (s) => { if (s.closed && !closedOk) throw new Error(`run ${run} is closed`); mutate(s); }, derived);
}

function unitOf(s, id) {
  const u = s.units.find((x) => x.id === safeId(id, 'unit'));
  if (!u) throw new Error(`no unit ${id} in run ${s.id}`);
  return u;
}

function expect(s, u, cmd) {
  const d = decideUnit(u, s, Date.now());
  if (!s.frozen) throw new Error('freeze the run first');
  if (!allows(cmd, d)) throw new Error(`${cmd} refused: next says "${d.action}"${d.reason ? ` (${d.reason})` : ''} for ${u.id}`);
}

function judged(evidence, v, gapText, causeText) {
  const verdict = v === 'pass' && !evidence ? 'fail' : v;
  const gap = verdict === 'fail' ? (gapText ?? (evidence ? 'unspecified' : 'PASS claimed without evidence')) : null;
  return { verdict, gap, cause: verdict === 'fail' && gapText ? causeText : null };
}

const commands = {
  init([run], o) {
    safeId(run, 'run');
    const b = settings().budgets ?? {};
    const fresh = {
      id: run, tag: safeId(o.tag ?? 'general', 'tag'),
      goal: text(o.goal, 'goal'), bar: text(o.bar, 'bar'), fence: text(o.fence, 'fence'), paths: list(o.paths),
      budget: {
        maxRounds: num(o['max-rounds'] ?? asArg(b.rounds), 4, 1, 8), maxMinutes: num(o['max-minutes'] ?? asArg(b.minutes), 240, 5, 10_080),
        maxUnits: num(o['max-units'], 6, 1, 20), maxAdded: num(o['max-added'], 2, 0, 10),
        staleMinutes: num(o['stale-minutes'], 45, 5, 1440), maxStudies: num(o['study-budget'], 2, 0, 10),
      },
      createdAt: now(), frozen: false, addedAfterFreeze: 0, units: [], notes: [], integration: { rounds: [] }, closed: null,
    };
    if (o.repo !== undefined) { if (typeof o.repo !== 'string' || !REPO.test(o.repo)) throw new Error('--repo must be owner/name'); fresh.repo = o.repo; }
    if (o.theme !== undefined) {
      const f = typeof o.theme === 'string' ? resolve(o.theme) : '';
      if (!f || extname(f).toLowerCase() !== '.css' || !existsSync(f) || !statSync(f).isFile()) throw new Error('--theme must be an existing .css file');
      fresh.theme = f;
    }
    return updateRun(runDir(run), { kind: 'run.init' }, (s) => { if (s) throw new Error(`run exists: ${run}`); return fresh; }, derived);
  },
  add([run, unit], o) {
    return change(run, 'unit.add', (s) => {
      safeId(unit, 'unit');
      if (s.units.some((u) => u.id === unit)) throw new Error(`unit exists: ${unit}`);
      if (s.units.length >= s.budget.maxUnits) throw new Error(`unit cap reached (${s.budget.maxUnits}): log the extra work as a follow-up note`);
      if (o.after) unitOf(s, o.after);
      if (s.frozen) {
        const reason = text(o.reason, 'reason (the run is frozen)');
        if (s.addedAfterFreeze >= s.budget.maxAdded) throw new Error('scope cap reached: log the extra work as a follow-up note and carry on');
        s.addedAfterFreeze++;
        s.notes.push({ kind: 'scope', text: `added ${unit}: ${reason}`, at: now() });
      }
      const link = optText(o.link, 300);
      if (link && !/^https?:\/\/\S+$/i.test(link)) throw new Error('--link must be an http(s) URL');
      const links = [...refLinks(s, 'issue', o.issue), ...refLinks(s, 'pr', o.pr)];
      const specialists = list(o.specialist).map((n) => safeId(n, 'specialist'));
      const u = { id: unit, bar: text(o.bar, 'bar'), ...(specialists.length ? { specialists } : {}), title: optText(o.title, 80), link, after: o.after ?? null, status: 'open', rounds: [], strategyChanges: 0, strategyAt: -1, heartbeatAt: null, stopReason: null, ...(links.length ? { links } : {}) };
      s.units.push(u);
      for (const b of o.behaviour ?? []) { const id = behave(s, u, { text: b }); log(u, 'behaviour', `${id}: ${optText(b, 300)}`); }
    }, { unit });
  },
  freeze([run]) { return change(run, 'run.freeze', (s) => { if (!s.units.length) throw new Error('add units first'); s.frozen = true; }); },
  // A new build: the critic marks every behaviour again.
  start([run, unit]) {
    return change(run, 'unit.start', (s) => { const u = unitOf(s, unit); expect(s, u, 'start'); u.status = 'building'; u.heartbeatAt = now(); reopen(u.behaviours); log(u, 'start', `try ${u.rounds.length + 1}`); }, { unit });
  },
  beat([run, unit], o) {
    return change(run, 'unit.beat', (s) => { const u = unitOf(s, unit); if (!['building', 'judging'].includes(u.status)) throw new Error(`unit ${unit} is ${u.status}`); expect(s, u, 'beat'); u.heartbeatAt = now(); log(u, 'beat', optText(o.text, 200) ?? ''); }, { unit });
  },
  built([run, unit], o) {
    return change(run, 'unit.built', (s) => {
      const u = unitOf(s, unit); if (u.status !== 'building') throw new Error(`unit ${unit} is ${u.status}, not building`); expect(s, u, 'built');
      u.status = 'judging'; u.heartbeatAt = now(); u.report = optText(o.report, 2000); log(u, 'built', u.report ?? '');
      delete u.specialistMarks; // a new build is judged again by every specialist
    }, { unit });
  },
  behave([run, unit], o) {
    let id;
    const s = change(run, 'behaviour', (st) => {
      if ((o.goal === true) === (unit !== undefined)) throw new Error('name a unit or --goal, not both');
      if (o.remove !== undefined && o.remove !== true) throw new Error('--remove takes no value');
      const u = unit === undefined ? null : unitOf(st, unit);
      // Dropping or rewording a behaviour changes the bar: never mid-judgement, and after freeze only with a reason.
      if (u?.status === 'judging') throw new Error(`behave refused: ${u.id} is being judged; wait for the verdict`);
      const list = u ? (u.behaviours ?? []) : (st.goalBehaviours ?? []);
      const changes = o.remove === true || (o.id !== undefined && list.some((b) => b.id === String(o.id).toUpperCase()));
      const reason = changes && st.frozen ? text(o.reason, 'reason (removing or rewording a behaviour after freeze changes the bar)', 300) : null;
      id = behave(st, u, { id: o.id, text: o.text, remove: o.remove === true });
      const what = o.remove ? `removed ${id}` : `${id}: ${optText(o.text, 300)}`;
      if (u) log(u, 'behaviour', reason ? `${what} (${reason})` : what);
      if (reason) st.notes.push({ kind: 'bar', text: `${u ? u.id : 'goal'} ${what}: ${reason}`, at: now() });
    }, { unit: unit ?? null });
    return { ...s, behaviour: id };
  },
  behaviours([run]) { const s = load(run); return { goal: s.goalBehaviours ?? [], units: Object.fromEntries(s.units.map((u) => [u.id, u.behaviours ?? []])) }; },
  evidence([run, unit], o) {
    let id;
    const s = change(run, 'evidence', (st) => {
      if ((o.goal === true) === (unit !== undefined)) throw new Error('name a unit or --goal, not both');
      const u = unit === undefined ? null : unitOf(st, unit);
      id = addEvidence(st, u, o, runDir(run));
      if (u) log(u, 'evidence', `${id} ${o.kind}${typeof o.label === 'string' ? `: ${optText(o.label, 120)}` : ''}`);
    }, { unit: unit ?? null });
    return { ...s, evidence: id };
  },
  // Allowed on a closed run: a merge often lands after the report.
  link([run, unit], o) {
    return change(run, 'unit.link', (s) => {
      const u = unitOf(s, unit);
      const add = [...refLinks(s, 'issue', o.issue), ...refLinks(s, 'pr', o.pr), ...refLinks(s, 'merge', o.merge)];
      if (o.url !== undefined) {
        const url = typeof o.url === 'string' ? webUrl(o.url.trim()) : null;
        if (!url || url.length > 500) throw new Error('--url must be an http(s) URL');
        add.push({ kind: 'other', url, label: optText(o.label, 120), at: now() });
      }
      if (!add.length) throw new Error('give --issue, --pr, --merge or --url');
      (u.links ??= []).push(...add);
      for (const l of add) log(u, 'link', l.url, { link: l.kind });
    }, { closedOk: true, unit });
  },
  verdict([run, unit, v], o) {
    return change(run, 'unit.verdict', (s) => {
      const u = unitOf(s, unit);
      if (u.status !== 'judging') throw new Error(`verdict refused: unit ${unit} is ${u.status}; record built first`);
      expect(s, u, 'verdict');
      oneOf(v, ['pass', 'fail'], 'verdict');
      if (v === 'fail' && o.score === undefined) throw new Error('--score is required on a fail (it drives the no-progress stop)');
      if (v === 'fail' && !optText(o.gap)) throw new Error('--gap is required on a fail (it drives the same-gap stop)');
      const evidence = optText(o.evidence);
      const { verdict, gap, cause } = judged(evidence, v, optText(o.gap, 500), optText(o.cause, 80));
      const critic = optText(o.critic, 120);
      if (o.specialist !== undefined) { // a required second critic: recorded on this round, the unit stays judging
        const name = String(o.specialist);
        if (!(u.specialists ?? []).includes(name)) throw new Error(`no specialist ${name} on unit ${unit} (add --specialist)`);
        (u.specialistMarks ??= {})[name] = { verdict, score: score(o.score), gap, cause, evidence, ...(critic ? { critic } : {}), at: now() };
        return;
      }
      const missing = (u.specialists ?? []).filter((n) => u.specialistMarks?.[n]?.verdict !== 'pass');
      if (verdict === 'pass' && missing.length) throw new Error(`pass refused: specialist ${missing.join(', ')} has not passed this build`);
      const round = u.rounds.length + 1;
      if (verdict === 'pass' && s.paths?.length && !(u.detect?.round === round && u.detect.clean)) {
        throw new Error(`pass refused: no clean detect result for round ${round}; run detect.mjs --run ${s.id} --unit ${u.id} --base … first`);
      }
      const marks = mark(u.behaviours ?? [], o.behaviour, verdict);
      u.rounds.push({ n: round, verdict, score: score(o.score), gap, cause, evidence, at: now(), ...(marks.length ? { behaviours: marks } : {}), ...(u.report ? { report: u.report } : {}), ...(critic ? { critic } : {}), ...(u.specialistMarks ? { specialists: u.specialistMarks } : {}) });
      u.report = null; delete u.specialistMarks;
      u.status = verdict === 'pass' ? 'pass' : 'open';
    }, { unit });
  },
  reset([run, unit], o) {
    return change(run, 'unit.reset', (s) => {
      const u = unitOf(s, unit);
      if (!['building', 'judging'].includes(u.status)) throw new Error(`unit ${unit} is ${u.status}, not in progress`);
      const reason = text(o.reason, 'reason', 300);
      s.notes.push({ kind: 'info', text: `reset ${unit} (${u.status} → open): ${reason}`, at: now() });
      log(u, 'reset', reason);
      u.status = 'open'; u.heartbeatAt = null;
    }, { unit });
  },
  strategy([run, unit], o) {
    return change(run, 'unit.strategy', (s) => {
      const u = unitOf(s, unit);
      expect(s, u, 'strategy');
      u.strategyChanges++; u.strategyAt = u.rounds.length;
      const t = text(o.text, 'text', 500);
      s.notes.push({ kind: 'strategy', text: `${unit}: ${t}`, at: now() });
      log(u, 'strategy', t);
    }, { unit });
  },
  integrate([run, v], o) {
    return change(run, 'run.integrate', (s) => {
      const d = decide(s).decision;
      if (d !== 'integrate') throw new Error(`integrate refused: the run is at "${d}"`);
      oneOf(v, ['pass', 'fail'], 'verdict');
      const evidence = optText(o.evidence);
      const j = judged(evidence, v, optText(o.gap, 500), optText(o.cause, 80));
      const marks = mark(s.goalBehaviours ?? [], o.behaviour, j.verdict);
      s.integration.rounds.push({ ...j, evidence, at: now(), ...(marks.length ? { behaviours: marks } : {}) });
    });
  },
  note([run], o) {
    const kind = oneOf(o.kind, ['situation', 'decision', 'follow-up', 'retro', 'question', 'bar', 'info', 'person', 'escape'], '--kind');
    if (kind === 'person') return change(run, 'note', (s) => personNote(s, { text: o.text, unit: o.unit }), { unit: typeof o.unit === 'string' ? o.unit : null });
    if (kind === 'escape') {
      return change(run, 'note', (s) => {
        if (typeof o.unit !== 'string') throw new Error('--kind escape needs --unit: the unit that passed');
        const u = unitOf(s, o.unit);
        const passed = u.rounds.findLastIndex((r) => r.verdict === 'pass');
        if (passed < 0) throw new Error(`unit ${u.id} has not passed: a defect before a pass is a gap, not an escape`);
        s.notes.push({ kind: 'escape', unit: u.id, round: passed + 1, text: text(o.text, 'text', 1000), at: now() });
      }, { closedOk: true, unit: typeof o.unit === 'string' ? o.unit : null });
    }
    if (o.unit !== undefined) throw new Error('--unit goes with --kind person or escape (or ask)');
    if (o.recommend !== undefined && kind !== 'question') throw new Error('--recommend goes with --kind question');
    if (o.answers !== undefined && kind !== 'decision') throw new Error('--answers goes with --kind decision');
    return change(run, kind === 'question' ? 'question' : 'note', (s) => {
      const note = { kind, text: text(o.text, 'text', kind === 'situation' ? 400 : 1000), at: now() };
      if (o.recommend !== undefined) note.recommend = text(o.recommend, 'recommend', 300);
      if (o.answers !== undefined) {
        const asked = s.notes.filter((n) => n.kind === 'question').length;
        const m = /^q(\d+)$/.exec(String(o.answers));
        if (!m || +m[1] < 1 || +m[1] > asked) throw new Error(`--answers must name a logged question (q1-q${asked})`);
        note.answers = o.answers;
      }
      s.notes.push(note);
    }, { closedOk: ['follow-up', 'retro'].includes(kind) });
  },
  study([run], o) { let id; const s = change(run, 'study', (st) => { id = addStudy(st, o); }); return { ...s, study: id }; },
  self(_, o) {
    if (o.json !== undefined && o.html !== undefined) throw new Error('--json or --html, not both');
    const m = selfModel({ ...loadSelf(), current: null });
    if (o.json) return m;
    if (o.html) {
      const file = join(baseDir('project'), 'coordinator.html');
      const ctx = { ...staticCtx(null, 0, loadTheme(themeFile({}, projectDir()))), runHref: (id) => `runs/${encodeURIComponent(id)}/hud.html` };
      writeAtomic(file, selfPage(m, Date.now(), ctx));
      return { file };
    }
    process.stdout.write(selfText(m));
    return null;
  },
  ask([run], o) { let id; const s = change(run, 'question', (st) => { id = ask(st, o); }, { unit: typeof o.unit === 'string' ? o.unit : null }); return { ...s, asked: id }; },
  answer([run, id], o) { return change(run, 'answer', (s) => answer(s, id, { choices: o.choice ?? [], other: o.other === true ? null : o.other, by: o.by ?? 'person' })); },
  'use-answer'([run, id]) { return change(run, 'answer.used', (s) => useAnswer(s, id)); },
  questions([run]) { return questions(load(run)).map(({ open, ...q }) => q); },
  serve([run], o) {
    load(run);
    const write = (kind, fn) => (form) => { let anchor; change(run, kind, (s) => { anchor = fn(s, form); }, { unit: form.get('unit') || null }); return anchor; };
    serve({
      port: num(o.port, 0, 0, 65_535),
      page: (path, live) => {
        const theme = themeFor(load(run));
        if (path === '/coordinator') return selfPage(selfModel({ ...loadSelf(), current: run }), Date.now(), liveCtx(live, run, theme));
        // /run/<other>[/unit/<u>|/maps|/map]: another run of this folder, read-only; /run/<served> is the served run.
        const m = /^\/run\/([^/]+)(\/unit\/.+|\/maps|\/map)?$/.exec(path);
        const id = m ? m[1] : run;
        if (m && !isSafeId(id)) return null;
        if (m && !exists(id)) return null;
        const s = load(id);
        const v = view(s, decide(s), Date.now(), { repo: repoFor(s) });
        const ctx = liveCtx(live, run, themeFor(s), id === run ? null : id);
        ctx.has = (file) => existsSync(join(runDir(id), 'artifacts', ...file.split('/')));
        const rest = m ? (m[2] ?? '/') : path;
        if (hasMap(runDir(id))) ctx.mapHref = `${ctx.base}/map?t=${encodeURIComponent(live.token)}`;
        if (rest === '/map' || path === '/map') return ctx.mapHref ? mapView(id, runDir(id), { ...ctx, pages: mapNav(ctx, id) }) : null;
        if (rest === '/maps') return mapsPage(v, Date.now(), ctx);
        return rest === '/' ? hud(v, Date.now(), ctx) : unitPage(v, decodeURIComponent(rest.slice('/unit/'.length)), Date.now(), ctx);
      },
      version: selfVersion,
      file: (target, name, other) => {
        const id = other ?? run;
        if (!isSafeId(id) || !exists(id)) return null;
        const a = artifact(load(id), target, name);
        return a ? { file: join(runDir(id), 'artifacts', a.rel), type: a.type } : null;
      },
      post: {
        '/answer': write('answer', (s, f) => { const id = f.get('q'); answer(s, id, { ...fromForm(find(s, id), f.getAll('choice'), f.get('other')), by: 'person' }); return id; }),
        '/note': write('note', (s, f) => { personNote(s, { text: f.get('text'), unit: f.get('unit') || undefined }); return f.get('unit') ? `unit-${f.get('unit')}` : ''; }),
      },
    }).then(({ server, url }) => {
      // So `doctor` can tell a running dashboard from a stale one. No token: the URL stays in this output only.
      const rec = join(runDir(run), 'serve.json');
      writeAtomic(rec, `${JSON.stringify({ pid: process.pid, port: server.address().port, at: now() })}
`);
      const drop = () => { try { if (JSON.parse(readFileSync(rec, 'utf8')).pid === process.pid) rmSync(rec); } catch { /* gone */ } };
      process.on('exit', drop);
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
      console.log(JSON.stringify({ url, note: 'local only; stop with Ctrl+C' }));
    }, (e) => { console.error(`error: ${e.message}`); process.exit(1); });
    return null;
  },
  // Polls every 2 s (fs.watch misses renames on some systems); the state file is
  // replaced atomically, so a read never sees half a write.
  // --remote: answers made away from this machine (web HUD, comment commands) arrive by pull.
  watch([run], o) {
    let prev = load(run);
    for (const line of events(null, prev)) console.log(line);
    setInterval(() => {
      try { const s = load(run); for (const line of events(prev, s)) console.log(line); prev = s; } catch { /* mid-replace on Windows: next tick */ }
    }, 2000);
    if (o.remote !== undefined) {
      if (o.remote !== true) throw new Error('--remote takes no value');
      const say = (line) => console.log(`remote: ${line}`);
      const bell = bellConfig({ base: baseDir('project'), project: projectDir() });
      if (!bell.service) say(`doorbell off: ${bell.why}; polling only`);
      remoteWatch({
        everyMs: num(o.every, 30, 10, 60) * 1000, say,
        pullOnce: () => pull({ run, dir: runDir(run), base: baseDir('project'), project: projectDir(), after: derived, restore: { map: mapRestore(runDir(run)) } }),
        startBell: bell.service ? (ring) => listen({ service: bell.service, repo: bell.repo, run, onRing: ring, say }) : null,
      });
    }
    return null;
  },
  // Returns this round's actions (a stop shows once, here) and records the stops.
  // Stops cascade (a stopped unit stops the units stacked on it), so apply them
  // until nothing changes; each stop is reported once, here.
  next([run]) {
    let stopped;
    const s = change(run, 'run.stop', (st) => { stopped = applyStops(st); });
    const plan = decide(s);
    return { decision: plan.decision, units: plan.units.map((u) => stopped.get(u.id) ?? u) };
  },
  brief([run, unit], o) {
    const files = o.quote ?? []; const labels = o.source ?? [];
    if (labels.length > files.length) throw new Error('one --source per --quote');
    const quotes = files.map((f, i) => {
      if (!existsSync(f) || !statSync(f).isFile()) throw new Error(`--quote: no file ${f}`);
      return { source: labels[i] ?? basename(f), text: readFileSync(f, 'utf8') };
    });
    const env = process.env.COORDINATOR_DIR ? commands.where().env : '';
    process.stdout.write(`${buildBrief(load(run), { role: o.role, unit, quotes, where: optText(o.where, 500), playbook: optText(o.playbook, 300), env })}\n`);
    return null;
  },
  show([run]) { const s = load(run); process.stdout.write(textView(view(s, decide(s)))); return null; },
  // Reads under the lock so it never renders a half-applied change; also refreshes the elapsed time.
  hud([run]) {
    if (!exists(run)) throw new Error(`no run: ${run}`);
    withLock(stateFile(run), () => derived(loadRun(runDir(run))));
    return { file: hudFile(run) };
  },
  close([run], o) {
    const outcome = oneOf(o.outcome, ['done', 'partial', 'stopped'], '--outcome');
    const closed = change(run, 'run.close', (s) => {
      applyStops(s); // an expired budget ends in-progress units first
      const busy = s.units.filter((u) => ['building', 'judging'].includes(u.status)).map((u) => u.id);
      if (busy.length) throw new Error(`close refused: ${busy.join(', ')} still in progress`);
      const d = decide(s).decision;
      if (outcome === 'done' && d !== 'done') throw new Error(`close --outcome done refused: the run is at "${d}"; use partial or stopped`);
      // Ending before the rules say so (giving up early) needs a stated reason.
      const expected = { partial: 'done-with-gaps', stopped: 'stopped' }[outcome];
      if (expected && d !== expected) s.notes.push({ kind: 'decision', text: `closed early as ${outcome} at "${d}": ${text(o.reason, 'reason (closing before the rules end the run)', 500)}`, at: now() });
      s.closed = { outcome, decision: d, at: now() };
    });
    const loose = adopt(load(run), runDir(run), { project: projectDir(), home: homedir() }).filter((r) => r.status === 'adoptable');
    return loose.length ? Object.assign(closed, { warning: `${loose.length} file(s) the run mentions live outside its folder; run: run.mjs adopt ${run}` }) : closed;
  },
  adopt([run], o) {
    const dry = o['dry-run'] !== undefined;
    let rows;
    if (dry) rows = adopt(load(run), runDir(run), { project: projectDir(), home: homedir() });
    else change(run, 'evidence', (s) => { rows = adopt(s, runDir(run), { project: projectDir(), home: homedir(), apply: true }); }, { closedOk: true });
    const count = (k) => rows.filter((r) => r.status === k).length;
    console.log(rows.length ? table(rows) : 'no file paths mentioned');
    console.log(`${dry ? 'adoptable' : 'adopted'} ${count(dry ? 'adoptable' : 'adopted')}, already ${count('already')}, inside ${count('inside')}, tracked ${count('tracked')}, missing ${count('missing')}, refused ${count('refused')}`);
    return null;
  },
  list() {
    if (!existsSync(runsDir())) return [];
    return readdirSync(runsDir()).filter((d) => isSafeId(d) && exists(d)).map((d) => {
      try {
        const s = loadRun(runDir(d));
        return { run: s.id, tag: s.tag, createdAt: s.createdAt, closed: s.closed?.outcome ?? null, decision: decide(s).decision };
      } catch (e) { return { run: d, createdAt: '', error: `unreadable: ${e.message}` }; }
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  // The project map (references/map.md): from the code into the run's folder; never into the project's tree unless --dest says so.
  map([run], o) {
    const s = load(run);
    const root = resolve(typeof o.root === 'string' ? o.root : projectDir());
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`--root must be a folder: ${root}`);
    if (o.unit !== undefined) unitOf(s, o.unit);
    if (o.dest !== undefined && o['pit-stop'] !== true) throw new Error('--dest goes with --pit-stop');
    const snap = buildMap(run, runDir(run), { root, maxSeconds: num(o['max-seconds'], 60, 1, 3600), unit: o.unit ?? null, ctx: staticCtx(runDir(run), 0, themeFor(s)), fresh: o.fresh === true, force: o.force === true, resetStage: o['reset-stage'] === true });
    commands.hud([run]); // the dashboard links to the map
    const b = snap.build;
    return {
      build: b.n, files: b.scanned, seconds: Math.round(b.ms.total / 100) / 10, partial: b.partial, stats: b.stats, page: mapHtml(runDir(run)),
      ...(o['reset-stage'] === true ? { reset: 'a new map history, staged: the next push replaces the copy, and pull on other machines takes it' } : {}),
      ...(o['pit-stop'] === true ? { pitStop: pitStop(runDir(run), typeof o.dest === 'string' ? o.dest : defaultDest(runDir(run))) } : {}),
    };
  },
  touches([run, path], o) {
    load(run);
    if (!path) throw new Error('usage: run.mjs touches <run> <path> [--json]');
    const out = touchesOf(run, runDir(run), path, o.json === true);
    if (o.json === true) return out;
    process.stdout.write(out);
    return null;
  },
  // Forward slashes and single quotes ($ and ` stay literal), so it pastes safely into a shell brief.
  where() { const d = baseDir('project').replace(/\\/g, '/'); return { stateDir: d, env: `COORDINATOR_DIR='${d.replace(/'/g, "'\\''")}'` }; },
  push([run], o) {
    load(run);
    return push({ run, dir: runDir(run), base: baseDir('project'), project: projectDir(), to: o.to, message: optText(o.message, 200) ?? undefined, render: (s) => render(s, decide(s)), attach: [mapAttach(runDir(run))] });
  },
  pull([run], o) {
    safeId(run, 'run');
    return pull({ run, dir: runDir(run), base: baseDir('project'), project: projectDir(), from: o.from, after: derived, restore: { map: mapRestore(runDir(run)) } });
  },
  stats(_, o) {
    return stats(commands.list().filter((r) => !r.error && r.closed && (!o.tag || r.tag === o.tag)).map((r) => load(r.run)));
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!commands[cmd]) { console.error('usage: run.mjs init|add|behave|behaviours|evidence|link|freeze|start|beat|built|reset|verdict|strategy|integrate|note|study|self|ask|answer|use-answer|questions|serve|watch|next|show|hud|map|touches|brief|close|adopt|push|pull|list|stats|where … (see the header of run.mjs)'); process.exit(2); }
try {
  const { pos, opt } = parse(rest, FLAGS[cmd] ?? [], REPEAT[cmd]);
  const out = commands[cmd](pos, opt);
  if (out !== null) console.log(JSON.stringify(['next', 'list', 'stats', 'where', 'hud', 'questions', 'behaviours', 'self', 'push', 'pull', 'map', 'touches'].includes(cmd) ? out : { ok: true, run: out.id, decision: decide(out).decision, ...(out.asked ? { asked: out.asked } : {}), ...(out.study ? { study: out.study } : {}), ...(out.behaviour ? { behaviour: out.behaviour } : {}), ...(out.evidence ? { evidence: out.evidence } : {}), ...(out.warning ? { warning: out.warning } : {}) }, null, 2));
} catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
