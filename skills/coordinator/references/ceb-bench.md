# CEB bench: the plan, the prices and the estimate

`run.mjs bench` plans a run of the Coordinator Engineering Benchmark (CEB). A plan says which model does which tasks, in which tool, with or without the Coordinator loop, and what that should cost. The person agrees to the cost before anything is spent. The playbook is `commands/bench.md`; the suite's task list is in `ceb-manifest.md`.

**This version plans and confirms. Running the tasks, the result bundle and ranked submission come in later versions.**

Code: `scripts/lib/ceb/bench.mjs` (the rules, pure), `prices.mjs` (the price lists), `fetch.mjs` (the manifest download), `cli.mjs` (the command).

## A configuration

A result is only comparable with results of the same configuration. `bench plan` checks every part and reports all problems at once.

| Option | Rule |
|---|---|
| `--model` | The exact id of a model in the suite's price list. An alias ("latest", "opus", "gpt") is refused, because it can point at a different model tomorrow |
| `--harness` | `claude-code` or `codex`: the tool that runs the tasks. Left out, it is the tool the command ran in |
| `--effort` | One of the tool's levels. Claude Code: `low`, `medium`, `high`, `xhigh`, `max`. Codex: `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--arm` | `coordinator` (default) or `baseline`: see below |
| `--serving` | How the model is served: `vendor-api` (default), a host, or a runtime and quantisation such as `ollama-q4_k_m`. Required for an open-weight model, because a quantised or third-party copy is not the same model |
| `--cap` | The most the run may spend at the suite's pinned prices, for example `"20 USD"`. Required; there is no default |
| `--mode` | `practice` never reaches the board. `ranked` is published, so it needs `--consent yes`, and the service picks its tasks. A ranked plan cannot start in this version |
| `--task` | Practice only: the tasks to run (`a,b` or repeated). Default: every task of the suite |

## With and without the Coordinator

Each configuration can run in two arms, on the same tasks, with the same cap and the same hidden tests:

- **`coordinator`:** each task runs through the loop: a lead, a builder and a blind critic, round after round until the bar is met.
- **`baseline`:** the same model does the task on its own in the same tool, in one session.

The board shows both rows and the difference between them. That difference is what the loop adds, and it is also how changes to the Coordinator itself are measured. Plan the two arms as two plans.

## The price list

`prices.mjs` holds one list per suite, in USD per million tokens: fresh input, input read from the provider's cache, input written to it (where the provider prices that apart), and output.

- **Cost is tokens times these prices,** whatever the runner paid. Two runners with different discounts, or one on their own hardware, get the same cost for the same tokens.
- **Every price comes from the provider's own pricing page,** listed in `sources`, on the date in `checked`.
- **A published price never changes.** A model is added with a new entry.
- **A note says where a price is a choice.** Where a provider charges more above a prompt size, has peak hours, or had an introductory price, the entry's `note` says which figure was pinned. `bench plan` repeats the note to the person.
- **An open-weight model is named by its weights release** (`openWeights` is its Hugging Face repository) and priced at its publisher's own API price for that release.

`run.mjs bench prices` prints the list. To add a model, add an entry with the provider's exact id and the pricing page in `sources`, in a pull request.

Not in the list, and why: xAI's current models, because a bare name such as `grok-4.7` is an alias for that model's latest release and xAI's page lists no dated id for it (only `grok-4.20-0309-reasoning` is pinned); Meta, which has published no new Llama weights since April 2025; and open-weight models with no publisher price to pin (Kimi K3.1 Pro, gpt-oss, Gemma 4).

## The estimate

The estimate is the tasks' expected tokens times the model's pinned prices.

| Figure | Value for `CEB-2026.12` |
|---|---|
| Tokens for each minute of a task's expected human time, per round | 6,000 fresh input, 60,000 cached input, 1,000 output |
| Rounds expected per task | 2 |
| Rounds at most | 4 |
| Baseline arm | One session, at 60% of one round's tokens |

So a 30-minute task on a model priced 4 / 0.20 / 20 USD is expected to cost 1.44 + 0.72 + 1.20 = 3.36 USD through the loop, and 6.72 USD at most.

**These token figures are assumed, not measured** (`estimateBasis.measured` is `false`). No run of the suite exists yet. The first real runs will replace them, and the plan says so to the person every time.

## The plan and the go-ahead

`bench plan` stores `<state folder>/bench/<id>/bench.json`:

| Field | Holds |
|---|---|
| `id`, `suite`, `createdAt` | `bench-YYYYMMDD-HHMMSS` (UTC), the suite, an ISO 8601 time |
| `manifest` | The SHA-256 of the manifest that was verified, and the id of the key that signed it |
| `config` | `model`, `harness`, `effort`, `arm`, `serving`, `mode`, `cap` (`amount`, `currency`), `consent` |
| `tasks` | Each task's `id`, `category`, `image` (pinned by digest) and `humanMinutes` |
| `estimate` | `expected`, `high`, the tokens assumed, and a figure per task |
| `status`, `confirmed` | `planned`, then `confirmed` with the time and the person's words |

Nothing that runs a task may start until `startRefusal(plan)` returns null. It returns a reason while the estimate is not confirmed, and for every ranked plan in this version. `bench confirm <id> --confirm "their words"` records the go-ahead once; it cannot be changed. No API key, token or handle is stored in a plan.

