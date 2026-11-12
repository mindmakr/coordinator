# Context: spend it on the work

Most of what a run costs is context re-read, not work done. Every turn an agent takes re-reads everything it has seen so far, so a large context costs a little on every turn, for as long as the agent lives. These rules keep each agent's context small and short-lived. They put "measure, don't guess" (the Lucid Coding manifesto, principle 8) into practice for tokens.

## The evidence

One coordinator run, measured from its transcripts. It delivered 12 pull requests in 3,530 model turns.

| Measure | Figure |
|---|---|
| Cost share (weighted) | 12 builders 61%, 28 reviewers 16%, the lead 19%, investigators 4% |
| Tokens that were cached context re-read | 97%. Output was under 1%. |
| Builders: turns per agent | 147 on average (82 to 314) |
| Builders: context size | about 75k tokens at the start, 340k to 920k at the end. None compacted. |
| Largest single builder | 314 turns, 922k tokens: 17% of the whole run |
| Fix rounds sent back to the same builder | 26 messages, each re-reading 250k to 900k tokens: about half of all builder cost |
| A fresh agent given the findings and the diff | under half that cost per round |
| Fixed prefix resent on every turn of every agent | about 72k tokens (tool definitions, 724 skills, 83 agent types, 854 MCP tool names, MCP server instructions, project instructions and memory): about 15% of cost |
| Agents parked longer than the one-hour prompt cache | whole context rewritten at full price: about 5% |
| "Agent finished" notices that woke the lead | 107, each re-reading its own 300k to 960k context. It compacted once. |
| Tool results over 10k characters | 399, half of all tool-result volume, mostly whole-file reads |

## The rules

Each rule says what to do, why, and how a run checks it.

### 1. A builder is closed when it reports

Do not send a fix round to the builder that did the work. The fix goes to a fresh agent. Its brief is the finding list, the diff range (`git diff <base> <head>`) and the files to read, and nothing else (`briefs.md`, round 2 or later). Resume an agent only when it is small (under about 150k tokens) and it is still inside the cache lifetime (one hour).

Why: a builder at 600k tokens re-reads 600k on every turn of the fix. The 26 resumes in the run above were about half of all builder cost, and a fresh agent did the same job for under half as much.

Check: `run.mjs show` lists each unit's builds and rounds. `S/context.mjs` counts the agents. Fewer agents than builds plus rounds means one was resumed.

### 2. Every agent has a context budget

At about 250k tokens an agent stops, writes a handover note (what is done, what is left, the files that matter, the commands that work) and reports. The lead starts a fresh agent with the note as its brief. The lead has a budget too: at about 300k it compacts, or hands over to a new session at the end of a batch of issues, with the run's own state as the handover (`durability.md`, Resume).

Why: builders ended between 340k and 920k and never compacted. The lead re-read 300k to 960k on each of 107 wake-ups.

Check: the largest contexts in `S/context.mjs` (`largest`, `lead`). Over the budget with `compactions: 0` is a miss.

### 3. One critic per round, and later rounds review the delta

A round has one general critic. A second critic joins only for a risk area: money, stored amounts, security, auth, migrations (`review.md`, Specialist critic), and a visual critic runs once per unit, not once per round (`visual.md`). From round 2 each critic reviews only the delta since the last judged head (`review.md`, Delta review).

Investigators and researchers run on a cheaper model; the harness decides how you name it. The lead decides, and records it in the staffing note.

Critics stay on the strong model for now. A cheaper critic for changes that do not touch money, stored amounts or security is not enabled: `review.md` fixes the depth, and `models.mjs` refuses a judge below `strong`. If the person wants it, they decide at intake, and the routing code needs a change first (`routing.md`). Reviewers were 16% of the run, so one critic and delta reviews take most of the saving without that risk.

Check: each round's critic setup (`verdict --critic`, `--specialist`) in `run.mjs show`. More than one general critic on a round is a miss.

### 4. Briefs are short; agents read ranges

A brief points to files. It does not paste what the repo already holds: not the playbook, not a design doc, not a diff the agent can run. Agents read file ranges (`sed -n 40,80p`, a search with context lines), not whole files over about 10k characters. They pipe long command output through a filter (`| tail -40`, `| grep -n FAIL`) and never read a saved log a second time. They attach evidence with `run.mjs evidence --file`, so the log is not re-read to quote it.

Why: 399 tool results over 10k characters were half of all tool-result volume, and each one rode along on every later turn.

Check: `bigToolResults` in `S/context.mjs`. A run with a handful is healthy; hundreds means whole-file reads.

### 5. Do not park a large agent, and wake once for several

Do not leave an agent over about 150k tokens waiting longer than the cache lifetime (one hour): finish it, or close it with a handover note. When agents finish, the lead does not act on each notice in turn. It waits until the notices that are due have arrived, reads them together and acts once (`commands/run.md`, `wait`).

Why: an agent that wakes after an hour pays to write its whole context again, about 5% of the run, and 107 wake-ups each re-read the lead's whole context.

Check: `cacheRewrites` and the lead's `wakeNotices` in `S/context.mjs`.

### 6. The lead runs machine-time checks itself

Test suites, type checks and lint cost machine time, not tokens, until an agent reads their output. The lead runs them as shell commands on the head and quotes the pass or fail lines in the critic's brief (`briefs.md`, `--quote`); the critic then cites that run instead of running the full suite again (`guardrails.md`, Test runs). Screen checks are done once per unit, after the code critic passes, not every round.

Why: each agent that runs and reads a suite carries the output for the rest of its life.

Check: `verdict --full-suite yes` is recorded once per head.

### 7. Trim the fixed prefix before a long run

Every agent starts with a fixed prefix, resent on every turn. In the run above it was about 72k tokens, about 15% of cost. Before a long run, per project, turn off the plugins, skills and MCP servers the project does not use, and shorten project instructions and memory to what a builder needs. `doctor.mjs` does not yet check this; do it in the harness's own settings.

Check: `subAgents.firstContextMedian` in `S/context.mjs` is roughly the prefix plus the brief. Write it in the retro; a figure that grows run on run is a plugin or a memory file that grew.

### 8. Measure, and write the numbers in the retro

After a run, run `node S/context.mjs <the session's transcript folder>` and put the output's figures in the retro note: tokens by kind, cost share by agent type, the largest contexts, cache rewrites, wake-ups, big tool results (`learning.md`). The next run sets its budgets from them. A lesson that a rule here saved or missed is added the usual way.

The script reads Claude Code transcripts (`~/.claude/projects/<project>/<session>.jsonl` and the `<session>/subagents/` folder). It prints counts only, never transcript text, and it calls no network. Cost shares use relative weights (input 1, cache write 1.25, cache read 0.1, output 5), so they rank agents; they are not a bill. A sub-agent's type comes from its `.meta.json`; builders and critics that share one agent type show as one group, so name them apart in the run's own `show`.

## Why these numbers

The thresholds (250k, 300k, 150k, one hour) come from one run. Change them when the retro numbers say so, and say which run in the commit.
