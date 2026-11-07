# Model routing: which model each role gets

Mechanical builder work goes to a cheaper model. Judgement stays on the strong one. Routing is on by default; the person can turn it off or change the table.

## The table

| Role or task class | Model | Why |
|---|---|---|
| Critic, specialist critic, visual critic, integrator | strong (`opus`) | Review depth is not where to save. Never routed down. |
| Builder, `mechanical` work: docs, copy, translations, renames, test fixtures, small mirror changes | cheap (`sonnet`) | The bar and the critic catch a slip; the work needs care, not judgement |
| Builder, anything else | the harness's default | Logic, data, security, money and UI need the full model |
| Researcher | the harness's default | |

Ask the script instead of working it out: `S/run.mjs models --role builder --class docs` prints `{ model, why }`. `model: null` means "pass no model, use the default".

When a unit fits two classes, use the stronger choice. A unit that failed once on the cheap model gets the default model for its next try, and the start says so (`--why "retry after cheap fail"`).

## Naming models per harness

- **Claude Code:** the Agent tool's `model` parameter: `opus`, `sonnet` or `haiku`.
- **Codex:** the model name Codex takes with `-m` / `--model` (or `model` in its config). Put the names in the table (below); Codex names are recorded as given and never ranked.
- **Other harnesses:** whatever name the harness takes; the table maps to it.

## Turning it on or off

`.coordinator/coordinator.json`, key `models`:

- absent: on, with the table above;
- `false`: off. Every agent gets the harness's default, and nothing is refused;
- an object mapping a role or task class to a model name, over the defaults, e.g. `{ "critic": "opus", "builder": "opus", "mechanical": "sonnet" }`. A key for a single class (`"translations": "haiku"`) beats `mechanical`.

A critic entry below the strongest model in the table is ignored with a warning: critics are never routed down. `S/run.mjs init --models on|off` writes the switch and keeps the rest of the file; `/coordinator:init` asks the person once (`commands/init.md`).

## Recording

Record every choice, routed or not, so the retro and `stats` can tell whether cheaper builders fail more:

- `S/run.mjs start <run> <unit> --model sonnet --why docs-only`: the model building this try, and the class that chose it.
- `S/run.mjs verdict <run> <unit> pass|fail … --model opus`: the model that judged. While routing is on, a judging model ranked below the strongest is refused.

The unit card and page then read "built by sonnet (docs-only) · judged by opus". `S/run.mjs stats` adds `roundsByBuilderModel` (rounds, passes, pass rate per builder model) and `roundsByJudgeModel`. In the retro, a cheap model whose pass rate sits clearly below the default's on the same kind of unit is a lesson: narrow its classes.
