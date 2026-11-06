# Changelog

## Unreleased

- **Built-in sub-skills** (#13): investigate, plan, fix, review (with a security pass and a project-rule pass), verify, visual, translations, release notes and board, each a short playbook in `references/sub-skills/` (when, inputs, how it plugs into the loop, steps, output). `references/sub-skills.md` maps loop steps to playbooks; the builder, critic and integrator briefs and `run.md` name the right one per step. The project's own skill still wins.
- **Review depth is fixed:** a strong model, the whole diff and its callers, the red test against base, full checks, and the correctness, security and project-rule passes every round. A budget can cut rounds or time, never a pass.
- **Lessons from real runs folded in:** each parallel builder gets its own database; audit and lookup work on auth failure paths must stay inside the equal-time envelope, and timing tests call the route; copy under the project's approval is not failed on wording; a bar that needs open-ended language detected is bounded before freeze; CAUSE names the root cause and is reused word for word; a defect found after a pass is recorded as an escape.
- **Plugin:** each sub-skill is listed as `/coordinator:<name>` (thin `skills/<name>/SKILL.md` entries).
- **Codex CLI note** (`references/codex.md`): install path and differences; discovery of all ten skills checked on codex-cli 0.160.0, a full run not yet.

## 0.5.0 (2026-11-06)

A live dashboard, and a bar made of behaviours with evidence attached. From the owner's feedback on the 0.4 HUD.

- **Live dashboard:** `run.mjs serve` pushes changes over Server-Sent Events (same token, 127.0.0.1 only, 15 s heartbeat, reconnect with backoff) and the page swaps only the blocks that changed, never one being typed in. A **Live** dot shows connected or reconnecting. No more full-page reloads.
- **Kept state:** open sections, scroll position, theme and timeline filters are remembered per browser, across live updates and reloads.
- **Theme toggle:** System, Light or Dark.
- **Behaviours make up the bar:** `add --behaviour "Given … when … then …"` (repeatable) or `behave <run> <unit> [--id B1] --text …` / `--id B1 --remove`; `behaviours <run>` lists them. The critic marks each with `verdict … --behaviour B1=pass:"evidence"`; `verdict pass` is refused while any behaviour is failing or unchecked, and `start` sets them back to unchecked.
- **Evidence per unit and behaviour:** `evidence <run> <unit> [--behaviour B1] (--text | --file | --url) --kind test|screenshot|log|link [--label]`. Text is masked and capped; images and small logs are checked and copied into `artifacts/<unit>/`; URLs must be http(s). Test output shows in a monospace block, collapsed when long; screenshots as thumbnails that open full size.
- **Goal evidence:** `behave <run> --goal …`, `evidence <run> --goal …`; the dashboard opens with **Goal: met / not yet**, and `integrate pass` needs every goal behaviour passing.
- **A page per unit** (`/unit/<id>`, live; `units/<id>.html` in the snapshot): behaviours, evidence, every round with the builder's report (`built --report`), the critic's verdict, score, cause and behaviour marks, notes and questions, links, and **the unit's own timeline** (start, beats with `beat --text`, built, verdicts, strategy, evidence, questions, answers, notes, links, merge, stop).
- **Timelines:** colour-coded badges with text labels, search, kind and unit filters, time ranges (30 min to 8+ days) and sort, all kept per browser.
- **Links everywhere:** URLs, `owner/repo#n`, and against the run's repo (`init --repo`, else the project's GitHub remote) `#n`, commit shas and branch names, each opening in a new tab with no referrer. `add`/`link --issue … --pr …` (repeatable, for linked repos) and `link --merge …` put chips on the card and the unit page.
- **Looks like the project:** `init --theme file.css` or `Theme:` in `COORDINATOR.md` maps the design system's custom properties (shadcn, Tailwind 4 `@theme`, daisyUI) onto the dashboard; unsafe values are dropped and nothing is loaded.
- **Retrying / Quiet, not "needs attention":** the unit badge says the lead is handling it (failed twice in a row; agent silent), with the reason on hover and a legend. Only Needs you and question cards address the person.
- **Local times:** the live pages show times in the viewer's locale and zone (relative within 24 h, full local time on hover); the snapshot keeps ISO with UTC spelled out. Every time is a `<time datetime>`.
- **Brand:** "Coordinator by mindmakr" mark, favicon, page titles ("<run> · Coordinator by mindmakr") and footer with the version.
- **Your place is kept:** live updates change the page in place (keyed rows, cards and sections, every key unique on its page; kept nodes stay), so the browser's own scroll anchoring holds the reader's place. A reload restores the scroll position once images and fonts have loaded. Known issue: in Chromium, an append to a list just above the top of the screen inside a tall card can shift the view (`references/hud.md`). Event keys carry a hash of the text and a number, so two events never share one.
- **Status at a glance:** a connection pill (Live, Reconnecting, Disconnected, Finished; after a server restart it says to open the new link and stops retrying, with a Retry button), a status dot per unit, active units first and finished ones dimmed (with Show finished), no pulsing under reduced motion.
- **Self-explaining numbers:** "Tries used: 2 of 4", "Score per try (0–10)" with a tooltip per dot (try, result, score, cause), one try as words, budget cards that explain themselves; only limits that block work turn red.
- **Search highlights:** every match in the visible timeline rows is marked (case, accent and diacritic insensitive, text nodes only), with an "n matches" count; kept across live updates.
- **Answered questions leave the open list:** the Questions card counts open ones only; answered and decided ones move to a collapsed Answered group that leads with the answer.
- **Bar changes are on the record:** after freeze, removing or rewording a behaviour needs `--reason` (logged as a bar note), and none changes while its unit is being judged. Behaviours set at `add` show on the timeline under their own kind.
- With no `--repo` and no GitHub remote, `#n` resolves against the GitHub links already in the run.
- **Snapshot:** `hud.html` is now a static read-only snapshot (no meta refresh, so open sections stay open); one page per unit beside it; small screenshots embedded.
- Older state files load: every new field is optional.

