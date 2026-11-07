#!/usr/bin/env node
// The coordinator's run state: one JSON file per run, written only through here.
// Each step is refused unless the loop asked for it (see allows() in lib/rules.mjs).
//
//   run.mjs init <run> --goal G --bar B --fence F [--paths a,b] [--tag T] [--max-rounds 4]
//                      [--max-minutes 240] [--max-units 6] [--max-added 2] [--stale-minutes 45]
//                      [--repo owner/name] (resolves #123 and shas; else the project's git remote) [--theme file.css]
//                      [--study-budget 2] (side studies allowed while waiting, 0-10)
//                      [--models on|off] model routing for this project (.coordinator/coordinator.json "models");
//                      `run.mjs init --models on|off` with no run only sets that
//                      [--continues <run>:<unit> …] finishes that unit of an earlier run here (add it under the
//                      same id, or add another id with add --continues): both runs record the link, a unit is
//                      continued once (no forks), and stats count the chain as one unit
//   run.mjs add <run> <unit> --bar B [--after U] [--reason R] [--title T] [--link URL] [--specialist a,b] (critics that must also pass)
//                  [--continues <run>:<unit>] this unit, under its own id, continues that unit of an earlier run
//                  [--issue owner/repo#n|URL …] [--pr …] [--behaviour "Given … when … then …" …]   (--reason required after freeze)
//   run.mjs behave <run> <unit>|--goal [--id B1] --text T | --id B1 --remove   add, reword (back to unchecked) or remove
//   run.mjs behaviours <run>        every behaviour of the goal and the units, with status and evidence
//   run.mjs evidence <run> <unit>|--goal [--behaviour B1] (--text T | --file path | --url U) --kind test|screenshot|log|link [--label L]
//   run.mjs link <run> <unit> [--issue … ] [--pr …] [--merge URL] [--url U --label L]   GitHub issues, PRs and merges for the unit
//                  [--continues <run>:<unit>]  record afterwards that this unit continues that one (any id; closed runs too)
//   run.mjs extend <run> <unit> [--rounds N] --reason R [--answer qN]   N (1-4, default 1; above 1 only when their words name it) more rounds for a unit
//                  at or stopped by its round budget: qN asked with --approves and answered with that option by the
//                  person (dashboard, web, or answer --by person --confirm "their words"), or else their note on
//                  the unit since its last verdict saying "approved" (lib/approval.mjs); recorded as a decision
//   run.mjs freeze <run>
//   run.mjs start <run> <unit> [--model M] [--why W]   only when next says build, or check-stale with phase building;
//                  M: the model that builds this try, W: the task class that chose it (e.g. docs-only);
//                  after a try failed on a model below strong, a model below strong needs [--force-model "reason"]
//   run.mjs beat <run> <unit> [--text T]     builder or critic still working (T: the milestone, e.g. "pushed")
//   run.mjs built <run> <unit> [--report R]  builder finished (R: its report in short): the unit waits for a critic
//   run.mjs reset <run> <unit> --reason R     in-progress unit with no artifact goes back to build (after a crash)
//   run.mjs verdict <run> <unit> pass|fail --evidence E [--gap G] [--cause C] --score 0-10   only after built;
//                  score and gap required on fail; cause is the critic's root-cause tag (drives same-gap);
//                  on a run with --paths, pass needs a clean detect.mjs --unit result;
//                  [--behaviour B1=pass:"evidence" | B1=fail:"gap" …]: a pass needs every behaviour passing
//                  [--model M] the model that judged (refused below the strong model while routing is on)
//                  [--critic SETUP] who judged (e.g. "review skill high + security"): stats groups escapes by it
//                  [--specialist NAME] a required second critic's verdict on this build (add --specialist a,b);
//                  the unit stays judging, and its pass is refused until every required specialist passed
//   run.mjs strategy <run> <unit> --text T                          only when next says change-strategy
//   run.mjs integrate <run> pass|fail --evidence E [--gap G] [--cause C] [--behaviour G1=pass:"…" …] [--model M]
//                  only when next says integrate; a pass needs every goal behaviour passing
//   run.mjs note <run> --kind situation|decision|follow-up|retro|question|bar|info|person|escape --text T
//                  escape: --unit U, a passed unit where a defect turned up later (a later review, verify, test, a person); counted by stats
//                  [--recommend R] (question: the lead's pick) [--answers qN] (decision: closes question N)
//                  [--unit U] (person: a note from the person about one unit) [--confirm] (person: their words, pasted)
//   run.mjs brief <run> [<unit>] --role builder|critic|integrator [--quote file … --source label …] [--where W] [--playbook P]
//                  prints the brief; each quoted file is fenced as data, and the goal, bar and fence follow it
//   run.mjs ask <run> --question Q --header H --option "label|description" (2-4, recommended first) [--multi] [--unit U]
//                  [--approves <label>] the option that approves a step only the person may approve (extend)
//   run.mjs answer <run> qN [--choice label …] [--other T] [--by person|lead]   changeable until used
//                  [--confirm "their words"] with --by person only: the person said this; never without their words
//   run.mjs use-answer <run> qN     the lead acted on the answer: it can no longer change
//   run.mjs questions <run>         every question with its options, answer, history and status
//   run.mjs study <run> --topic T --area security|design|stack|other --text "what it learned" --source URL … [--lesson id …] [--by agent]
//                  one side study while the run waits (capped per run by --study-budget); lessons it added go in with lessons.mjs add --source
//   run.mjs self [--json] [--html]  the coordinator's own view across every run here (age, learning, memory, stats,
//                  history, plans, proposals, side study); --html writes coordinator.html in the state folder
//   run.mjs gaps [--json] [--all]   open gaps across every run here (stopped and unfinished units, runs closed early,
//                  follow-ups, out-of-fence items, open questions, upstream proposals, escapes); --all adds resolved ones
//   run.mjs gap close|reopen <run> <id> --reason R [--by person|lead]   closes (or reopens) one gap: a decision note
//                  in that run's log (closed runs too); the id is kind:run:unit:seq as gaps prints it
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
//   run.mjs touches <run> <path> [--json] [--unit U]   what that file touches, from the map, for a builder's brief;
//                  --unit records the path as one the unit will change (no map needed for that), so `next` can
//                  say when a unit that changes the same file merged first
//   run.mjs sync <run> <unit> [--text T]   the target branch was merged into the unit's branch (after `next` asked)
//   run.mjs models [--role builder|critic|… --class docs,auth]   the routing table, or the model for one role and task class
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
import { allows, decide, decideUnit, roundCap, stats } from './lib/rules.mjs';
import { childId, continuesOf, linkedRuns, parseContinues } from './lib/chain.mjs';
import { answerRefusal, namedRounds, noteRefusal } from './lib/approval.mjs';
import { lastWriter } from './lib/provenance.mjs';
import { clip } from './lib/plain.mjs';
import { normPath, pendingSyncs, syncStep } from './lib/overlap.mjs';
import { EVENTS, loadRun, readRun, updateRun } from './lib/events.mjs';
import { pull, push } from './lib/statesync.mjs';
import { bellConfig, listen } from './lib/doorbell.mjs';
import { remoteWatch } from './lib/remote.mjs';
import { atLeast, byModel, escalation, judgeAllowed, modelName, route, routing, setRouting, UNSPECIFIED } from './lib/models.mjs';
import { baseDir, isSafeId, projectDir, safeId, withLock, writeAtomic } from './lib/store.mjs';
import { hud, liveCtx, staticCtx } from './lib/hud.mjs';
import { githubRef, inferRepo, REPO, repoFromText, webUrl } from './lib/links.mjs';
import { readSettings } from './lib/settings.mjs';
import { load as loadTheme, themeFile } from './lib/theme.mjs';
import { log } from './lib/timeline.mjs';
import { unitPage } from './lib/unitpage.mjs';
import { mapsPage } from './lib/mapspage.mjs';
import { answer, answerText, ask, events, find, fromForm, personNote, questions, useAnswer } from './lib/questions.mjs';
import { serve } from './lib/serve.mjs';
import { selfModel, selfText } from './lib/self.mjs';
import { loadRuns, loadSelf, selfVersion } from './lib/selfdata.mjs';
import { closeGap, gaps, gapsText, parseGapId } from './lib/gaps.mjs';
import { selfPage } from './lib/selfpage.mjs';
import { addStudy } from './lib/study.mjs';
import { text as textView, view } from './lib/view.mjs';
import { render } from './lib/workbench.mjs';
import { build as buildMap, defaultDest, hasMap, mapAttach, mapHtml, mapNav, mapRestore, mapView, pitStop, touchesOf } from './lib/map/index.mjs';

