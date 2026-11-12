# Coordinator Engineering Benchmark (CEB): design

Status: approved by the owner on 2026-11-12, with every recommendation in section 7 accepted. Written on 2026-11-07 as a proposal. No product code changes with this document.

Notes since it was written:

- "1.0.1" in this document means the first phase (the MVP). No version number is fixed; it is picked when the work ships.
- The repos are named after the product: `mindmakr/coordinator-bench` (public tasks), `mindmakr/coordinator-bench-graders` (private hidden tests and reference solutions) and `mindmakr/coordinator-bench-ledger` (the public ledger, called `mindmakr/ceb-ledger` below).
- Section 2.3 says the event log records no tokens or cost. It does now (`skills/coordinator/scripts/lib/cost.mjs`), so that part of the MVP is mostly done.
- The work is planned as two epics: part 1 (suite, bench command, grading, tickets) and part 2 (signatures, ledger, leaderboard, anomaly flags).

CEB compares models doing real engineering work inside the Coordinator loop. Community members run it on their own machines with their own API keys, and a public leaderboard shows who leads on accuracy, quality, cost and speed. Results have to be trustworthy even though we never see the runner's machine.

---

## 1. Goal and non-goals

**Goal.** Answer "which model, in which harness, does engineering work best right now, and at what cost and speed?" with numbers people can check.

| # | Goal | Measured by |
|---|---|---|
| G1 | Accuracy | Share of tasks a hidden grader passes, with a 95% confidence interval |
| G2 | Quality beyond pass/fail | A quality index from deterministic checks on the final diff (section 2.3) |
| G3 | Cost | Cost per task and per solved task, from token counts at a pinned price list |
| G4 | Speed | Median wall time per task, and model time apart from tool time |
| G5 | Who leads now | A leaderboard per suite version, updated as results arrive, with unconfirmed results marked |
| G6 | Community-run | Anyone with Coordinator, a harness and an API key can contribute in one command |
| G7 | Trustworthy | Every result is signed, logged in a public append-only ledger, graded by us, and counts only once others reproduce it |

**Non-goals for 1.0.1**

- Proving which model produced an output. With hosted models this cannot be proven today (section 4.1); we make faking expensive and detectable instead.
- Running the community's builds on our servers. Builders and critics run on the runner's machine, as in every Coordinator run.
- Benchmarking on anyone's own code. Tasks are public fixtures; nothing from a private repo is ever uploaded.
- A token, a coin or payment to runners.
- Any GitHub Actions workflow. Grading runs on the service's own worker.

---

## 2. What CEB measures and how it scores

### 2.1 Why not reuse an existing benchmark

The existing benchmarks each teach something, and none measures what Coordinator is built for.

