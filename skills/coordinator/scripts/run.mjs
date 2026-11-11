#!/usr/bin/env node
// The coordinator's run state: one JSON file per run, written only through here.
// Each step is refused unless the loop asked for it (see allows() in lib/rules.mjs).
//
//   run.mjs init <run> --goal G --bar B --fence F [--alias "the name you use"] [--paths a,b] [--tag T] [--max-rounds 4]
//                      [--max-minutes 240] [--max-units 6] [--max-added 2] [--stale-minutes 45]
//                      [--max-launch-minutes N] [--max-launch-cost "0.50 USD"] caps for one agent launch: next passes
//                      them on (launch), and a launch reported over one is noted on its unit (guardrails.md)
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
//   run.mjs add-specialist <run> <unit> <name> --reason R   a critic that must also pass, added after add: required from the
//                  unit's next build on (or the one being judged), refused once the unit passed or stopped; logged as a decision
//   run.mjs behave <run> <unit>|--goal [--id B1] --text T | --id B1 --remove   add, reword (back to unchecked) or remove
//   run.mjs behaviours <run>        every behaviour of the goal and the units, with status and evidence
//   run.mjs evidence <run> <unit>|--goal [--behaviour B1] (--text T | --file path | --url U) --kind test|screenshot|log|link|reins [--label L]
//   run.mjs link <run> <unit> [--issue … ] [--pr …] [--merge URL [--same-tree T]] [--url U --label L]   GitHub issues, PRs and merges;
//                  --same-tree: the merged tree is the reviewed head merged with the target, so no post-merge re-check (recorded)
//                  [--continues <run>:<unit>]  record afterwards that this unit continues that one (any id; closed runs too)
//   run.mjs extend <run> <unit> [--rounds N] --reason R [--answer qN]   N (1-4, default 1; above 1 only when their words name it) more rounds for a unit
//                  at or stopped by its round budget: qN asked with --approves and answered with that option by the
//                  person (dashboard, web, or answer --by person --confirm "their words"), or else their note on
//                  the unit since its last verdict saying "approved" (lib/approval.mjs); recorded as a decision
//   run.mjs ship <run> <unit> --merge URL --reason R (--confirm "their words" | --answer qN)   a unit merged on the person's
//                  decision with no final verdict (open, building, judging or stopped): ends shipped ("Shipped without a final
//                  verdict"; delivered, never a clean pass), links the merge, and files the missing verdict and its last round's
//                  open findings as follow-ups; without --confirm or --answer, their latest note on the unit (lib/approval.mjs)
//   run.mjs freeze <run>
//   Cost (start, built, verdict, foldin): [--tokens-in N --tokens-out N --minutes M --cost "0.42 USD"], what the harness
//                  reported for that launch; stats, show and the HUD sum them per unit, model and run ("not recorded" when missing)
//   --accept-open (init, add, behave): keep a goal, bar or behaviour line that reads open-ended (lib/openbar.mjs), recorded as a bar note
//   run.mjs start <run> <unit> [--model M] [--why W]   only when next says build, or check-stale with phase building;
//                  M: the model that builds this try, W: the task class that chose it (e.g. docs-only);
//                  after a try failed on a model below strong, a model below strong needs [--force-model "reason"]
//   run.mjs beat <run> <unit> [--text T]     builder or critic still working (T: the milestone, e.g. "pushed"); on an open unit
//                  (work started early, e.g. a stacked unit begun at the person's request) only logged, marked early
//   run.mjs built <run> <unit> [--report R]  builder finished (R: its report in short): the unit waits for a critic
//                  [--head <sha>] the commit the builder reported (the reviewed head for fold-ins, unless verdict --head names one)
//   run.mjs reset <run> <unit> --reason R     in-progress unit with no artifact goes back to build (after a crash)
//   run.mjs verdict <run> <unit> pass|fail --evidence E [--gap G] [--cause C] --score 0-10   only after built;
//                  score and gap required on fail; cause is the critic's root-cause tag (drives same-gap);
//                  on a run with --paths, pass needs a clean detect.mjs --unit result;
//                  [--behaviour B1=pass:"evidence" | B1=fail:"gap" …]: a pass needs every behaviour passing
//                  [--model M] the model that judged (refused below the strong model while routing is on)
//                  [--critic SETUP] who judged (e.g. "review skill high + security"): stats groups escapes by it
//                  [--specialist NAME] a required second critic's verdict on this build (add --specialist a,b);
//                  the unit stays judging, and its pass is refused until every required specialist passed
//                  --severity high|medium on a fail (required; a low or nit never fails: pass with --fold instead)
//                  [--finding "<high|medium|low|nit>: …" …] each FINDINGS line; the fail's severity is the worst; a pass lists none high or medium
//                  [--fold "…" …] on a pass: lows and nits ("nit: …") folded in before merge; never one in a pinned area; next then says fold-in
//                  [--full-suite yes|no] whether the critic ran the full suite this round
//                  [--head <sha>] the commit the critic judged; a specialist may mark a round the general fail just closed
//   run.mjs verdict <run> <unit> pass|fail --early --score N --evidence E [--gap G --severity S] [--specialist NAME] [--head <sha>]
//                  an early review of work on an open or building unit (started before its try): recorded apart, never a
//                  round, moves and passes nothing; next, show and the unit page list it (early)
//   run.mjs foldin <run> <unit> --head <sha> --evidence E [--reviewed <sha>]   only when next says fold-in: the targeted check
//                  of the folds (no new critic round). The head must build on the reviewed one, stay under init's
//                  --fold-max-files (10) and --fold-max-lines (200), and have a clean detect.mjs run on it; next then says done, step merge
//   run.mjs strategy <run> <unit> --text T                          only when next says change-strategy
//   run.mjs integrate <run> pass|fail --evidence E [--gap G] [--cause C] [--behaviour G1=pass:"…" …] [--model M]
//                  only when next says integrate; a pass needs every goal behaviour passing
//   run.mjs note <run> --kind situation|decision|follow-up|retro|question|bar|info|person|escape --text T
//                  escape: --unit U, a passed unit where a defect turned up later (a later review, verify, test, a person); counted by stats
//                  [--recommend R] (question: the lead's pick) [--answers qN] (decision: closes question N)
//                  [--unit U] (person: a note from the person about one unit; decision, follow-up, info: scoped to that unit,
//                  shown on its page) [--confirm] (person: their words, pasted)
//   run.mjs brief <run> [<unit>] --role builder|critic|integrator [--quote file … --source label …] [--where W] [--playbook P]
//                  prints the brief; each quoted file is fenced as data, and the goal, bar and fence follow it.
//                  [--lessons N] the top N lessons for the run's tag ride along as hints (default 5, 0 for none),
//                  fenced as data too; a lesson counts as used once per run
//   run.mjs ask <run> --question Q --header H --option "label|description" (2-4, recommended first) [--multi] [--unit U]
//                  [--approves <label>] the option that approves a step only the person may approve (extend)
//   run.mjs ask <run> --finish <unit>   only when next says ask-person: the ready finish-line question (ship with follow-ups,
//                  one more round, stop); next acts on the person's pick
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
//   run.mjs gaps --check [--run R] [--dry-run]   asks GitHub through gh (opt-in; the gaps view's only network call)
//                  whether a stopped unit's own PR merged (closes it, links the merge) and whether an unverified
//                  tracked ref exists (closes it), each with a decision note "checked on <date>: …";
//                  --dry-run lists them and changes nothing; no gh, or not signed in: says so, changes nothing
//   run.mjs gap close|reopen <run> <id> --reason R [--by lead | --by person --confirm "their words"]   closes (or
//                  reopens) one gap: a decision note in that run's log (closed runs too); the id as gaps prints it
//   run.mjs serve <run> [--port P]  the live dashboard (forms, unit pages, live updates) on 127.0.0.1, behind a per-start token;
//                  /maps the run's maps, /coordinator the self view, /run/<other> another run read-only
//   run.mjs watch <run> [--remote [--every S]]   one line per new or changed answer and per note from the person; never exits.
//                  --remote also pulls the run from its state branch every S seconds (10-60, default 30), and at once
//                  when the service's doorbell rings (COORDINATOR_SERVICE); lines starting "remote:" are about that link
//   run.mjs next <run>     prints what to do and records any stops
//   run.mjs show <run>     prints the compact text HUD (status, progress, ETA, situation, needs you, units, budget, next step)
//   run.mjs status-line [<run>] [--json]   the one line the lead posts at each milestone ("payday-x · Running: 2 of 4 units
//                          done (50%), building u3 round 2, about 1 h left (~21:40). Nothing needs you."), the closing
//                          line once the run concluded; with no run, one line per run, active first (lib/progress.mjs)
//   run.mjs hud <run>      rewrites hud.html, maps.html and units/<unit>.html beside state.json now and prints its path
//                          (every change rewrites it too, with workbench.md)
//   run.mjs close <run> --outcome done|partial|stopped [--reason R]   reason required when closing before the rules end the run;
//                  warns when files the run mentions are not adopted yet
//   run.mjs report <run> [--draft | --file notes.md [--i-checked]]   the run's report (report.html, /report): --draft reads PRs, merges,
//                  migrations, env vars, scripts and jobs from the state and git into a draft; --file stores the
//                  lead's release notes (Markdown) in the run; with neither, says what is stored
//   run.mjs quality <run> | --project [--json]   code quality and compliance signals (duplication, structure, naming,
//                  redundancy, security, privacy) on the run's changed files and the whole project; with a run,
//                  stored as quality.json for the report (references/quality.md)
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
//   run.mjs calls <run> <unit> [--base ref --head ref | --files a,b] [--root dir] [--json]   the JS/TS functions the unit's
//                  diff touched (default: its recorded detect base and head), what they call and what calls them; shown
//                  on the unit page and the maps page's Calls view; map --unit U computes it for U too
//   run.mjs sync <run> <unit> [--text T]   the target branch was merged into the unit's branch (after `next` asked)
//   run.mjs models [--role builder|critic|… --class docs,auth]   the routing table, or the model for one role and task class
//   run.mjs list | stats [--tag T] | where      list: every run with its status word, progress, ETA and status line;
//                  where prints the state folder for briefs (COORDINATOR_DIR)
//   run.mjs push <run> [--to branch|./folder] [--message M]   pit stops only (a unit merged, a decision
//                  recorded, the run closed): the run's events, snapshot and README, project lessons and
//                  stats, masked, to the coordinator-state branch (never main; a public repo needs a
//                  private companion repo, references/durability.md); "visibility" in .coordinator/coordinator.json,
//                  else gh is asked, else refused (the refusal, and init while it is unset, name the file and key)
//   run.mjs pull <run> [--from branch|./folder]   restores the run on another machine, or appends the
//                  copy's newer events; never overwrites local events the copy lacks. After the lead's own
//                  later events, it replays the copy's extra answers and person notes (nothing else) on top
//   run.mjs list --all     every run on this PC from the register (~/.coordinator/registry.json), by project
//   run.mjs dashboard [--port P] [--open] | dashboard stop   the live page of every run on this PC (default port 7480);
//                  a running one prints its link instead of starting another (references/hud.md)
//   --harness NAME (any command): the tool running it (claude-code, codex, antigravity, gemini …); else
//                  COORDINATOR_HARNESS, else detected. Every write stamps the run with it and the skill version
// Every change appends one event to the run's events.jsonl; state.json is a snapshot derived from it.
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawn as spawnProcess } from 'node:child_process';
import { get as httpGet } from 'node:http';
import { basename, extname, join, resolve } from 'node:path';
import { helpAndExit, num, oneOf, optText, parse, score, text } from './lib/args.mjs';
import { behave, mark, reopen } from './lib/behaviours.mjs';
import { addEvidence, artifact, openStored, storedPath } from './lib/evidence.mjs';
import { adopt, table } from './lib/adopt.mjs';
import { homedir } from 'node:os';
import { buildBrief } from './lib/briefs.mjs';
import { markUsed, topLessons } from './lib/lessonstore.mjs';
import { allows, decide, decideUnit, earlySummary, FAILING, FINISH, finishQuestion, openFindings, requiredOn, roundCap, SEVERITIES, stats } from './lib/rules.mjs';
import { COST_FLAGS, costEntry, costStats, launchCost, overLaunch } from './lib/cost.mjs';
import { openWarning } from './lib/openbar.mjs';
import { checkFold, FOLD_DEFAULTS, foldDiff, parseFinding } from './lib/findings.mjs';
import { childId, continuesOf, linkedRuns, parseContinues } from './lib/chain.mjs';
import { answerRefusal, decisionRefusal, namedRounds, noteRefusal } from './lib/approval.mjs';
import { lastWriter } from './lib/provenance.mjs';
import { clip } from './lib/plain.mjs';
import { ordered, runStatus } from './lib/progress.mjs';
import { normPath, pendingSyncs, syncStep } from './lib/overlap.mjs';
import { harnessOf, stamp } from './lib/harness.mjs';
import { entryFor, projectKey, readRegistry, register, registryFile, registryHome } from './lib/registry.mjs';
import { PROJECT_PAGE, pcModel, pcPage, pcVersion, projectPage } from './lib/dashboard.mjs';
import { pathToFileURL } from 'node:url';
import { EVENTS, loadRun, readRun, updateRun } from './lib/events.mjs';
import { pull, push, VISIBILITY_HINT } from './lib/statesync.mjs';
import { bellConfig, listen } from './lib/doorbell.mjs';
import { remoteWatch } from './lib/remote.mjs';
import { atLeast, byModel, escalation, judgeAllowed, modelName, route, routing, setRouting, UNSPECIFIED } from './lib/models.mjs';
import { baseDir, isSafeId, projectDir, safeId, withLock, writeAtomic } from './lib/store.mjs';
import { hud, liveCtx, staticCtx } from './lib/hud.mjs';
import { githubRef, inferRepo, REPO, repoFromText, webUrl } from './lib/links.mjs';
import { readSettings, settingsFile } from './lib/settings.mjs';
import { load as loadTheme, themeFile } from './lib/theme.mjs';
import { log } from './lib/timeline.mjs';
import { unitPage } from './lib/unitpage.mjs';
import { mapsPage } from './lib/mapspage.mjs';
import { reportFor, reportPages, storeReport } from './lib/report/cli.mjs';
import { hasRetro, retroCommand } from './lib/retro.mjs';
import { answer, answerText, ask, events, find, fromForm, personNote, questions, useAnswer } from './lib/questions.mjs';
import { serve } from './lib/serve.mjs';
import { selfModel, selfText } from './lib/self.mjs';
import { gapsCheckFile, loadRuns, loadSelf, selfVersion } from './lib/selfdata.mjs';
import { planCheck } from './lib/gapcheck.mjs';
import { closeGap, gaps, gapsText, parseGapId } from './lib/gaps.mjs';
import { selfPage } from './lib/selfpage.mjs';
import { addStudy } from './lib/study.mjs';
import { text as textView, view } from './lib/view.mjs';
import { render } from './lib/workbench.mjs';
import { build as buildMap, callsText, computeCalls, defaultDest, hasMap, mapAttach, mapHtml, mapNav, mapRestore, mapView, pitStop, readCalls, touchesOf, unitFiles } from './lib/map/index.mjs';

