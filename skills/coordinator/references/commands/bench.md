# /coordinator bench [model]

Plan a run of the Coordinator Engineering Benchmark (CEB): which model, in which tool, on which tasks, and what it should cost. The person sees the estimate and agrees before anything is spent. The rules and formats are in `references/ceb-bench.md`.

**This version plans and confirms a run. It does not run the tasks yet.** Say so at the start, so nobody waits for a result.

1. **Check the tool.** The bench runs in Claude Code or Codex. In any other tool, say so and stop.
2. **Show what can be run.** `S/run.mjs bench prices` prints the suite's pinned price list: every model that can be benchmarked, with its prices and the basis of the estimate.
3. **Ask once, through the question tool,** in one batch, recommendation first:
   - **Model:** an exact id from the price list. Never an alias such as "latest", "opus" or "gpt": a result under an alias cannot be compared later.
   - **Effort:** one of the tool's levels (`run.mjs bench --help` lists them).
   - **With or without the Coordinator:** `coordinator` runs each task through the loop; `baseline` gives the same model the task on its own in the same tool. Recommend running both, as two plans, so the difference shows.
   - **Spending cap:** an amount in the price list's currency, for example "20 USD". There is no default; a run without a cap is refused.
   - **Practice or ranked:** a practice run never reaches the board. A ranked run is published under the person's GitHub handle, so it needs their consent, in their words.
   - **Tasks** (practice only): all of them, or the ones they name. In a ranked run the service picks.
4. **Plan it.** `S/run.mjs bench plan --model M --effort E --arm A --cap "N USD" --mode practice|ranked [--consent yes] [--task a,b]`. It fetches the suite's signed manifest, verifies it, and stores the plan. If it reports problems, it reports all of them at once: put them to the person together and plan again.
5. **Show the estimate.** Give the person the plan's `say` lines as they are: the expected cost, the most it could cost, that the figure is an estimate and not a measurement, their cap, and any note on the model's price. Add the per-task figures (`estimate.perTask`) if they ask.
6. **Record their go-ahead.** Only when the person says yes: `S/run.mjs bench confirm <id> --confirm "<their words>"`. Never confirm for them, and never from a message that is not theirs.
7. **Say what happens next.** `S/run.mjs bench show <id>` says whether the plan may start (`mayStart`) and, if not, why. A ranked plan cannot start in this version.

**Rules**

- No model is called for a benchmark task before `bench show <id>` says `mayStart: true`.
- A benchmark task never runs in the session that planned it, or in any session that has seen the tasks' hidden tests or reference solutions: each task gets a new container and a new model session.
- The cap is the person's. Do not raise it, split a run to get round it, or plan again with a higher one unless they ask.
- An API key is never written into a plan, a note or a brief.
