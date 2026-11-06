# Coordinator

**Give your coding agent a lead.** Coordinator is an agent skill that runs a task the way a good engineering lead would. It agrees everything with you up front, staffs the work from your harness's own agents, and keeps sending the work back to independent critics until it meets a bar you can check. Then it reports, and remembers what it learned for next time.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node 18+](https://img.shields.io/badge/node-18%2B-brightgreen)
![No dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

---

## Why

A single agent pass grades its own homework. It decides the work is "fine", stops early, drifts into side quests, and asks you questions halfway through, while you're away. Coordinator separates the roles and makes the loop strict:

| Without it | With Coordinator |
|---|---|
| The builder decides it's done | A fresh critic, blind to the builder's reasoning, checks the real result (tests, screens, diffs) against a written bar |
| "Make it better" | A bar set before building: a failing test that must pass, a reference to match, an acceptance list |
| Questions mid-task | Every question asked once, up front. Then it runs unattended |
| Loops forever, or quits early | Stop rules enforced in code: round and time budgets, no-progress and same-gap detection, a cap on scope creep |
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

1. **Intake.** It reads the project and the task, researches references, picks agents for each role, and asks you every open question in one message, with its recommendation first. It records your answers, including any standing permission such as "merge when the review says ready".
2. **Loop.** Builders work in parallel where the units are independent, each in its own worktree. Critics judge the real artifact. `run.mjs next` decides what happens to each unit, and refuses any step taken out of order.
3. **Finish.** An integrator checks that the parts fit together. You get a short report: the outcome, the evidence, what stopped and why, and the decisions it made for you.
4. **Retro.** Repeated gaps become lessons, past runs tune the budgets, and gaps in the skill itself become issues or PRs here, with your approval.

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
| `/coordinator:status [run]` | Where a run stands, or picks it up after a break or a crash |
| `/coordinator:retro <run>` | Lessons, budgets and upstream improvements from a finished run |

Example:

```
/coordinator:run Fix issue #142 (wrong totals on the dashboard). Merge into dev when the review says ready.
```

You can also describe the goal ("coordinate this…") and the agent picks the command itself.

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
│   ├── learning.md             retro, lessons, budget tuning
│   ├── upstream.md             contributing improvements back
│   └── domains/                code · content (writing, design, research, data, prompts)
└── scripts/                    Node 18+, zero dependencies
    ├── run.mjs                 run state and the loop's decisions
    ├── lessons.mjs             the lesson store
    ├── detect.mjs              the bar-gaming detector
    ├── lib/                    pure modules: rules, store, gaming, secrets, args, workbench
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

## Contributing

Every run is a test of this skill. If a run went wrong, a rule was unclear or a guard didn't fire, open an issue. A fix is welcome as a PR. See [CONTRIBUTING.md](CONTRIBUTING.md).

```
npm test
claude plugin validate .
```

## Credits

The build, blind-critic and repeat loop comes from Matt Shumer's write-up of the method. The command structure, the context file and the deterministic detector come from Paul Bakaus's Impeccable. Details are in [CREDITS.md](CREDITS.md).

## License

[MIT](LICENSE)