const FLAGS = {
  init: ['goal', 'bar', 'fence', 'paths', 'tag', 'max-rounds', 'max-minutes', 'max-units', 'max-added', 'stale-minutes', 'repo', 'theme', 'study-budget', 'models', 'continues'],
  extend: ['rounds', 'reason', 'answer'],
  start: ['model', 'why', 'force-model'], models: ['role', 'class'],
  study: ['topic', 'area', 'text', 'source', 'lesson', 'by'], self: ['json', 'html'], gaps: ['json', 'all'], gap: ['reason', 'by'],
  add: ['bar', 'after', 'reason', 'title', 'link', 'issue', 'pr', 'behaviour', 'specialist', 'continues'], verdict: ['evidence', 'gap', 'cause', 'score', 'behaviour', 'critic', 'specialist', 'model'], strategy: ['text'],
  integrate: ['evidence', 'gap', 'cause', 'behaviour', 'model'], beat: ['text'], built: ['report'],
  behave: ['goal', 'id', 'text', 'remove', 'reason'], evidence: ['goal', 'behaviour', 'text', 'file', 'url', 'kind', 'label'],
  link: ['issue', 'pr', 'merge', 'url', 'label', 'continues'], note: ['kind', 'text', 'recommend', 'answers', 'unit', 'confirm'],
  ask: ['question', 'header', 'option', 'multi', 'unit', 'approves'], answer: ['choice', 'other', 'by', 'confirm'], serve: ['port'], watch: ['remote', 'every'], map: ['root', 'max-seconds', 'unit', 'pit-stop', 'dest', 'fresh', 'force', 'reset-stage'], touches: ['json', 'unit'], sync: ['text'], close: ['outcome', 'reason'], adopt: ['dry-run'], stats: ['tag'], reset: ['reason'],
  brief: ['role', 'quote', 'source', 'where', 'playbook'],
  push: ['to', 'message'], pull: ['from'],
};
const REPEAT = { init: ['continues'], study: ['source', 'lesson'], ask: ['option'], answer: ['choice'], add: ['behaviour', 'issue', 'pr'], verdict: ['behaviour'], integrate: ['behaviour'], link: ['issue', 'pr', 'merge'], brief: ['quote', 'source'] };

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
  const v = view(s, plan, Date.now(), { repo: repoFor(s), linked: linkedOf(s) });
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
// The runs this one continues or was continued in (lib/chain.mjs), for the pages; a missing one shows as "not here".
const linkedOf = (s) => linkedRuns(s, (id) => (isSafeId(id) && exists(id) ? loadRun(runDir(id)) : null));

