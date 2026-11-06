# Coordinator

**Give your coding agent a lead.** Coordinator is an agent skill that runs a task the way a good engineering lead would. It agrees everything with you up front, staffs the work from your harness's own agents, and keeps sending the work back to independent critics until it meets a bar you can check. Then it reports, and remembers what it learned for next time.

Author: Asif Raja, by [mindmakr](https://github.com/mindmakr) · Homepage: [mindmakr.github.io/coordinator](https://mindmakr.github.io/coordinator/)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node 18+](https://img.shields.io/badge/node-18%2B-brightgreen)
![No dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

## What it is, and why

One person can run a team of agents, if something keeps that team honest. Coordinator does that job:

- **Questions first.** Every open question is asked once, before the work starts, with a recommendation. Then the run goes on without you.
- **Nobody marks their own work.** Builders build; a separate critic, blind to the builder's reasoning, checks the real result against a bar written in advance. A pass needs evidence.
- **Hard stops.** Budgets, no-progress and same-cause detection, and a scope cap are enforced in code, not left to the agent's judgement.
- **Durable state.** Every run is a locked JSON file. A crash or a context reset resumes from it.
- **Lessons.** Each run ends with a retro that carries lessons and tuned budgets into the next one.
- **A dashboard in your browser.** Each run writes its own page, and can serve it locally with answer forms. No separate GUI app to install.

---

## With and without it

A single agent pass grades its own homework. It decides the work is "fine", stops early, drifts into side quests, and asks you questions halfway through, while you're away. Coordinator separates the roles and makes the loop strict:

| Without it | With Coordinator |
|---|---|
| The builder decides it's done | A fresh critic, blind to the builder's reasoning, checks the real result (tests, screens, diffs) against a written bar |
| "Make it better" | A bar set before building: a failing test that must pass, a reference to match, an acceptance list |
| Questions mid-task | Every question asked once, up front. Then it runs unattended |
| Loops forever, or quits early | Stop rules enforced in code: round and time budgets, no-progress and same-root-cause detection, a cap on scope creep |
| Tests quietly skipped to go green | A deterministic detector flags focused, skipped or deleted tests, removed assertions, rewritten snapshots and suppressed checks |
| Generic, template-looking output | A craft bar: no slop in copy, titles, navigation or prompts, and UI built from researched references (or yours, such as Mobbin) |
| Forgets everything | Lessons and budgets carried from run to run; general improvements sent back to this repo |

## How a run works

```
 intake ─────► split ─────► build ─────► judge ─────► next
 ask once,      units you    one fresh    one blind     ├─ build again: fix the biggest gap
 research,      can judge    builder      critic        ├─ change strategy: the same gap came back
 staff team     separately   per unit     per round     ├─ stop: budget spent, no progress, stuck
                                                         └─ integrate ─► report ─► retro (learn)
```

1. **Intake.** It reads the project and the task, researches references, picks agents for each role, and asks you every open question in one batch, through your harness's question tool, with its recommendation first. It records your answers, including any standing permission such as "merge when the review says ready".
2. **Loop.** Builders work in parallel where the units are independent, each in its own worktree. Critics judge the real artifact. `run.mjs next` decides what happens to each unit, and refuses any step taken out of order.
3. **Finish.** An integrator checks that the parts fit together. You get a short report: the outcome, the evidence, what stopped and why, and the decisions it made for you.
4. **Retro.** Repeated gaps become lessons, past runs tune the budgets, and gaps in the skill itself become issues or PRs here, with your approval.

## Works with

Coordinator brings no team of its own: it staffs builders, critics and researchers from the agents, skills and tools your harness already has. It is designed for any harness that can delegate to sub-agents, run a script and ask you a question.

- **Claude Code:** supported today, as a plugin or a copied skill folder.
- **Other skills-capable harnesses:** copy `skills/coordinator` into the harness's skills folder. Fallbacks are built in (a numbered list where there is no question tool, a file path where there are no Artifacts), but so far it is packaged and released for Claude Code only.
- **Planned for 1.0:** a second harness with its own install path and an end-to-end run. The draft design ([#15](https://github.com/mindmakr/coordinator/issues/15)) recommends OpenAI Codex CLI; the choice is still open.

## Install

**Claude Code plugin**

```
/plugin marketplace add mindmakr/coordinator
/plugin install coordinator@coordinator
```

**Any skills-capable harness:** copy `skills/coordinator` into your skills folder (for Claude Code, `~/.claude/skills/`). Installed this way, the commands are `/coordinator init`, `/coordinator run <task>` and so on.

**Needs:** Node 18+ and git. No other dependencies.

Then add `.coordinator/` to your project's `.gitignore`.

## Use

| Command | What it does |
|---|---|
| `/coordinator:init` | Learns the project once: checks, protected branches, risk areas, standing rules. Writes `COORDINATOR.md` |
| `/coordinator:run <task>` | Intake, then the loop until the bar is met. Takes an issue, a PR, or a plain description |
| `/coordinator:status [run]` | Where a run stands (a compact text HUD), or picks it up after a break or a crash |
| `/coordinator:retro <run>` | Lessons, budgets and upstream improvements from a finished run |

Example:

```
/coordinator:run Fix issue #142 (wrong totals on the dashboard). Merge into dev when the review says ready.
```

You can also describe the goal ("coordinate this…") and the agent picks the command itself.

**Watching a run.** Each run keeps a `hud.html` beside its state. It opens with the situation in plain words, a **Needs you** box with the lead's recommendation (or "Nothing needs you"), and a rough time left; each unit says in one sentence what it is for, how it went and what happens next. Then the unit board, scores per round, budget bars, a timeline, and the decisions, questions and follow-ups. It is rewritten on every change and reloads itself, with no scripts and no network, so you can open it straight from disk. In Claude Code the lead can publish it as a private Artifact. `run.mjs show <run>` prints the same at a glance in text.

**Answering from the HUD.** `run.mjs serve <run>` serves the same page on 127.0.0.1 with answer forms: each question's options as cards, the recommended one first, an Other box, and a note box per unit. The lead asks through the question tool and mirrors each question there, so you can answer in either place and change your answer until the lead uses it. `run.mjs watch <run>`, running in the lead's background, prints each answer and note as it arrives, so the lead hears at once.

## What's inside

```
skills/coordinator/
├── SKILL.md                    the router and the rules every command shares (<500 words)
├── references/
│   ├── commands/               init · run · status: one playbook per command
│   ├── bar.md                  choosing a bar a critic can check
│   ├── briefs.md               builder, critic and integrator briefs
│   ├── craft.md                the no-slop bar; UI from references
│   ├── team.md                 staffing roles from your harness's agents
│   ├── guardrails.md           budgets, fence, stop rules, gated actions
│   ├── durability.md           background agents, heartbeats, resume
│   ├── hud.md                  the text and HTML views of a run
│   ├── learning.md             retro, lessons, budget tuning
│   ├── upstream.md             contributing improvements back
│   └── domains/                code · content (writing, design, research, data, prompts)
└── scripts/                    Node 18+, zero dependencies
    ├── run.mjs                 run state and the loop's decisions
    ├── lessons.mjs             the lesson store
    ├── detect.mjs              the bar-gaming detector
    ├── lib/                    pure modules: rules, store, gaming, secrets, args, workbench, view, plain, hud, questions, serve
    └── test/                   node:test suites
```

## Design principles

- **Short files, one job each.** Load only the playbook you need. Logic lives in pure, tested modules.
- **State over memory.** Every run is a JSON file, written atomically behind a lock, with a readable `workbench.md`. Crashes and context resets resume from it.
- **Safe by default.**
  - No network calls, no shell strings, and ids validated against path traversal.
  - Secrets are refused in lessons and masked in run state.
  - Merging, deploying, deleting, spending or posting needs your approval, given up front.
- **Extensible.** New playbooks are commands or domain files that reuse the core. They never fork it.

## Coming soon

Planned, not built yet. The road to 1.0 is [#15](https://github.com/mindmakr/coordinator/issues/15), in milestones [#9](https://github.com/mindmakr/coordinator/issues/9) to [#14](https://github.com/mindmakr/coordinator/issues/14).

| Add-on | Status |
|---|---|
| Behaviours and evidence on the bar, a live dashboard with a page per unit | In development (0.5) |
| Follow and answer a run from a phone, with alerts | On the 1.0 plan ([#11](https://github.com/mindmakr/coordinator/issues/11), [#12](https://github.com/mindmakr/coordinator/issues/12), [#18](https://github.com/mindmakr/coordinator/issues/18)) |
| Security pass as a second critic on every code change | On the 1.0 plan ([#13](https://github.com/mindmakr/coordinator/issues/13)) |
| Run maps: mind, flow, heat and goal relevance | On the 1.0 plan ([#20](https://github.com/mindmakr/coordinator/issues/20)) |
| Project map: code, settings, surfaces and reuse | On the 1.0 plan ([#21](https://github.com/mindmakr/coordinator/issues/21)) |
| The coordinator's own page: lessons, stats, history, proposals | On the 1.0 plan ([#19](https://github.com/mindmakr/coordinator/issues/19)) |
| Compliance and audit trails, API flows, caller and callee graphs, function and external dependency maps | Proposed; [tell us what you need](https://github.com/mindmakr/coordinator/issues/new/choose) |

## Contributing

Every run is a test of this skill. If a run went wrong, a rule was unclear or a guard didn't fire, open an issue. A fix is welcome as a PR. See [CONTRIBUTING.md](CONTRIBUTING.md).

```
npm test
claude plugin validate .
```

## Inspired by

- **The Gauntlet Loop** by Matt Shumer ([write-up](https://somethingbig.ai/gauntlet-loop), [example repository](https://github.com/mshumer/Claude-of-Duty)): the build, blind-critic and repeat loop.
- **[Impeccable](https://github.com/pbakaus/impeccable)** by Paul Bakaus: the command structure, the context file and the deterministic detector.
- Wider work on long-term agent memory and graph-shaped workflows shaped the lessons store and the planned maps.

Details are in [CREDITS.md](CREDITS.md).

## Support the project

Coordinator is maintained by one author. It needs contributors, evangelists, sponsors and partners, especially people who build models, coding tools and open-source agents.

- **Contribute:** report runs that went wrong, send fixes, or build an adapter for your harness ([CONTRIBUTING.md](CONTRIBUTING.md)).
- **Spread the word:** write up a run, present it, or point a team at it.
- **Sponsor or partner:** credits for test runs, an adapter built together, or sponsorship, through the [sponsor or partner form](https://github.com/mindmakr/coordinator/issues/new?template=sponsor-or-partner.yml). It is a public issue, so leave out private contact and payment details.

More on the [homepage](https://mindmakr.github.io/coordinator/).

## License

[MIT](LICENSE)
