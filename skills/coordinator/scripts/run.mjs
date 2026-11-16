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
//                  [--feature-map path] [--new-surface] [--statechart path|json]   validate UI bar and attach unit statechart
//   run.mjs add-specialist <run> <unit> <name> --reason R   a critic that must also pass, added after add: required from the
//                  unit's next build on (or the one being judged), refused once the unit passed or stopped; logged as a decision
//   run.mjs behave <run> <unit>|--goal [--id B1] --text T | --id B1 --remove [--feature-map path] [--new-surface] [--statechart path|json]   add, reword (back to unchecked) or remove;
//                  behaviour text (here and in add --behaviour) is 500 characters at most, refused over it, never cut
//   run.mjs behaviours <run>        every behaviour of the goal and the units, with status and evidence
//   run.mjs evidence <run> <unit>|--goal [--behaviour B1] (--text T | --file path | --url U) --kind test|screenshot|log|link|reins|prism [--label L]
//                  prism: --file <worktree>/.prism/gate-report.json, beside the tokens.json it was checked against; while the
//                  unit is judged it must be for the commit being judged, and its PASS or FAIL then gates the pass (references/prism.md)
//   run.mjs link <run> <unit> [--issue … ] [--pr …] [--merge URL [--same-tree T]] [--url U --label L]   GitHub issues, PRs and merges;
//                  --same-tree: the merged tree is the reviewed head merged with the target, so no post-merge re-check (recorded)
//                  [--continues <run>:<unit>]  record afterwards that this unit continues that one (any id; closed runs too)
//   run.mjs extend <run> <unit> [--rounds N] --reason R [--answer qN]   N (1-4, default 1; above 1 only when their words name it) more rounds for a unit
//                  at or stopped by its round budget: qN asked with --approves and answered with that option by the
//                  person (dashboard, web, or answer --by person --confirm "their words"), or else their note on
//                  the unit since its last verdict saying "approved" (lib/approval.mjs); recorded as a decision
//   run.mjs extend <run> --answer qN --reason R [--minutes M]   more time for the run: qN asked on the run (no --unit) with
//                  --approves and --grant-minutes N, and answered with that option by the person; adds exactly N (M: fewer,
//                  never more), recorded as a decision with their words; refused for a question with no N, or confirmed
//                  words that name another amount or ask for less (lib/approval.mjs confirmRefusal)
//   run.mjs ship <run> <unit> --merge URL --reason R (--confirm "their words" | --answer qN)   a unit merged on the person's
//                  decision with no final verdict (open, building, judging or stopped): ends shipped ("Shipped without a final
//                  verdict"; delivered, never a clean pass), links the merge, and files the missing verdict and its last round's
//                  open findings as follow-ups; without --confirm or --answer, their latest note on the unit (lib/approval.mjs)
//   run.mjs freeze <run> [--feature-map path] [--new-surface] [--statechart path|json] [--skip-feasibility]
//   run.mjs pause <run> --reason R | resume <run>   the person stops the work by hand (overnight, a restart): until resume,
//                  no minute counts toward the time budget, next says paused and starts no unit, and start is refused;
//                  a second pause, or resume on a run that is not paused, is refused (lib/pause.mjs)
//   Cost (start, built, verdict, foldin): [--tokens-in N --tokens-out N --minutes M --cost "0.42 USD"], what the harness
//                  reported for that launch; stats, show and the HUD sum them per unit, model and run ("not recorded" when missing)
//   --accept-open (init, add, behave): keep a goal, bar or behaviour line that reads open-ended (lib/openbar.mjs), recorded as a bar note
//   One lead per run (lib/lead.mjs, references/durability.md "One lead"): the lead steps (init, add, add-specialist,
//                  start, reset, verdict, strategy, extend, freeze, foldin, ship, integrate, close, ask, use-answer, pause,
//                  resume, push, pull, and next when it records a stop; there is no stop command) are refused from any
//                  window but the run's lead. The first lead step claims a run that has none (event lead.claim, written
//                  with the step or not at all). Every lead step takes [--lead ID] (or COORDINATOR_LEAD) where the tool
//                  gives no window id of its own, and [--takeover]: claims the run of a lead that is gone; never one still active
//   run.mjs lead <run> [--takeover --reason R] [--lead ID]   who leads the run, since when, last active (minutes ago and
//                  local time); claims the run when it has no lead or its lead is gone (logged "took over from <id>: <why>");
//                  --takeover --reason R takes it from a lead still active, only with the person's yes (the one way to)
//   run.mjs start <run> <unit> [--model M] [--why W] [--skip-feasibility]   only when next says build, or check-stale with phase building;
//                  a unit being built or judged whose last beat is younger than the stale minutes keeps its agent:
//                  start refuses unless [--takeover --reason R] from the window that already leads the run, logged on the unit
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
//                  [--model M] the model that judged (refused below the strong model while routing is on, except a
//                  general critic of a unit outside every pinned area, given [--class C1,C2] its task classes)
//                  [--critic SETUP] who judged (e.g. "review skill high + security"): stats groups escapes by it
//                  [--specialist NAME] a required second critic's verdict on this build (add --specialist a,b);
//                  the unit stays judging; the general pass is refused until every required specialist has marked the build, and a failed mark closes the round as failed by that specialist
//                  --severity high|medium on a fail (required; a low or nit never fails: pass with --fold instead)
//                  [--finding "<high|medium|low|nit>: …" …] each FINDINGS line; the fail's severity is the worst; a pass lists none high or medium
//                  [--fold "…" …] on a pass: lows and nits ("nit: …") folded in before merge; never one in a pinned area; next then says fold-in
//                  [--full-suite yes|no] whether the critic ran the full suite this round
//                  [--head <sha>] the commit the critic judged; a specialist may mark a round the general fail just closed
//                  [--reins-packet path] inspect reins_state snapshot transitions against the unit's statechart
//   run.mjs verdict <run> <unit> pass|fail --early --score N --evidence E [--gap G --severity S] [--specialist NAME] [--head <sha>]
//                  an early review of work on an open or building unit (started before its try): recorded apart, never a
//                  round, moves and passes nothing; next, show and the unit page list it (early)
//   run.mjs foldin <run> <unit> --head <sha> --evidence E [--reviewed <sha>]   only when next says fold-in: the targeted check
//                  of the folds (no new critic round). The head must build on the reviewed one, stay under init's
//                  --fold-max-files (10) and --fold-max-lines (200), and have a clean detect.mjs run on it; next then says done, step merge
//   run.mjs strategy <run> <unit> --text T                          only when next says change-strategy
//   run.mjs integrate <run> pass|fail --evidence E [--gap G] [--cause C] [--behaviour G1=pass:"…" …] [--model M]
//                  only when next says integrate; a pass needs every goal behaviour passing. Once, at done-with-gaps after a
//                  failed check: pass --evidence E, the fresh check that passed on the fixed result; the run is then done
//   run.mjs note <run> --kind situation|decision|follow-up|retro|question|bar|info|person|escape --text T
//                  escape: --unit U, a passed unit where a defect turned up later (a later review, verify, test, a person); counted by stats
//                  [--recommend R] (question: the lead's pick) [--answers qN] (decision: closes question N)
//                  [--unit U] (person: a note from the person about one unit; decision, follow-up, info: scoped to that unit,
//                  shown on its page) [--confirm] (person: their words, pasted)
//                  [--asking dialog|dashboard] (decision: the person's intake answer on how questions are asked in this run;
//                  it wins over the project's "asking" setting, and ask prints the mode in force; a lead step:
//                  refused from another window, takes [--lead ID] [--takeover]; every other note is a worker step)
//   run.mjs brief <run> [<unit>] --role builder|critic|integrator [--quote file … --source label …] [--where W] [--playbook P (300 characters at most, refused over it)]
//                  [--findings-file F] the brief says to read F in full first: every finding to fix (builder) or to check;
//                  --where stays short (500 characters at most, refused over it, never cut): findings go in that file
//                  prints the brief; each quoted file is fenced as data, and the goal, bar and fence follow it.
//                  [--lessons N] the top N lessons for the run's tag ride along as hints (default 5, 0 for none),
//                  fenced as data too; a lesson counts as used once per run
//                  [--to F] writes the whole brief to F and prints a short prompt instead: the brief's marker line,
//                  then `Read "F" in full first`, so context.mjs still counts the agent under its role and round
//   run.mjs ask <run> --question Q --header H --option "label|description" (2-4, recommended first) [--multi] [--unit U]
//                  [--approves <label>] the option that approves a step only the person may approve (extend)
//                  [--grant-minutes N] with --approves, on a run question: the run time (1-1440 minutes) that option grants;
//                  its description states "N more minutes" (written for you when empty); the question, header and every option name no other amount
//   run.mjs ask <run> --finish <unit>   only when next says ask-person: the ready question next names, the finish line
//                  (ship with follow-ups, one more round, stop) or, with reason "same-files: <file>", same files
//                  (change the bar, simplify the design, accept as is, one more round); next acts on the person's pick
//                  The time budget pauses while a question to the person is open (ask to its answer) and no unit is building or judging.
//                  Prints the question's label: "<project> · <run name> (<run id>)", plus " › Task <unit>: <title>" on a unit (lib/questions.mjs questionLabel),
//                  and the asking mode in force: asking { mode: dialog|dashboard, from: run|project|default } (lib/questions.mjs askingMode)
//   run.mjs answer <run> qN [--choice label …] [--other T] [--by person|lead]   changeable until used
//                  [--confirm "their words"] with --by person only: the person said this; never without their words
//   run.mjs use-answer <run> qN     the lead acted on the answer: it can no longer change
//   run.mjs questions <run>         every question with its options, answer, history and status, and its label
//   run.mjs study <run> --topic T --area security|design|stack|other --text "what it learned" --source URL … [--lesson id …] [--by agent]
//                  one side study while the run waits (capped per run by --study-budget); lessons it added go in with lessons.mjs add --source
//   run.mjs self [--json] [--html]  the coordinator's own view across every run here (age, learning, memory, stats,
//                  history, plans, proposals, side study); --html writes coordinator.html in the state folder
//                  (every change rewrites it in the background: --html --queued is that writer; COORDINATOR_SNAPSHOT=sync
//                  writes it in place)
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
//   run.mjs suite <run> <unit> --head <sha> -- <test command …> | --result "<pass line>" [--fail]   the lead's full suite on
//                  that head: the command runs under this machine's one suite lock and is recorded; critics of the head cite it
//   run.mjs precheck <run> <unit> --base <ref> --head <ref>   mechanical checks of the diff (references/precheck.md), recorded;
//                  exits 1 on a hit. built --head refuses a head with one unless --skip-precheck --reason R; built --base B runs it
//   built … [--changelog "<line>"]   the unit's changelog line (units never edit CHANGELOG.md); run.mjs changelog <run> prints them all
//   run.mjs followup <run> --text T --triage batch|P1|P2|P3|drop --reason R [--unit U]   batch items make one unit that builds last
//   add … [--paths a,b] [--open "<why>"]; behave … [--open]; freeze … [--open]: a behaviour with never, any, all, cannot, only,
//                  always or every is refused unless it lists its cases or --open says why it can be met (logged)
//   run.mjs next --all     next for every open run this window leads
//   run.mjs next <run>     prints what to do and records any stops; on a run past its time budget it records nothing and
//                          lists the stops close will record (recorded: false); on a paused run it says how to resume
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
//   run.mjs bench plan|confirm|show|prices …   a run of the Coordinator Engineering Benchmark: the plan, its cost estimate at
//                  the suite's pinned prices and the person's go-ahead; no model is called before that
//                  (run.mjs bench --help lists the options; references/commands/bench.md)
//   run.mjs models [<run> <unit>] [--role builder|critic|… --class docs,auth]   the routing table, or the model for one role and task class;
//                  with the unit, the critic's model is the one verdict takes: strong, with why, when its title, bar,
//                  behaviours or a specialist critic pin it (lib/models.mjs cheapCriticRefusal)
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
//   run.mjs dashboard [--port P] [--open] [--foreground] | dashboard stop   the live page of every run on this PC
//                  (default port 7480), detached so it outlives this window (--foreground: in this process), output
//                  in ~/.coordinator/dashboard.log; a running one prints its link instead of starting another; its
//                  Waiting on you answers any registered run's open questions (references/hud.md)
//   run.mjs waiting [--json]   what waits on you across every run on this PC, oldest first: open questions,
//                  upstream proposals not filed, runs finished but not closed or waiting on their retro, paused
//                  runs, an out-of-date plugin (from the last online doctor check); from disk only (lib/waiting.mjs)
//   --harness NAME (any command): the tool running it (claude-code, codex, antigravity, gemini …); else
//                  COORDINATOR_HARNESS, else detected. Every write stamps the run with it and the skill version
// Every change appends one event to the run's events.jsonl; state.json is a snapshot derived from it.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, lstatSync, realpathSync, rmSync, statSync, truncateSync } from 'node:fs';
import { execFile, spawn as spawnProcess } from 'node:child_process';
import { basename, extname, join, resolve } from 'node:path';
import { helpAndExit, num, oneOf, optText, parse, score, text } from './lib/args.mjs';
import { behave, mark, reopen } from './lib/behaviours.mjs';
import { findFeatureMap, validateBehavioursAgainstFeatureMap } from './lib/featuremap.mjs';
import { applyPacketTransitionVerdict, attachUnitStatechart, behaviourSignature, checkBarFeasibility, readBoundedJsonFile, resolveAllowedRoots, resolveWorktreeRoot, syncStatechartStatuses } from './lib/statechart.mjs';
import { addEvidence, artifact, openStored, storedPath } from './lib/evidence.mjs';
import { prismRefusal } from './lib/prismreport.mjs';
import { homedir, tmpdir } from 'node:os';
import { briefPrompt, buildBrief } from './lib/briefs.mjs';
import { checksInForce, markUsed, topLessons } from './lib/lessonstore.mjs';
import { afterFixIntegration, allows, decide, decideUnit, earlySummary, oneCritic, spent, FAILING, FINISH, finishQuestion, openFindings, requiredOn, roundCap, SAME_FILES, SEVERITIES, specialistFailure, stats } from './lib/rules.mjs';
import { usedMinutes } from './lib/clock.mjs';
import { pauseNote, pausedRefusal, pauseRun, resumeRun } from './lib/pause.mjs';
import { COST_FLAGS, costEntry, costStats, launchCost, overLaunch } from './lib/cost.mjs';
import { openWarning, unboundedRefusal, unboundedWords as unboundedWordsOf } from './lib/openbar.mjs';
import { holdLock } from './lib/store.mjs';
import { drain as drainJob, queue as queueJob } from './lib/bgjob.mjs';
import { recordSuite, runSuite, sameHead, SHA, summaryLines } from './lib/suites.mjs';
import { precheck, precheckRules, RULES as PRECHECK_RULES } from './lib/precheck.mjs';
import { parseDiff } from './lib/gaming.mjs';
import { addedFiles, changedLines, checkedOut, commitOf, diffText, fileAt, namedIn, uncommitted } from './lib/gitdiff.mjs';
import { addFollowup } from './lib/followups.mjs';
import { leadBudget } from './lib/leadctx.mjs';
import { checkFold, FOLD_DEFAULTS, foldDiff, parseFinding } from './lib/findings.mjs';
import { childId, continuesOf, linkedRuns, parseContinues } from './lib/chain.mjs';
import { answerRefusal, confirmRefusal, decisionRefusal, grantQuestion, namedRounds, noteRefusal } from './lib/approval.mjs';
import { lastWriter } from './lib/provenance.mjs';
import { clip } from './lib/plain.mjs';
import { ordered, runStatus } from './lib/progress.mjs';
import { normPath, pendingSyncs, syncStep } from './lib/overlap.mjs';
import { harnessOf, stamp } from './lib/harness.mjs';
import { claim, claimText, decideLead, identity, isLeadStep, LEAD_FORMS, LEAD_STEPS, leadInfo, machineId, refresh, runMachine, secondBuilder, stale, windowAlive } from './lib/lead.mjs';
import { agoText } from './lib/progress.mjs';
import { entryFor, projectKey, readRegistry, register, registryFile, registryHome } from './lib/registry.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { childEnv, dashboardCaller, pcAnswer, VIA_ENV } from './lib/pcanswer.mjs';
import { VERSION } from './lib/version.mjs';
import { EVENTS, loadRun, readRun, updateRun } from './lib/events.mjs';
import { atLeast, byModel, cheapCriticRefusal, escalation, judgeAllowed, modelName, route, routing, setRouting, UNSPECIFIED } from './lib/models.mjs';
import { baseDir, isSafeId, projectDir, safeId, withLock, writeAtomic } from './lib/store.mjs';
import { githubRef, inferRepo, REPO, repoFromText, webUrl } from './lib/links.mjs';
import { activeHelpers, readSettings, settingsFile } from './lib/settings.mjs';
import { load as loadTheme, themeFile } from './lib/theme.mjs';
import { log } from './lib/timeline.mjs';
import { BENCH_FLAGS, BENCH_REPEAT, benchCommand, benchHelp } from './lib/ceb/cli.mjs';
import { ASKING, answer, answerText, ask, askingMode, events, find, fromForm, personNote, projectName, questions, useAnswer } from './lib/questions.mjs';
import { closeGap, gaps, gapsText, parseGapId } from './lib/gaps.mjs';
import { text as textView, view } from './lib/view.mjs';