## The network

`bench plan` makes two https GETs, to `raw.githubusercontent.com/mindmakr/coordinator-bench`, for the suite's `manifest.json` and `manifest.json.sig`: no redirects, no credentials, a size limit and a 15-second timeout. The manifest is used only after its signature verifies against the keys the skill ships. Offline, pass `--manifest <file> [--sig <file>]`. The other bench commands call nothing.

## Models from other providers, and open-weight models

**None of these routes has been run through the bench yet.** They are setup notes from the providers' own documentation, read on 2026-11-13. The step that runs tasks will test them.

**Which tool.** Claude models run in Claude Code. Every other model runs in Codex. Anthropic states that it does not support routing Claude Code to non-Claude models. Several providers publish a guide for it all the same, but through such an endpoint Claude Code's token counts can be estimates and cache prices may not apply, so the cost is less exact. `bench plan` allows the pairing and says so.

**Codex with another provider.** Add a provider to `~/.codex/config.toml` and select it:

```toml
model = "<the provider's model name>"
model_provider = "example"

[model_providers.example]
name = "Example"
base_url = "https://api.example.com/v1"
env_key = "EXAMPLE_API_KEY"
wire_api = "responses"
```

- **The endpoint must speak the Responses API.** It is the only wire format current Codex accepts.
- **Keep the key in the environment variable named by `env_key`.** Some provider guides put it in the file as `experimental_bearer_token`; do not.
- **Set `model_context_window`** to the model's real window when Codex does not know the model.

| Provider | `base_url` | Guide |
|---|---|---|
| xAI | `https://api.x.ai/v1` | https://docs.x.ai/developers/rest-api-reference/inference/responses |
| DeepSeek | `https://api.deepseek.com/` | https://api-docs.deepseek.com/quick_start/agent_integrations/codex |
| Alibaba (Qwen) | `https://<WorkspaceId>.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` | https://www.alibabacloud.com/help/en/model-studio/codex |
| Z.ai (GLM) | `https://api.z.ai/api/v1` | https://docs.z.ai/devpack/tool/codex |
| MiniMax | `https://api.minimax.io/v1` | https://platform.minimax.io/docs/m-plan/codex.md |
| OpenRouter | `https://openrouter.ai/api/v1` | https://openrouter.ai/docs/guides/guides/coding-agents/codex-cli |

**Google Gemini.** Google's OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/`) speaks Chat Completions only, so Codex cannot use it directly. It needs a proxy in between that translates the Responses API, such as LiteLLM. Name the proxy in `--serving`.

**An open-weight model on your own hardware.** Serve it with a runtime that has a Responses endpoint, then point Codex at it:

| Runtime | How | Guide |
|---|---|---|
| Ollama | `codex --oss --local-provider ollama -m <model>`, or `base_url = "http://localhost:11434/v1/"` | https://docs.ollama.com/integrations/codex |
| LM Studio | `codex --oss --local-provider lmstudio -m <model>` | https://lmstudio.ai/docs/integrations/codex |
| vLLM | `base_url = "http://localhost:8000/v1"`; serve with `--enable-auto-tool-choice` and the model's tool-call parser | https://docs.vllm.ai/en/latest/serving/integrations/codex/ |
| llama.cpp server | Its `/v1/responses` endpoint; tools need `--jinja` | https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md |

- **Raise the context length.** Ollama's default is 4,000 tokens under 24 GiB of video memory and 32,000 up to 48 GiB, which is too small for these tasks. Set `OLLAMA_CONTEXT_LENGTH` to 64,000 or more and check with `ollama ps`.
- **Say what you ran.** A quantised copy is a different model from the full weights. Put the runtime and quantisation in `--serving`, for example `ollama-q4_k_m` or `vllm-fp16`, so its rows stand apart on the board.
- **The model must call tools.** The tasks cannot be done without them.

| Model id in the price list | Weights | Size |
|---|---|---|
| `qwen3.8-27b` | `Qwen/Qwen3.8-27B` (Apache-2.0) | 27 billion parameters; about 18 GB quantised in Ollama. The one here that fits a single consumer GPU |
| `glm-5.3-flash` | `zai-org/GLM-5.3-Flash` (MIT) | 320 billion parameters, 18 billion active |
| `minimax-m3.1-flash` | `MiniMaxAI/MiniMax-M3.1-Flash` (its own licence) | About 428 billion parameters, 23 billion active |
| `glm-5.3` | `zai-org/GLM-5.3` (its own licence) | 753 billion parameters; a multi-GPU server |
| `deepseek-v4.1-flash-1017` | `deepseek-ai/DeepSeek-V4.1-Flash-1017` (MIT) | 763 billion parameters; a multi-GPU server |
| `mistral-large-4` | `mistralai/Mistral-Large-4-1T-A52B` (Mistral's open-weight licence) | About a trillion parameters, 52 billion active; eight GPUs in the publisher's examples |
| `deepseek-v4-pro-0813` | `deepseek-ai/DeepSeek-V4-Pro-0813` (MIT) | 1.7 trillion parameters; a GPU cluster |

Read a model's licence before you serve it to others.