const FLAGS = {
  init: ['alias', 'goal', 'bar', 'fence', 'paths', 'tag', 'max-rounds', 'max-minutes', 'max-units', 'max-added', 'stale-minutes', 'max-launch-minutes', 'max-launch-cost', 'repo', 'theme', 'study-budget', 'models', 'continues', 'accept-open', 'fold-max-files', 'fold-max-lines'],
  extend: ['rounds', 'reason', 'answer'], 'add-specialist': ['reason'],
  start: ['model', 'why', 'force-model', 'force-start', 'reason', ...COST_FLAGS], models: ['role', 'class'], foldin: ['head', 'reviewed', 'evidence', ...COST_FLAGS],
  study: ['topic', 'area', 'text', 'source', 'lesson', 'by'], self: ['json', 'html'], gaps: ['json', 'all', 'check', 'run', 'dry-run'], gap: ['reason', 'by', 'confirm'],
  add: ['bar', 'after', 'reason', 'title', 'link', 'issue', 'pr', 'behaviour', 'specialist', 'continues', 'accept-open'], verdict: ['evidence', 'gap', 'cause', 'score', 'behaviour', 'critic', 'specialist', 'model', 'severity', 'finding', 'fold', 'full-suite', 'head', 'early', ...COST_FLAGS], strategy: ['text'], ship: ['merge', 'reason', 'answer', 'confirm'],
  integrate: ['evidence', 'gap', 'cause', 'behaviour', 'model'], beat: ['text'], built: ['report', 'head', ...COST_FLAGS],
  behave: ['goal', 'id', 'text', 'remove', 'reason', 'accept-open'], evidence: ['goal', 'behaviour', 'text', 'file', 'url', 'kind', 'label'],
  link: ['issue', 'pr', 'merge', 'url', 'label', 'continues', 'same-tree'], note: ['kind', 'text', 'recommend', 'answers', 'unit', 'confirm'],
  ask: ['question', 'header', 'option', 'multi', 'unit', 'approves', 'finish'], answer: ['choice', 'other', 'by', 'confirm'], serve: ['port'], watch: ['remote', 'every'], map: ['root', 'max-seconds', 'unit', 'pit-stop', 'dest', 'fresh', 'force', 'reset-stage'], touches: ['json', 'unit'], calls: ['root', 'base', 'head', 'files', 'max-seconds', 'json'], sync: ['text'], close: ['outcome', 'reason'], adopt: ['dry-run'], report: ['draft', 'file', 'i-checked'], quality: ['project', 'json'], stats: ['tag'], reset: ['reason'],
  brief: ['role', 'quote', 'source', 'where', 'playbook', 'lessons'], dashboard: ['port', 'open'], list: ['all'], 'status-line': ['json'],
  push: ['to', 'message'], pull: ['from'],
};
// Notes about one unit (#45): scoped with --unit, shown on its page.
const UNIT_NOTES = ['decision', 'follow-up', 'info'];
const REPEAT = { init: ['continues'], study: ['source', 'lesson'], ask: ['option'], answer: ['choice'], add: ['behaviour', 'issue', 'pr'], verdict: ['behaviour', 'fold', 'finding'], integrate: ['behaviour'], link: ['issue', 'pr', 'merge'], brief: ['quote', 'source'] };