// Modules only some commands need are loaded when one of them runs, so a read-only call (next, show, brief, …) does
// not compile the page writers (every run.mjs call is a new process). PAGES: what derived() and the pages need,
// loaded by main() before any command that may change a run; EXTRAS: what a few commands need (EXTRA_COMMANDS).
let hud, liveCtx, staticCtx, unitPage, mapsPage, reportFor, reportPages, storeReport, selfPage, selfModel, selfText, gapsCheckFile, loadRuns, loadSelf, selfVersion, PROJECT_PAGE, pcModel, pcPage, pcVersion, projectPage, render, waitingList, waitingText, buildMap, callsText, computeCalls, defaultDest, hasMap, mapAttach, mapHtml, mapNav, mapRestore, mapView, pitStop, readCalls, touchesOf, unitFiles;
let serve, bellConfig, listen, remoteWatch, pull, push, VISIBILITY_HINT, planCheck, hasRetro, retroCommand, addStudy, adopt, table, httpGet;
let pagesLoaded = null; let extrasLoaded = null;
const loadPages = () => (pagesLoaded ??= Promise.all([
    import('./lib/hud.mjs').then((x) => ({ hud, liveCtx, staticCtx } = x)),
    import('./lib/unitpage.mjs').then((x) => ({ unitPage } = x)),
    import('./lib/mapspage.mjs').then((x) => ({ mapsPage } = x)),
    import('./lib/report/cli.mjs').then((x) => ({ reportFor, reportPages, storeReport } = x)),
    import('./lib/selfpage.mjs').then((x) => ({ selfPage } = x)),
    import('./lib/self.mjs').then((x) => ({ selfModel, selfText } = x)),
    import('./lib/selfdata.mjs').then((x) => ({ gapsCheckFile, loadRuns, loadSelf, selfVersion } = x)),
    import('./lib/dashboard.mjs').then((x) => ({ PROJECT_PAGE, pcModel, pcPage, pcVersion, projectPage } = x)),
    import('./lib/workbench.mjs').then((x) => ({ render } = x)),
    import('./lib/waiting.mjs').then((x) => ({ waitingList, waitingText } = x)),
    import('./lib/map/index.mjs').then((x) => ({ build: buildMap, callsText, computeCalls, defaultDest, hasMap, mapAttach, mapHtml, mapNav, mapRestore, mapView, pitStop, readCalls, touchesOf, unitFiles } = x)),
]));
const loadExtras = () => (extrasLoaded ??= Promise.all([
    import('./lib/serve.mjs').then((x) => ({ serve } = x)),
    import('./lib/doorbell.mjs').then((x) => ({ bellConfig, listen } = x)),
    import('./lib/remote.mjs').then((x) => ({ remoteWatch } = x)),
    import('./lib/statesync.mjs').then((x) => ({ pull, push, VISIBILITY_HINT } = x)),
    import('./lib/gapcheck.mjs').then((x) => ({ planCheck } = x)),
    import('./lib/retro.mjs').then((x) => ({ hasRetro, retroCommand } = x)),
    import('./lib/study.mjs').then((x) => ({ addStudy } = x)),
    import('./lib/adopt.mjs').then((x) => ({ adopt, table } = x)),
    import('node:http').then((x) => ({ get: httpGet } = x)),
]));
// Commands that never write a run, or whose rare write (next: a stop, a rebuilt snapshot) has its pages rewritten after it (PAGES_DUE).
const NO_PAGES = new Set(['behaviours', 'questions', 'show', 'status-line', 'where', 'stats', 'models', 'brief', 'next', 'bench', 'changelog']);
const EXTRA_COMMANDS = new Set(['init', 'close', 'adopt', 'serve', 'dashboard', 'watch', 'push', 'pull', 'gaps', 'gap', 'study', 'lead']);

const FLAGS = {
  init: ['alias', 'goal', 'bar', 'fence', 'paths', 'tag', 'max-rounds', 'max-minutes', 'max-units', 'max-added', 'stale-minutes', 'max-launch-minutes', 'max-launch-cost', 'repo', 'theme', 'study-budget', 'models', 'continues', 'accept-open', 'fold-max-files', 'fold-max-lines'],
  extend: ['rounds', 'minutes', 'reason', 'answer'], 'add-specialist': ['reason'],
  start: ['model', 'why', 'force-model', 'force-start', 'reason', 'skip-feasibility', ...COST_FLAGS], models: ['role', 'class'], foldin: ['head', 'reviewed', 'evidence', ...COST_FLAGS],
  study: ['topic', 'area', 'text', 'source', 'lesson', 'by'], self: ['json', 'html', 'queued'], gaps: ['json', 'all', 'check', 'run', 'dry-run'], gap: ['reason', 'by', 'confirm'],
  add: ['bar', 'after', 'reason', 'title', 'link', 'issue', 'pr', 'behaviour', 'specialist', 'continues', 'accept-open', 'open', 'paths', 'feature-map', 'new-surface', 'statechart'], verdict: ['evidence', 'gap', 'cause', 'score', 'behaviour', 'critic', 'specialist', 'model', 'class', 'severity', 'finding', 'fold', 'full-suite', 'head', 'early', 'reins-packet', ...COST_FLAGS], strategy: ['text'], ship: ['merge', 'reason', 'answer', 'confirm'],
  integrate: ['evidence', 'gap', 'cause', 'behaviour', 'model'], beat: ['text'], built: ['report', 'head', 'base', 'changelog', 'skip-precheck', 'reason', ...COST_FLAGS],
  behave: ['goal', 'id', 'text', 'remove', 'reason', 'accept-open', 'open', 'feature-map', 'new-surface', 'statechart'], evidence: ['goal', 'behaviour', 'text', 'file', 'url', 'kind', 'label'],
  freeze: ['feature-map', 'new-surface', 'skip-feasibility', 'statechart', 'open'],
  suite: ['head', 'result', 'fail'], precheck: ['base', 'head'], changelog: [], followup: ['text', 'triage', 'reason', 'unit'], next: ['all'],
  link: ['issue', 'pr', 'merge', 'url', 'label', 'continues', 'same-tree'], note: ['kind', 'text', 'recommend', 'answers', 'unit', 'confirm', 'asking'],
  ask: ['question', 'header', 'option', 'multi', 'unit', 'approves', 'grant-minutes', 'finish'], answer: ['choice', 'other', 'by', 'confirm'], serve: ['port'], watch: ['remote', 'every'], map: ['root', 'max-seconds', 'unit', 'pit-stop', 'dest', 'fresh', 'force', 'reset-stage'], touches: ['json', 'unit'], calls: ['root', 'base', 'head', 'files', 'max-seconds', 'json'], sync: ['text'], close: ['outcome', 'reason'], adopt: ['dry-run'], report: ['draft', 'file', 'i-checked'], quality: ['project', 'json'], stats: ['tag'], reset: ['reason'],
  brief: ['role', 'quote', 'source', 'where', 'findings-file', 'playbook', 'lessons', 'to'], dashboard: ['port', 'open', 'foreground'], list: ['all'], waiting: ['json'], 'status-line': ['json'],
  push: ['to', 'message'], pull: ['from'], bench: BENCH_FLAGS, pause: ['reason'], lead: ['lead', 'takeover', 'reason'],
};
// Lead steps (lib/lead.mjs) all take --lead and --takeover (claims a gone lead's run). A step's own --reason is never a
// takeover's reason: only run.mjs lead <run> --takeover --reason R takes over a lead that is still active.
// note takes them too, for its one lead form (note --asking, LEAD_FORMS); any other note refuses them.
for (const c of [...LEAD_STEPS, ...Object.keys(LEAD_FORMS)]) FLAGS[c] = [...new Set([...(FLAGS[c] ?? []), 'lead', 'takeover'])];
// Notes about one unit (#45): scoped with --unit, shown on its page.
const UNIT_NOTES = ['decision', 'follow-up', 'info'];
const REPEAT = { init: ['continues'], study: ['source', 'lesson'], ask: ['option'], answer: ['choice'], add: ['behaviour', 'issue', 'pr'], verdict: ['behaviour', 'fold', 'finding'], integrate: ['behaviour'], link: ['issue', 'pr', 'merge'], brief: ['quote', 'source'], bench: BENCH_REPEAT, suite: ['result'] };