// Checks a --continues target: an earlier run of this folder, with that unit, not passed,
// and not continued anywhere else (no forks: a chain is a line, so stats count it once).
// child: this run; as: this run's unit id (null at init: the parent's id).
function parentOf(raw, child, as = null) {
  const c = parseContinues(raw);
  if (c.run === child) throw new Error('--continues names this run itself');
  if (!exists(c.run)) throw new Error(`--continues: no run ${c.run} here`);
  const u = loadRun(runDir(c.run)).units.find((x) => x.id === c.unit);
  if (!u) throw new Error(`--continues: no unit ${c.unit} in run ${c.run}`);
  if (u.status === 'pass') throw new Error(`--continues: ${c.run}:${c.unit} already passed`);
  const mine = (run, unit) => run === child && (as === null || unit === undefined || unit === as);
  const other = (u.continuedIn ?? []).find((x) => !mine(x.run, x.unit));
  const kid = commands.list().filter((r) => !r.error && r.run !== child).find((r) => continuesOf(load(r.run)).some((x) => x.run === c.run && x.unit === c.unit));
  const taken = other ? `${other.run}${other.unit ? `:${other.unit}` : ''}` : kid?.run;
  if (taken) throw new Error(`--continues: ${c.run}:${c.unit} is already continued in ${taken}; continue that run's unit instead (a unit is continued once)`);
  return as && as !== c.unit ? { ...c, as } : c;
}
// The parent's side of the link; allowed on a closed run, like a merge link.
function markParent(c, child) {
  change(c.run, 'unit.link', (s) => {
    const u = unitOf(s, c.unit);
    const had = (u.continuedIn ?? []).find((x) => x.run === child);
    if (had) { if (c.as && had.unit !== c.as) had.unit = c.as; return; }
    (u.continuedIn ??= []).push({ run: child, ...(c.as ? { unit: c.as } : {}), at: now() });
    log(u, 'link', `continued in ${child}${c.as ? `:${c.as}` : ''}`, { link: 'continued' });
  }, { closedOk: true, unit: c.unit });
}
// Records on this run that unit u continues c (same parent again: a no-op; the id may differ).
function addContinues(s, u, c) {
  const list = (s.continues ??= []);
  const same = list.find((x) => x.run === c.run && x.unit === c.unit);
  if (same && childId(same) !== u.id && s.units.some((x) => x.id === childId(same))) throw new Error(`--continues: ${c.run}:${c.unit} is already continued here by ${childId(same)}`);
  const mineElse = list.find((x) => childId(x) === u.id && !(x.run === c.run && x.unit === c.unit));
  if (mineElse) throw new Error(`--continues: ${u.id} already continues ${mineElse.run}:${mineElse.unit}`);
  if (same) { if (u.id === c.unit) delete same.as; else same.as = u.id; return; }
  list.push(u.id === c.unit ? { run: c.run, unit: c.unit } : { run: c.run, unit: c.unit, as: u.id });
  log(u, 'link', `continues ${c.run}${u.id === c.unit ? '' : `:${c.unit}`}`, { link: 'continues' });
}
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
    const routeOn = o.models === undefined ? undefined : oneOf(o.models, ['on', 'off'], '--models') === 'on';
    if (run === undefined && routeOn !== undefined) return { models: setRouting(baseDir('project'), routeOn), file: join(baseDir('project'), 'coordinator.json') };
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
    const parents = (o.continues ?? []).map((raw) => parentOf(raw, run));
    if (new Set(parents.map((c) => c.unit)).size < parents.length) throw new Error('--continues: one earlier run per unit id (continue a second one with add <run> <unit> --continues)');
    if (parents.length) fresh.continues = parents;
    if (o.repo !== undefined) { if (typeof o.repo !== 'string' || !REPO.test(o.repo)) throw new Error('--repo must be owner/name'); fresh.repo = o.repo; }
    if (o.theme !== undefined) {
      const f = typeof o.theme === 'string' ? resolve(o.theme) : '';
      if (!f || extname(f).toLowerCase() !== '.css' || !existsSync(f) || !statSync(f).isFile()) throw new Error('--theme must be an existing .css file');
      fresh.theme = f;
    }
    const made = updateRun(runDir(run), { kind: 'run.init' }, (s) => { if (s) throw new Error(`run exists: ${run}`); return fresh; }, derived);
    if (routeOn !== undefined) setRouting(baseDir('project'), routeOn); // only once the run exists
    for (const c of parents) markParent(c, run);
    return made;
  },
  add([run, unit], o) {
    const cont = o.continues === undefined ? null : parentOf(o.continues, run, safeId(unit, 'unit'));
    const out = change(run, 'unit.add', (s) => {
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
      if (cont) addContinues(s, u, cont);
    }, { unit });
    if (cont) markParent(cont, run);
    return out;
  },
  freeze([run]) {
    return change(run, 'run.freeze', (s) => {
      if (!s.units.length) throw new Error('add units first');
      const missing = (s.continues ?? []).filter((c) => !s.units.some((u) => u.id === childId(c)));
      if (missing.length) throw new Error(`freeze refused: the run continues ${missing.map((c) => `${c.run}:${c.unit}`).join(', ')}; add ${missing.map(childId).join(', ')} (or add a unit with --continues <run>:<unit>)`);
      s.frozen = true;
    });
  },
  // A new build: the critic marks every behaviour again.
  start([run, unit], o) {
    const model = modelName(o.model, 'model'); const why = optText(o.why, 80);
    if (why && !model) throw new Error('--why goes with --model');
    const force = o['force-model'] === undefined ? null : text(o['force-model'] === true ? undefined : o['force-model'], 'reason for --force-model', 300);
    if (force && !model) throw new Error('--force-model goes with --model');
    const cfg = routing(baseDir('project'));
    return change(run, 'unit.start', (s) => {
      const u = unitOf(s, unit); expect(s, u, 'start');
      const esc = escalation(cfg, u);
      // After a cheap fail: --model at or above strong, or a cheaper one with --force-model "reason".
      if (esc && !(model && atLeast(model, cfg.strong))) {
        if (!force) throw new Error(`start refused: ${esc.why}; start with --model ${esc.model} (or a cheaper --model with --force-model "reason")`);
        s.notes.push({ kind: 'decision', text: `${u.id}: built on ${model} again (${esc.why}): ${force}`, at: now() });
      }
      u.status = 'building'; u.heartbeatAt = now(); reopen(u.behaviours);
      delete u.builtBy; delete u.builtWhy;
      // With routing on, an unnamed model is recorded as such, so pass rates stay honest.
      const builtBy = model ?? (cfg.on ? UNSPECIFIED : null);
      if (builtBy) { u.builtBy = builtBy; if (why) u.builtWhy = why; }
      log(u, 'start', `try ${u.rounds.length + 1}${model ? ` on ${model}${why ? ` (${why})` : ''}` : ''}`);
    }, { unit });
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
    const cont = o.continues === undefined ? null : parentOf(o.continues, run, safeId(unit, 'unit'));
    const out = change(run, 'unit.link', (s) => {
      const u = unitOf(s, unit);
      const add = [...refLinks(s, 'issue', o.issue), ...refLinks(s, 'pr', o.pr), ...refLinks(s, 'merge', o.merge)];
      if (o.url !== undefined) {
        const url = typeof o.url === 'string' ? webUrl(o.url.trim()) : null;
        if (!url || url.length > 500) throw new Error('--url must be an http(s) URL');
        add.push({ kind: 'other', url, label: optText(o.label, 120), at: now() });
      }
      if (cont) addContinues(s, u, cont);
      if (!add.length && !cont) throw new Error('give --issue, --pr, --merge, --url or --continues');
      (u.links ??= []).push(...add);
      for (const l of add) log(u, 'link', l.url, { link: l.kind });
    }, { closedOk: true, unit });
    if (cont) markParent(cont, run);
    return out;
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
      const judge = modelName(o.model, 'model');
      const rcfg = routing(baseDir('project'));
      if (judge && !judgeAllowed(rcfg, judge)) throw new Error(`verdict refused: critics are never routed down; ${judge} is below the strong model or not it (references/routing.md)`);
      const judgedBy = judge ? { judgedBy: judge } : (rcfg.on ? { judgedBy: UNSPECIFIED } : {});
      if (o.specialist !== undefined) { // a required second critic: recorded on this round, the unit stays judging
        const name = String(o.specialist);
        if (!(u.specialists ?? []).includes(name)) throw new Error(`no specialist ${name} on unit ${unit} (add --specialist)`);
        (u.specialistMarks ??= {})[name] = { verdict, score: score(o.score), gap, cause, evidence, ...(critic ? { critic } : {}), ...judgedBy, at: now() };
        return;
      }
      const missing = (u.specialists ?? []).filter((n) => u.specialistMarks?.[n]?.verdict !== 'pass');
      if (verdict === 'pass' && missing.length) throw new Error(`pass refused: specialist ${missing.join(', ')} has not passed this build`);
      const round = u.rounds.length + 1;
      if (verdict === 'pass' && s.paths?.length && !(u.detect?.round === round && u.detect.clean)) {
        throw new Error(`pass refused: no clean detect result for round ${round}; run detect.mjs --run ${s.id} --unit ${u.id} --base … first`);
      }
      const marks = mark(u.behaviours ?? [], o.behaviour, verdict);
      u.rounds.push({ n: round, verdict, score: score(o.score), gap, cause, evidence, at: now(), ...(marks.length ? { behaviours: marks } : {}), ...(u.report ? { report: u.report } : {}), ...(critic ? { critic } : {}), ...(u.builtBy ? { builtBy: u.builtBy, ...(u.builtWhy ? { builtWhy: u.builtWhy } : {}) } : {}), ...judgedBy, ...(u.specialistMarks ? { specialists: u.specialistMarks } : {}) });
      u.report = null; delete u.specialistMarks; delete u.builtBy; delete u.builtWhy;
      u.status = verdict === 'pass' ? 'pass' : 'open';
    }, { unit });
  },
  // The target branch was merged into this unit's branch: `next` stops asking until another overlapping unit merges.
  sync([run, unit], o) {
    return change(run, 'unit.sync', (s) => {
      const u = unitOf(s, unit);
      u.syncedAt = now();
      log(u, 'sync', optText(o.text, 200) ?? 'merged the target in');
    }, { unit });
  },
  // A unit at, or stopped by, its round budget gets N more rounds once the person approved them (#36).
  extend([run, unit], o) {
    const rounds = num(o.rounds, 1, 1, 4); // one unless the approval's words name more
    const reason = text(o.reason, 'reason', 300);
    return change(run, 'unit.extend', (s) => {
      const u = unitOf(s, unit);
      const atCap = u.status === 'stopped' ? u.stopReason === 'budget: rounds' : u.status === 'open' && u.rounds.length >= roundCap(u, s);
      if (!atCap) throw new Error(`extend refused: ${u.id} is ${u.status}${u.stopReason ? ` (${u.stopReason})` : ''}; extend only lifts a round budget the unit has used up`);
      // Only the person's explicit yes (lib/approval.mjs), given since the unit's last verdict, used once,
      // written by the answer or note command (never a hand edit: lib/provenance.mjs); the decision quotes it.
      const since = u.rounds.at(-1)?.at ?? s.createdAt;
      const events = readRun(runDir(run))?.log?.events ?? [];
      const written = (locate, kinds, what) => {
        const by = lastWriter(events, locate, s);
        if (!kinds.includes(by)) throw new Error(`extend refused: ${what} was last written by ${by ?? 'nothing in the log'}, not by ${kinds.join(' or ')} (a hand edit of state.json never approves)`);
      };
      let source; let words;
      if (o.answer !== undefined) {
        const q = questions(s).find((x) => x.id === String(o.answer));
        if (!q) throw new Error(`--answer: no question ${o.answer}`);
        if (q.unit !== u.id) throw new Error(`--answer: ${q.id} ${q.unit ? `is about ${q.unit}` : 'names no unit'}; an approving question must name ${u.id} (ask … --unit ${u.id})`);
        if (['used', 'decided'].includes(q.status)) throw new Error(`extend refused: ${q.id} is already ${q.status}; one approval is good for one extend: ask again`);
        const why = answerRefusal(q);
        if (why) throw new Error(`extend refused: ${why}`);
        if (q.answer.at < since) throw new Error(`extend refused: ${q.id} was answered before ${u.id}'s last verdict; ask again`);
        const qi = +q.id.slice(1) - 1; const hi = q.history.length - 1;
        written((st) => st?.notes?.filter((n) => n.kind === 'question')[qi]?.history?.[hi], ['answer'], `${q.id}'s answer`);
        written((st) => { const n = st?.notes?.filter((x) => x.kind === 'question')[qi]; return n && { approves: n.approves, unit: n.unit, options: n.options }; }, ['question'], `${q.id}`);
        const opt = q.options.find((x) => x.label === q.answer.choices[0]);
        words = [opt?.label, opt?.description, q.answer.confirm].filter(Boolean).join(' ');
        source = `${q.id} "${q.header ? `${q.header}: ` : ''}${clip(q.text, 160)}" answered "${q.answer.choices[0]}${opt?.description ? ` (${clip(opt.description, 120)})` : ''}" via ${q.answer.via}${q.answer.confirm ? `, their words: "${clip(q.answer.confirm, 200)}"` : ''}`;
      } else {
        const n = (s.notes ?? []).findLast((x) => x.kind === 'person' && x.unit === u.id && x.at >= since);
        if (!n) throw new Error(`extend refused: no approval from the person since ${u.id}'s last verdict; give --answer qN (a question on ${u.id} asked with --approves, answered by them), or they add a note on ${u.id} that says "approved"`);
        if (n.usedBy) throw new Error(`extend refused: their latest note on ${u.id} was already used by an extend; one approval is good for one extend`);
        const why = noteRefusal(n);
        if (why) throw new Error(`extend refused: ${why}; their latest note on ${u.id}: "${clip(n.text, 120)}"`);
        const ni = s.notes.indexOf(n);
        written((st) => st?.notes?.[ni], ['note'], 'their note');
        words = n.text;
        source = `their note via ${n.via}: "${clip(n.text, 300)}"`;
        n.usedBy = { unit: u.id, at: now() };
      }
      // One round unless their own words name more.
      const named = namedRounds(words);
      if (rounds > (named ?? 1)) throw new Error(`extend refused: --rounds ${rounds}, but the approval ${named ? `names ${named}` : 'names no number, so it is for one round'}`);
      u.extraRounds = (u.extraRounds ?? 0) + rounds;
      if (u.status === 'stopped') { u.status = 'open'; u.stopReason = null; }
      const scope = named ? `their words name ${named}` : 'their words name no number: one round';
      s.notes.push({ kind: 'decision', text: `${u.id}: ${rounds} more round${rounds === 1 ? '' : 's'} (now ${roundCap(u, s)}; ${scope}), approved by the person (${source}): ${reason}`, at: now(), ...(o.answer !== undefined ? { answers: String(o.answer) } : {}) });
      log(u, 'extend', `+${rounds} round${rounds === 1 ? '' : 's'}: ${reason}`);
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
      const judge = modelName(o.model, 'model');
      const rcfg = routing(baseDir('project'));
      if (judge && !judgeAllowed(rcfg, judge)) throw new Error(`integrate refused: the integrator is never routed down; ${judge} is below the strong model (references/routing.md)`);
      const j = judged(evidence, v, optText(o.gap, 500), optText(o.cause, 80));
      const marks = mark(s.goalBehaviours ?? [], o.behaviour, j.verdict);
      s.integration.rounds.push({ ...j, evidence, at: now(), ...(judge ? { judgedBy: judge } : (rcfg.on ? { judgedBy: UNSPECIFIED } : {})), ...(marks.length ? { behaviours: marks } : {}) });
    });
  },
  note([run], o) {
    const kind = oneOf(o.kind, ['situation', 'decision', 'follow-up', 'retro', 'question', 'bar', 'info', 'person', 'escape'], '--kind');
    if (o.confirm !== undefined && (kind !== 'person' || o.confirm !== true)) throw new Error('--confirm takes no value and goes with --kind person');
    if (kind === 'person') return change(run, 'note', (s) => personNote(s, { text: o.text, unit: o.unit, via: 'cli', confirm: o.confirm === true }), { unit: typeof o.unit === 'string' ? o.unit : null });
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
  gaps(_, o) {
    const list = gaps(loadRuns()).filter((g) => o.all || g.status === 'open');
    if (o.json) return list;
    process.stdout.write(gapsText(list));
    return null;
  },
  gap([verb, run, id], o) {
    const reopen = oneOf(verb, ['close', 'reopen'], 'gap close|reopen') === 'reopen';
    const reason = text(o.reason, 'reason', 500);
    const p = parseGapId(id);
    if (!p) throw new Error(`not a gap id: ${id} (run.mjs gaps lists them)`);
    if (p.run !== run) throw new Error(`gap ${id} belongs to run ${p.run}, not ${run}`);
    const found = gaps(loadRuns()).find((g) => g.id === id);
    if (!found) throw new Error(`no gap ${id} in run ${run} (run.mjs gaps --all lists them)`);
    if (!reopen && found.status === 'resolved' && !found.resolution.derived) throw new Error(`gap ${id} is already closed: ${found.resolution.reason}`);
    if (reopen && (found.status === 'open' || found.resolution.derived)) throw new Error(`gap ${id} was not closed by a note${found.status === 'resolved' ? ` (the state resolves it: ${found.resolution.reason})` : ''}`);
    return change(run, 'note', (s) => closeGap(s, id, { reason, by: o.by ?? 'lead', reopen }), { closedOk: true, unit: p.unit && load(run).units.some((u) => u.id === p.unit) ? p.unit : null });
  },
  ask([run], o) { let id; const s = change(run, 'question', (st) => { id = ask(st, o); }, { unit: typeof o.unit === 'string' ? o.unit : null }); return { ...s, asked: id }; },
  answer([run, id], o) {
    if (o.confirm !== undefined && o.by !== 'person') throw new Error('--confirm needs an explicit --by person');
    return change(run, 'answer', (s) => answer(s, id, { choices: o.choice ?? [], other: o.other === true ? null : o.other, by: o.by ?? 'person', via: 'cli', confirm: o.confirm === true ? '' : o.confirm }));
  },
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
        const v = view(s, decide(s), Date.now(), { repo: repoFor(s), linked: linkedOf(s) });
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
        '/answer': write('answer', (s, f) => { const id = f.get('q'); answer(s, id, { ...fromForm(find(s, id), f.getAll('choice'), f.get('other')), by: 'person', via: 'dashboard' }); return id; }),
        '/note': write('note', (s, f) => { personNote(s, { text: f.get('text'), unit: f.get('unit') || undefined, via: 'dashboard' }); return f.get('unit') ? `unit-${f.get('unit')}` : ''; }),
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
    const cfg = routing(baseDir('project'));
    const suggest = (u) => { const e = u.action === 'build' ? escalation(cfg, unitOf(s, u.id)) : null; return e ? { ...u, model: e.model, modelWhy: e.why } : u; };
    // A unit that changes files an already merged unit changed takes the target in first (#37).
    const syncs = pendingSyncs(s);
    const sync = (u) => (syncs.has(u.id) && ['build', 'judge', 'done'].includes(u.action) ? { ...u, sync: syncStep(s.id, u.id, syncs.get(u.id), u.action === 'done') } : u);
    return { decision: plan.decision, units: plan.units.map((u) => stopped.get(u.id) ?? sync(suggest(u))) };
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
  show([run]) { const s = load(run); process.stdout.write(textView(view(s, decide(s), Date.now(), { linked: linkedOf(s) }))); return null; },
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
    const loose = adopt(load(run), runDir(run), { project: projectDir(), home: homedir() }).filter((r) => ['adoptable', 'repairable', 'unclear'].includes(r.status));
    return loose.length ? Object.assign(closed, { warning: `${loose.length} file(s) the run mentions are not safely stored in its folder (outside it, damaged, or an unclear path); run: run.mjs adopt ${run} --dry-run` }) : closed;
  },
  adopt([run], o) {
    const dry = o['dry-run'] !== undefined;
    let rows;
    if (dry) rows = adopt(load(run), runDir(run), { project: projectDir(), home: homedir() });
    else change(run, 'evidence', (s) => { rows = adopt(s, runDir(run), { project: projectDir(), home: homedir(), apply: true }); }, { closedOk: true });
    const count = (k) => rows.filter((r) => r.status === k).length;
    console.log(rows.length ? table(rows) : 'no file paths mentioned');
    console.log(`${dry ? 'adoptable' : 'adopted'} ${count(dry ? 'adoptable' : 'adopted')}, ${dry ? 'repairable' : 'repaired'} ${count(dry ? 'repairable' : 'repaired')}, already ${count('already')}, inside ${count('inside')}, tracked ${count('tracked')}, missing ${count('missing')}, unclear ${count('unclear')}, refused ${count('refused')}`);
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
    if (!path) throw new Error('usage: run.mjs touches <run> <path> [--json] [--unit U]');
    if (o.unit !== undefined) {
      const p = normPath(path);
      if (!p || p.length > 300 || p.split('/').includes('..') || /^[A-Za-z]:|^\//.test(p)) throw new Error('--unit records a path relative to the project root');
      change(run, 'unit.touches', (s) => {
        const u = unitOf(s, o.unit);
        if (!(u.touches ?? []).includes(p)) { (u.touches ??= []).push(p); log(u, 'touches', p); }
      }, { unit: String(o.unit) });
      if (!hasMap(runDir(run))) { const note = { recorded: p, unit: String(o.unit), map: 'none yet: run map for what it touches' }; if (o.json === true) return note; console.log(JSON.stringify(note)); return null; }
    }
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
    const runs = commands.list().filter((r) => !r.error && r.closed && (!o.tag || r.tag === o.tag)).map((r) => load(r.run));
    return { ...stats(runs), ...byModel(runs) };
  },
  // The routing table (references/routing.md), or the model for one role and task class.
  models(_, o) {
    const cfg = routing(baseDir('project'));
    for (const w of cfg.warnings) console.error(`warning: ${w}`);
    if (o.role === undefined) return cfg;
    return { role: o.role, class: o.class ?? null, ...route(cfg, String(o.role), typeof o.class === 'string' ? o.class : null) };
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!commands[cmd]) { console.error('usage: run.mjs init|models|add|behave|behaviours|evidence|link|freeze|start|beat|built|reset|extend|sync|verdict|strategy|integrate|note|study|self|ask|answer|use-answer|questions|serve|watch|next|show|hud|map|touches|brief|close|gaps|gap|push|pull|adopt|list|stats|where … (see the header of run.mjs)'); process.exit(2); }
try {
  const { pos, opt } = parse(rest, FLAGS[cmd] ?? [], REPEAT[cmd]);
  const out = commands[cmd](pos, opt);
  if (out !== null) console.log(JSON.stringify(out.id === undefined || ['models', 'next', 'list', 'stats', 'where', 'hud', 'questions', 'behaviours', 'self', 'gaps', 'push', 'pull', 'map', 'touches'].includes(cmd) ? out : { ok: true, run: out.id, decision: decide(out).decision, ...(out.asked ? { asked: out.asked } : {}), ...(out.study ? { study: out.study } : {}), ...(out.behaviour ? { behaviour: out.behaviour } : {}), ...(out.evidence ? { evidence: out.evidence } : {}), ...(out.warning ? { warning: out.warning } : {}) }, null, 2));
} catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