// Stops cascade (a stopped unit stops the units stacked on it): apply until nothing changes.
function applyStops(st) {
  const stopped = new Map();
  for (let changed = true; changed;) {
    changed = false;
    for (const u of decide(st).units) if (u.action === 'stop') {
      const unit = st.units.find((x) => x.id === u.id); unit.status = 'stopped'; unit.stopReason = u.reason; log(unit, 'stop', u.reason);
      stopped.set(u.id, u); changed = true;
    } else if (u.action === 'ship') { // the person chose to ship at the finish line: every open finding becomes a follow-up
      const unit = st.units.find((x) => x.id === u.id); const last = unit.rounds.at(-1);
      const open = openFindings(last);
      unit.status = 'pass'; unit.shipped = { answer: u.answer, round: unit.rounds.length, score: last?.score ?? null, findings: open.length, at: now() };
      st.notes.push({ kind: 'decision', answers: u.answer, text: `${unit.id}: shipped with follow-ups (score ${last?.score ?? 'none'}), the person's choice at the finish line (${u.answer}); ${open.length} open finding${open.length === 1 ? '' : 's'} filed as follow-ups`, at: now() });
      for (const f of open) st.notes.push({ kind: 'follow-up', unit: unit.id, shipped: u.answer, text: `${unit.id} (shipped, ${f.severity}${f.by === 'critic' ? '' : `, ${f.by}`}): ${f.text}`, at: now() });
      log(unit, 'ship', `shipped with follow-ups (${u.answer})`);
      stopped.set(u.id, { id: u.id, action: 'done', step: 'merge', reason: `shipped with follow-ups (${u.answer})` }); changed = true;
    } else if (u.action === 'one-more') { // the person chose one more round: recorded like extend, then the usual rules decide
      const unit = st.units.find((x) => x.id === u.id);
      const lifted = unit.rounds.length >= roundCap(unit, st);
      if (lifted) unit.extraRounds = (unit.extraRounds ?? 0) + 1;
      const q = (st.notes ?? []).filter((n) => n.kind === 'question')[Number(u.answer.slice(1)) - 1];
      const a = q?.history?.at(-1);
      st.notes.push({ kind: 'decision', answers: u.answer, text: `${unit.id}: one more round${lifted ? ` (now ${roundCap(unit, st)})` : ''}, the person's choice at the finish line (${u.answer} answered "${a?.choices?.[0] ?? ''}" via ${a?.via ?? 'unknown'}${a?.confirm ? `, their words: "${String(a.confirm).slice(0, 200)}"` : ''}); the same-gap and no-progress rules still apply`, at: now() });
      log(unit, 'extend', `one more round (${u.answer})`);
      changed = true;
    }
  }
  return stopped;
}

// An open-ended goal, bar or behaviour line warns (lib/openbar.mjs); --accept-open keeps it and records that.
function openCheck(lines, accept, notes) {
  const warning = openWarning(lines);
  if (!warning) return null;
  if (accept === undefined) return warning;
  if (accept !== true) throw new Error('--accept-open takes no value');
  notes.push({ kind: 'bar', text: `kept an open-ended line on purpose: ${lines.map((l) => `${l.what}: "${String(l.text).slice(0, 160)}"`).join('; ')}`, at: now() });
  return null;
}
// A launch over the run's per-launch cap (init --max-launch-minutes / --max-launch-cost) is noted on the unit, not refused.
const launchCaps = (s) => (s.budget?.launchMinutes || s.budget?.launchCost ? { minutes: s.budget.launchMinutes ?? null, cost: s.budget.launchCost ?? null } : null);
const addCost = (s, u, entry) => {
  if (!entry) return;
  (u.costs ??= []).push(entry);
  const over = overLaunch(entry, launchCaps(s));
  if (over.length) s.notes.push({ kind: 'info', unit: u.id, text: `${u.id}: the ${entry.role} launch (${entry.step}) took ${over.join(' and ')}`, at: entry.at });
};

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
  const calls = readCalls(runDir(s.id)); // per-unit function calls (map/calls/), when computed
  writeAtomic(join(runDir(s.id), 'maps.html'), mapsPage(v, Date.now(), { ...staticCtx(runDir(s.id), 0, theme), calls }));
  for (const u of s.units) writeAtomic(join(runDir(s.id), 'units', `${u.id}.html`), unitPage(v, u.id, Date.now(), { ...staticCtx(runDir(s.id), 1, theme), calls }));
  for (const [name, html] of reportPages(s, v, runDir(s.id), staticCtx(runDir(s.id), 0, theme))) writeAtomic(join(runDir(s.id), name), html);
  registerRun(s);
  writeSnapshot();
}

// coordinator.html in the state folder: the coordinator page as a file, rewritten after every change to a
// run, so it is never older than the last change (about half a second on a 39 MB folder). It reads every
// run of this folder under the snapshot's own lock, so of two writers at once the later one, which read
// the later state, writes last. The PC's runs come from the register alone. The live page is run.mjs dashboard.
const snapshotFile = () => join(baseDir('project'), 'coordinator.html');
function writeSnapshot() {
  const file = snapshotFile();
  try {
    withLock(file, () => {
      const t = Date.now();
      const m = { ...selfModel({ ...loadSelf(), current: null }), pc: pcModel(readRegistry(), { here: baseDir('project'), read: false }) };
      const ctx = { ...staticCtx(null, 0, loadTheme(themeFile({}, projectDir()))), runHref: (id) => `runs/${encodeURIComponent(id)}/hud.html`, pcHref: staticPcHref };
      writeAtomic(file, selfPage(m, t, ctx));
    });
    return file;
  } catch (e) { console.error(`warning: ${file} was not rewritten: ${e.message}`); return null; }
}

// The runs of this folder the register does not know yet (from before it): registered once, from their state as it is.
function registerFolder() {
  if (process.env.COORDINATOR_REGISTRY === 'off' || !existsSync(runsDir())) return;
  const known = new Set(readRegistry().filter((e) => e.key === projectKey(baseDir('project'))).map((e) => e.run));
  for (const id of readdirSync(runsDir()).filter((d) => isSafeId(d) && !known.has(d) && exists(d))) {
    try { registerRun(loadRun(runDir(id))); } catch { /* unreadable: list says so */ }
  }
}
// On disk, a registered run links to its own hud.html: beside this file, or a file: URL into its project.
const staticPcHref = (key, run) => {
  const e = readRegistry().find((x) => x.key === key && x.run === run);
  if (!e) return null;
  return projectKey(baseDir('project')) === key ? `runs/${encodeURIComponent(run)}/hud.html` : pathToFileURL(join(e.stateDir, 'runs', run, 'hud.html')).href;
};

// list --all: every run on this PC from the register (lib/registry.mjs), grouped by project, each read now.
function listAll(flag) {
  if (flag !== true) throw new Error('--all takes no value');
  registerFolder();
  const pc = pcModel(readRegistry({ prune: true }), { here: baseDir('project') });
  return pc.groups.map((g) => ({
    project: g.project, stateDir: g.stateDir, here: g.key === pc.here,
    runs: g.runs.map((r) => ({
      run: r.run, ...(r.alias ? { alias: r.alias } : {}), title: r.title ?? null, harness: r.origin?.harness ?? r.harness ?? null, skill: r.origin?.skill ?? r.skill ?? null,
      origin: r.origin?.line ?? null, ...(r.origin?.warning ? { warning: r.origin.warning } : {}), lastSeen: r.lastSeen,
      ...(r.error ? { error: r.error } : { status: r.status.word, line: r.status.line }),
    })),
  }));
}