const featureMapRoot = () => resolveWorktreeRoot({ project: projectDir(), base: baseDir('project'), cwd: process.cwd() });
function readJsonOpt(raw, { flag, allowInline = false, maxBytes, run = null } = {}) {
  const project = projectDir();
  const base = baseDir('project');
  const cwd = process.cwd();
  const runDirPath = run && isSafeId(run) ? runDir(run) : null;
  return readBoundedJsonFile(raw, {
    flag,
    allowInline,
    maxBytes,
    baseDir: resolveWorktreeRoot({ project, base, cwd }),
    allowedRoots: resolveAllowedRoots({ project, base, runDirPath, cwd }),
  });
}
function validateUnitSurfaceBar(u, o = {}) {
  if (o['new-surface'] !== undefined && o['new-surface'] !== true) throw new Error('--new-surface takes no value');
  if (o['feature-map'] !== undefined && (typeof o['feature-map'] !== 'string' || !o['feature-map'].trim())) {
    throw new Error('--feature-map requires a non-empty path');
  }
  const fm = findFeatureMap(featureMapRoot(), o['feature-map'] ?? null);
  if (!fm.found) return fm;
  const res = validateBehavioursAgainstFeatureMap(u.behaviours ?? [], fm, {
    allowNew: o['new-surface'] === true,
    bar: u.bar ?? '',
    priorContract: u.surfaceContract ?? [],
  });
  if (!res.ok) throw new Error(res.errors.map((e) => e.message).join('; '));
  if (res.matched.length) u.surfaceContract = res.matched;
  else delete u.surfaceContract;
  return fm;
}

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
      st.notes.push({ kind: 'decision', answers: u.answer, text: `${unit.id}: shipped with follow-ups (score ${last?.score ?? 'none'}), the person's choice at ${u.at ?? 'the finish line'} (${u.answer}); ${open.length} open finding${open.length === 1 ? '' : 's'} filed as follow-ups`, at: now() });
      for (const f of open) st.notes.push({ kind: 'follow-up', unit: unit.id, shipped: u.answer, text: `${unit.id} (shipped, ${f.severity}${f.by === 'critic' ? '' : `, ${f.by}`}): ${f.text}`, at: now() });
      log(unit, 'ship', `shipped with follow-ups (${u.answer})`);
      stopped.set(u.id, { id: u.id, action: 'done', step: 'merge', reason: `shipped with follow-ups (${u.answer})` }); changed = true;
    } else if (u.action === 'one-more') { // the person chose one more round: recorded like extend, then the usual rules decide
      const unit = st.units.find((x) => x.id === u.id);
      const lifted = unit.rounds.length >= roundCap(unit, st);
      if (lifted) unit.extraRounds = (unit.extraRounds ?? 0) + 1;
      const q = (st.notes ?? []).filter((n) => n.kind === 'question')[Number(u.answer.slice(1)) - 1];
      const a = q?.history?.at(-1);
      const what = u.choice && u.choice !== SAME_FILES.round ? `${u.choice.toLowerCase()}, then one more round` : 'one more round';
      st.notes.push({ kind: 'decision', answers: u.answer, text: `${unit.id}: ${what}${lifted ? ` (now ${roundCap(unit, st)})` : ''}, the person's choice at ${u.at ?? 'the finish line'} (${u.answer} answered "${a?.choices?.[0] ?? ''}" via ${a?.via ?? 'unknown'}${a?.confirm ? `, their words: "${String(a.confirm).slice(0, 200)}"` : ''}); the same-gap and no-progress rules still apply`, at: now() });
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
const repoFor = (s) => s.repo ?? inferRepo(projectDir(), { cacheFile: join(baseDir('project'), 'repo-cache.json') }) ?? repoFromText(JSON.stringify(s));
// Settings from .coordinator/coordinator.json; a broken file means defaults here (doctor reports it).
const asArg = (v) => (Number.isInteger(v) ? String(v) : undefined);
const settings = () => readSettings(baseDir('project')).settings;
const themeFor = (s) => { const t = settings().theme; return loadTheme(themeFile(s, projectDir()) ?? (typeof t === 'string' && t ? resolve(projectDir(), t) : null)); };

// The files people read: rewritten inside the state's lock after every change.
// hud.html and units/<unit>.html are static snapshots: no script, no network.
// A write by a command that runs without the page modules (NO_PAGES: next rebuilding a stale snapshot, importing a
// legacy run, recording a stop) leaves the run in PAGES_DUE; main() loads the modules after the command and rewrites them.
const PAGES_DUE = new Set();
function derived(s) {
  if (typeof render !== 'function') { PAGES_DUE.add(s.id); return; }
  const plan = decide(s);
  writeAtomic(join(runsDir(), s.id, 'workbench.md'), render(s, plan));
  const v = view(s, plan, Date.now(), { repo: repoFor(s), linked: linkedOf(s), project: project() });
  const theme = themeFor(s);
  writeAtomic(hudFile(s.id), hud(v, Date.now(), staticCtx(runDir(s.id), 0, theme)));
  const calls = readCalls(runDir(s.id)); // per-unit function calls (map/calls/), when computed
  writeAtomic(join(runDir(s.id), 'maps.html'), mapsPage(v, Date.now(), { ...staticCtx(runDir(s.id), 0, theme), calls }));
  for (const u of s.units) writeAtomic(join(runDir(s.id), 'units', `${u.id}.html`), unitPage(v, u.id, Date.now(), { ...staticCtx(runDir(s.id), 1, theme), calls }));
  for (const [name, html] of reportPages(s, v, runDir(s.id), staticCtx(runDir(s.id), 0, theme))) writeAtomic(join(runDir(s.id), name), html);
  registerRun(s);
  queueSnapshot();
}

// coordinator.html in the state folder: the coordinator page as a file, rewritten after every change to a
// run (about a third of a second on a 56 MB folder), by a background writer (queueSnapshot) so the command that
// made the change does not wait for it. It reads every run of this folder under the snapshot's own lock, so of two
// writers at once the later one, which read the later state, writes last. The PC's runs come from the register
// alone. The live page is run.mjs dashboard. Throws when it could not write the page.
const snapshotFile = () => join(baseDir('project'), 'coordinator.html');
function renderSnapshot() {
  const file = snapshotFile();
  withLock(file, () => {
    const t = Date.now();
    const reg = readRegistry(); // once per snapshot: each read checks every entry's folder on disk
    const m = { ...selfModel({ ...loadSelf(), current: null }), pc: pcModel(reg, { here: baseDir('project'), read: false }) };
    const ctx = { ...staticCtx(null, 0, loadTheme(themeFile({}, projectDir()))), runHref: (id) => `runs/${encodeURIComponent(id)}/hud.html`, pcHref: staticPcHref(reg) };
    writeAtomic(file, selfPage(m, t, ctx));
  });
  return file;
}
function writeSnapshot() {
  try { return renderSnapshot(); } catch (e) { console.error(`warning: ${snapshotFile()} was not rewritten: ${e.message}`); return null; }
}

// After a change: the background writer (lib/bgjob.mjs; run.mjs self --html --queued) rewrites coordinator.html, one
// at a time, until the last change's stamp is covered; a burst of changes costs one or two renders. It starts in
// the temp folder, so it never holds the project folder open (Windows refuses to delete a live process's working
// folder), with the project named in COORDINATOR_PROJECT_DIR. A render that fails leaves its error in
// coordinator.html.error and the stamp uncovered, so the next change tries again. COORDINATOR_SNAPSHOT=sync writes it
// in place instead (the default under node:test, whose temporary folders a background writer would outlive).
const snapshotJob = () => { const f = snapshotFile(); return { want: `${f}.want`, done: `${f}.done`, lock: `${f}.writer`, error: `${f}.error` }; };
const snapshotSync = () => (process.env.COORDINATOR_SNAPSHOT ?? (process.env.NODE_TEST_CONTEXT ? 'sync' : 'background')) === 'sync';
function queueSnapshot() {
  if (snapshotSync()) return writeSnapshot();
  const job = snapshotJob();
  try {
    queueJob(job, (handover) => {
      const env = { ...process.env, COORDINATOR_PROJECT_DIR: projectDir(), COORDINATOR_JOB_HANDOVER: handover };
      const child = spawnProcess(process.execPath, [RUN_MJS, 'self', '--html', '--queued'], { cwd: tmpdir(), env, detached: true, stdio: 'ignore', windowsHide: true });
      // A writer that started and then failed: its lock names a dead pid (the next change takes it over), and the
      // page is written here. One that never started has no pid: queue throws and the catch below writes it.
      child.once('error', () => { if (child.pid !== undefined) writeSnapshot(); });
      child.unref();
      return child.pid;
    });
    return null;
  } catch (e) {
    console.error(`warning: coordinator.html is written in place (no background writer: ${e.message})`);
    return writeSnapshot();
  }
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
const staticPcHref = (reg) => (key, run) => {
  const e = reg.find((x) => x.key === key && x.run === run);
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
// the global dashboard. It never fails the write; COORDINATOR_REGISTRY=off leaves it alone, and a run
// whose state folder is in the system temporary folder is left out unless COORDINATOR_REGISTRY=on.
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
// The project in each question's label: the folder that holds .coordinator/ (lib/questions.mjs projectName).
const project = () => projectName(baseDir('project'));
const labelOf = (s, id) => questions(s, { project: project() }).find((q) => q.id === id)?.label ?? null;
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
// During a lead step on this run (LEAD), refused unless this window leads it; a claim the step needs is written
// with it, as its own lead.claim event, in the same lock: both or neither. A change it makes marks the lead
// active and records this window's process again (a resumed window has a new one).
// leadWhen: { o, when(s) }: this change is a lead step only when when(s) holds on the locked state (next, when it
// records a stop); the check is made there, in the same locked write as the change.
function change(run, kind, mutate, { closedOk = false, unit = null, leadWhen = null } = {}) {
  if (!exists(run)) throw new Error(`no run: ${run}`);
  let claimed = null;
  const out = updateRun(runDir(run), { kind, unit, by: BY }, (s, mark) => {
    if (s.closed && !closedOk) throw new Error(`run ${run} is closed`);
    if (leadWhen && !LEAD && !s.closed && leadWhen.when(s)) leadCheck(run, leadWhen.o, s);
    const mine = LEAD && LEAD.run === s.id && !s.closed;
    if (mine) claimed = leadOf(s, mark);
    const before = mine ? JSON.stringify(s) : null;
    mutate(s);
    if (mine) {
      const machine = machineFor(s.id, LEAD.me);
      if (JSON.stringify(s) !== before || stale(s.lead, LEAD.me, machine)) refresh(s, LEAD.me, { at: now(), machine });
    }
  }, derived);
  if (claimed) CLAIMED = claimed;
  return out;
}

// One lead per run (lib/lead.mjs). LEAD: this window while one of its lead steps runs (led: it led the run
// before this step); CLAIMED: what a claim prints.
let LEAD = null; let CLAIMED = null;
// This PC's value for a run (lib/lead.mjs runMachine): read only when checking, made when a lead is recorded.
const hereFor = (run, create) => { const m = machineId(registryHome(), { create }); return m ? runMachine(m, projectKey(baseDir('project')), run) : null; };
const machineFor = (run, me) => (me.pid ? hereFor(run, true) : null);
const leadAlive = (lead, run) => windowAlive(pidAlive, (r) => hereFor(r, false))(lead, run);
const takeoverOf = (o) => {
  if (o.takeover !== undefined && o.takeover !== true) throw new Error('--takeover takes no value');
  return o.takeover === true;
};
// Before a lead step changes anything: who this window is (a bad --lead stops it here), and whether it may lead
// the run. Refuses at once when it may not; writes nothing (change() writes the claim with the step).
// --takeover claims a gone lead's run, never an active one (run.mjs lead --takeover --reason R does that).
// s: the run's state when the caller already holds it (under the lock).
function leadCheck(run, o, s = null) {
  const me = identity(BY.harness, { flag: o.lead });
  const opts = () => ({ nowMs: Date.now(), alive: leadAlive, claimGone: takeoverOf(o) });
  const first = decideLead(s ?? load(run), me, opts());
  if (first.action === 'refuse') throw new Error(first.message);
  LEAD = { run: safeId(run, 'run'), me, opts, led: first.action === 'lead' };
  return LEAD;
}
// Under the run's lock: decides again (another window may have claimed it since) and records a claim.
// mark (lib/events.mjs updateRun): ends the claim's own lead.claim event before the step's.
function leadOf(s, mark = null) {
  const d = decideLead(s, LEAD.me, LEAD.opts());
  if (d.action === 'refuse') throw new Error(d.message);
  if (d.action !== 'claim') return null;
  const lead = claim(s, LEAD.me, { harness: BY.harness, at: now(), from: d.from, why: d.why, machine: machineFor(s.id, LEAD.me) });
  mark?.('lead.claim');
  return claimText(LEAD.me, lead, BY.harness);
}
// A claim on its own (push, run.mjs lead): one lead.claim event.
function claimNow(run) {
  let claimed = null;
  updateRun(runDir(run), { kind: 'lead.claim', by: BY }, (s) => { claimed = leadOf(s); }, derived);
  if (claimed) CLAIMED = claimed;
}
// --continues also writes the parent run's side of the link: refused while another window actively leads the
// parent (a gone lead, or none, is fine: that link is all this writes there).
function parentLead(c, o) {
  const p = load(c.run);
  if (p.closed) return;
  const d = decideLead(p, identity(BY.harness, { flag: o.lead }), { nowMs: Date.now(), alive: leadAlive, claimGone: true });
  if (d.action === 'refuse') throw new Error(`--continues ${c.run}:${c.unit}: ${d.message}`);
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

// The person's approving answer to q for `extend` (lib/approval.mjs): unused, the approving option picked by
// the person, the answer and the question written by their commands (never a hand edit: lib/provenance.mjs).
// Their words (option and confirmed text) and how the decision quotes them.
function approvingAnswer(q, written) {
  if (['used', 'decided'].includes(q.status)) throw new Error(`extend refused: ${q.id} is already ${q.status}; one approval is good for one extend: ask again`);
  const why = answerRefusal(q);
  if (why) throw new Error(`extend refused: ${why}`);
  const qi = +q.id.slice(1) - 1; const hi = q.history.length - 1;
  written((st) => st?.notes?.filter((n) => n.kind === 'question')[qi]?.history?.[hi], ['answer'], `${q.id}'s answer`);
  written((st) => { const n = st?.notes?.filter((x) => x.kind === 'question')[qi]; return n && { text: n.text, header: n.header, approves: n.approves, unit: n.unit, options: n.options, grantMinutes: n.grantMinutes }; }, ['question'], `${q.id}`);
  const opt = q.options.find((x) => x.label === q.answer.choices[0]);
  return {
    words: [opt?.label, opt?.description, q.answer.confirm].filter(Boolean).join(' '), confirm: q.answer.confirm ?? null,
    source: `${q.id} "${q.header ? `${q.header}: ` : ''}${clip(q.text, 160)}" answered "${q.answer.choices[0]}${opt?.description ? ` (${clip(opt.description, 120)})` : ''}" via ${q.answer.via}${q.answer.confirm ? `, their words: "${clip(q.answer.confirm, 200)}"` : ''}`,
  };
}

// More minutes for the run's time budget (`extend <run> --minutes`), on the person's approving answer to a
// question on the run: exactly the minutes stored on it (ask --grant-minutes N), or fewer with --minutes, never read from
// their words; their confirmed words may only repeat N and ask for no less (lib/approval.mjs confirmRefusal). next reads the budget afresh, so units past it go on.
function extendTime(run, o) {
  if (o.rounds !== undefined) throw new Error('--rounds goes with a unit (extend <run> <unit>); more time for the run is --minutes');
  if (o.answer === undefined || o.answer === true) throw new Error('extend refused: more time needs --answer qN, a question on the run (no --unit) asked with --approves and answered by the person with that option');
  const reason = text(o.reason, 'reason', 300);
  const asked = num(o.minutes, null, 1, 10_080); // at most what their words name; their number when left out
  return change(run, 'run.extend', (s) => {
    const q = questions(s).find((x) => x.id === String(o.answer));
    if (!q) throw new Error(`--answer: no question ${o.answer}`);
    if (q.unit) throw new Error(`--answer: ${q.id} is about ${q.unit}; a question approving more time for the run names no unit`);
    const granted = q.grantMinutes;
    // The stored question passes the check ask ran (lib/approval.mjs grantQuestion), whoever last wrote it.
    if (Number.isInteger(granted) && granted >= 1) {
      try { grantQuestion(q, granted); } catch (e) { throw new Error(`extend refused: ${q.id}: ${e.message}; ask again`); }
    }
    const { confirm, source } = approvingAnswer(q, writtenBy(run, s, 'extend'));
    if (!Number.isInteger(granted) || granted < 1) throw new Error(`extend refused: ${q.id} stores no amount of time: ask again with --grant-minutes N, e.g. --option "Yes" --approves Yes --grant-minutes 60`);
    const why = confirm && confirmRefusal(confirm, granted);
    if (why) throw new Error(`extend refused: ${q.id}'s confirmed words ${why}; ask again with the amount they want`);
    const minutes = asked ?? granted;
    if (minutes > granted) throw new Error(`extend refused: --minutes ${minutes}, but ${q.id} grants ${granted}`);
    const before = s.budget.maxMinutes; const total = before + minutes;
    if (total > 10_080) throw new Error(`extend refused: the time budget would be ${total} minutes, over the 10080 limit`);
    const used = Math.round(usedMinutes(s, Date.now()));
    s.budget.maxMinutes = total;
    s.budget.addedMinutes = (Number.isInteger(s.budget.addedMinutes) ? s.budget.addedMinutes : 0) + minutes;
    const scope = minutes === granted ? `${q.id} grants ${granted}` : `${q.id} grants ${granted}; ${minutes} added`;
    s.notes.push({ kind: 'decision', answers: q.id, at: now(), text: `run time budget: ${minutes} more minutes (now ${total}, was ${before}; ${used} used; ${scope}), approved by the person (${source}): ${reason}` });
  });
}

// The ready question next names for the unit (lib/rules.mjs): the finish line, or same files. Logged on the unit only when `next` asks for it.
function askFinish(run, o) {
  if (typeof o.finish !== 'string') throw new Error('--finish takes the unit: ask <run> --finish <unit>');
  for (const k of ['question', 'header', 'option', 'multi', 'unit', 'approves', 'grant-minutes']) if (o[k] !== undefined) throw new Error(`--${k} does not go with --finish: the question is ready-made`);
  let id;
  const s = change(run, 'question', (st) => {
    const u = unitOf(st, o.finish);
    const d = decideUnit(u, st, Date.now());
    if (d.action !== 'ask-person' || d.asked) throw new Error(`ask --finish refused: next says "${d.action}"${d.asked ? ` (already asked as ${d.asked})` : ''} for ${u.id}`);
    const q = d.question ?? finishQuestion(u);
    id = ask(st, { question: q.question, header: q.header, option: q.options, unit: u.id });
    const note = st.notes.filter((n) => n.kind === 'question').at(-1);
    if (Array.isArray(d.behaviours)) note.sameBehaviours = d.behaviours; else if (Array.isArray(d.files)) note.sameFiles = d.files; else note.finish = true;
  }, { unit: String(o.finish) });
  return { ...s, asked: id, label: labelOf(s, id), asking: askingMode(s, settings()) };
}

// A brief is never cut silently (the reins-flight retro: fix rounds lost their finding lists to a cut --where).
// A --where over the limit is refused; the findings go in a file the brief names (--findings-file).
const WHERE_MAX = 500;
function briefWhere(value) {
  const where = optText(value, Infinity);
  if (where && where.length > WHERE_MAX) throw new Error(`--where is ${where.length} characters, over the ${WHERE_MAX} limit: keep --where to the worktree or branch and put the findings in a file, passed with --findings-file <path>`);
  return where;
}
// --playbook is refused over its limit too, never cut.
const PLAYBOOK_MAX = 300;
function briefPlaybook(value) {
  const playbook = optText(value, Infinity);
  if (playbook && playbook.length > PLAYBOOK_MAX) throw new Error(`--playbook is ${playbook.length} characters, over the ${PLAYBOOK_MAX} limit: keep it to the playbook's name or path`);
  return playbook;
}
function findingsFile(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error('--findings-file takes a path');
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('--findings-file: the path has a control character');
  const path = resolve(value);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`--findings-file: no file ${path}`);
  return path.replace(/\\/g, '/');
}

// brief --to: where the whole brief is written (context.md, rule 8).
function briefTo(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim()) throw new Error('--to takes a file path');
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('--to: the path has a control character');
  const path = resolve(value);
  if (existsSync(path) && !statSync(path).isFile()) throw new Error(`--to: ${path} is not a file`);
  return path;
}

// --open "<why it can be met>": keeps a behaviour line that reads unbounded (lib/openbar.mjs unboundedRefusal), logged.
const openReason = (v) => (v === undefined ? null : text(v === true ? undefined : v, 'open (why the line can be met as written)', 300));
function keepOpen(s, u, id, why) {
  if (!why) return;
  const b = (u ? u.behaviours : s.goalBehaviours)?.find((x) => x.id === id);
  if (!b || !unboundedWordsOf(b.text).length) return;
  b.open = why;
  s.notes.push({ kind: 'bar', ...(u ? { unit: u.id } : {}), text: `${u ? u.id : 'goal'} ${id} kept open-ended (${unboundedWordsOf(b.text).join(', ')}): ${why}`, at: now() });
}

// The command after -- on run.mjs suite (set by main), run as an argument list.
let SUITE_ARGV = [];

// precheck on base..head in the project's checkout (lib/precheck.mjs): the rules from the settings, the diff, the
// files it adds, the test lists' text at head, and whether a test file at head names each new module.
function runPrecheck(baseRef, headRef) {
  const root = projectDir();
  const rules = precheckRules(settings().precheck);
  const base = commitOf(root, baseRef, 'base'); const head = commitOf(root, headRef, 'head');
  const tests = new RegExp(rules.tests);
  const lists = rules.testList.map((file) => ({ file, text: fileAt(root, head, file) ?? '' }));
  const hits = precheck({ files: parseDiff(diffText(root, base, head)), added: addedFiles(root, base, head) }, rules, { lists, mentioned: (name) => namedIn(root, head, name, tests) });
  return { base, head, hits };
}
// Every precheck rule turned off ("precheck": false, or all of them in "off"): built needs no precheck then.
const precheckOff = () => new Set(precheckRules(settings().precheck).off).size >= PRECHECK_RULES.length;

// The delta a later round's critic reviews: lines changed since the last reviewed head (lib/rules.mjs oneCritic).
function deltaOf(u, head) {
  const from = u.rounds.at(-1)?.reviewedHead;
  if (!from || !head) return null;
  const lines = changedLines(projectDir(), from, head);
  return Number.isInteger(lines) ? { from, to: head, lines } : null;
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
    // Who leads, checked before anything is written: a bad --lead leaves no run without a lead.
    const me = identity(BY.harness, { flag: o.lead });
    if (takeoverOf(o)) throw new Error('--takeover: a new run has no lead to take over');
    for (const c of parents) parentLead(c, o);
    // The window that starts the run leads it: run.init and its lead.claim are written together, or neither.
    LEAD = { run, me, opts: () => ({ nowMs: Date.now(), alive: leadAlive }), led: false };
    let claimed = null;
    updateRun(runDir(run), { kind: 'run.init', by: BY, then: { kind: 'lead.claim', mutate: (s) => { claimed = leadOf(s); } } }, (s) => { if (s) throw new Error(`run exists: ${run}`); return fresh; }, derived);
    if (claimed) CLAIMED = claimed;
    const made = load(run);
    if (routeOn !== undefined) setRouting(baseDir('project'), routeOn); // only once the run exists
    for (const c of parents) markParent(c, run);
    // push needs to know whether the repo is public; say where to put it now, not at the first pit stop (#66).
    const st = settings();
    const setup = st.visibility === undefined && st.state !== 'local' && !st.stateRepo ? `before push: gh is asked whether this repo is public, and the push is refused when it cannot say. ${VISIBILITY_HINT(settingsFile(baseDir('project')))}` : null;
    // The checks the scripts enforce on this run, and the lessons made checks (lessons.mjs mark --check).
    let off = [];
    try { if (precheckRules(st.precheck).off.length === PRECHECK_RULES.length) off = ['precheck']; } catch { /* doctor reports a bad setting */ }
    const checks = checksInForce([baseDir('project'), baseDir('global')], { off });
    return Object.assign(made, warning ? { warning } : {}, setup ? { setup } : {}, { checks });
  },
  add([run, unit], o) {
    const cont = o.continues === undefined ? null : parentOf(o.continues, run, safeId(unit, 'unit'));
    if (cont) parentLead(cont, o);
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
      const openWhy = openReason(o.open);
      const refusal = unboundedRefusal((o.behaviour ?? []).map((b, i) => ({ what: `${unit} behaviour ${i + 1}`, text: b, open: openWhy })));
      if (refusal) throw new Error(refusal);
      for (const b of o.behaviour ?? []) { const id = behave(s, u, { text: b }); log(u, 'behaviour', `${id}: ${optText(b, 300)}`); keepOpen(s, u, id, openWhy); }
      const paths = list(o.paths);
      if (paths.length) u.paths = paths;
      const fm = validateUnitSurfaceBar(u, o);
      attachUnitStatechart(u, fm, { rawStatechart: o.statechart !== undefined ? readJsonOpt(o.statechart, { flag: '--statechart', allowInline: true, run }) : null });
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
      if (usedMinutes(s, Date.now()) > s.budget.maxMinutes) throw new Error('add-specialist refused: the time budget is spent; it stops new critics');
      if ((u.specialists ?? []).includes(who)) throw new Error(`${u.id} already has specialist ${who}`);
      u.specialists = [...(u.specialists ?? []), who];
      (u.specialistFrom ??= {})[who] = u.rounds.length + 1;
      s.notes.push({ kind: 'decision', unit: u.id, text: `${u.id}: specialist ${who} added, required from round ${u.rounds.length + 1}: ${reason}`, at: now() });
    }, { unit });
  },
  async freeze([run], o = {}) {
    if (o['skip-feasibility'] !== undefined && o['skip-feasibility'] !== true) throw new Error('--skip-feasibility takes no value');
    const pre = load(run);
    if (!pre.units.length) throw new Error('add units first');
    const preMissing = (pre.continues ?? []).filter((c) => !pre.units.some((u) => u.id === childId(c)));
    if (preMissing.length) throw new Error(`freeze refused: the run continues ${preMissing.map((c) => `${c.run}:${c.unit}`).join(', ')}; add ${preMissing.map(childId).join(', ')} (or add a unit with --continues <run>:<unit>)`);
    const rawChart = o.statechart !== undefined ? readJsonOpt(o.statechart, { flag: '--statechart', allowInline: true, run }) : null;
    for (const u of pre.units) validateUnitSurfaceBar(structuredClone(u), o);
    const feasMap = new Map();
    if (o['skip-feasibility'] !== true) {
      const hcfg = activeHelpers(baseDir('project'));
      if (hcfg.error) throw new Error(hcfg.error);
      if (hcfg.on) {
        const checks = await Promise.all(pre.units.map(async (u) => [u.id, { ...(await checkBarFeasibility(u, hcfg)), sig: behaviourSignature(u), at: now() }]));
        for (const [uid, res] of checks) {
          if (!res.ok) throw new Error(res.message);
          feasMap.set(uid, res);
        }
      }
    }
    return change(run, 'run.freeze', (s) => {
      if (!s.units.length) throw new Error('add units first');
      const missing = (s.continues ?? []).filter((c) => !s.units.some((u) => u.id === childId(c)));
      if (missing.length) throw new Error(`freeze refused: the run continues ${missing.map((c) => `${c.run}:${c.unit}`).join(', ')}; add ${missing.map(childId).join(', ')} (or add a unit with --continues <run>:<unit>)`);
      for (const u of s.units) {
        const fm = validateUnitSurfaceBar(u, o);
        attachUnitStatechart(u, fm, { rawStatechart: rawChart });
        const feas = feasMap.get(u.id);
        if (feas) u.feasibility = feas;
      }
      // Every behaviour reads closed, or carries its --open reason (lib/openbar.mjs unboundedRefusal).
      const openWhy = openReason(o.open);
      const lines = [...(s.goalBehaviours ?? []).map((b) => ({ u: null, b })), ...s.units.flatMap((u) => (u.behaviours ?? []).map((b) => ({ u, b })))];
      const refusal = unboundedRefusal(lines.map(({ u, b }) => ({ what: `${u ? u.id : 'goal'} ${b.id}`, text: b.text, open: b.open ?? openWhy })));
      if (refusal) throw new Error(`freeze ${refusal}`);
      if (openWhy) for (const { u, b } of lines) if (!b.open) keepOpen(s, u, b.id, openWhy);
      s.frozen = true;
    });
  },
  // The person stops the work by hand (overnight, a restart): paused minutes count toward no budget
  // and no unit starts until resume (lib/pause.mjs, #132).
  pause([run], o) {
    const reason = text(o.reason, 'reason (why the run pauses)', 300);
    return change(run, 'run.pause', (s) => pauseRun(s, { reason, at: now() }));
  },
  resume([run]) { return change(run, 'run.resume', (s) => resumeRun(s, { at: now() })); },
  // A new build: the critic marks every behaviour again.
  async start([run, unit], o) {
    if (o['skip-feasibility'] !== undefined && o['skip-feasibility'] !== true) throw new Error('--skip-feasibility takes no value');
    const model = modelName(o.model, 'model'); const why = optText(o.why, 80);
    if (why && !model) throw new Error('--why goes with --model');
    const force = o['force-model'] === undefined ? null : text(o['force-model'] === true ? undefined : o['force-model'], 'reason for --force-model', 300);
    if (force && !model) throw new Error('--force-model goes with --model');
    if (o['force-start'] !== undefined && o['force-start'] !== true) throw new Error('--force-start takes no value; give --reason R');
    const early = o['force-start'] === true ? text(o.reason, 'reason (starting before the specialists marked the round)', 300) : null;
    const takeover = takeoverOf(o);
    if (!early && !takeover && o.reason !== undefined) throw new Error('--reason goes with --force-start or --takeover');
    const cfg = routing(baseDir('project'));
    let checkedFeas = null;
    if (o['skip-feasibility'] !== true) {
      const pre = load(run);
      const preU = unitOf(pre, unit);
      if (preU.feasibility?.ok === false) throw new Error(preU.feasibility.message || 'start refused: Jev noul feasibility < 0.30');
      const sig = behaviourSignature(preU);
      const hcfg = activeHelpers(baseDir('project'));
      if (hcfg.error) throw new Error(hcfg.error);
      if (pre.frozen && hcfg.on && (!preU.feasibility || preU.feasibility.skipped || preU.feasibility.sig !== sig)) {
        const res = await checkBarFeasibility(preU, hcfg);
        if (!res.ok) throw new Error(res.message);
        checkedFeas = { ...res, sig, at: now() };
      }
    }
    return change(run, 'unit.start', (s) => {
      const paused = pausedRefusal(s, 'start'); // a paused run starts no unit (#132)
      if (paused) throw new Error(paused);
      const u = unitOf(s, unit);
      // No second builder on a working unit (lib/lead.mjs): its agent keeps it while it beats.
      const busy = secondBuilder(u, s, Date.now());
      if (busy && !takeover) throw new Error(busy);
      // Taking over the run and taking over a unit at work are separate acts: the second only by its lead.
      if (busy && !LEAD?.led) throw new Error(`start --takeover refused: ${u.id} is ${u.status === 'building' ? 'being built' : 'being judged'}, and this window did not lead run ${s.id} before this step. Taking over the run comes first, as its own step: run.mjs lead ${s.id}; then start ${s.id} ${u.id} --takeover --reason R`);
      if (takeover && ['building', 'judging'].includes(u.status)) {
        const d = decideUnit(u, s, Date.now()); // a takeover skips only the wait for the working agent, never a stop
        if (!s.frozen || !['wait', 'judge', 'check-stale'].includes(d.action)) throw new Error(`start --takeover refused: next says "${d.action}"${d.reason ? ` (${d.reason})` : ''} for ${u.id}`);
        const why = text(o.reason, `reason (why ${u.id} gets a new builder while ${u.status === 'building' ? 'its builder' : 'its critic'} may still work)`, 300);
        const last = agoText(u.heartbeatAt ?? s.createdAt, Date.now()) ?? 'not recorded';
        s.notes.push({ kind: 'decision', text: `${u.id}: started try ${u.rounds.length + 1} while ${u.status} (last beat ${last}): ${why}`, at: now() });
        log(u, 'start', `took over from the ${u.status === 'building' ? 'builder' : 'critic'} (last beat ${last}): ${why}`);
      } else if (early) {
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
      u.status = 'building'; u.heartbeatAt = now(); reopen(u.behaviours); syncStatechartStatuses(u);
      if (checkedFeas) u.feasibility = checkedFeas;
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
    if (o.head !== undefined && (typeof o.head !== 'string' || !/^[0-9a-f]{7,64}$/i.test(o.head))) throw new Error('--head takes the commit the builder reported');
    if (o.base !== undefined && o.head === undefined) throw new Error('--base goes with --head: the precheck runs on base..head');
    const skip = o['skip-precheck'];
    if (skip !== undefined && skip !== true) throw new Error('--skip-precheck takes no value; give the reason with --reason');
    const skipWhy = skip === true ? text(o.reason, 'reason (why the precheck hits are kept)', 300) : null;
    if (skip === undefined && o.reason !== undefined) throw new Error('--reason goes with --skip-precheck');
    // A precheck run now (--base), or the one recorded for this head: built refuses a head with a hit (lib/precheck.mjs).
    const fresh = typeof o.base === 'string' ? runPrecheck(o.base, o.head) : null;
    const pre = load(run);
    const head = fresh?.head ?? o.head?.toLowerCase();
    // Lines changed since the last reviewed head: from round 2 a small delta gets one critic (lib/rules.mjs oneCritic).
    const pu = pre.units.find((x) => x.id === unit);
    const delta = pu && o.head ? deltaOf(pu, o.head.toLowerCase()) : null;
    // Without --head there is no commit to check (a unit with no code, or a lead who left it out): said, not refused.
    // A commit this repository does not have (a unit in another repository) cannot be prechecked here: said, not refused.
    const foreign = head && !fresh && !(() => { try { return commitOf(projectDir(), head, 'head'); } catch { return null; } })();
    const warning = precheckOff() ? null
      : !head ? 'no --head: no precheck ran on this build (built --head <sha> --base <sha> runs it)'
        : foreign ? `${head.slice(0, 12)} is not a commit in this repository: no precheck ran on it` : null;
    const out = change(run, 'unit.built', (s) => {
      const u = unitOf(s, unit); if (u.status !== 'building') throw new Error(`unit ${unit} is ${u.status}, not building`); expect(s, u, 'built');
      if (fresh) u.precheck = { base: fresh.base, head: fresh.head, hits: fresh.hits, at: now() };
      const rec = u.precheck && head && (u.precheck.head.startsWith(head) || head.startsWith(u.precheck.head)) ? u.precheck : null;
      if (rec?.hits.length && !skipWhy) throw new Error(`built refused: the precheck of ${rec.head.slice(0, 12)} has ${rec.hits.length} hit(s): ${rec.hits.map((h) => `${h.rule} ${h.file}`).join(', ')}. Fix them, or keep them with --skip-precheck --reason "…" (logged)`);
      if (rec?.hits.length) s.notes.push({ kind: 'decision', unit: u.id, text: `${u.id}: precheck hits kept on ${rec.head.slice(0, 12)} (${rec.hits.map((h) => h.rule).join(', ')}): ${skipWhy}`, at: now() });
      // A head with no precheck is not let through unchecked (unless every rule is off in coordinator.json).
      if (head && !rec && !foreign && !precheckOff()) {
        if (!skipWhy) throw new Error(`built refused: no precheck of ${head.slice(0, 12)}: pass --base <the commit the unit branched from> and built runs it, or run run.mjs precheck ${s.id} ${u.id} --base <sha> --head ${head.slice(0, 12)} first; --skip-precheck --reason "…" goes without (logged)`);
        s.notes.push({ kind: 'decision', unit: u.id, text: `${u.id}: built without a precheck on ${head.slice(0, 12)}: ${skipWhy}`, at: now() });
      }
      if (o.changelog !== undefined) u.changelog = text(o.changelog === true ? undefined : o.changelog, 'changelog', 300);
      if (delta) u.delta = delta; else delete u.delta;
      // The commit the builder reported: the reviewed head a fold-in must build on, unless the critic or detect names one.
      u.status = 'judging'; u.heartbeatAt = now(); u.judgingAt = now(); u.report = optText(o.report, 2000); log(u, 'built', u.report ?? '');
      if (o.head !== undefined) u.builtHead = o.head.toLowerCase(); else delete u.builtHead;
      addCost(s, u, costEntry(o, { step: 'built', role: 'builder', model: u.builtBy && u.builtBy !== UNSPECIFIED ? u.builtBy : null, at: now() }));
      delete u.specialistMarks; // a new build is judged again by every specialist
    }, { unit });
    return warning ? { ...out, warning } : out;
  },
  behave([run, unit], o) {
    let id; let warning = null;
    const s = change(run, 'behaviour', (st) => {
      if ((o.goal === true) === (unit !== undefined)) throw new Error('name a unit or --goal, not both');
      if (o.remove !== undefined && o.remove !== true) throw new Error('--remove takes no value');
      if (o.remove !== true && typeof o.text === 'string') warning = openCheck([{ what: `${unit ?? 'the goal'} behaviour`, text: o.text }], o['accept-open'], st.notes);
      if (o.statechart !== undefined && o.goal === true) throw new Error('--statechart goes with a unit, not --goal');
      const u = unit === undefined ? null : unitOf(st, unit);
      // Dropping or rewording a behaviour changes the bar: never mid-judgement, and after freeze only with a reason.
      if (u?.status === 'judging') throw new Error(`behave refused: ${u.id} is being judged; wait for the verdict`);
      const list = u ? (u.behaviours ?? []) : (st.goalBehaviours ?? []);
      const changes = o.remove === true || (o.id !== undefined && list.some((b) => b.id === String(o.id).toUpperCase()));
      const reason = changes && st.frozen ? text(o.reason, 'reason (removing or rewording a behaviour after freeze changes the bar)', 300) : null;
      const openWhy = openReason(o.open);
      if (o.remove !== true && typeof o.text === 'string') { const refusal = unboundedRefusal([{ what: `${unit ?? 'the goal'} behaviour`, text: o.text, open: openWhy }]); if (refusal) throw new Error(refusal); }
      id = behave(st, u, { id: o.id, text: o.text, remove: o.remove === true });
      if (o.remove !== true) keepOpen(st, u, id, openWhy);
      if (u) {
        delete u.feasibility;
        const fm = validateUnitSurfaceBar(u, o);
        attachUnitStatechart(u, fm, { rawStatechart: o.statechart !== undefined ? readJsonOpt(o.statechart, { flag: '--statechart', allowInline: true, run }) : null });
      }
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
    const packetData = o['reins-packet'] !== undefined ? readJsonOpt(o['reins-packet'], { flag: '--reins-packet', maxBytes: 2 * 1024 * 1024, run }) : null;
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
      const foldItems = (o.fold ?? []).map((f) => checkFold(text(f === true ? undefined : f, 'fold', 500)));
      const folds = foldItems.map((f) => (f.severity === 'low' ? f.text : `nit: ${f.text}`));
      if (folds.length && v !== 'pass') throw new Error('--fold goes with a pass: a fail sends the gap back to the builder');
      if (folds.length > 10) throw new Error('at most 10 --fold items: more than that is another round');
      const fullSuite = o['full-suite'] === undefined ? null : o['full-suite'] === true ? true : oneOf(String(o['full-suite']), ['yes', 'no'], '--full-suite') === 'yes';
      let effectiveV = v;
      let effectiveScore = score(o.score);
      let effectiveSeverity = severity;
      let effectiveGap = optText(o.gap, 500);
      let effectiveCause = optText(o.cause, 80);
      let evidence = optText(o.evidence);
      let behaviourRaws = o.behaviour;
      const packetRes = applyPacketTransitionVerdict({
        unit: u, packetData, early,
        verdict: effectiveV, score: effectiveScore, severity: effectiveSeverity,
        gap: effectiveGap, cause: effectiveCause, evidence, behaviours: behaviourRaws ?? [],
        addEvidenceFn: (ev) => addEvidence(s, u, ev, runDir(run)),
        logFn: (kind, msg) => log(u, kind, msg),
      });
      ({ verdict: effectiveV, score: effectiveScore, severity: effectiveSeverity, gap: effectiveGap, cause: effectiveCause, evidence, behaviours: behaviourRaws } = packetRes);
      const { verdict, gap, cause } = judged(evidence, effectiveV, effectiveGap, effectiveCause);
      const extra = { ...(verdict === 'fail' && effectiveSeverity ? { severity: effectiveSeverity } : {}), ...(findings.length ? { findings } : {}), ...(verdict === 'pass' && folds.length ? { folds } : {}), ...(fullSuite === null ? {} : { fullSuite }) };
      const critic = optText(o.critic, 120);
      const judge = modelName(o.model, 'model');
      const rcfg = routing(baseDir('project'));
      if (o.class === true) throw new Error("--class takes the unit's task classes, e.g. --class docs,search-ui");
      const classes = typeof o.class === 'string' ? o.class.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean) : [];
      const role = o.specialist === undefined ? 'critic' : 'specialist';
      if (judge && !judgeAllowed(rcfg, judge, role, { classes, unit: u })) {
        throw new Error(`verdict refused: ${judge} is below the strong model (${rcfg.strong}); ${role === 'critic' ? `a cheaper general critic judges only a unit outside every pinned area: ${cheapCriticRefusal(rcfg, judge, classes, u)}` : 'specialist critics are never routed down'} (references/routing.md)`);
      }
      const judgedBy = judge ? { judgedBy: judge } : (rcfg.on ? { judgedBy: UNSPECIFIED } : {});
      if (early) {
        const by = o.specialist === undefined ? 'critic' : safeId(String(o.specialist), 'specialist');
        const head = typeof o.head === 'string' ? { head: o.head.toLowerCase() } : {};
        (u.early ??= []).push({ n: u.early.length + 1, before: u.rounds.length + 1, by, verdict, score: effectiveScore, gap, cause, evidence, ...extra, ...head, ...(critic ? { critic } : {}), ...judgedBy, at: now() });
        addCost(s, u, costEntry(o, { step: 'verdict', role: by === 'critic' ? 'critic' : `critic:${by}`, model: judge, at: now() }));
        log(u, 'early', `early review ${u.early.length} by ${by}: ${verdict} ${effectiveScore}${gap ? `: ${clip(gap, 120)}` : ''} (not a round)`);
        return;
      }
      // One critic on a small delta (lib/rules.mjs oneCritic): its verdict closes the round, and no other is taken.
      const solo = late ? null : oneCritic(u);
      if (solo) {
        const who = o.specialist === undefined ? 'general' : String(o.specialist);
        if (who !== solo.critic) throw new Error(`verdict refused: one critic judges round ${u.rounds.length + 1} (a ${solo.lines}-line delta): ${solo.critic === 'general' ? 'the general critic, without --specialist' : `${solo.critic}, with the general checks (--specialist ${solo.critic})`}`);
      }
      if (o.specialist !== undefined && !solo) { // a required second critic: recorded on this round, the unit stays judging
        const name = String(o.specialist);
        if (!(u.specialists ?? []).includes(name)) throw new Error(`no specialist ${name} on unit ${unit} (run.mjs add-specialist ${s.id} ${u.id} ${name} --reason …)`);
        // The visual gate (references/prism.md): a FAIL report blocks every pass; the prism specialist needs a PASS one.
        const gate = verdict === 'pass' && !late ? prismRefusal(u, name) : null;
        if (gate) throw new Error(gate);
        const markObj = { verdict, score: effectiveScore, gap, cause, evidence, ...extra, ...(critic ? { critic } : {}), ...judgedBy, at: now() };
        if (late) { (closed.specialists ??= {})[name] = { ...markObj, late: true }; log(u, 'verdict', `${name}: ${verdict} on round ${closed.n ?? u.rounds.length}, after the round closed`); }
        else {
          (u.specialistMarks ??= {})[name] = markObj;
          if (packetRes.transCheck && !packetRes.transCheck.ok) { mark(u.behaviours ?? [], behaviourRaws, verdict); syncStatechartStatuses(u); }
        }
        addCost(s, u, costEntry(o, { step: 'verdict', role: `critic:${name}`, model: judge, at: now() }));
        return;
      }
      if (late) throw new Error('unreachable');
      // Every required specialist marks the build before a general pass closes the round.
      const unmarked = solo ? [] : (u.specialists ?? []).filter((n) => !u.specialistMarks?.[n]);
      if (verdict === 'pass' && unmarked.length) throw new Error(`pass refused: specialist ${unmarked.join(', ')} has not passed this build`);
      // A general pass on a build a specialist failed (#126): recorded as given, the round closes as failed by that specialist.
      const byS = verdict === 'pass' ? specialistFailure(u.specialistMarks) : null;
      const passes = verdict === 'pass' && !byS;
      // A solo specialist judges with its own rules: the prism specialist passes only on a PASS gate report.
      const gate = passes ? prismRefusal(u, solo && solo.critic !== 'general' ? solo.critic : null) : null;
      if (gate) throw new Error(gate);
      const round = u.rounds.length + 1;
      if (passes && s.paths?.length && !(u.detect?.round === round && u.detect.clean)) {
        throw new Error(`pass refused: no clean detect result for round ${round}; run detect.mjs --run ${s.id} --unit ${u.id} --base … first`);
      }
      const marks = mark(u.behaviours ?? [], behaviourRaws, verdict);
      syncStatechartStatuses(u);
      // A specialist's fold-ins ride on the pass too.
      if (passes) for (const [n, m] of Object.entries(u.specialistMarks ?? {})) for (const f of m.folds ?? []) extra.folds = [...(extra.folds ?? []), `${f} (${n})`];
      // A failed round carries no fold-ins: the general critic's lows and nits stay on it as findings.
      if (byS || verdict === 'fail') { delete extra.folds; if (foldItems.length) extra.findings = [...(extra.findings ?? []), ...foldItems]; }
      const closing = byS ? { verdict: 'fail', gap: byS.gap, cause: byS.cause } : { verdict, gap, cause };
      addCost(s, u, costEntry(o, { step: 'verdict', role: 'critic', model: judge, at: now() }));
      // The head the critic reviewed, from the detect run of this round: a fold-in must build on it.
      // The head the critic judged (--head), else this round's detect head, else the builder's reported head.
      const reviewedHead = typeof o.head === 'string' ? o.head.toLowerCase() : (u.detect?.round === round && u.detect.head) ? u.detect.head : (u.builtHead ?? null);
      // Kept on a fail too: the next critic reviews the delta since this head (sub-skills/review.md, Delta review).
      if (reviewedHead) extra.reviewedHead = reviewedHead;
      u.rounds.push({ n: round, verdict: closing.verdict, score: effectiveScore, gap: closing.gap, cause: closing.cause, evidence, at: now(), ...extra, ...(byS ? { severity: byS.severity, general: 'pass', failedBy: byS.failedBy } : {}), ...(marks.length ? { behaviours: marks } : {}), ...(u.report ? { report: u.report } : {}), ...(critic ? { critic } : {}), ...(u.builtBy ? { builtBy: u.builtBy, ...(u.builtWhy ? { builtWhy: u.builtWhy } : {}) } : {}), ...judgedBy, ...(u.specialistMarks ? { specialists: u.specialistMarks } : {}), ...(solo ? { oneCritic: solo.critic, deltaLines: solo.lines } : {}) });
      u.report = null; delete u.specialistMarks; delete u.builtBy; delete u.builtWhy; delete u.judgingAt; delete u.builtHead; delete u.delta;
      if (byS) log(u, 'verdict', `round ${round} failed by specialist ${byS.failedBy.join(', ')}; the general critic passed it (score ${score(o.score) ?? 'none'})`);
      u.status = passes ? 'pass' : 'open';
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
    if (unit === undefined) return extendTime(run, o); // no unit: more time for the run
    if (o.minutes !== undefined) throw new Error('--minutes goes with the run, not a unit: extend <run> --minutes N --answer qN --reason R');
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
        ({ words, source } = approvingAnswer(q, written));
        if (q.answer.at < since) throw new Error(`extend refused: ${q.id} was answered before ${u.id}'s last verdict; ask again`);
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
      if (rounds > (named ?? 1)) throw new Error(`extend refused: --rounds ${rounds}, but the approval ${named ? `names ${named}` : 'names no single number, so it is for one round'}`);
      u.extraRounds = (u.extraRounds ?? 0) + rounds;
      if (u.status === 'stopped') { u.status = 'open'; u.stopReason = null; }
      const scope = named ? `their words name ${named}` : 'their words name no single number: one round';
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
        const asked = s.notes.filter((n) => n.kind === 'question')[qi];
        const ready = asked?.finish === true ? FINISH.ship : Array.isArray(asked?.sameFiles) ? SAME_FILES.accept : null;
        const why = answerRefusal(ready ? { ...q, approves: ready } : q);
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
      // After a failed check ended the run with gaps: the pass of a fresh check on the fixed result, once (lib/rules.mjs).
      const afterFix = d !== 'integrate' && afterFixIntegration(s);
      if (d !== 'integrate' && !afterFix) throw new Error(`integrate refused: the run is at "${d}"`);
      oneOf(v, ['pass', 'fail'], 'verdict');
      const evidence = optText(o.evidence);
      if (afterFix && v !== 'pass') throw new Error(`integrate refused: the run is at "${d}" after a failed integration check; only one pass is recorded now, the fresh check of the fixed result`);
      if (afterFix && !evidence) throw new Error('integrate refused: a pass after the failed integration check needs --evidence: the fix and the fresh check that passed on the fixed result');
      const judge = modelName(o.model, 'model');
      const rcfg = routing(baseDir('project'));
      if (judge && !judgeAllowed(rcfg, judge, 'integrator')) throw new Error(`integrate refused: the integrator is never routed down; ${judge} is below the strong model (references/routing.md)`);
      const j = judged(evidence, v, optText(o.gap, 500), optText(o.cause, 80));
      const marks = mark(s.goalBehaviours ?? [], o.behaviour, j.verdict);
      const failed = s.integration.rounds.at(-1);
      s.integration.rounds.push({ ...j, evidence, at: now(), ...(judge ? { judgedBy: judge } : (rcfg.on ? { judgedBy: UNSPECIFIED } : {})), ...(marks.length ? { behaviours: marks } : {}), ...(afterFix ? { afterFix: true } : {}) });
      if (afterFix) s.notes.push({ kind: 'decision', text: `integration passed after a fix: check ${s.integration.rounds.length - 1} failed ("${clip(failed.gap ?? 'no gap', 160)}"); the fresh check of the fixed result passed: ${clip(evidence, 300)}`, at: now() });
    });
  },
  note([run], o) {
    const kind = oneOf(o.kind, ['situation', 'decision', 'follow-up', 'retro', 'question', 'bar', 'info', 'person', 'escape'], '--kind');
    if (o.asking === undefined && (o.lead !== undefined || o.takeover !== undefined)) throw new Error('--lead and --takeover go with --asking: any other note is a worker step');
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
    if (o.asking !== undefined && (kind !== 'decision' || o.unit !== undefined)) throw new Error('--asking goes with --kind decision, on the run (no --unit)');
    const askMode = o.asking === undefined ? undefined : oneOf(o.asking, ASKING, '--asking');
    return change(run, kind === 'question' ? 'question' : 'note', (s) => {
      const note = { kind, ...(o.unit !== undefined ? { unit: unitOf(s, String(o.unit)).id } : {}), text: text(o.text, 'text', kind === 'situation' ? 400 : 1000), at: now() };
      if (o.recommend !== undefined) note.recommend = text(o.recommend, 'recommend', 300);
      if (o.answers !== undefined) {
        const asked = s.notes.filter((n) => n.kind === 'question').length;
        const m = /^q(\d+)$/.exec(String(o.answers));
        if (!m || +m[1] < 1 || +m[1] > asked) throw new Error(`--answers must name a logged question (q1-q${asked})`);
        note.answers = o.answers;
      }
      if (askMode !== undefined) { s.askMode = askMode; note.asking = askMode; }
      s.notes.push(note);
    }, { closedOk: ['follow-up', 'retro'].includes(kind), unit: typeof o.unit === 'string' ? safeId(o.unit, 'unit') : null });
  },
  study([run], o) { let id; const s = change(run, 'study', (st) => { id = addStudy(st, o); }); return { ...s, study: id }; },
  self(_, o) {
    if (o.json !== undefined && o.html !== undefined) throw new Error('--json or --html, not both');
    if (o.queued !== undefined && !o.html) throw new Error('--queued goes with --html');
    if (o.html && o.queued) return { file: snapshotFile(), job: drainJob(snapshotJob(), renderSnapshot, { handover: process.env.COORDINATOR_JOB_HANDOVER || null }) };
    if (o.html) return { file: writeSnapshot() };
    const m = selfModel({ ...loadSelf(), current: null });
    if (o.json) return m;
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
    let id; const s = change(run, 'question', (st) => { id = ask(st, o); }, { unit: typeof o.unit === 'string' ? o.unit : null }); return { ...s, asked: id, label: labelOf(s, id), asking: askingMode(s, settings()) };
  },
  answer([run, id], o) {
    if (o.confirm !== undefined && o.by !== 'person') throw new Error('--confirm needs an explicit --by person');
    // Started by the PC dashboard for an answer the person gave on its page (lib/pcanswer.mjs): recorded via the dashboard.
    const dash = process.env[VIA_ENV] !== undefined;
    if (dash && !dashboardCaller(process.env[VIA_ENV], readDashboardRecord(), process.ppid)) throw new Error(`${VIA_ENV} is set, but this process was not started by the running PC dashboard`);
    if (dash && (o.by !== 'person' || o.confirm !== undefined)) throw new Error('an answer from the PC dashboard is --by person, with no --confirm');
    return change(run, 'answer', (s) => {
      // The dashboard checked the question was open before starting this process; check again under the run's
      // lock, so an answer that landed in between is never overwritten from the PC page.
      if (dash) { const q = questions(s).find((x) => x.id === id); if (!q?.open) throw new Error(`${id} is no longer open (${q?.status ?? 'not asked'}); nothing written`); }
      answer(s, id, { choices: o.choice ?? [], other: o.other === true ? null : o.other, by: o.by ?? 'person', via: dash ? 'dashboard' : 'cli', confirm: o.confirm === true ? '' : o.confirm });
    });
  },
  'use-answer'([run, id]) { return change(run, 'answer.used', (s) => useAnswer(s, id)); },
  questions([run]) { return questions(load(run), { project: project() }).map(({ open, ...q }) => q); },
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
        const v = view(s, decide(s), Date.now(), { repo: repoFor(s), linked: linkedOf(s), project: project() });
        const ctx = liveCtx(live, run, themeFor(s), id === run ? null : id);
        ctx.has = (file) => storedPath(runDir(id), file) !== null;
        ctx.calls = readCalls(runDir(id));
        const rest = m ? (m[2] ?? '/') : path;
        if (hasMap(runDir(id))) ctx.mapHref = `${ctx.base}/map?t=${encodeURIComponent(live.token)}`;
        if (rest === '/map' || path === '/map') return ctx.mapHref ? mapView(id, runDir(id), { ...ctx, pages: mapNav(ctx), units: s.units }) : null;
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
  // It runs detached, so it outlives the session and shell that started it (--foreground: in this process).
  dashboard([verb], o) {
    const rec = dashboardFile();
    const old = readDashboardRecord();
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
    if (verb !== undefined) throw new Error('usage: run.mjs dashboard [--port P] [--open] [--foreground] | dashboard stop');
    // The detached child runs in the register's folder, not a project: the command that started it registered already.
    if (!process.env[DETACHED_ENV]) registerFolder();
    if (o.open !== undefined && o.open !== true) throw new Error('--open takes no value');
    if (o.foreground !== undefined && o.foreground !== true) throw new Error('--foreground takes no value');
    const port = num(o.port, DASHBOARD_PORT, 1, 65_535);
    const fresh = () => (o.foreground ? serveDashboard(port, o) : startDashboard(port, o));
    // A dashboard already running answers its own link: print it instead of starting another.
    if (running && old.url) {
      answers(old.url).then((ok) => {
        if (!ok) return fresh();
        if (o.open) openBrowser(old.url);
        // One started by another copy of the skill is reused, never stopped here: say so, and how to restart it.
        const other = old.version !== VERSION;
        console.log(JSON.stringify({ url: old.url, pid: old.pid, reused: true, version: old.version ?? null, note: other
          ? `a dashboard from ${old.version ? `skill ${old.version}` : 'an older skill'} is already running; this is ${VERSION}. To run this one: run.mjs dashboard stop, then run.mjs dashboard`
          : 'a dashboard is already running; stop it with run.mjs dashboard stop' }));
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
  // Past the time budget, looking changes nothing (#132): the stops are worked out in memory, reported
  // with recorded: false, and recorded by close.
  // Who leads the run; claims it when it has none or its lead is gone (the step /coordinator:status runs).
  // A lead still active is only reported, unless --takeover --reason (after the person's yes).
  lead([run], o) {
    const s = load(run);
    const me = identity(BY.harness, { flag: o.lead });
    const takeover = takeoverOf(o);
    if (o.reason !== undefined && !takeover) throw new Error('--reason goes with --takeover');
    const force = takeover ? text(o.reason, 'reason (why this window takes the run over: the person said yes)', 300) : null;
    const report = (st, extra = {}) => {
      const i = leadInfo(st, Date.now(), { alive: leadAlive });
      return { run: st.id, you: !!i && st.lead.id === me.id, ...(i ? { tool: i.tool, since: i.since, lastActive: i.lastActive, ...(i.gone ? { gone: i.goneText } : {}) } : { tool: null }), ...extra };
    };
    if (s.closed) return report(s, { closed: true });
    const d = decideLead(s, me, { nowMs: Date.now(), alive: leadAlive, claimGone: true, force });
    if (d.action === 'refuse') return report(s, { step: `this window does not lead ${s.id}: leave its lead steps to that window; with the person's yes, run.mjs lead ${s.id} --takeover --reason R takes it over now` });
    if (d.action === 'lead') {
      // Its own lead (the step /coordinator:status runs): records this window's process again, so a resumed
      // window that has only run this step does not look ended.
      // Decided outside the lock; `refresh` re-checks the lead id under the lock.
      const machine = machineFor(s.id, me);
      if (stale(s.lead, me, machine)) updateRun(runDir(run), { kind: 'lead.claim', by: BY }, (st) => refresh(st, me, { at: now(), machine }), derived);
      return report(load(run), { id: me.id });
    }
    LEAD = { run: safeId(run, 'run'), me, opts: () => ({ nowMs: Date.now(), alive: leadAlive, claimGone: true, force }), led: false };
    claimNow(run);
    const claimed = CLAIMED; CLAIMED = null;
    return report(load(run), { ...(claimed ?? {}), id: me.id });
  },
  async next([run], o = {}) {
    // --all: the actions for every open run of this folder that this window leads (the perf plan, cause H: runs
    // under one lead waited on each other); each run as next <run> would print it.
    if (o.all !== undefined) {
      if (o.all !== true) throw new Error('--all takes no value');
      if (run !== undefined) throw new Error('next --all takes no run');
      const me = identity(BY.harness, { flag: o.lead }).id;
      const ids = existsSync(runsDir()) ? readdirSync(runsDir()).filter((d) => isSafeId(d) && exists(d)) : [];
      const mine = ids.filter((id) => { try { const x = load(id); return !x.closed && x.lead?.id === me; } catch { return false; } });
      const runs = [];
      for (const id of mine) runs.push({ run: id, ...(await commands.next([id], { ...o, all: undefined })) });
      return { lead: me, runs, ...(runs.length ? {} : { note: 'this window leads no open run here' }) };
    }
    let stopped; let s = load(run);
    const expired = !s.closed && spent(s, Date.now());
    // Expired: applyStops changes the loaded state in memory only; it is never saved.
    if (expired) stopped = applyStops(s);
    else {
      // Recording a stop is a lead step (lib/lead.mjs); reading what to do next is not. Whether it records
      // one is decided on the locked state, with the lead check, in the same write as the stop.
      s = change(run, 'run.stop', (st) => { stopped = applyStops(st); }, { leadWhen: { o, when: (st) => applyStops(structuredClone(st)).size > 0 } });
    }
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
    // A unit at work: its last beat, worked out here in minutes and local time (never a bare UTC time to convert).
    const beat = (u) => { const x = unitOf(s, u.id); return ['building', 'judging'].includes(x.status) ? { ...u, lastBeat: agoText(x.heartbeatAt ?? s.createdAt, Date.now()) } : u; };
    // One critic on a small delta (lib/rules.mjs oneCritic): next names it, so the lead launches only that one.
    const solo = (u) => { if (u.action !== 'judge') return u; const x = oneCritic(unitOf(s, u.id)); return x ? { ...u, critics: 1, critic: x.critic, deltaLines: x.lines } : u; };
    const units = plan.units.map((u) => (stopped.has(u.id) ? { ...stopped.get(u.id), ...(expired ? { recorded: false } : {}) } : beat(launch(early(how(sync(solo(suggest(u)))))))));
    const paused = pauseNote(s); // a paused run starts nothing: its build and judge steps wait (lib/pause.mjs)
    const outcome = { stopped: 'stopped', 'done-with-gaps': 'partial', done: 'done' }[plan.decision];
    const led = s.closed ? null : leadInfo(s, Date.now(), { alive: leadAlive });
    // The lead's context budget, from its transcript's usage numbers only (lib/leadctx.mjs).
    const budget = s.closed ? null : leadBudget(s.notes);
    return {
      decision: paused ? 'paused' : plan.decision, ...(paused ? { paused } : {}), units,
      ...(led ? { lead: { tool: led.tool, lastActive: led.lastActive, ...(led.gone ? { gone: led.goneText } : {}) } } : {}),
      ...(budget && budget.level !== 'ok' ? { context: budget } : {}),
      ...(expired ? { spent: { text: 'the time budget is spent: next recorded nothing', step: outcome ? `run.mjs close ${s.id} --outcome ${outcome} records the stops above` : 'a critic started inside the time budget may still return its verdict; then close records the stops' } } : {}),
    };
  },
  // The lead's full suite on a unit's head (lib/suites.mjs): the command after -- runs under this machine's one suite
  // lock (never two full suites at once: the load flakes) and is recorded; or --result records a run made elsewhere.
  // Critics of that head then cite it and run no full suite (lib/briefs.mjs).
  suite([run, unit], o) {
    unitOf(load(run), unit);
    if (typeof o.head !== 'string' || !SHA.test(o.head)) throw new Error('--head takes the commit the suite runs on (7-64 hex characters)');
    if (o.fail !== undefined && o.fail !== true) throw new Error('--fail takes no value');
    const given = (o.result ?? []).map((r) => text(r === true ? undefined : r, 'result', 300));
    if (given.length && SUITE_ARGV.length) throw new Error('--result or a command after --, not both');
    if (!given.length && !SUITE_ARGV.length) throw new Error('usage: run.mjs suite <run> <unit> --head <sha> -- <test command …> | --result "<pass line>" [--fail]');
    let ok = o.fail === undefined; let results = given; let code = null; let seconds = null;
    // The record says which commit was tested: a run made here must be on that commit with no tracked change on
    // top; a result given from elsewhere must name a commit this repository has.
    let head; let loose = []; // untracked files in the checkout, recorded with the run
    // A result from elsewhere (CI, another repository's checkout) is recorded for the commit as given, in full when
    // this repository has it.
    if (given.length) { try { head = commitOf(projectDir(), o.head, 'head'); } catch { head = o.head.toLowerCase(); } }
    else {
      if (o.fail !== undefined) throw new Error('--fail goes with --result: a command\'s exit code says whether it passed');
      // The checkout must be at --head with nothing uncommitted, checked again once the lock is ours: the tree may
      // change while this call waits for another suite.
      const atHead = () => {
        let here; try { here = checkedOut(process.cwd()); } catch { throw new Error(`suite runs in the unit's checkout: ${process.cwd()} is not a git checkout`); }
        if (!sameHead(o.head, here)) throw new Error(`suite refused: this checkout is at ${here.slice(0, 12)}, not --head ${o.head}: run it in the unit's worktree at that commit`);
        const { changed, untracked } = uncommitted(process.cwd());
        if (changed.length) throw new Error(`suite refused: ${changed.length} tracked file(s) changed on top of ${here.slice(0, 12)} (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', …' : ''}): commit them, then run the suite on that commit`);
        // Untracked files (a report, a tool's folder, or a new file the commit forgot) do not stop the run: they are
        // recorded with it, and the critic's brief names them.
        loose = untracked;
        return here;
      };
      head = atHead();
      const release = holdLock(join(registryHome(), 'suite.lock'), { run, unit, head: o.head }, { onWait: (h) => console.error(`waiting: a full suite is running on this machine (run ${h.run ?? '?'}, unit ${h.unit ?? '?'}, since ${h.at})`) });
      let r; try { if (atHead() !== head) throw new Error(`suite refused: the checkout moved off ${head.slice(0, 12)} while waiting`); r = runSuite(SUITE_ARGV, { cwd: process.cwd() }); } finally { release(); }
      ({ code, seconds } = r); ok = code === 0;
      results = summaryLines(r.output).map((l) => text(l, 'result', 300));
      if (!results.length) results = [`exit code ${code}`];
      if (!ok) process.stderr.write(`${r.output.split(/\r?\n/).slice(-40).join('\n')}\n`);
    }
    let rec;
    change(run, 'evidence', (s) => {
      const u = unitOf(s, unit);
      rec = recordSuite(u, { head, ok, results, at: now(), code, seconds, untracked: loose });
      log(u, 'suite', `full suite ${ok ? 'passed' : 'FAILED'} on ${rec.head.slice(0, 12)}: ${results.at(-1)}`);
    }, { unit });
    return { run, unit, suite: rec };
  },
  // Mechanical checks of the unit's diff (lib/precheck.mjs, rules from "precheck" in .coordinator/coordinator.json),
  // recorded on the unit for that head: built refuses a head whose precheck has a hit.
  precheck([run, unit], o) {
    unitOf(load(run), unit);
    const res = runPrecheck(o.base, o.head);
    change(run, 'unit.detect', (s) => {
      const u = unitOf(s, unit);
      u.precheck = { base: res.base, head: res.head, hits: res.hits, at: now() };
      log(u, 'precheck', res.hits.length ? `${res.hits.length} hit(s): ${res.hits.map((h) => `${h.rule} ${h.file}`).join(', ')}` : 'clean');
    }, { unit });
    if (res.hits.length) process.exitCode = 1;
    return { run, unit, clean: !res.hits.length, base: res.base, head: res.head, hits: res.hits };
  },
  // Every unit's changelog line (built --changelog), for the release PR to write in one place.
  changelog([run]) {
    const s = load(run);
    const lines = s.units.filter((u) => u.changelog).map((u) => `- ${u.changelog}`);
    process.stdout.write(lines.length ? `${lines.join('\n')}\n` : `no changelog lines recorded (run.mjs built ${s.id} <unit> --changelog "<line>")\n`);
    return null;
  },
  // A follow-up, triaged as it arrives (lib/followups.mjs): batch (one unit that builds last), P1-P3 or drop.
  followup([run], o) {
    const triage = typeof o.triage === 'string' ? o.triage.replace(/^p/, 'P') : o.triage;
    let out;
    const s = change(run, 'note', (st) => {
      const unit = o.unit === undefined ? null : unitOf(st, o.unit).id;
      out = addFollowup(st, { text: text(o.text, 'text', 500), triage, reason: text(o.reason, 'reason', 300), unit, at: now() });
    }, { unit: o.unit ?? null });
    return { run: s.id, triage, ...(out.unit ? { batchUnit: out.unit, items: s.units.find((u) => u.id === out.unit)?.bar } : {}), ...(out.file ? { step: out.file } : {}) };
  },
  brief([run, unit], o) {
    const files = o.quote ?? []; const labels = o.source ?? [];
    if (labels.length > files.length) throw new Error('one --source per --quote');
    const quotes = files.map((f, i) => {
      if (!existsSync(f) || !statSync(f).isFile()) throw new Error(`--quote: no file ${f}`);
      return { source: labels[i] ?? basename(f), text: readFileSync(f, 'utf8') };
    });
    const to = briefTo(o.to); // a bad --to fails before anything is marked used
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
    const brief = `${buildBrief(load(run), { role: o.role, unit, quotes, where: briefWhere(o.where), findingsFile: findingsFile(o['findings-file']), playbook: briefPlaybook(o.playbook), env })}\n`;
    if (!to) { process.stdout.write(brief); return null; }
    // Passed by file: the whole brief goes to the file, and the prompt printed for the agent starts with its marker line.
    writeAtomic(to, brief);
    process.stdout.write(`${briefPrompt(brief, to.replace(/\\/g, '/'))}\n`);
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
  show([run]) { const s = load(run); process.stdout.write(textView(view(s, decide(s), Date.now(), { linked: linkedOf(s), project: project(), alive: leadAlive }))); return null; },
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
  // What waits on the person across every run on this PC (lib/waiting.mjs), oldest first: the same list as the PC dashboard's Waiting on you.
  waiting(pos, o = {}) {
    if (pos.length) throw new Error('usage: run.mjs waiting [--json]');
    if (o.json !== undefined && o.json !== true) throw new Error('--json takes no value');
    registerFolder();
    const nowMs = Date.now();
    const items = waitingList(readRegistry(), { nowMs });
    if (o.json) return items;
    process.stdout.write(waitingText(items, nowMs));
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
    const snap = buildMap(run, runDir(run), { root, maxSeconds: num(o['max-seconds'], 60, 1, 3600), unit: o.unit ?? null, ctx: { ...staticCtx(runDir(run), 0, themeFor(s)), units: s.units }, fresh: o.fresh === true, force: o.force === true, resetStage: o['reset-stage'] === true });
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
    if (LEAD?.run === run && !LEAD.led) claimNow(run); // the pushed copy holds the claim
    return push({ run, dir: runDir(run), base: baseDir('project'), project: projectDir(), to: o.to, message: optText(o.message, 200) ?? undefined, render: (s) => render(s, decide(s)), attach: [mapAttach(runDir(run))] });
  },
  pull([run], o) {
    safeId(run, 'run');
    // Checked as a lead step (refused while another window actively leads the run), but never claims, even with
    // --takeover against a gone lead: a claim here would fork the local log from the copy. The next lead step claims.
    return pull({ run, dir: runDir(run), base: baseDir('project'), project: projectDir(), from: o.from, after: derived, restore: { map: mapRestore(runDir(run)) } });
  },
  stats(_, o) {
    const runs = commands.list().filter((r) => !r.error && r.closed && (!o.tag || r.tag === o.tag)).map((r) => load(r.run));
    return { ...stats(runs), ...byModel(runs), ...costStats(runs) };
  },
  // The routing table (references/routing.md), or the model for one role and task class.
  bench(pos, o) { return benchCommand(pos, o, { base: baseDir('project'), by: BY }); },
  models([run, unit], o) {
    if (run !== undefined && unit === undefined) throw new Error('usage: run.mjs models [<run> <unit>] --role R [--class C]: give the unit with its run');
    if (unit !== undefined && o.role === undefined) throw new Error('--role goes with a unit: run.mjs models <run> <unit> --role critic --class C');
    const u = unit === undefined ? null : unitOf(load(run), unit);
    const cfg = routing(baseDir('project'));
    for (const w of cfg.warnings) console.error(`warning: ${w}`);
    if (o.role === undefined) return cfg;
    return { role: o.role, class: o.class ?? null, ...(u ? { unit: u.id } : {}), ...route(cfg, String(o.role), typeof o.class === 'string' ? o.class : null, u) };
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

// The PC dashboard (run.mjs dashboard): its record, its log, the server itself and the detached start.
const RUN_MJS = fileURLToPath(import.meta.url);
const DETACHED_ENV = 'COORDINATOR_DASHBOARD_DETACHED'; // set by startDashboard for its child: no token in the log
const LOG_MAX = 1024 * 1024; // a longer dashboard.log starts again, at a start or while the dashboard runs
const dashboardFile = () => join(registryHome(), 'dashboard.json');
const dashboardLog = () => join(registryHome(), 'dashboard.log');
function readDashboardRecord() { try { return JSON.parse(readFileSync(dashboardFile(), 'utf8')); } catch { return null; } }

// An answer from the front page's Needs you: checked first (lib/pcanswer.mjs), then recorded by
// `run.mjs answer` in that project's state folder, the same locked code as on the CLI, as given via the dashboard.
// Async, so a run whose lock is busy never freezes the page for the other runs; the POST is answered when it ends.
// The child gets only childEnv: no session tokens or ids, and it is stamped as the dashboard, not the starting tool.
function answerFromPc(form, token) {
  const t = pcAnswer(readRegistry(), form);
  return new Promise((done, fail) => {
    execFile(process.execPath, [RUN_MJS, ...t.args], {
      cwd: existsSync(t.entry.project) ? t.entry.project : t.entry.stateDir,
      env: childEnv(process.env, { COORDINATOR_DIR: t.entry.stateDir, [VIA_ENV]: token }),
      encoding: 'utf8', windowsHide: true, timeout: 60_000,
    }, (e, _out, err) => {
      if (!e) return done(t.anchor);
      const why = String(err ?? '').split(/\r?\n/).reverse().find((l) => l.startsWith('error: '));
      return fail(new Error(why ? why.slice('error: '.length) : 'the answer was not recorded'));
    });
  });
}

// Serves the PC dashboard in this process and records { pid, port, url } in dashboard.json (0600).
function serveDashboard(port, o) {
  const rec = dashboardFile();
  let token = null;
  const start = (p) => serve({
    port: p, extra: PROJECT_PAGE, version: () => pcVersion(readRegistry()),
    post: { '/answer': (form) => answerFromPc(form, token) },
    page: (path, live) => {
      const t = `t=${encodeURIComponent(live.token)}`;
      const home = { path: '/', label: 'This PC', href: `/?${t}` };
      if (path === '/') {
        const ctx = { live, theme: null, run: null, store: null, base: '', home: `/?${t}`, embed: null, readOnly: true, pages: [home], runHref: () => null, pcHref: (key, id, sub = '') => `/p/${key}/run/${encodeURIComponent(id)}${sub}?${t}`, answerForm: { token: live.token } };
        const entries = readRegistry(); const nowMs = Date.now();
        return pcPage(pcModel(entries, { here: null, nowMs }), nowMs, ctx, waitingList(entries, { nowMs }));
      }
      return projectPage(path, live, readRegistry(), home);
    },
  });
  const ready = ({ server, url, token: made }) => {
    token = made;
    writeAtomic(rec, `${JSON.stringify({ pid: process.pid, port: server.address().port, url, version: VERSION, at: now() })}\n`);
    try { chmodSync(rec, 0o600); } catch { /* not on this file system */ }
    const drop = () => { try { if (JSON.parse(readFileSync(rec, 'utf8')).pid === process.pid) rmSync(rec); } catch { /* gone */ } };
    process.on('exit', drop);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
    if (process.env[DETACHED_ENV]) {
      // Keep dashboard.log short while the dashboard runs for days. Its stdout is that file opened for append,
      // so emptying it in place is safe: the next line lands at the new end.
      setInterval(() => trimLog(dashboardLog()), 60_000).unref();
      console.log(JSON.stringify({ started: true, pid: process.pid, port: server.address().port, cwdIsHome: resolve(process.cwd()) === resolve(registryHome()), version: VERSION, at: now() }));
      return;
    }
    if (o.open) openBrowser(url);
    console.log(JSON.stringify({ url, note: 'every run on this PC; local only; stop with run.mjs dashboard stop' }));
  };
  start(port).catch((e) => {
    if (e.code === 'EADDRINUSE' && o.port === undefined) { console.error(`port ${port} is taken; using a free one`); return start(0); }
    throw e;
  }).then(ready, (e) => { console.error(`error: ${e.message}`); process.exit(1); });
}

// Empties the log in place when it is too long. lstat, not stat: only a regular file is trimmed, never what a symlink points at.
function trimLog(path) {
  try { const st = lstatSync(path); if (st.isFile() && st.size > LOG_MAX) truncateSync(path, 0); } catch { /* none yet, or gone */ }
}

// Starts the PC dashboard as a detached process (no console window on Windows), its output in
// dashboard.log, and prints its link once the link answers. The child records itself in dashboard.json.
// It runs in the register's folder, so it never holds the caller's folder (often a worktree) open, and it
// gets only childEnv from this session.
function startDashboard(port, o) {
  const log = dashboardLog();
  mkdirSync(registryHome(), { recursive: true });
  trimLog(log);
  // A raw file handle, not lib/store.mjs: the log is the detached child's own stdout and stderr, which must be
  // a file descriptor (a pipe would die with this process, and a hidden window on Windows needs a handle).
  // Opened for append, so the child's in-place trim (serveDashboard) is safe.
  const fd = openSync(log, 'a', 0o600);
  try { chmodSync(log, 0o600); } catch { /* not on this file system */ }
  let child;
  try {
    child = spawnProcess(process.execPath, [RUN_MJS, 'dashboard', '--foreground', ...(o.port !== undefined ? ['--port', String(port)] : [])], {
      detached: true, windowsHide: true, stdio: ['ignore', fd, fd], cwd: registryHome(), env: childEnv(process.env, { [DETACHED_ENV]: '1' }),
    });
  } finally { closeSync(fd); }
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.on('error', () => { exited = true; });
  const until = Date.now() + 20_000;
  const tick = async () => {
    const r = readDashboardRecord();
    if (r && r.pid === child.pid && typeof r.url === 'string' && await answers(r.url)) {
      child.unref();
      if (o.open) openBrowser(r.url);
      console.log(JSON.stringify({ url: r.url, pid: child.pid, log, note: 'every run on this PC; it runs on after this window closes; local only; stop with run.mjs dashboard stop' }));
      return;
    }
    if (exited || Date.now() > until) {
      if (!exited) { try { child.kill(); } catch { /* gone */ } }
      let tail = ''; try { tail = readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).slice(-3).join(' | '); } catch { /* none */ }
      console.error(`error: the dashboard did not start${tail ? `: ${tail}` : ''} (log: ${log})`);
      process.exit(1);
    }
    setTimeout(tick, 150);
  };
  tick();
}

// --harness works on every command: it names the tool that runs this one (lib/harness.mjs).
// The CLI as a function: run.mjs runs it with its own arguments; the tests call it in process (test/inproc.mjs),
// which is why the module keeps no state between calls but LEAD, CLAIMED and BY, reset here.
let BY = null;
export async function main(args = process.argv.slice(2)) {
  helpAndExit(import.meta.url, args);
  const [cmd, ...all] = args;
  LEAD = null; CLAIMED = null; BY = null; SUITE_ARGV = []; PAGES_DUE.clear();
  // suite runs the command after --, as given: cut there first, so none of its words (--harness included) is
  // read as a run.mjs option.
  const cut = cmd === 'suite' ? all.indexOf('--') : -1;
  const argv = cut >= 0 ? all.slice(0, cut) : all;
  if (cut >= 0) SUITE_ARGV = all.slice(cut + 1);
  const rest = []; let harnessFlag;
  for (let i = 0; i < argv.length; i++) {
    const m = /^--harness(?:=([\s\S]*))?$/.exec(argv[i]);
    if (!m) { rest.push(argv[i]); continue; }
    harnessFlag = m[1] ?? argv[++i] ?? '';
  }
  try { BY = stamp(harnessOf(harnessFlag)); } catch (e) { console.error(`error: ${e.message}`); process.exit(2); }
  if (!commands[cmd]) { console.error('usage: run.mjs init|lead|status-line|dashboard|models|add|add-specialist|behave|behaviours|evidence|link|freeze|pause|resume|start|beat|built|reset|extend|ship|sync|verdict|foldin|strategy|integrate|note|study|self|ask|answer|use-answer|questions|serve|watch|next|show|hud|map|touches|calls|brief|close|gaps|gap|push|pull|adopt|report|quality|list|waiting|stats|where|bench|suite|precheck|changelog|followup … (see the header of run.mjs)'); process.exit(2); }
  if (cmd === 'bench' && rest.some((a) => a === '--help' || a === '-h')) { console.log(benchHelp()); process.exit(0); }
  try {
    const { pos, opt } = parse(rest, FLAGS[cmd] ?? [], REPEAT[cmd]);
    await Promise.all([NO_PAGES.has(cmd) ? null : loadPages(), EXTRA_COMMANDS.has(cmd) ? loadExtras() : null]);
    // One lead per run (lib/lead.mjs): a lead step from another window is refused before it changes anything; a
    // claim it needs is written with its change (change()). init checks and claims itself; next only when it would
    // record a stop; pull checks and never writes a claim; note only in its lead form (note --asking). Closed runs
    // have no lead.
    if (isLeadStep(cmd, opt) && !['init', 'next'].includes(cmd)) {
      const run = pos[0];
      if (typeof run === 'string' && isSafeId(run) && exists(run) && !load(run).closed) {
        leadCheck(run, opt);
        // Over the lead's context budget, lead steps stop until a compaction or a handover note (lib/leadctx.mjs).
        const budget = leadBudget(load(run).notes);
        if (budget?.level === 'over') throw new Error(budget.text);
      }
    }
    const out = await commands[cmd](pos, opt);
    if (PAGES_DUE.size) {
      await loadPages();
      for (const id of PAGES_DUE) withLock(stateFile(id), () => derived(loadRun(runDir(id))));
      PAGES_DUE.clear();
    }
    const claimed = (o) => (CLAIMED && o && typeof o === 'object' && !Array.isArray(o) ? { ...o, claim: CLAIMED } : o);
    if (out !== null) console.log(JSON.stringify(claimed(out.id === undefined || ['models', 'next', 'lead', 'list', 'stats', 'where', 'hud', 'questions', 'behaviours', 'self', 'gaps', 'push', 'pull', 'map', 'touches', 'report', 'quality', 'bench'].includes(cmd) ? out : { ok: true, run: out.id, decision: decide(out).decision, ...(out.asked ? { asked: out.asked } : {}), ...(out.label ? { label: out.label } : {}), ...(out.asking ? { asking: out.asking } : {}), ...(out.study ? { study: out.study } : {}), ...(out.behaviour ? { behaviour: out.behaviour } : {}), ...(out.evidence ? { evidence: out.evidence } : {}), ...(out.warning ? { warning: out.warning } : {}), ...(out.setup ? { setup: out.setup } : {}), ...(out.checks ? { checks: out.checks } : {}) }), null, 2));
  } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
}

// Run as a script (node run.mjs …), not when imported.
const isMain = () => { try { return realpathSync(process.argv[1]) === realpathSync(RUN_MJS); } catch { return false; } };
if (process.argv[1] && isMain()) await main();
