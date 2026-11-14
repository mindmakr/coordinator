# One lead per run, one dashboard per PC: design

Status: agreed with the owner on 2026-11-14 (section 4) and built in the run `one-lead` (section 6). This document now says what was built, including the decisions made during the build: the 10-minute rule for a closed window (5.1), dashboard-first asking as an option (5.3), and the layout of Waiting on you (5.5).

This replaces the first draft, "one boss mode", where one window led every run on the PC. The owner chose the lighter version below (section 4, D1). A boss can come later if more than one window still feels like too many.

## 1. In one paragraph

Each run has exactly one lead window. The first window to lead a run keeps it. When that window ends or goes quiet, the next window to pick the run up takes it over, and the handover goes into the run's log. This works from any tool: Claude Code, Codex or any other. Other windows can read the run but cannot change its course, and nobody can start a second builder on a unit that is still working. One dashboard serves the whole PC and keeps running when windows close. It takes the answer to every run's questions and lists everything that waits on you. Every question names its project and run.

## 2. Why this and not a boss

The problems on 2026-11-14 were:

1. two windows leading the same run, and one of them started a second builder;
2. questions from several windows with no run name;
3. the dashboard stopping when its window closed;
4. test runs showing on the dashboard;
5. loose ends that nobody listed.

Each has a small, direct fix (section 5). A boss that leads every run in every project would fix them too, but at a cost:

- one session's context carries every run, so it fills up and compacts more often;
- the boss has to read each project's own instructions itself;
- it needs a background process and a way to wake the session;
- one stuck window stalls every run.

Coordinator works well because each run is self-contained and its log lets it survive a crash. This design keeps that.

## 3. What changes for you

- **You can lead from any window, in any tool.** The first window that leads a run keeps it. Another window that tries to change the run is told "this run is led by another window (Claude Code, last active 12 min ago)". Once that window has closed and the run has been quiet for 10 minutes, or the run has been quiet for 45 minutes, the next window that runs `/coordinator:status <run>` takes it over without asking you, and says so.
- **Every question says which run it is about**, for example "payday · Financial Insights (payday-fi-1426) › Task u2: Payout summary card".
- **You choose how questions reach you.** By default a question opens the question dialog in the lead's window. If you prefer, choose **dashboard first**: the lead writes the question in the chat and on the dashboards, keeps working, and takes your first answer from either place.
- **One dashboard for everything.** `http://127.0.0.1:7480` keeps running when windows close. The first Coordinator window that starts a run or runs `/coordinator:dashboard` starts it, and later windows reuse it. You can answer any run's questions on its front page.
- **A "Waiting on you" list** on that page: open questions, upstream notes waiting for your go-ahead, paused runs, finished runs that could not close on their own, and an out-of-date plugin.
- **Finished runs close themselves.** When every unit has passed and the final check has passed, the lead closes the run and runs its retro without asking. A run with a stopped unit still asks you.
- **No test runs** on the dashboard.

## 4. The owner's answers (2026-11-14)

| # | Question | Answer |
|---|---|---|
| D1 | One boss for every run, or the light version? | **Light now, a boss later if still needed.** |
| D2 | Who leads a run? | **The first window to lead it, in any tool. When it ends, whoever picks the run up next.** |
| D3 | Flight alerts from live apps as new work? | **Not in this build.** Nothing new reaches the network. |
| D4 | What a lead may do without asking | **The small list, plus closing finished runs, plus their retros** (5.6). |
| D5 | Start the dashboard when Windows starts? | **No.** It keeps running when windows close, and the first Coordinator window after a restart starts it again. |
| q1 | When does a closed Claude Code window stop leading its run? (asked during the build) | **After 10 quiet minutes.** A window reopened within those 10 minutes keeps its run. |
| B5 | How are questions asked? (asked during the build) | **The question dialog stays the default. Dashboard first is an option**, per project or per run (5.3). |

## 5. How it works

### 5.1 One lead per run

