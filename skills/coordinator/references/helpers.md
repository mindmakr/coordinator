# Helper models: small models for small jobs

The strong model judges and builds. Many smaller jobs around it need only a quick, typed answer: which class is this unit, a one-line summary of what an agent just did, a first look at a screenshot. A small model does them for a fraction of the cost, often free, on the person's own machine.

Helpers are **off by default**, and nothing depends on them. With no `helpers` set, every step works as before: the lead does these jobs itself.

## Setup (one command)

| Where the model runs | Command | Notes |
|---|---|---|
| This machine, [Ollama](https://ollama.com) | `S/helper.mjs setup ollama` | Free and private. Then `S/helper.mjs ping` says which `ollama pull` to run |
| This machine, [LM Studio](https://lmstudio.ai) | `S/helper.mjs setup lmstudio` | Start its local server first; load the models `ping` names |
| Another PC (home network, Tailscale, a cloud GPU box in your private network) | `S/helper.mjs setup ollama --endpoint http://gpu-box:11434/v1` | Plain http only on private addresses, and doctor warns about it; https anywhere else |
| A router: [OpenRouter](https://openrouter.ai) | `S/helper.mjs setup openrouter` then set `OPENROUTER_API_KEY` | Text and screenshots leave the machine |
| OpenAI | `S/helper.mjs setup openai` then set `OPENAI_API_KEY` | Same |
| Any other OpenAI-compatible server or router (LiteLLM, vLLM, llama.cpp server, a company gateway) | `S/helper.mjs setup custom --endpoint URL [--key-env NAME]` | |

Change a model with `--decide M`, `--summarize M` or `--look M`, and the confidence floor with `--min-confidence 0.8`. `S/helper.mjs status` shows what is in use; `S/helper.mjs setup off` removes it. `/coordinator:init` asks once (`commands/init.md`).

Defaults per provider are in `scripts/lib/helpers.mjs` (`PROVIDERS`). For Ollama: `gemma3:4b` decides, `gemma3:1b` summarizes, `qwen2.5vl:7b` looks. With 12 GB of GPU memory or more, `qwen3-vl:8b` looks better at dense screens. Pick models with thinking off, or a fast one: these jobs want a quick answer, not reasoning.

**A committed settings file cannot turn helpers on.** If git tracks `.coordinator/coordinator.json`, its `helpers` are ignored and `setup` refuses to write to it, because that file would then decide where your key is sent for everyone who clones the repo. Keep `.coordinator/` git-ignored.

**Keys are never stored.** `helpers.keyEnv` holds the *name* of an environment variable; the key stays in the environment. A key, token or password anywhere in `helpers` fails doctor, and `setup` refuses a `--key-env` that looks like a key.

## The jobs

Every call prints JSON. `escalate: true` means **do not use this answer**: the reply did not parse, picked something not offered, or its confidence is under `minConfidence` (0.8 by default). Do that step yourself, as if there were no helper. Text is masked for secrets before it leaves (`lib/secrets.mjs`).

| Job | Command | Use it for |
|---|---|---|
| `decide` | `S/helper.mjs decide --question Q --choice A --choice B … [--context-file F]` | A pick from a fixed list: a unit's task class for routing (`routing.md`), whether a builder's report has the parts its brief asked for, whether two follow-ups are the same gap |
| `summarize` | `S/helper.mjs summarize --file <agent output> [--max-words 25]` | Tool summaries, below |
| `look` | `S/helper.mjs look --image shot.png --context "screen, role, locale, width"` | The visual pre-screen, below |

**Never a helper:** a verdict, a score, a behaviour mark, a pinned-class call (`routing.md`), or any gated action (`guardrails.md`). Helpers point; the strong model and the critics decide.

## Tool summaries

When a sub-agent returns, or between its beats, summarize its tool calls and output: `S/helper.mjs summarize --file <its output>`. Read the summary instead of the raw log, and record it where the person sees it: `S/run.mjs beat <run> <unit> --text "<summary>"` while it works, or the first line of `built --report`. Open the raw output only when the summary or the report does not add up. This is where the lead saves most tokens on long runs.

## Visual pre-screen

Before the visual critic (`sub-skills/visual.md`) judges, run `look` on every screenshot of the matrix. Pass the flagged ones (each with its `problems`) to the critic in its brief as pointers.

- A flagged screen (problems found, or an unsure look) is where the critic looks first.
- **An unflagged screen is not passed.** The critic still opens at least one screenshot per locale, per text direction and per width, plus every flagged one, and records in EVIDENCE what it opened. The helper narrows the search; it never shrinks the bar.
- Screenshots with personal data never go to a router: use a local helper or skip the pre-screen. Seeded test data only (`visual.md` step 1).

## Recording

Pass a helper's `usage` and `ms` on with the step it served when it matters (`--tokens-in`, `--tokens-out`, `--minutes`), so `stats` keeps counting the run's whole cost. `helper.mjs stats` shows calls, escalations, time and tokens per job in this project (counts only, never a prompt or an answer), and says so when a job hands back 30% or more of at least ten answers. In the retro, such a job is a lesson: change its model or drop the job (`learning.md`).

## Network

`helper.mjs` is the only script that calls a helper, and only after `setup`: `POST <endpoint>/chat/completions`, and `GET <endpoint>/models` for `ping` (`lib/helpercall.mjs`). It follows no redirects. A local or private endpoint keeps everything on the person's machines; a router endpoint sends the prompt and any screenshot to that provider, and each answer from one says so (`sentTo`). The rule is in `AGENTS.md`.