| Benchmark | What it measures | Lesson for CEB |
|---|---|---|
| SWE-bench Verified | Real GitHub issues, graded by fail-to-pass and pass-to-pass tests | Retired by OpenAI in 2026: an audit of 27.6% of the tasks found 59.4% of those had flawed tests, and every frontier model tested had seen some problems and solutions (Epoch's review). Public, static tasks go stale. |
| SWE-bench Pro | The same shape on copyleft and private codebases; a held-out set kept unpublished | Scores fell on the private set (one model from 23.1% to 14.9%). A private or held-out set is the most direct contamination check. |
| SWE-bench-Live | Issues created since 2024, a Docker image per task, continuous curation | Fresh tasks beat static ones; one image per task makes runs reproducible. |
| SWE-bench submissions | Predictions, per-task logs and a reasoning trace for every task; maintainers re-run a random subset for a "verified" mark | Require the trajectory; spot-check by re-running. |
| Aider polyglot | 225 Exercism exercises in six languages, two attempts, cost and edit-format columns | Report cost next to accuracy, per run. |
| Terminal-Bench | Agent and model pairs in containers; resolution rate, cost and tokens, 95% confidence intervals | Rank agent and model together, show intervals. |
| LiveCodeBench | Contest problems tagged by release date, scored only on problems after a model's cutoff | Date every task; compare scores before and after a model's cutoff. |
| HumanEval / MBPP | Single functions with few tests; EvalPlus adds 80x and 35x more tests and scores drop | Weak tests inflate scores: grade with many hidden tests. |
| MLE-bench | 75 Kaggle competitions, medals, at least 3 seeds with standard error, rule-violation and plagiarism detectors | Several seeds per task; check for copying. |
| METR time horizons | Task length (human time) at which a model succeeds 50% of the time; hierarchical bootstrap over task families, tasks and attempts | Bootstrap over tasks and trials, not single runs. |
| Chatbot Arena | Crowd pairwise votes, Bradley-Terry ratings, bootstrap intervals | Crowd scale works, but "The Leaderboard Illusion" shows private variant testing and selective disclosure bias the board. Every attempt must count, not only the ones a submitter chooses to show. |
| Artificial Analysis | Output speed, time to first token and a blended price, measured on the provider's own API | Speed depends on where and when you measure; say how. |

**What only CEB can measure.** Coordinator already runs a builder, a blind critic and a written bar, round by round, with every model, verdict and timestamp in `events.jsonl`. So CEB can report what the benchmarks above cannot: rounds needed to pass, how often the critic passed work the hidden grader then failed (the critic's escape rate), and whether the builder gamed the bar (`detect.mjs`).

### 2.2 The task suite

A suite is versioned (`CEB-2026.12`), signed, and lists each task with its container image pinned by digest. Each task is small but real: a fixture repo with a history, an issue written the way a person would write it, and a bar of **closed behaviours** (issue #35: "catch every X" cannot be checked; "these six templates" can).

| Category | Example | Hidden grader checks |
|---|---|---|
| Bug fix | Wrong totals when a refund crosses a month | The repro test, plus the suite's own pass-to-pass tests |
| Feature with tests | Add pagination to an API with a page-size cap | Behaviour tests the builder never saw; its own new tests must fail on the original code |
| Refactor | Split a 900-line module without changing behaviour | Full suite, public API snapshot, the duplication and length signals from `quality.mjs` |
| Security fix | An IDOR on an invoice route | An exploit test that must now fail, and the security signals |
| UI with a visual check | A settings form in English and Arabic (RTL), at phone and desktop width | Playwright behaviour tests and a screenshot diff against a reference within a threshold |
| Multi-repo (phase 2) | A field added to an API and to the web client that reads it | Contract tests across both repos |

Each task records the human time it should take (as METR does), its creation date, and a canary GUID in every file so the task can be filtered out of training data and probed for memorisation (as BIG-bench does; a model that ranks the canary as unusually likely has seen it).

**Size of the MVP suite:** 12 public tasks (2 in each of the first five categories, plus 2 spare) and a server-side hidden grader for each. Hidden whole tasks come in phase 2.

### 2.3 Per-trial measurements

A **trial** is one task run once through the Coordinator loop by one configuration: model id (dated, never an alias like "latest"), harness and its version, effort setting, Coordinator version.

| Measure | Source | Trust |
|---|---|---|
| Solved | Hidden grader, run by us on the submitted diff | High: the runner cannot see or change it |
| Behaviours passed | Hidden grader, share of closed behaviours | High |
| Rounds to pass | `events.jsonl`: critic verdicts until the loop's pass | Medium: the loop's own critic |
| Critic escape | Loop said pass, hidden grader said fail | High (both sides recorded) |
| Gaming | `detect.mjs` on the final diff: skipped or deleted tests, removed assertions, rewritten snapshots | High: we run it |
| Quality index | `quality.mjs` on the diff against the reference solution: duplication, function length, nesting, security and privacy signals, diff size | High: we run it |
| Tokens | Harness output: `claude -p --output-format json` reports usage and `total_cost_usd`; `codex exec --json` reports `input_tokens`, `cached_input_tokens`, `output_tokens` per turn | Self-reported; cross-checked against the transcript |
| Cost | Tokens times the suite's pinned price list, so two runners with different discounts compare fairly. The runner's own reported cost is shown beside it | Derived |
| Wall time | Ticket issue to bundle signing, and `duration_api_ms` (model time) apart from tool time | Low: depends on the machine and provider load |

**Quality is not one LLM's opinion.** In 1.0.1 every quality signal is deterministic and computed by us. A gamed diff scores zero for the trial whatever the grader says. A blind review score from a pinned reviewer model is a phase 2 option (open question Q2), shown as its own column, never folded into accuracy.

The Coordinator event log does not record tokens or cost today (`lib/eventschema.mjs` has no such fields). 1.0.1 adds them as optional payload fields on `built` and `verdict`, read from the harness's JSON output.

### 2.4 The leaderboard

One board per suite version. A row is a configuration (model, harness, effort).

| Column | How |
|---|---|
| Rank | By solve rate. Rows whose 95% intervals overlap share a rank band, so a one-point lead inside the noise is not shown as a lead |
| Solve rate | Hierarchical bootstrap over tasks, then trials (METR's method), 95% interval |
| Quality index | 0–100, median over solved trials |
| Cost | Median per task and per solved task |
| Speed | Median wall time; model time on hover |
| Rounds to pass | Median |
| Critic escape rate | Share of loop passes the grader failed |
| Evidence | Trials, distinct runners, status |

**Status.** A row is **unconfirmed** as soon as its first result lands, so the board fills fast, as the owner asked. It becomes **confirmed** when every task has at least 3 trials from at least 2 independent runners whose solve rates agree within their intervals. From phase 2 the top three also need a spot-check by a reference runner (section 3).

**Time.** No decay within a suite. A new suite version ships every quarter with fresh tasks written after the latest model cutoffs; the previous board is archived, not blended. A model id that the provider retires keeps its archived rows.

**Views.** Accuracy (default), value (solved tasks per dollar), and a cost-against-accuracy chart showing the Pareto front. Per harness: the same model in Claude Code and in Codex is two rows, and a filter compares them.

---

## 3. How a community member runs it

```
/coordinator:bench                       (or: node <skill>/scripts/run.mjs bench)
```

1. **Intake, asked once:** which configuration (model, harness, effort), a spending cap (passed to Claude Code as `--max-budget-usd`; for Codex, which reports tokens but no cost, the bench starts no new round once the running cost at pinned prices reaches the cap), practice or ranked, and consent to publish under their GitHub handle. The bench prints an estimate from the pinned price list before anything is spent.
2. **Fetch:** the signed suite manifest. Each task's image is pulled by digest (`ghcr.io/mindmakr/ceb-<task>@sha256:…`), so every runner starts from the same bytes.
3. **Ticket:** for each trial the bench asks the service for a ticket: a nonce, the task (chosen by the service, not the runner), and a deadline. The ticket is logged before work starts. **Every ticket must come back as a result; a ticket that does not counts as a failed trial.** This is pre-registration: it stops a runner running ten times and submitting the best, which is the selective-disclosure problem that biased Chatbot Arena.
4. **Run:** a normal Coordinator run inside the task container, with the model under test in every role (open question Q1). The runner's API keys stay in their environment and are never written to the bundle.
5. **Bundle:** the final diff, `events.jsonl`, the harness's usage output, the full transcript (as SWE-bench requires reasoning traces), provider request ids, the ticket, and hashes of the Coordinator release, the harness binary and the image. Masked with `lib/secrets.mjs`, and local paths and user names stripped.
6. **Sign and submit:** signed, uploaded, graded by us, logged. The runner gets a link to the trial's page.

A practice run uses the same tasks without a ticket and never reaches the board.

---

## 4. Trust design

### 4.1 What can and cannot be proven

The runner controls the machine. With a hosted model, nothing the runner sends us proves that model X produced the diff: they could paste in a diff from another model or write it by hand, and fabricate a transcript and token counts to match. Provider response ids (Anthropic's `request-id`, for example) are for support and cannot be checked by a third party. The provider's usage reports are aggregated by minute, hour or day, need an admin key, and are not signed.

Two technologies can prove more, and neither fits 1.0.1:

- **TLS proofs (TLSNotary).** A notary joins the TLS session through multi-party computation and signs what the server sent. It would prove "api.anthropic.com returned this". Today it supports TLS 1.2 only, needs a notary we trust, and an agent session is hundreds of long streaming calls. Worth an experiment, not a dependency.
- **GPU TEEs.** H100 confidential computing inside an Intel TDX or AMD SEV-SNP VM gives an attestation report, and one provider signs each request and response with an enclave key. This proves the model in the enclave produced the output, but only for open-weight models served that way. It says nothing about closed models on their makers' APIs.

So CEB does not claim proof of the model. It proves the rest, and makes a fake one costly and visible.

### 4.2 Mechanisms

| Mechanism | What it does |
|---|---|
| **Server-side grading** | The hidden tests, `detect.mjs` and `quality.mjs` run in our sandbox (no network, pinned image) on the submitted diff. The runner never sees the grader, so the accuracy number is ours, not theirs. |
| **Tickets (pre-registration)** | Task assignment and every attempt are logged before work starts. Unreturned tickets count as fails. |
| **Signed bundles** | The runner signs with Sigstore keyless signing: a short-lived certificate bound to their GitHub identity through OIDC, the signature recorded in Sigstore's public Rekor log. Anyone can check who submitted what, and when, without trusting us. Where `cosign` is missing, the service records the GitHub login and signs the ledger entry itself (weaker; open question Q4). |
| **Public ledger** | An append-only log of tickets, bundle hashes, grades and status changes, as a Merkle tree in the style of Certificate Transparency (RFC 9162): signed checkpoints, inclusion proofs for each entry, consistency proofs between checkpoints. Stored as a public git repo, `mindmakr/ceb-ledger`, so anyone can mirror it; each checkpoint is also signed into Rekor, which gives an outside, timestamped copy we do not control. |
| **Replication** | A configuration is confirmed only when independent runners agree (section 2.4). One runner's fake score stays "unconfirmed" until someone else matches it. |
| **Reference runners (phase 2)** | Maintainers and sponsors re-run a random sample of tasks for any configuration entering the top three, as SWE-bench maintainers re-run a random subset before the verified mark. |
| **Anomaly checks** | A trial is flagged when its transcript does not fit its numbers: token counts against transcript length, wall time against model time, a diff that appears without the edits that made it, a solve rate far above other runners of the same configuration, or style and length profiles unlike the model's other trials. Flags hold a result back for review; they never silently delete it. |
| **Contamination defences** | Fresh tasks each quarter, dated after model cutoffs; canary GUIDs; a hidden pool (phase 2) handed out per ticket and retired after a set number of exposures; the gap between public and hidden scores published per model, as SWE-bench Pro does with its private set. |
| **Reputation (phase 2)** | A runner's weight in confirmation grows with account age and with how often their past results matched others. A runner flagged twice needs a reference runner to confirm their results. No stake and no money. |

### 4.3 Threats, honestly

| Threat | Stopped | Not stopped |
|---|---|---|
| Diff from another model or a person, claimed as model X | Caught when replication disagrees, when anomaly checks fire, or by a reference runner's re-run | A careful faker whose score sits close to the honest score. They gain nothing on the board, because replication sets the number |
| Run many times, submit the best | Tickets: every attempt counts | Nothing left, except running without tickets, which never reaches the board |
| Tampered grading | Grading is ours | – |
| Gaming the bar (skipped tests, rewritten snapshots) | `detect.mjs` server-side; the trial scores zero | A new trick the detector misses until we add it |
| Model trained on the tasks | Fresh quarterly tasks, canaries, hidden pool, public versus hidden gap | Contamination we cannot see: a lab may train on a leaked task without the canary |
| Hidden task leaked by a runner | Per-ticket hand-out, exposure counts, retirement | The leak itself; it only shortens the task's life |
| Fake accounts confirming each other (Sybil) | GitHub identity, account age, reputation, reference runners for the top | A patient attacker with many aged accounts, for rows below the top three |
| Inflated or deflated cost | Cost from tokens at pinned prices; tokens cross-checked against the transcript | Token counts are still self-reported |
| Faster or slower runs | Medians, model time separated from tool time | Speed is the weakest number; the board says so |
| We rewrite the ledger | Mirrors, consistency proofs, checkpoints in Rekor | Showing different views to different readers is caught only if someone compares; witnesses make that routine |
| Modified Coordinator or harness | Release and binary hashes in the bundle; replication | A runner who edits locally and forges the hashes: only replication catches it |

### 4.4 Blockchain or transparency log

**Recommendation: a public Merkle transparency log plus Sigstore signatures, not a blockchain.**

- The usual test (Wüst and Gervais, "Do you need a blockchain?") asks whether there is a trusted third party who can order writes. Here there is: the project. A blockchain earns its cost only when many writers who do not trust each other have no such party.
- What a blockchain would add (an order nobody can rewrite) the log already gives: anyone can check inclusion and consistency, mirrors keep copies, and Rekor holds our checkpoints outside our control. As DSHR puts it, cryptography makes a record tamper-evident; copies make it tamper-resistant.
- A blockchain does not solve the hard problem. "Did model X really produce this diff?" is a question about the outside world, the oracle problem, and no chain answers it.
- Tokens and rewards invite the gaming we are trying to stop. On Bittensor, where validators earn for scoring work, validators copy each other's published scores instead of evaluating, because agreeing with the group pays; the fix there was hiding scores for a period (commit-reveal). CEB pays no one, and tickets play the commit-reveal role.
- Cost: no gas fees, no wallet for contributors, no new dependency in a zero-dependency skill.

If the owner wants an outside timestamp later, anchoring a checkpoint hash in a public chain once a day is cheap and changes nothing else.

---

## 5. Where results live and show

- **Ledger:** the public `mindmakr/ceb-ledger` repo (the repo-as-database idea from the 1.0 design), with signed checkpoints.
- **Grading and intake:** a new worker in the hosted service, in its own container with no network for the graded code. It never calls a model. Grading is a container run of a few minutes per trial; it costs server time, not Actions minutes.
- **Leaderboard:** a page in the hosted service, drawn from the ledger; each row links to its trials, each trial to its diff, transcript, grade, signature and inclusion proof. A static export can be published from the ledger by anyone, so the board does not depend on our service staying up.
- **Privacy:** tasks are public fixtures; CEB never reads the runner's own repos. A bundle holds the fixture diff, the run log, the transcript and usage, masked; no API keys, no environment, no local paths. A runner may stay pseudonymous under their GitHub handle and may withdraw future publication; logged entries stay, because the log is append-only, but the board can hide a withdrawn runner's name.

---

## 6. Phased plan

| Phase | Scope |
|---|---|
| **1.0.1 MVP** | Suite `CEB-2026.12`: 12 public tasks in five categories, images pinned by digest, canaries. Server-side hidden graders, `detect.mjs` and `quality.mjs`. `/coordinator:bench` and `run.mjs bench` for Claude Code and Codex, with spending cap and estimate. Tokens and cost added to the event log. Tickets. Signed bundles (Sigstore when `cosign` is present; otherwise service-signed). The Merkle ledger in a public repo with signed checkpoints in Rekor. Leaderboard with unconfirmed and confirmed rows, intervals, rank bands, the cost and speed columns, and the critic escape rate. Basic anomaly flags. |
| **1.1** | Hidden rotating task pool with exposure limits. Multi-repo tasks. Reference runners and spot-checks for the top three. Reputation. Outside witnesses that co-sign checkpoints. Optional blind review score from a pinned reviewer model. Public-versus-hidden gap per model. |
| **1.2** | Community-contributed tasks, reviewed and signed into a suite. A TEE track for open-weight models served from attested GPUs. A TLSNotary experiment for one provider. Other harnesses through adapters. |

---

## 7. Open questions for the owner

**Q1. Which model plays the critic?**
(a) The model under test plays every role, so the row measures that model in Coordinator, and its critic escape rate becomes a metric of its own. (b) A fixed reference critic for everyone, so rounds-to-pass compare fairly, but every runner needs access to that model. (c) Both, as two boards.
*Recommendation: (a) for 1.0.1; the hidden grader is the objective score either way. (b) as a second board in 1.1 if people ask.*

**Q2. One blended score, or accuracy first?**
(a) Rank by solve rate, with quality, cost and speed as columns and a value view. (b) A weighted CEB score.
*Recommendation: (a). Any weights are a choice people will argue with; a blend also hides a cheap model that is nearly as good. Revisit after a quarter of data.*

**Q3. Where does grading run?**
(a) On our worker, with the grader never shown to runners. (b) On the runner's machine after they commit to the diff's hash, with the grader then revealed.
*Recommendation: (a). It is the one number we can stand behind; (b) leaks every grader after one use.*

**Q4. Is a Sigstore signature required for a result to count?**
(a) Required. (b) Optional; service-signed results count the same. (c) Optional, but only Sigstore-signed results count towards "confirmed".
*Recommendation: (c). `doctor` checks for `cosign`; the skill stays dependency-free.*

**Q5. Blockchain?**
(a) No; transparency log plus Rekor. (b) The log, plus a daily checkpoint anchored in a public chain. (c) A chain as the store.
*Recommendation: (a), with (b) kept as a cheap later option (section 4.4).*

**Q6. Who pays for runs?**
(a) Runners use their own keys. (b) Sponsors fund reference runners and the hidden pool through the existing sponsor or partner form.
*Recommendation: both. The board names sponsor-funded runs.*

**Q7. Do providers get early or private access?**
*Recommendation: no. The Leaderboard Illusion shows private testing and withdrawn scores bias a board. Every ticket is public from the moment it is issued.*

---

## Sources

Every page below was opened while writing this design.

- SWE-bench leaderboard: https://www.swebench.com/
- SWE-bench submission rules: https://github.com/SWE-bench/experiments
- SWE-bench Pro leaderboard and subsets: https://labs.scale.com/leaderboard/swe_bench_pro_public
- Epoch AI, review of SWE-bench Verified (reports OpenAI's audit): https://epoch.ai/benchmarks/swe-bench-verified/review
- SWE-bench Goes Live!: https://arxiv.org/abs/2505.23419
- Aider leaderboards: https://aider.chat/docs/leaderboards/
- Terminal-Bench: https://www.tbench.ai/ and https://www.tbench.ai/leaderboard/terminal-bench/2.0
- Harbor framework: https://docs.harborframework.com/
- LiveCodeBench: https://livecodebench.github.io/
- EvalPlus (HumanEval+ and MBPP+): https://github.com/evalplus/evalplus
- MLE-bench: https://github.com/openai/mle-bench
- METR, measuring AI ability to complete long tasks: https://metr.org/blog/2025-03-19-measuring-ai-ability-to-complete-long-tasks/
- LMSYS, Chatbot Arena leaderboard update (Elo to Bradley-Terry): https://lmsys.org/blog/2023-12-07-leaderboard/
- The Leaderboard Illusion: https://arxiv.org/abs/2504.20879
- Artificial Analysis methodology: https://artificialanalysis.ai/methodology
- Sigstore overview: https://docs.sigstore.dev/about/overview/
- Rekor overview: https://docs.sigstore.dev/logging/overview/
- RFC 9162, Certificate Transparency 2.0: https://www.rfc-editor.org/rfc/rfc9162.html
- transparency.dev: https://transparency.dev/
- TLSNotary: https://tlsnotary.org/docs/intro
- Phala, GPU TEEs on OpenRouter: https://phala.com/posts/GPU-TEEs-is-Alive-on-OpenRouter
- BIG-bench canary: https://github.com/google/BIG-bench/blob/main/bigbench/benchmark_tasks/training_on_test_set/README.md
- Wüst and Gervais, Do you need a Blockchain?: https://eprint.iacr.org/2017/375
- DSHR on the same paper: https://blog.dshr.org/2018/02/do-you-need-blockchain.html
- Taostats, weight copying in Bittensor: https://docs2.taostats.io/concepts/weight-copying/
- Claude Code headless mode (JSON output, cost fields, `--max-budget-usd`): https://code.claude.com/docs/en/headless
- Codex non-interactive mode (`codex exec --json` usage fields): https://learn.chatgpt.com/docs/non-interactive-mode
- Claude API errors and request ids: https://platform.claude.com/docs/en/api/errors
- Claude Usage and Cost API: https://platform.claude.com/docs/en/api/usage-cost-api