## 0.4.0 (2026-11-06)

The person answers the lead's questions and adds notes from the HUD, and the lead hears about it at once.

- **Questions shaped like the question tool:** `run.mjs ask <run> --question Q --header H --option "label|description" …` (2–4 options, the recommended one first, free text always allowed, `--multi`, `--unit`). The older `note --kind question` still works and shows as a question with no options.
- **Answers you can change until used:** `run.mjs answer <run> qN --choice … --other … --by person|lead` records an answer; `use-answer` marks it acted on, after which it is refused. Every answer is kept in the question's history. `run.mjs questions <run>` lists them all.
- **Notes from the person:** `note --kind person --text T [--unit U]`, shown on the unit card and in "Notes from you".
- **The answer page:** `run.mjs serve <run> [--port P]` serves the HUD with answer forms and note boxes on 127.0.0.1 only, behind a token made at each start; a POST also needs the page's own origin. Writes use the same locked state code as the CLI. It reloads like the file but never while a form is being filled in (one inline script, allowed by a per-response nonce). `hud.html` on disk stays script-free and read-only, and says how to get the answer page.
- **The lead hears at once:** `run.mjs watch <run>` prints one line per new or changed answer and per note, polling every 2 s; the lead runs it in the background so an answer wakes it (`references/commands/run.md`).
- Older state files load: questions without options or history read as before.

## 0.3.0 (2026-11-06)

The HUD explains the run in plain words (#7).

- **Situation, Needs you, Time left** at the top of `hud.html` and `run.mjs show`: the lead's latest `note --kind situation` (or a count of tasks in progress, done and waiting), a highlighted box of open questions with the lead's recommendation (`note --kind question --recommend R`, closed by `note --kind decision --answers qN`), and a rough time left from the median try so far and the time budget.
- **One plain sentence per unit**, before the scores: what it is for, how it went, what happens next. `add` takes `--title` and an http(s) `--link`. Raw gap and evidence move behind a toggle.
- **Needs attention** badge on a unit that failed two tries in a row or whose agent went quiet.
- The lead writes a situation note after each verdict and each merge (`references/commands/run.md`).
- All new fields are optional: older state files load and render as before.

## 0.2.0 (2026-11-06)

From the first real run and its owner's feedback.

- **HUD** (#3):
  - `run.mjs show` prints a compact text view: units, phase, rounds, score trend, budget used against its limits (time included), the next step, and counts of questions, follow-ups and decisions;
  - every change rewrites `hud.html` beside the state, in the same lock: one fixed, self-contained template with the unit board, score charts, budget bars, a timeline, and the decisions, questions and follow-ups. No scripts, no network, escaped state text, reloads every 15 s while the run is open, light and dark, phone width;
  - `run.mjs hud <run>` rewrites it on demand and prints its path. `references/hud.md` covers publishing it as an Artifact in Claude Code.
- **Same gap by root cause** (#5): the critic replies with a `CAUSE:` tag, `verdict` and `integrate` take `--cause`, and two rounds with the same cause count as the same gap even when worded differently. Without a cause on both rounds the wording decides, so older state files still load and behave as before.
- **Questions through the question tool** (#2): intake and gated-action questions go through the harness's question tool (AskUserQuestion in Claude Code), each with a short context line and the recommendation first, or a numbered list where there is no such tool. Builders, critics and integrators never ask the person.
- **Short replies** (#1): outcome first, as short as the content allows, with a context line when several pieces of work are active.

## 0.1.0 (2026-11-06)

First public version.

- Commands: `init`, `run`, `status`, `retro`.
- One intake batch, then an unattended loop: builders, blind critics, an integrator.
- Stop rules in code:
  - round and time budgets;
  - no progress;
  - the same gap after a change of strategy;
  - a blocked stacked unit;
  - a cap on scope added after the split;
  - out-of-order steps refused.
- `detect.mjs`: flags focused, skipped, deleted or renamed-away tests, removed or trivialised assertions, rewritten snapshots, suppressed checks, ignored failures, and edits outside the fence.
- Durable state:
  - atomic and locked;
  - shared across git worktrees;
  - heartbeats for builders and critics;
  - resume after a crash or compaction.
- Lessons: merged, ranked and pruned. Budgets tuned from past runs. Improvements contributed upstream with the user's approval.
- Craft bar (no slop). UI built from researched or supplied references. Roles staffed from the harness's own agents.