// The machine-wide register (lib/registry.mjs): every write keeps this run listed for list --all and
// the global dashboard. It never fails the write; COORDINATOR_REGISTRY=off leaves it alone.
function registerRun(s) {
  if (process.env.COORDINATOR_REGISTRY === 'off') return;
  try { register(entryFor(s, { project: projectDir(), stateDir: baseDir('project') })); } catch (e) { console.error(`warning: the run register (${registryFile()}) was not updated: ${e.message}`); }
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
  return updateRun(runDir(run), { kind, unit, by: BY }, (s) => { if (s.closed && !closedOk) throw new Error(`run ${run} is closed`); mutate(s); }, derived);
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

// A unit's calls: --base/--head, else the base and head its detect run recorded, else the files
// a map build tagged with it changed (or --files). Refs must be commits, never options.
function unitCallsFor(run, s, unit, { root, base, head, files = [], deadline }) {
  const u = unitOf(s, unit);
  const ref = (r, name) => { if (r === undefined || r === null) return null; if (typeof r !== 'string' || !r || r.startsWith('-') || /\s/.test(r)) throw new Error(`bad --${name}: ${r}`); return r; };
  let b = ref(base, 'base'); let h = ref(head, 'head');
  if (!b !== !h) throw new Error('--base and --head go together');
  if (!b && !files.length && u.detect?.base && u.detect?.head) { b = u.detect.base; h = u.detect.head; }
  const fromMap = files.length ? [] : unitFiles(runDir(run), u.id); // also the fallback when the diff's commits are gone
  if (!b && !files.length && !fromMap.length) return null; // nothing recorded to say what the unit changed
  return computeCalls(runDir(run), { root, unit: u.id, base: b, head: h, files: files.length || b ? files : fromMap, fallbackFiles: fromMap, source: files.length ? 'files' : 'map build', deadline });
}

// Checks that what approves a step was last written by one of `kinds` of event (the answer, question or
// note command), never by a hand edit of state.json (lib/provenance.mjs).
function writtenBy(run, s, cmd) {
  const events = readRun(runDir(run))?.log?.events ?? [];
  return (locate, kinds, what) => {
    const by = lastWriter(events, locate, s);
    if (!kinds.includes(by)) throw new Error(`${cmd} refused: ${what} was last written by ${by ?? 'nothing in the log'}, not by ${kinds.join(' or ')} (a hand edit of state.json never approves)`);
  };
}

// The finish line's ready question (lib/rules.mjs), logged on the unit only when `next` asks for it.
function askFinish(run, o) {
  if (typeof o.finish !== 'string') throw new Error('--finish takes the unit: ask <run> --finish <unit>');
  for (const k of ['question', 'header', 'option', 'multi', 'unit', 'approves']) if (o[k] !== undefined) throw new Error(`--${k} does not go with --finish: the question is ready-made`);
  let id;
  const s = change(run, 'question', (st) => {
    const u = unitOf(st, o.finish);
    const d = decideUnit(u, st, Date.now());
    if (d.action !== 'ask-person' || d.asked) throw new Error(`ask --finish refused: next says "${d.action}"${d.asked ? ` (already asked as ${d.asked})` : ''} for ${u.id}`);
    const q = finishQuestion(u);
    id = ask(st, { question: q.question, header: q.header, option: q.options, unit: u.id });
    st.notes.filter((n) => n.kind === 'question').at(-1).finish = true;
  }, { unit: String(o.finish) });
  return { ...s, asked: id };
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
        foldFiles: num(o['fold-max-files'], FOLD_DEFAULTS.files, 1, 100), foldLines: num(o['fold-max-lines'], FOLD_DEFAULTS.lines, 1, 5000),
      },
      createdAt: now(), frozen: false, addedAfterFreeze: 0, units: [], notes: [], integration: { rounds: [] }, closed: null,
    };
    // Caps for one agent launch (guardrails.md): off unless given here or in budgets.launchMinutes / launchCost.
    const launchMin = o['max-launch-minutes'] ?? asArg(b.launchMinutes);
    if (launchMin !== undefined) fresh.budget.launchMinutes = num(launchMin, undefined, 1, 600);
    const launchMoney = o['max-launch-cost'] ?? (typeof b.launchCost === 'string' ? b.launchCost : undefined);
    if (launchMoney !== undefined) fresh.budget.launchCost = launchCost(launchMoney);
    const parents = (o.continues ?? []).map((raw) => parentOf(raw, run));
    if (new Set(parents.map((c) => c.unit)).size < parents.length) throw new Error('--continues: one earlier run per unit id (continue a second one with add <run> <unit> --continues)');
    if (parents.length) fresh.continues = parents;
    if (o.alias !== undefined) fresh.alias = text(o.alias, 'alias', 80);
    if (o.repo !== undefined) { if (typeof o.repo !== 'string' || !REPO.test(o.repo)) throw new Error('--repo must be owner/name'); fresh.repo = o.repo; }
    if (o.theme !== undefined) {
      const f = typeof o.theme === 'string' ? resolve(o.theme) : '';
      if (!f || extname(f).toLowerCase() !== '.css' || !existsSync(f) || !statSync(f).isFile()) throw new Error('--theme must be an existing .css file');
      fresh.theme = f;
    }
    const warning = openCheck([{ what: 'the goal', text: fresh.goal }, { what: 'the bar', text: fresh.bar }], o['accept-open'], fresh.notes);
    const made = updateRun(runDir(run), { kind: 'run.init', by: BY }, (s) => { if (s) throw new Error(`run exists: ${run}`); return fresh; }, derived);
    if (routeOn !== undefined) setRouting(baseDir('project'), routeOn); // only once the run exists
    for (const c of parents) markParent(c, run);
    // push needs to know whether the repo is public; say where to put it now, not at the first pit stop (#66).
    const st = settings();
    const setup = st.visibility === undefined && st.state !== 'local' && !st.stateRepo ? `before push: gh is asked whether this repo is public, and the push is refused when it cannot say. ${VISIBILITY_HINT(settingsFile(baseDir('project')))}` : null;
    return Object.assign(made, warning ? { warning } : {}, setup ? { setup } : {});
  },
  add([run, unit], o) {
    const cont = o.continues === undefined ? null : parentOf(o.continues, run, safeId(unit, 'unit'));
    let warning = null;
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
      warning = openCheck([{ what: `${unit}'s bar`, text: u.bar }, ...(u.behaviours ?? []).map((b) => ({ what: `${unit} ${b.id}`, text: b.text }))], o['accept-open'], s.notes);
    }, { unit });
    if (cont) markParent(cont, run);
    return warning ? Object.assign(out, { warning }) : out;
  },
  // A required second critic for a unit added without it (#45): it judges the build being judged now,
  // or the next one; a round that closed before it was added never waits on its mark.
  'add-specialist'([run, unit, name], o) {
    const who = safeId(name, 'specialist');
    const reason = text(o.reason, 'reason', 300);
    return change(run, 'unit.specialist', (s) => {
      const u = unitOf(s, unit);
      if (['pass', 'stopped'].includes(u.status)) throw new Error(`add-specialist refused: ${u.id} is ${u.status}; a specialist joins before the unit's verdict`);
      if ((Date.now() - Date.parse(s.createdAt)) / 60_000 > s.budget.maxMinutes) throw new Error('add-specialist refused: the time budget is spent; it stops new critics');
      if ((u.specialists ?? []).includes(who)) throw new Error(`${u.id} already has specialist ${who}`);
      u.specialists = [...(u.specialists ?? []), who];
      (u.specialistFrom ??= {})[who] = u.rounds.length + 1;
      s.notes.push({ kind: 'decision', unit: u.id, text: `${u.id}: specialist ${who} added, required from round ${u.rounds.length + 1}: ${reason}`, at: now() });
    }, { unit });
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
    if (o['force-start'] !== undefined && o['force-start'] !== true) throw new Error('--force-start takes no value; give --reason R');
    const early = o['force-start'] === true ? text(o.reason, 'reason (starting before the specialists marked the round)', 300) : null;
    if (!early && o.reason !== undefined) throw new Error('--reason goes with --force-start');
    const cfg = routing(baseDir('project'));
    return change(run, 'unit.start', (s) => {
      const u = unitOf(s, unit);
      // A new build ends the round: a specialist mark still to come could no longer be recorded.
      if (early) {
        const d = decideUnit(u, s, Date.now());
        if (!s.frozen || d.action !== 'wait' || !d.specialists) throw new Error(`--force-start refused: next says "${d.action}" for ${u.id}; it only skips a wait for specialist marks`);
        s.notes.push({ kind: 'decision', text: `${u.id}: started try ${u.rounds.length + 1} before ${d.specialists.join(', ')} marked round ${u.rounds.length}; their findings on it are lost: ${early}`, at: now() });
        log(u, 'start', `early: without ${d.specialists.join(', ')}`);
      } else expect(s, u, 'start');
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
      addCost(s, u, costEntry(o, { step: 'start', role: 'builder', model, at: now() }));
      log(u, 'start', `try ${u.rounds.length + 1}${model ? ` on ${model}${why ? ` (${why})` : ''}` : ''}`);
    }, { unit });
  },
  // On an open unit (work started early, e.g. a stacked unit begun at the person's request, #66) the beat is
  // only logged, marked early: the unit stays open and no rule reads it; `start` still begins its first try.
  beat([run, unit], o) {
    return change(run, 'unit.beat', (s) => {
      const u = unitOf(s, unit);
      if (!['building', 'judging', 'open'].includes(u.status)) throw new Error(`unit ${unit} is ${u.status}`);
      expect(s, u, 'beat');
      const t = optText(o.text, 200) ?? '';
      if (u.status === 'open') { log(u, 'beat', `early (not started): ${t}`.trim()); return; }
      u.heartbeatAt = now(); log(u, 'beat', t);
    }, { unit });
  },
  built([run, unit], o) {
    return change(run, 'unit.built', (s) => {
      const u = unitOf(s, unit); if (u.status !== 'building') throw new Error(`unit ${unit} is ${u.status}, not building`); expect(s, u, 'built');
      // The commit the builder reported: the reviewed head a fold-in must build on, unless the critic or detect names one.
      if (o.head !== undefined && (typeof o.head !== 'string' || !/^[0-9a-f]{7,64}$/i.test(o.head))) throw new Error('--head takes the commit the builder reported');
      u.status = 'judging'; u.heartbeatAt = now(); u.judgingAt = now(); u.report = optText(o.report, 2000); log(u, 'built', u.report ?? '');
      if (o.head !== undefined) u.builtHead = o.head.toLowerCase(); else delete u.builtHead;
      addCost(s, u, costEntry(o, { step: 'built', role: 'builder', model: u.builtBy && u.builtBy !== UNSPECIFIED ? u.builtBy : null, at: now() }));
      delete u.specialistMarks; // a new build is judged again by every specialist
    }, { unit });
  },
  behave([run, unit], o) {
    let id; let warning = null;
    const s = change(run, 'behaviour', (st) => {
      if ((o.goal === true) === (unit !== undefined)) throw new Error('name a unit or --goal, not both');
      if (o.remove !== undefined && o.remove !== true) throw new Error('--remove takes no value');
      if (o.remove !== true && typeof o.text === 'string') warning = openCheck([{ what: `${unit ?? 'the goal'} behaviour`, text: o.text }], o['accept-open'], st.notes);
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
    return { ...s, behaviour: id, ...(warning ? { warning } : {}) };
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
      // The merged tree equals the reviewed head merged with the target: the review stands, no post-merge re-check.
      if (o['same-tree'] !== undefined) {
        if (typeof o['same-tree'] !== 'string' || !/^[0-9a-f]{7,64}$/i.test(o['same-tree'])) throw new Error('--same-tree takes the tree id both sides share (git rev-parse <merge>^{tree})');
        if (!o.merge?.length) throw new Error('--same-tree goes with --merge');
        if (u.status !== 'pass') throw new Error(`--same-tree: ${u.id} has not passed`);
        u.postMerge = { check: 'skipped: the merged tree equals the reviewed head merged with the target', tree: o['same-tree'].toLowerCase(), at: now() };
        log(u, 'merge-check', `skipped: same tree ${o['same-tree'].slice(0, 12)} as reviewed`);
      }
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
      // A required specialist whose mark arrives after the general critic's fail closed the round:
      // recorded on that round (its high must count), once, before a new build starts (#51 round 3).
      const closed = u.rounds.at(-1);
      // An early review (#66): a critic judged work on an open or building unit (a stacked unit started early, before
      // its base passed). Recorded apart, in u.early: it is never a round, never moves the unit, and passes nothing.
      if (o.early !== undefined && o.early !== true) throw new Error('--early takes no value');
      const early = o.early === true;
      if (early) {
        if (!['open', 'building'].includes(u.status)) throw new Error(`verdict --early refused: ${u.id} is ${u.status}; ${u.status === 'judging' ? 'record the verdict without --early' : 'an early review is for work not yet judged'}`);
        if (decideUnit(u, s, Date.now()).action === 'stop') throw new Error(`verdict --early refused: the rules stop ${u.id}`);
        for (const k of ['fold', 'behaviour']) if (o[k] !== undefined) throw new Error(`--${k} does not go with --early: an early review passes nothing`);
        if (o.score === undefined) throw new Error('--score is required on an early review');
        if (!optText(o.evidence)) throw new Error('--evidence is required on an early review');
      }
      const late = !early && o.specialist !== undefined && ['open', 'stopped'].includes(u.status) && closed?.verdict === 'fail' && !closed.specialists?.[String(o.specialist)]
        && requiredOn(u, u.rounds.length).includes(String(o.specialist));
      if (u.status !== 'judging' && !late && !early) throw new Error(`verdict refused: unit ${unit} is ${u.status}; record built first (a review of work started early: verdict --early)`);
      if (!late && !early) expect(s, u, 'verdict');
      oneOf(v, ['pass', 'fail'], 'verdict');
      if (o.head !== undefined && (typeof o.head !== 'string' || !/^[0-9a-f]{7,64}$/i.test(o.head))) throw new Error('--head takes the commit the critic judged');
      if (v === 'fail' && o.score === undefined) throw new Error('--score is required on a fail (it drives the no-progress stop)');
      if (v === 'fail' && !optText(o.gap)) throw new Error('--gap is required on a fail (it drives the same-gap stop)');
      // Only a high or medium finding fails a round; lows and nits ride on a pass as fold-ins (references/bar.md).
      const severity = o.severity === undefined ? null : oneOf(String(o.severity).toLowerCase(), SEVERITIES, '--severity');
      if (v === 'fail' && !severity) throw new Error('--severity high|medium is required on a fail: the severity of the gap');
      if (v === 'fail' && !FAILING.includes(severity)) throw new Error(`fail refused: a ${severity} finding does not fail a round; pass, and record them as fold-ins (--fold "…")`);
      if (v === 'pass' && severity) throw new Error('--severity goes with a fail; record lows and nits on a pass with --fold');
      const findings = (o.finding ?? []).map((f) => { const x = parseFinding(text(f === true ? undefined : f, 'finding', 500)); return x; });
      const worst = SEVERITIES.find((x) => findings.some((f) => f.severity === x));
      if (v === 'fail' && worst && SEVERITIES.indexOf(worst) < SEVERITIES.indexOf(severity)) throw new Error(`--severity ${severity}, but a ${worst} finding is listed: the gap's severity is the worst finding's`);
      if (v === 'pass' && FAILING.includes(worst)) throw new Error(`pass refused: a ${worst} finding is listed; a high or medium finding fails the round`);
      const folds = (o.fold ?? []).map((f) => checkFold(text(f === true ? undefined : f, 'fold', 500))).map((f) => (f.severity === 'low' ? f.text : `nit: ${f.text}`));
      if (folds.length && v !== 'pass') throw new Error('--fold goes with a pass: a fail sends the gap back to the builder');
      if (folds.length > 10) throw new Error('at most 10 --fold items: more than that is another round');
      const fullSuite = o['full-suite'] === undefined ? null : o['full-suite'] === true ? true : oneOf(String(o['full-suite']), ['yes', 'no'], '--full-suite') === 'yes';
      const evidence = optText(o.evidence);
      const { verdict, gap, cause } = judged(evidence, v, optText(o.gap, 500), optText(o.cause, 80));
      const extra = { ...(verdict === 'fail' && severity ? { severity } : {}), ...(findings.length ? { findings } : {}), ...(verdict === 'pass' && folds.length ? { folds } : {}), ...(fullSuite === null ? {} : { fullSuite }) };
      const critic = optText(o.critic, 120);
      const judge = modelName(o.model, 'model');
      const rcfg = routing(baseDir('project'));
      if (judge && !judgeAllowed(rcfg, judge)) throw new Error(`verdict refused: critics are never routed down; ${judge} is below the strong model or not it (references/routing.md)`);
      const judgedBy = judge ? { judgedBy: judge } : (rcfg.on ? { judgedBy: UNSPECIFIED } : {});
      if (early) {
        const by = o.specialist === undefined ? 'critic' : safeId(String(o.specialist), 'specialist');
        const head = typeof o.head === 'string' ? { head: o.head.toLowerCase() } : {};
        (u.early ??= []).push({ n: u.early.length + 1, before: u.rounds.length + 1, by, verdict, score: score(o.score), gap, cause, evidence, ...extra, ...head, ...(critic ? { critic } : {}), ...judgedBy, at: now() });
        addCost(s, u, costEntry(o, { step: 'verdict', role: by === 'critic' ? 'critic' : `critic:${by}`, model: judge, at: now() }));
        log(u, 'early', `early review ${u.early.length} by ${by}: ${verdict} ${score(o.score)}${gap ? `: ${clip(gap, 120)}` : ''} (not a round)`);
        return;
      }
      if (o.specialist !== undefined) { // a required second critic: recorded on this round, the unit stays judging
        const name = String(o.specialist);
        if (!(u.specialists ?? []).includes(name)) throw new Error(`no specialist ${name} on unit ${unit} (run.mjs add-specialist ${s.id} ${u.id} ${name} --reason …)`);
        const mark = { verdict, score: score(o.score), gap, cause, evidence, ...extra, ...(critic ? { critic } : {}), ...judgedBy, at: now() };
        if (late) { (closed.specialists ??= {})[name] = { ...mark, late: true }; log(u, 'verdict', `${name}: ${verdict} on round ${closed.n ?? u.rounds.length}, after the round closed`); }
        else (u.specialistMarks ??= {})[name] = mark;
        addCost(s, u, costEntry(o, { step: 'verdict', role: `critic:${name}`, model: judge, at: now() }));
        return;
      }
      if (late) throw new Error('unreachable');
      {
      }
      const missing = (u.specialists ?? []).filter((n) => u.specialistMarks?.[n]?.verdict !== 'pass');
      if (verdict === 'pass' && missing.length) throw new Error(`pass refused: specialist ${missing.join(', ')} has not passed this build`);
      const round = u.rounds.length + 1;
      if (verdict === 'pass' && s.paths?.length && !(u.detect?.round === round && u.detect.clean)) {
        throw new Error(`pass refused: no clean detect result for round ${round}; run detect.mjs --run ${s.id} --unit ${u.id} --base … first`);
      }
      const marks = mark(u.behaviours ?? [], o.behaviour, verdict);
      // A specialist's fold-ins ride on the pass too.
      if (verdict === 'pass') for (const [n, m] of Object.entries(u.specialistMarks ?? {})) for (const f of m.folds ?? []) extra.folds = [...(extra.folds ?? []), `${f} (${n})`];
      addCost(s, u, costEntry(o, { step: 'verdict', role: 'critic', model: judge, at: now() }));
      // The head the critic reviewed, from the detect run of this round: a fold-in must build on it.
      // The head the critic judged (--head), else this round's detect head, else the builder's reported head.
      const reviewedHead = typeof o.head === 'string' ? o.head.toLowerCase() : (u.detect?.round === round && u.detect.head) ? u.detect.head : (u.builtHead ?? null);
      // Kept on a fail too: the next critic reviews the delta since this head (sub-skills/review.md, Delta review).
      if (reviewedHead) extra.reviewedHead = reviewedHead;
      u.rounds.push({ n: round, verdict, score: score(o.score), gap, cause, evidence, at: now(), ...extra, ...(marks.length ? { behaviours: marks } : {}), ...(u.report ? { report: u.report } : {}), ...(critic ? { critic } : {}), ...(u.builtBy ? { builtBy: u.builtBy, ...(u.builtWhy ? { builtWhy: u.builtWhy } : {}) } : {}), ...judgedBy, ...(u.specialistMarks ? { specialists: u.specialistMarks } : {}) });
      u.report = null; delete u.specialistMarks; delete u.builtBy; delete u.builtWhy; delete u.judgingAt; delete u.builtHead;
      u.status = verdict === 'pass' ? 'pass' : 'open';
    }, { unit });
  },
  // The targeted check of a pass's fold-ins: only the folds and the tests they touch, no new critic round.
  foldin([run, unit], o) {
    return change(run, 'unit.foldin', (s) => {
      const u = unitOf(s, unit); expect(s, u, 'foldin');
      if (typeof o.head !== 'string' || !/^[0-9a-f]{7,64}$/i.test(o.head)) throw new Error('--head takes the commit the fold-ins landed on');
      const evidence = text(o.evidence, 'evidence (what checked the fold-ins and the tests they touch)', 2000);
      const last = u.rounds.at(-1);
      // The fold must build on what the critic reviewed, stay small, and pass the fence and gaming check.
      const reviewed = last.reviewedHead ?? (typeof o.reviewed === 'string' ? o.reviewed : null);
      if (!reviewed) throw new Error(`foldin refused: no reviewed head recorded for ${u.id}'s pass (no --head on built or verdict, no detect run that round); give --reviewed <the commit the critic judged>`);
      if (last.reviewedHead && o.reviewed !== undefined) throw new Error('--reviewed is recorded already (the reviewed head, from verdict --head, the round\'s detect run or built --head); leave it out');
      const d = foldDiff(reviewed, o.head);
      const caps = { files: s.budget.foldFiles ?? FOLD_DEFAULTS.files, lines: s.budget.foldLines ?? FOLD_DEFAULTS.lines };
      if (!d.descends) throw new Error(`foldin refused: ${o.head} does not build on the reviewed head ${d.reviewed.slice(0, 12)}; a different history needs a new round`);
      if (!d.files) throw new Error(`foldin refused: nothing changed since the reviewed head ${d.reviewed.slice(0, 12)}`);
      if (d.files > caps.files || d.lines > caps.lines) throw new Error(`foldin refused: ${d.files} files and ${d.lines} lines changed since the reviewed head (caps ${caps.files} files, ${caps.lines} lines; init --fold-max-files/--fold-max-lines); that is a new round, not a fold-in`);
      if (!(u.detect?.fold && u.detect.head === d.head && u.detect.base === d.reviewed)) throw new Error(`foldin refused: no detect result for this fold; run detect.mjs --run ${s.id} --unit ${u.id} --base ${d.reviewed.slice(0, 12)} --head ${d.head.slice(0, 12)} first`);
      if (!u.detect.clean) throw new Error(`foldin refused: detect found ${u.detect.hits} hit(s) on the fold (fence or gaming); that needs a new round`);
      last.foldin = { head: d.head, reviewed: d.reviewed, files: d.files, lines: d.lines, detect: { clean: true, files: u.detect.files }, evidence, at: now() };
      addCost(s, u, costEntry(o, { step: 'foldin', role: 'fold-in check', at: now() }));
      log(u, 'foldin', `${last.folds.length} fold-in${last.folds.length === 1 ? '' : 's'} checked at ${d.head.slice(0, 12)}: ${d.files} files, ${d.lines} lines since the reviewed head`);
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
      const written = writtenBy(run, s, 'extend');
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
  // A unit merged on the person's decision with no final verdict (#66): it ends shipped, delivered, never a clean
  // pass. The missing verdict and any open findings of its last round become follow-ups (Gaps); the merge is linked.
  ship([run, unit], o) {
    const reason = text(o.reason, 'reason', 300);
    if (o.merge === undefined) throw new Error('--merge URL is required: the PR or merge that shipped it');
    if (o.answer !== undefined && o.confirm !== undefined) throw new Error('--answer or --confirm, not both');
    if (o.confirm === true) throw new Error('--confirm takes their words: --confirm "what the person said"');
    return change(run, 'unit.ship', (s) => {
      const u = unitOf(s, unit);
      if (!s.frozen) throw new Error('freeze the run first');
      if (u.status === 'pass') throw new Error(`ship refused: ${u.id} has ${u.shipped ? 'shipped' : 'passed'} already`);
      const [merge] = refLinks(s, 'merge', [o.merge]);
      const written = writtenBy(run, s, 'ship');
      // Their decision since the unit's last verdict (or since it was added), used once, quoted in the decision.
      const since = u.rounds.at(-1)?.at ?? s.createdAt;
      let source; let answers = null;
      if (o.answer !== undefined) {
        const q = questions(s).find((x) => x.id === String(o.answer));
        if (!q) throw new Error(`--answer: no question ${o.answer}`);
        if (q.unit !== u.id) throw new Error(`--answer: ${q.id} ${q.unit ? `is about ${q.unit}` : 'names no unit'}; the question must name ${u.id} (ask … --unit ${u.id})`);
        if (['used', 'decided'].includes(q.status)) throw new Error(`ship refused: ${q.id} is already ${q.status}; ask again`);
        const qi = +q.id.slice(1) - 1;
        const finish = s.notes.filter((n) => n.kind === 'question')[qi]?.finish === true;
        const why = answerRefusal(finish ? { ...q, approves: FINISH.ship } : q);
        if (why) throw new Error(`ship refused: ${why}`);
        if (q.answer.at < since) throw new Error(`ship refused: ${q.id} was answered before ${u.id}'s last verdict; ask again`);
        written((st) => st?.notes?.filter((n) => n.kind === 'question')[qi]?.history?.[q.history.length - 1], ['answer'], `${q.id}'s answer`);
        written((st) => { const n = st?.notes?.filter((x) => x.kind === 'question')[qi]; return n && { approves: n.approves, unit: n.unit, options: n.options }; }, ['question'], `${q.id}`);
        source = `${q.id} answered "${q.answer.choices[0]}" via ${q.answer.via}${q.answer.confirm ? `, their words: "${clip(q.answer.confirm, 200)}"` : ''}`;
        answers = q.id;
      } else {
        // --confirm "their words": the lead pastes what the person said (references/commands/run.md); recorded as their note.
        if (o.confirm !== undefined) personNote(s, { text: o.confirm, unit: u.id, via: 'cli', confirm: true });
        const n = (s.notes ?? []).findLast((x) => x.kind === 'person' && x.unit === u.id && x.at >= since);
        if (!n) throw new Error(`ship refused: no decision from the person on ${u.id} since its last verdict; give --confirm "their words", --answer qN (a question on ${u.id} they answered), or they add a note on ${u.id}`);
        if (n.usedBy) throw new Error(`ship refused: their latest note on ${u.id} was already used by an ${n.usedBy.by ?? 'extend'}`);
        const why = decisionRefusal(n);
        if (why) throw new Error(`ship refused: ${why}`);
        if (o.confirm === undefined) written((st) => st?.notes?.[s.notes.indexOf(n)], ['note'], 'their note');
        source = `their words via ${n.via}: "${clip(n.text, 300)}"`;
        n.usedBy = { unit: u.id, by: 'ship', at: now() };
      }
      const was = u.status; const last = u.rounds.at(-1);
      const open = openFindings(last);
      u.status = 'pass'; u.stopReason = null; u.heartbeatAt = null;
      u.report = null; delete u.specialistMarks; delete u.builtBy; delete u.builtWhy; delete u.judgingAt; delete u.builtHead;
      u.shipped = { verdict: 'none', was, ...(answers ? { answer: answers } : {}), round: u.rounds.length, score: last?.score ?? null, findings: open.length, merge: merge.url, at: now() };
      (u.links ??= []).push(merge);
      log(u, 'link', merge.url, { link: 'merge' });
      log(u, 'ship', `shipped without a final verdict (was ${was}): ${reason}`);
      s.notes.push({ kind: 'decision', unit: u.id, ...(answers ? { answers } : {}), text: `${u.id}: shipped without a final verdict (it was ${was}${u.rounds.length ? `, last round ${u.rounds.length} ${last.verdict}` : ', no round recorded'}), merged as ${merge.url} on the person's decision (${source}): ${reason}`, at: now() });
      const tag = { kind: 'follow-up', unit: u.id, shipped: answers ?? 'person', noVerdict: true };
      s.notes.push({ ...tag, text: `${u.id} (shipped without a final verdict): no critic judged what merged (${merge.url}); review it after the fact or record why not`, at: now() });
      for (const f of open) s.notes.push({ ...tag, text: `${u.id} (shipped, ${f.severity}${f.by === 'critic' ? '' : `, ${f.by}`}): ${f.text}`, at: now() });
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
    if (o.unit !== undefined && !UNIT_NOTES.includes(kind)) throw new Error(`--unit goes with --kind ${['person', 'escape', ...UNIT_NOTES].join(', ')} (or ask)`);
    if (o.recommend !== undefined && kind !== 'question') throw new Error('--recommend goes with --kind question');
    if (o.answers !== undefined && kind !== 'decision') throw new Error('--answers goes with --kind decision');
    return change(run, kind === 'question' ? 'question' : 'note', (s) => {
      const note = { kind, ...(o.unit !== undefined ? { unit: unitOf(s, String(o.unit)).id } : {}), text: text(o.text, 'text', kind === 'situation' ? 400 : 1000), at: now() };
      if (o.recommend !== undefined) note.recommend = text(o.recommend, 'recommend', 300);
      if (o.answers !== undefined) {
        const asked = s.notes.filter((n) => n.kind === 'question').length;
        const m = /^q(\d+)$/.exec(String(o.answers));
        if (!m || +m[1] < 1 || +m[1] > asked) throw new Error(`--answers must name a logged question (q1-q${asked})`);
        note.answers = o.answers;
      }
      s.notes.push(note);
    }, { closedOk: ['follow-up', 'retro'].includes(kind), unit: typeof o.unit === 'string' ? safeId(o.unit, 'unit') : null });
  },
  study([run], o) { let id; const s = change(run, 'study', (st) => { id = addStudy(st, o); }); return { ...s, study: id }; },
  self(_, o) {
    if (o.json !== undefined && o.html !== undefined) throw new Error('--json or --html, not both');
    const m = selfModel({ ...loadSelf(), current: null });
    if (o.json) return m;
    if (o.html) return { file: writeSnapshot() };
    process.stdout.write(selfText(m));
    return null;
  },
  gaps(_, o) {
    if (o.check !== undefined || o['dry-run'] !== undefined || o.run !== undefined) {
      if (o.check !== true) throw new Error('--run and --dry-run go with --check');
      const only = o.run === undefined ? null : safeId(o.run, 'run');
      if (only && !exists(only)) throw new Error(`no run: ${only}`);
      const plan = planCheck(loadRuns(), { only });
      if (!plan.ok) { console.error(plan.error); return { checked: false, reason: plan.error, closes: [] }; }
      if (o['dry-run'] !== true) {
        const at = now();
        for (const c of plan.closes) {
          if (c.merge && c.unit) change(c.run, 'unit.link', (s) => { const u = unitOf(s, c.unit); u.links = [...(u.links ?? []), { kind: 'merge', url: c.merge, label: 'checked with gh', at }]; }, { closedOk: true, unit: c.unit });
          change(c.run, 'note', (s) => closeGap(s, c.gap, { reason: c.reason, by: 'lead', checked: { at, ref: c.ref, state: c.state } }), { closedOk: true, unit: c.unit && load(c.run).units.some((u) => u.id === c.unit) ? c.unit : null });
        }
        writeAtomic(gapsCheckFile(), `${JSON.stringify({ at, asked: plan.asked, closed: plan.closes.length, run: only })}\n`);
      }
      return { checked: true, dryRun: o['dry-run'] === true, asked: plan.asked, closes: plan.closes };
    }
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
    return change(run, 'note', (s) => closeGap(s, id, { reason, by: o.by ?? 'lead', confirm: o.confirm === undefined ? null : o.confirm === true ? '' : String(o.confirm), reopen }), { closedOk: true, unit: p.unit && load(run).units.some((u) => u.id === p.unit) ? p.unit : null });
  },
  ask([run], o) {
    if (o.finish !== undefined) return askFinish(run, o);
    let id; const s = change(run, 'question', (st) => { id = ask(st, o); }, { unit: typeof o.unit === 'string' ? o.unit : null }); return { ...s, asked: id };
  },
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
        if (path === '/coordinator') {
          const ctx = liveCtx(live, run, theme);
          ctx.pcHref = (key, id) => (key === projectKey(baseDir('project')) ? ctx.runHref(id) : `/p/${key}/run/${encodeURIComponent(id)}?t=${encodeURIComponent(live.token)}`);
          return selfPage({ ...selfModel({ ...loadSelf(), current: run }), pc: pcModel(readRegistry(), { here: baseDir('project') }) }, Date.now(), ctx);
        }
        // /p/<key>/run/<run>/…: a run of another project on this PC, read-only (lib/dashboard.mjs).
        if (PROJECT_PAGE.test(path)) return projectPage(path, live, readRegistry(), { path: '/coordinator', label: 'Coordinator', href: `/coordinator?t=${encodeURIComponent(live.token)}` });
        // /run/<other>[/unit/<u>|/maps|/map]: another run of this folder, read-only; /run/<served> is the served run.
        const m = /^\/run\/([^/]+)(\/unit\/.+|\/maps|\/map|\/report|\/retro)?$/.exec(path);
        const id = m ? m[1] : run;
        if (m && !isSafeId(id)) return null;
        if (m && !exists(id)) return null;
        const s = load(id);
        const v = view(s, decide(s), Date.now(), { repo: repoFor(s), linked: linkedOf(s) });
        const ctx = liveCtx(live, run, themeFor(s), id === run ? null : id);
        ctx.has = (file) => storedPath(runDir(id), file) !== null;
        ctx.calls = readCalls(runDir(id));
        const rest = m ? (m[2] ?? '/') : path;
        if (hasMap(runDir(id))) ctx.mapHref = `${ctx.base}/map?t=${encodeURIComponent(live.token)}`;
        if (rest === '/map' || path === '/map') return ctx.mapHref ? mapView(id, runDir(id), { ...ctx, pages: mapNav(ctx, id) }) : null;
        if (rest === '/maps') return mapsPage(v, Date.now(), ctx);
        if (rest === '/report' || rest === '/retro') return reportPages(s, v, runDir(id), ctx, rest.slice(1))[0][1];
        return rest === '/' ? hud(v, Date.now(), ctx) : unitPage(v, decodeURIComponent(rest.slice('/unit/'.length)), Date.now(), ctx);
      },
      version: () => selfVersion() + pcVersion(readRegistry()),
      extra: PROJECT_PAGE,
      file: (target, name, other) => {
        const id = other ?? run;
        if (!isSafeId(id) || !exists(id)) return null;
        const a = artifact(load(id), target, name);
        const fd = a ? openStored(runDir(id), a.rel) : null; // a checked name, no links, inside artifacts/<target>/, opened once
        return fd === null ? null : { fd, type: a.type };
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
  // The global dashboard: every run on this PC (lib/dashboard.mjs), no run argument, on a stable port.
  dashboard([verb], o) {
    const rec = join(registryHome(), 'dashboard.json');
    const old = (() => { try { return JSON.parse(readFileSync(rec, 'utf8')); } catch { return null; } })();
    const running = old && Number.isInteger(old.pid) && pidAlive(old.pid);
    if (verb === 'stop') {
      if (!running) { rmSync(rec, { force: true }); console.log(JSON.stringify({ stopped: false, note: 'no dashboard was running' }, null, 2)); return null; }
      // Kill only a process that still serves the recorded link (its token proves it is our dashboard):
      // a pid reused by another program after a crash or a reboot is left alone, and the stale record goes.
      answers(old.url ?? '').then((ok) => {
        rmSync(rec, { force: true });
        if (ok) process.kill(old.pid);
        console.log(JSON.stringify(ok ? { stopped: true, pid: old.pid } : { stopped: false, note: `the record named pid ${old.pid}, which does not serve the dashboard; nothing stopped, the record removed` }, null, 2));
      });
      return null;
    }
    if (verb !== undefined) throw new Error('usage: run.mjs dashboard [--port P] [--open] | dashboard stop');
    registerFolder();
    if (o.open !== undefined && o.open !== true) throw new Error('--open takes no value');
    const port = num(o.port, DASHBOARD_PORT, 1, 65_535);
    const start = (p) => serve({
      port: p, post: {}, extra: PROJECT_PAGE, version: () => pcVersion(readRegistry()),
      page: (path, live) => {
        const t = `t=${encodeURIComponent(live.token)}`;
        const home = { path: '/', label: 'This PC', href: `/?${t}` };
        if (path === '/') {
          const ctx = { live, theme: null, run: null, store: null, base: '', home: `/?${t}`, embed: null, readOnly: true, pages: [home], runHref: () => null, pcHref: (key, id) => `/p/${key}/run/${encodeURIComponent(id)}?${t}` };
          return pcPage(pcModel(readRegistry(), { here: null }), Date.now(), ctx);
        }
        return projectPage(path, live, readRegistry(), home);
      },
    });
    const ready = ({ server, url }) => {
      writeAtomic(rec, `${JSON.stringify({ pid: process.pid, port: server.address().port, url, at: now() })}
`);
      try { chmodSync(rec, 0o600); } catch { /* not on this file system */ }
      const drop = () => { try { if (JSON.parse(readFileSync(rec, 'utf8')).pid === process.pid) rmSync(rec); } catch { /* gone */ } };
      process.on('exit', drop);
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
      if (o.open) openBrowser(url);
      console.log(JSON.stringify({ url, note: 'every run on this PC; local only; stop with run.mjs dashboard stop' }));
    };
    const fresh = () => start(port).catch((e) => {
      if (e.code === 'EADDRINUSE' && o.port === undefined) { console.error(`port ${port} is taken; using a free one`); return start(0); }
      throw e;
    }).then(ready, (e) => { console.error(`error: ${e.message}`); process.exit(1); });
    // A dashboard already running answers its own link: print it instead of starting another.
    if (running && old.url) {
      answers(old.url).then((ok) => {
        if (!ok) return fresh();
        if (o.open) openBrowser(old.url);
        console.log(JSON.stringify({ url: old.url, pid: old.pid, reused: true, note: 'a dashboard is already running; stop it with run.mjs dashboard stop' }));
        return null;
      });
      return null;
    }
    fresh();
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
    const sync = (u) => (syncs.has(u.id) && ['build', 'judge', 'done', 'fold-in'].includes(u.action) ? { ...u, sync: syncStep(s.id, u.id, syncs.get(u.id), u.action === 'done') } : u);
    // The command for the two steps the lead takes from here: the finish-line question and the fold-in check.
    const how = (u) => {
      if (u.action === 'ask-person' && !u.asked) return { ...u, step: `run.mjs ask ${s.id} --finish ${u.id}, and the same question through the question tool` };
      if (u.action === 'fold-in') return { ...u, step: `check only the fold-ins and the tests they touch, then run.mjs foldin ${s.id} ${u.id} --head <sha> --evidence "…"` };
      return u;
    };
    // Early reviews since the last round (verdict --early, #66): shown and counted, never a round.
    const early = (u) => { const e = earlySummary(unitOf(s, u.id)); return e ? { ...u, early: e } : u; };
    // The per-launch caps the lead passes to the agent it launches for this step (guardrails.md).
    const caps = launchCaps(s);
    const launch = (u) => (caps && ['build', 'judge', 'fold-in'].includes(u.action) ? { ...u, launch: { ...(caps.minutes ? { minutes: caps.minutes } : {}), ...(caps.cost ? { cost: `${caps.cost.amount} ${caps.cost.currency}` } : {}) } } : u);
    return { decision: plan.decision, units: plan.units.map((u) => stopped.get(u.id) ?? launch(early(how(sync(suggest(u)))))) };
  },
  brief([run, unit], o) {
    const files = o.quote ?? []; const labels = o.source ?? [];
    if (labels.length > files.length) throw new Error('one --source per --quote');
    const quotes = files.map((f, i) => {
      if (!existsSync(f) || !statSync(f).isFile()) throw new Error(`--quote: no file ${f}`);
      return { source: labels[i] ?? basename(f), text: readFileSync(f, 'utf8') };
    });
    const env = process.env.COORDINATOR_DIR ? commands.where().env : '';
    // What past runs taught rides along in every builder and critic brief (references/learning.md).
    const top = num(o.lessons, 5, 0, 20);
    if (top && o.role !== 'integrator') {
      const lessons = topLessons([baseDir('project'), baseDir('global')], load(run).tag, top);
      if (lessons.length) {
        quotes.push({ source: 'lessons from past runs (hints)', text: lessons.map((l) => `- ${l.text}`).join('\n') });
        try { markUsed(lessons, run); } catch { /* a locked or read-only lessons file never blocks a brief */ }
      }
    }
    process.stdout.write(`${buildBrief(load(run), { role: o.role, unit, quotes, where: optText(o.where, 500), playbook: optText(o.playbook, 300), env })}\n`);
    return null;
  },
  // The one-line status a lead posts in the chat (references/commands/run.md); with no run, one line per run:
  // active runs first, then the recently concluded ones.
  'status-line'([run], o) {
    const statuses = run ? [load(run)] : commands.list().filter((r) => !r.error).map((r) => load(r.run));
    const all = statuses.map((s) => runStatus(s, decide(s), { runs: [...linkedOf(s).values()].filter((r) => r && Array.isArray(r.units)) }));
    if (o.json === true) return all;
    if (run) { console.log(all[0].line); return null; }
    const { active, concluded, older } = ordered(all, statuses);
    const lines = [...active.map((x) => x.line), ...concluded.map((x) => x.line)];
    if (!lines.length) lines.push('No runs yet.');
    if (older) lines.push(`(${older} older concluded ${older === 1 ? 'run' : 'runs'}: run.mjs list)`);
    for (const l of lines) console.log(l);
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
      if (busy.length) throw new Error(`close refused: ${busy.join(', ')} still in progress (merged on the person's decision with no final verdict: run.mjs ship ${s.id} <unit> --merge URL --reason R --confirm "their words")`);
      const d = decide(s).decision;
      if (outcome === 'done' && d !== 'done') throw new Error(`close --outcome done refused: the run is at "${d}"; use partial or stopped`);
      // Ending before the rules say so (giving up early) needs a stated reason.
      const expected = { partial: 'done-with-gaps', stopped: 'stopped' }[outcome];
      if (expected && d !== expected) s.notes.push({ kind: 'decision', text: `closed early as ${outcome} at "${d}": ${text(o.reason, 'reason (closing before the rules end the run)', 500)}`, at: now() });
      s.closed = { outcome, decision: d, at: now() };
    });
    const loose = adopt(load(run), runDir(run), { project: projectDir(), home: homedir() }).filter((r) => ['adoptable', 'repairable', 'unclear'].includes(r.status));
    const warnings = [
      ...(hasRetro(closed) ? [] : [`no retro note: ask the person to run ${retroCommand(closed)} (references/learning.md)`]),
      ...(loose.length ? [`${loose.length} file(s) the run mentions are not safely stored in its folder (outside it, damaged, or an unclear path); run: run.mjs adopt ${run} --dry-run`] : []),
    ];
    return warnings.length ? Object.assign(closed, { warning: warnings.join('; ') }) : closed;
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
  // The report's release notes (lib/report/cli.mjs): a draft from the state and git, or the lead's notes stored in the run.
  report([run], o) {
    load(run);
    if (o.draft !== undefined && o.file !== undefined) throw new Error('--draft or --file, not both');
    if (o.file !== undefined) { change(run, 'report', (s) => storeReport(s, o.file, { checked: o['i-checked'] === true }), { closedOk: true }); return reportFor(load(run), runDir(run)); }
    const out = reportFor(load(run), runDir(run), { draft: o.draft !== undefined, root: projectDir() });
    if (o.draft !== undefined) { commands.hud([run]); process.stdout.write(out.markdown); return null; }
    return out;
  },
  quality([run], o) {
    if ((o.project === true) === (run !== undefined)) throw new Error('usage: run.mjs quality <run> | --project [--json]');
    const out = reportFor(run === undefined ? null : load(run), run === undefined ? null : runDir(run), { quality: true, root: projectDir() });
    if (run !== undefined) commands.hud([run]);
    if (o.json === true) return out.quality;
    process.stdout.write(out.text);
    return null;
  },
  list(_, o = {}) {
    if (o.all !== undefined) return listAll(o.all);
    if (!existsSync(runsDir())) return [];
    return readdirSync(runsDir()).filter((d) => isSafeId(d) && exists(d)).map((d) => {
      try {
        const s = loadRun(runDir(d));
        const plan = decide(s);
        const st = runStatus(s, plan, { runs: [...linkedOf(s).values()].filter((r) => r && Array.isArray(r.units)) });
        return {
          run: s.id, ...(s.alias ? { alias: s.alias } : {}), tag: s.tag, createdAt: s.createdAt, closed: s.closed?.outcome ?? null, decision: plan.decision,
          harness: s.writer?.harness ?? null, skill: s.writer?.skill ?? null,
          // The plain status (lib/progress.mjs): the same word, progress and ETA as show, the HUD and the coordinator page.
          status: st.word, progress: { done: st.done, total: st.total, pct: st.pct, stopped: st.stopped }, doing: st.concluded ? null : st.doing,
          eta: st.eta.text, readyAt: st.eta.readyAt, needsYou: st.needsYou.map((q) => q.id), line: st.line,
        };
      } catch (e) { return { run: d, createdAt: '', error: `unreadable: ${e.message}` }; }
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  // The project map (references/map.md): from the code into the run's folder; never into the project's tree unless --dest says so.
  map([run], o) {
    const t0 = Date.now();
    const s = load(run);
    const root = resolve(typeof o.root === 'string' ? o.root : projectDir());
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`--root must be a folder: ${root}`);
    if (o.unit !== undefined) unitOf(s, o.unit);
    if (o.dest !== undefined && o['pit-stop'] !== true) throw new Error('--dest goes with --pit-stop');
    const snap = buildMap(run, runDir(run), { root, maxSeconds: num(o['max-seconds'], 60, 1, 3600), unit: o.unit ?? null, ctx: staticCtx(runDir(run), 0, themeFor(s)), fresh: o.fresh === true, force: o.force === true, resetStage: o['reset-stage'] === true });
    // A build after a unit merged also finds the functions that unit touched (map/calls/<unit>.json), in what is left of the cap.
    const calls = o.unit !== undefined ? unitCallsFor(run, s, o.unit, { root, deadline: t0 + num(o['max-seconds'], 60, 1, 3600) * 1000 }) : null;
    commands.hud([run]); // the dashboard links to the map
    const b = snap.build;
    return {
      ...(calls ? { calls: { touched: calls.touchedTotal, source: calls.source, partial: calls.partial } } : {}),
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
  // Function calls (references/map.md): the functions a unit's diff touched, what they call and what calls them.
  calls([run, unit], o) {
    const s = load(run);
    if (!unit) throw new Error('usage: run.mjs calls <run> <unit> [--base ref --head ref | --files a,b] [--root dir] [--json]');
    const root = resolve(typeof o.root === 'string' ? o.root : projectDir());
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`--root must be a folder: ${root}`);
    const data = unitCallsFor(run, s, unit, { root, base: o.base, head: o.head, files: list(o.files), deadline: Date.now() + num(o['max-seconds'], 60, 1, 3600) * 1000 });
    if (!data) throw new Error(`nothing recorded says what ${unit} changed: pass --base and --head (its branch's merge base and head), or --files a,b`);
    commands.hud([run]); // the unit page and the maps page show it
    if (o.json === true) return data;
    process.stdout.write(callsText(data));
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
    return { ...stats(runs), ...byModel(runs), ...costStats(runs) };
  },
  // The routing table (references/routing.md), or the model for one role and task class.
  models(_, o) {
    const cfg = routing(baseDir('project'));
    for (const w of cfg.warnings) console.error(`warning: ${w}`);
    if (o.role === undefined) return cfg;
    return { role: o.role, class: o.class ?? null, ...route(cfg, String(o.role), typeof o.class === 'string' ? o.class : null) };
  },
};

const DASHBOARD_PORT = 7480; // stable, so the link stays the same; the owner's run dashboards use 7471-7473
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// True when the recorded link still serves the page (a reused pid would not).
function answers(url) {
  return new Promise((ok) => {
    let req;
    try { req = httpGet(url, { timeout: 1500 }, (res) => { res.resume(); ok(res.statusCode === 200); }); } catch { ok(false); return; } // not a URL
    req.on('timeout', () => { req.destroy(); ok(false); });
    req.on('error', () => ok(false));
  });
}
function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawnProcess(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (e) { console.error(`could not open a browser: ${e.message}`); }
}

// --harness works on every command: it names the tool that runs this one (lib/harness.mjs).
helpAndExit(import.meta.url);
const [cmd, ...argv] = process.argv.slice(2);
const rest = []; let harnessFlag;
for (let i = 0; i < argv.length; i++) {
  const m = /^--harness(?:=([\s\S]*))?$/.exec(argv[i]);
  if (!m) { rest.push(argv[i]); continue; }
  harnessFlag = m[1] ?? argv[++i] ?? '';
}
let BY = null;
try { BY = stamp(harnessOf(harnessFlag)); } catch (e) { console.error(`error: ${e.message}`); process.exit(2); }
if (!commands[cmd]) { console.error('usage: run.mjs init|status-line|dashboard|models|add|add-specialist|behave|behaviours|evidence|link|freeze|start|beat|built|reset|extend|ship|sync|verdict|foldin|strategy|integrate|note|study|self|ask|answer|use-answer|questions|serve|watch|next|show|hud|map|touches|calls|brief|close|gaps|gap|push|pull|adopt|report|quality|list|stats|where … (see the header of run.mjs)'); process.exit(2); }
try {
  const { pos, opt } = parse(rest, FLAGS[cmd] ?? [], REPEAT[cmd]);
  const out = commands[cmd](pos, opt);
  if (out !== null) console.log(JSON.stringify(out.id === undefined || ['models', 'next', 'list', 'stats', 'where', 'hud', 'questions', 'behaviours', 'self', 'gaps', 'push', 'pull', 'map', 'touches', 'report', 'quality'].includes(cmd) ? out : { ok: true, run: out.id, decision: decide(out).decision, ...(out.asked ? { asked: out.asked } : {}), ...(out.study ? { study: out.study } : {}), ...(out.behaviour ? { behaviour: out.behaviour } : {}), ...(out.evidence ? { evidence: out.evidence } : {}), ...(out.warning ? { warning: out.warning } : {}), ...(out.setup ? { setup: out.setup } : {}) }, null, 2));
} catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
