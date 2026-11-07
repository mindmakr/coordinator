# Model routing: which model each role gets

Mechanical builder work goes to a cheaper model. Judgement stays on the strong one. Routing is on by default; the person can turn it off or change the table.

## The table

| Role or task class | Model | Why |
|---|---|---|
| Critic, specialist critic, visual critic, integrator | `strong` (`opus`) | Review depth is not where to save. Never below `strong`, whatever the table says. |
| Builder: security, money, migrations, auth, payments, billing, invoicing, authentication, authorization, permissions, secrets, crypto, PII, personal data | `strong` | Pinned: the table cannot route them down |
| Builder, `mechanical` work: docs, copy, translations, renames, test fixtures, small mirror changes | cheap (`sonnet`) | The bar and the critic catch a slip; the work needs care, not judgement |
| Builder, anything else | the harness's default | Logic, data and UI need the full model |
| Researcher | the harness's default | |

A class is pinned when any word of it (split on anything but letters and digits) is one of `auth`, `authn`, `authz`, `money`, `pay`, `fee`, `fees`, `role`, `pii`, `token`, `login`, `bill`, `kyc`, or starts with one of these stems: `secur`, `migrat`, `oauth`, `payment`, `payout`, `payroll`, `salar`, `ledger`, `refund`, `wallet`, `disburs`, `kyc`, `session`, `csrf`, `rbac`, `role`, `permission`, `iban`, `schema`, `authent`, `authori`, `billing`, `invoic`, `secret`, `crypt`, `encrypt`, `password`, `credential`, `otp`, `mfa`, `2fa`, `jwt`, `xss`, `inject`, `ssrf`, `acl`, `sanitiz`, `sanitis`, `cors`, `csp`, `tls`, `cookie`, `audit`, `gdpr`, `pdpl`; or it names personal data or access control. So `invoice-pdf`, `db-migration`, `salary-slip`, `user-permissions` and `personal_data_export` are all pinned. Pinning too much costs money, not safety. A rename or mirror change that touches a pinned area counts as that class too: give both (`--class renames,auth`). A unit in several classes gets the strongest of their choices.

Ask the script instead of working it out: `S/run.mjs models --role builder --class docs` prints `{ model, why }`. `model: null` means "pass no model, use the default".

## Naming models per harness

- **Claude Code:** the Agent tool's `model` parameter: `opus`, `sonnet` or `haiku`. Full ids count as their family when they hold exactly one family word and only version or date parts (`claude-sonnet-4-5`, `claude-3-5-haiku-20241022`); anything else (`claude-opus-4-5-haiku`) is unranked. Case does not matter, and `stats` groups a family into one row. Provider wrappers are stripped first: Bedrock `us.` / `eu.` / `apac.` / `global.` and `anthropic.` prefixes and `-v1:0` suffixes, and Vertex `@20250805` dates, so `us.anthropic.claude-opus-4-1-20250805-v1:0` and `claude-opus-4-1@20250805` count as opus.
- **Codex:** the model name Codex takes with `-m` / `--model` (or `model` in its config). Codex names have no built-in ranking, so declare the strong one: `"models": { "strong": "<your strongest Codex model>", "mechanical": "<a cheaper one>" }`. A critic may then use only that `strong` name.
- **Other harnesses:** the same: name `strong`, then the cheaper entries.

## Turning it on or off

`.coordinator/coordinator.json`, key `models`:

- absent: on, with the table above;
- `false`: off. Every agent gets the harness's default, and nothing is refused;
- an object mapping a role or task class to a model name, over the defaults, e.g. `{ "strong": "opus", "critic": "opus", "builder": "opus", "mechanical": "sonnet" }`. `strong` (default `opus`) is the floor for judges and pinned classes. A custom `strong` that contains `claude`, `anthropic`, `haiku`, `sonnet` or `opus` anywhere (any case, any separator) must be a recognised opus id, or it is refused: `sonnet`, `claude-3-5-haiku`, `us.anthropic.claude-haiku-4-5`, `claude_haiku` and `opus-haiku` all are. Any other custom `strong` is an unranked name for another harness. The same parsing applies to judge names in `verdict` and `integrate` and to the escalation check in `start`: a Claude-looking name that does not parse never counts as strong. A key for a single class (`"translations": "haiku"`) beats `mechanical`.

A judge or pinned-class entry below `strong` is ignored with a warning. `S/run.mjs init --models on|off` writes the switch and keeps the rest of the file (a malformed file is refused, never overwritten); `/coordinator:init` asks the person once (`commands/init.md`).

## Escalation

After any try fails on a model below `strong`, and until a try builds on `strong`, `next` suggests `strong` (`model`, `modelWhy`) and `start` needs `--model` at or above it. `start` with no `--model`, or a cheaper one, is refused unless a cheaper `--model` comes with `--force-model "reason"`, which logs a decision.

## Recording

Record every choice, routed or not, so the retro and `stats` can tell whether cheaper builders fail more:

- `S/run.mjs start <run> <unit> --model sonnet --why docs-only`: the model building this try, and the class that chose it.
- `S/run.mjs verdict … --model opus` and `S/run.mjs integrate … --model opus`: the model that judged. While routing is on, a judge below `strong` (or an unranked name other than `strong`) is refused.

While routing is on, a `start`, `verdict` or `integrate` without `--model` records `unspecified`, so pass rates stay honest and the dashboard counts the rounds with no model. The unit card and page then read "built by sonnet (docs-only) · judged by opus", and the dashboard's budget block shows rounds and pass rate per builder model. `S/run.mjs stats` adds `roundsByBuilderModel` and `roundsByJudgeModel`. In the retro, a cheap model whose pass rate sits clearly below the default's on the same kind of unit is a lesson: narrow its classes.