- **Claiming.** A run records its lead with a `lead.claim` event: a random lead id (never a host or user name), the tool, and the time. The `docs/design/v1.md` section 4.5 sketch used the same name. `init` claims for the window that starts the run. A run made before this change has no claim; its first lead step claims it.
- **The id.** The claiming step prints the id, and the lead passes it on every later lead step as `--lead <id>`, or sets it once as `COORDINATOR_LEAD` where its shell keeps environment variables. The playbook's `S` line carries it, so the lead never has to remember it.
- **Lead steps** are the steps that change the plan or the run's course: `init`, `add`, `add-specialist`, `start`, `reset`, `verdict`, `strategy`, `extend`, `freeze`, `foldin`, `ship`, `integrate`, `stop`, `close`, `ask`, `use-answer`, `pause`, `resume`, `push`, `pull`, and `next` when it would record a stop. With a different lead's id, or none, they refuse: "run X is led by another window (Claude Code, last active 14:05, 12 min ago); `/coordinator:status X` takes it over once that window has been quiet for 45 min".
- **Never refused:** worker steps (`beat`, `built`, `evidence`, and an agent's `note`), so builders and critics keep working whoever leads. Also never refused: read-only steps (`show`, `status-line`, `questions`, `list`), answers and person notes from the dashboard or the CLI.
- **When a lead counts as gone.** A lead is active while the run sees a lead step from it, or a beat from one of its units. It counts as gone in one of two ways:
  - **its window has ended:** the tool told us the window's process (Claude Code does), that process no longer runs on this PC, and the run has seen no lead step and no beat for 10 minutes (q1). A window reopened within those 10 minutes keeps its run;
  - **it has been quiet:** whatever the tool, no lead step and no beat for the run's stale time (`--stale-minutes`, 45 by default), the same clock that already decides a builder is quiet. This is the only signal that holds for every tool.
- **Taking over.** Once the lead is gone, the next window that runs `status <run>` (or any lead step with `--takeover`) claims the run without asking (D2, D4) and writes "took over from <old id>: quiet since 14:05". While the old lead is still active, a takeover needs `--takeover --reason "…"` and happens only after you say yes. The window that took over follows the existing Resume steps (`references/durability.md`): units whose builders belonged to the old window go back to build with `reset`, and fresh agents start.
- **The old window**, if it is still open, has its next lead step refused with the message above, so it stops instead of competing.

### 5.2 No second builder on a working unit

This is the fix for what happened on 2026-11-14, and it holds for every lead:

- `start` on a unit that is building or being judged, with a beat younger than its stale time, refuses unless the lead adds `--takeover --reason "…"`, which is logged.
- Every age the lead acts on comes from the script, worked out in minutes and printed in this PC's time zone: "last beat 52 min ago (14:05 local)". `show`, `next`, `status-line` and the refusals print ages this way. The lead never works out an age from a UTC timestamp, which is the mistake that started the second builder.

### 5.3 Questions name their run and task

The owner added this on 2026-11-14: when Coordinator asks a question, it should be clear which Coordinator, run and task the question comes from.

- Questions are asked only in two places:
  - the harness's own question tool (in Claude Code, the ask-user dialog);
  - the dashboards: the local one, and the web one on the hosted service, as today.
  
  They are never asked as plain chat text.
- Each question shows where it comes from, in this order:
  1. the project;
  2. the run, by its name (its `--alias`, else its title, clipped) and its id;
  3. the task (unit) the question is about, by its title and id.
  
  For example: "payday · Financial Insights (payday-fi-1426) › Task u2: Payout summary card". A question about the whole run shows no task.
- `run.mjs ask` returns this line as `label`. It is built by the script, never typed by the lead. The lead puts it on the first line of the question, because the question tool's header holds only 12 characters. The header itself holds the short run name.
- The local dashboard, the web dashboard and the "Waiting on you" list show the same line above each question, grouped by project and run.
- **Dashboard first, as an option (B5).** In Claude Code the question dialog holds the window until it is answered in the terminal. So an answer you give first on the dashboard cannot close the dialog. For people who would rather answer on the dashboard, there is a second way to ask:
  - the lead logs the question with `run.mjs ask`, as always;
  - it writes the question in the chat as plain text: the label, the question and the options, its recommendation first;
  - it opens no dialog and keeps working on what does not depend on the answer;
  - it acts on the first answer: from a dashboard (it hears it through `run.mjs watch`), or typed in the terminal (it records your words with `run.mjs answer … --by person --confirm "<your words>"`). Both places then show the answer.

  The dialog stays the default. Dashboard first is chosen per project (`"asking": "dashboard"` in `.coordinator/coordinator.json`, asked by `/coordinator:init`) or per run (an intake answer, recorded as a decision with `--asking`). The run's choice wins. `run.mjs ask` prints the mode in force, so the lead never has to guess.

### 5.4 One dashboard for the PC

- **It outlives the window.** `run.mjs dashboard` starts the server as a detached process, with its output in `~/.coordinator/dashboard.log`. It keeps today's port 7480, its token, and the `~/.coordinator/dashboard.json` record. When one is already running it prints that link, as today. `dashboard stop` stops it, as today.
- **Started on first use.** The `run` playbook's intake runs `run.mjs dashboard` (a no-op when one is up) and gives you the link once. No sign-in start (D5).
- **Answers for every run.** The front page gains **Needs you** with answer forms for each open question on the PC. They use the same locked code as `run.mjs answer`. Today the PC pages are read-only and answers go only through each run's own `serve`. This lets the page write to other projects' state folders. The protections stay the same: 127.0.0.1 only, a token made at each start, the page's own origin required on every form, and `dashboard.json` readable by you only. The lead hears the answer the way it does today: `watch`, or `next` at its next step.

### 5.5 Waiting on you

A list at the top of the front page, built only from state already on disk, across every project in the register. `run.mjs waiting` prints the same list in the terminal. It is one heading, oldest first, and each item says how long it has waited:

- open questions first, as **Questions for you**, each with its label and answer form;
- upstream proposals not yet filed (the existing gaps rules, `lib/gaps.mjs`), grouped per run;
- runs finished but not closed: units stopped, or the final check not passed;
- paused runs;
- an out-of-date plugin, from the last `doctor` result on disk. The dashboard itself never calls the network.

When a lead starts or resumes a run, it runs `run.mjs waiting` and mentions items older than a day, at most once a day. The full Gaps list stays on each project's Coordinator page.

### 5.6 What a lead does without asking (D4)

In `references/guardrails.md` ("Without asking, and what still asks"), the one place this list lives:

- **Without asking:**
  - start the dashboard;
  - restart a builder or critic that went quiet, once per unit per round (the second time, it asks);
  - take over a run whose lead has gone (5.1);
  - close a run once every unit has passed and the final check has passed, then run its retro.
- **Still asks, as today:**
  - start a new run (its up-front questions);
  - take over from a lead that is still active;
  - close a run with a stopped unit;
  - merge, release, publish, deploy, push to a protected branch, delete, spend, post anything public, or file anything upstream.

The retro's upstream notes and filing them count as posting, so they keep waiting for your go-ahead and appear under Waiting on you.

### 5.7 Keeping test runs off the PC list

The throwaway runs on 2026-11-14 ("ck", "q1" to "q5", "p", "pr") had state folders in the system's temporary folder. The skill's own tests already use a temporary register (`test/home.setup.mjs`). Two other things write to the real one:

- the service tests: `service/test/helpers.mjs` runs `run.mjs` with the real home folder;
- builders who try `run.mjs` by hand in a temporary folder.

The fix:

- the register never records a run whose state folder is inside the system's temporary folder (`COORDINATOR_REGISTRY=on` forces it);
- the service tests set their own `COORDINATOR_HOME`;
- the same rule skips entries already in the register when it is read, so nothing has to be deleted by hand.

### 5.8 Network and privacy

Nothing new calls the network (D3). The lead id is random. The claim holds the id, the tool and a time. The detached dashboard listens on 127.0.0.1 only.

### 5.9 Not in this build

- A boss window that leads every run, a background watcher, an inbox for tasks from other windows, and wake-ups (D1: later, if still needed).
- Flight alerts as new work (D3).
- Leads across several machines (v1 section 4.5). The `lead.claim` event leaves room for it.

## 6. Build plan

One Coordinator run in this repo (`one-lead`), following the context rules (`references/context.md`). Each step was one unit with its own pull request:

1. **Test runs off the PC list** (5.7). Small and independent, so it goes first.
2. **One lead per run** (5.1) and **no second builder** (5.2): `lead.claim` in the event schema, the refusals, the takeover, and ages printed by the script.
3. **The dashboard outlives its window** (5.4, first two points) and questions name their run (5.3).
4. **Answers and Waiting on you on the PC dashboard** (5.4 answers, 5.5).
5. **Playbooks and docs:**
   - `references/commands/run.md`: start the dashboard and check Waiting on you at intake, claim and pass the lead id, ask only through the question tool or the dashboards with the label first, the dashboard-first option ("Asking"), restart a quiet agent once per round, close and retro on their own;
   - `references/commands/status.md`: who leads, takeover, and never a second lead;
   - `references/guardrails.md`: 5.6;
   - `references/commands/init.md`: the `asking` setting;
   - `references/hud.md` and `references/durability.md`;
   - the `asking` setting and `run.mjs ask` printing the mode in force.

Agreed separately, not part of this run: Coordinator reads reins flight reports and compares (`lib/reinsreport.mjs`), so a fix unit can show "2 resolved, 0 new" as its evidence.
