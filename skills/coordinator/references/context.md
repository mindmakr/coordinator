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

Check: `resumedAgents` in `S/context.mjs` counts the agents that were given a second brief. It should be 0, or each one small and inside the cache lifetime.

### 2. Every agent has a context budget, and the lead keeps its own

At about 250k tokens an agent stops, writes a handover note (what is done, what is left, the files that matter, the commands that work) and reports. The lead starts a fresh agent with the note as its brief. The lead has a budget too: at about 300k it compacts, or hands over to a new session at the end of a batch of issues, with the run's own state as the handover (`durability.md`, Resume).

The lead lives longest, so each token in its context is paid for more often than any other. Keeping it lean is the lead's own job, for the whole run:

- **The run state is its memory.** Decisions, the situation and follow-ups go into the run with `run.mjs note`, and come back with `run.mjs show` and `next`. Nothing has to stay in the chat to be remembered, so a compaction or a new session loses nothing.
- **It reads conclusions, not material.** Agents report in 10 lines or fewer. The lead does not read a whole diff, a whole log or an agent's transcript: it runs the check and keeps the pass or fail lines (rule 6), or sends an agent to read and report.
- **It delegates looking.** A question that means reading several files goes to an investigator, which returns the answer with file and line, not the files.
- **It acts once on a batch of notices** (rule 5).

Why: builders ended between 340k and 920k and never compacted. The lead re-read 300k to 960k on each of 107 wake-ups.

Check: the largest contexts in `S/context.mjs` (`largest`, `lead`). Over the budget with `compactions: 0` is a miss.

### 3. One critic per round, and later rounds review the delta

A round has one general critic. A second critic joins only for a risk area: money, stored amounts, security, auth, migrations (`review.md`, Specialist critic), and a visual critic runs once per unit, not once per round (`visual.md`). From round 2 each critic reviews only the delta since the last judged head (`review.md`, Delta review).

Investigators and researchers run on a cheaper model; the harness decides how you name it. The lead decides, and records it in the staffing note.

The general critic runs on the cheaper model only for a unit outside every pinned area (`routing.md`, The cheaper critic). Money, stored amounts, security and the other pinned areas keep the strong model, and so does every specialist. Reviewers were 16% of the run measured here; one critic per round and delta reviews still take most of that saving.

Check: each round's critic setup (`verdict --critic`, `--specialist`) in `run.mjs show`. More than one general critic on a round is a miss.

### 4. Briefs are short and complete; agents read ranges

A brief points to files. It does not paste what the repo already holds: not the playbook, not a design doc, not a diff the agent can run. Agents read file ranges (`sed -n 40,80p`, a search with context lines), not whole files over about 10k characters. They pipe long command output through a filter (`| tail -40`, `| grep -n FAIL`) and never read a saved log a second time. They attach evidence with `run.mjs evidence --file`, so the log is not re-read to quote it.

Short is not thin. A brief holds every fact its agent needs to start work, and nothing the agent can read for itself. An agent that must find again what the lead already knows spends its context finding it, and one that guesses costs a round. So a brief names:

- the goal, the bar, the behaviours and the fence (`run.mjs brief` fills these in);
- where to work, the base and the head, and the files and line ranges that matter;
- the commands that work here (the mapped tests, typecheck, lint) and how to see the result;
- what is already known: the cause that was found, what was ruled out, the decision that was made and why, the hot-spot files;
- on a fix round, the findings, each with its file and line.

Every fact in a brief is one the lead checked: the path exists, the head is the one named, the command runs. A wrong fact in a brief costs more than a missing one, because the agent builds on it.

The test for a brief: could the agent start from it alone, without asking and without searching for something the lead already knew? If not, add the fact. If a line would not change what the agent does, cut it.

Why: 399 tool results over 10k characters were half of all tool-result volume, and each one rode along on every later turn.

Check: `bigToolResults` in `S/context.mjs`. A run with a handful is healthy; hundreds means whole-file reads. `subAgents.firstContextMedian` less the fixed prefix (rule 7) is the size of a brief: a large one was padded. A round lost because an agent lacked a fact the lead had is a lesson for the retro (`learning.md`).

### 5. Do not park a large agent, and wake once for several

Do not leave an agent over about 150k tokens waiting longer than the cache lifetime (one hour): finish it, or close it with a handover note. When agents finish, the lead does not act on each notice in turn. It waits until the notices that are due have arrived, reads them together and acts once (`commands/run.md`, `wait`).

Why: an agent that wakes after an hour pays to write its whole context again, about 5% of the run, and 107 wake-ups each re-read the lead's whole context.

Check: `cacheRewrites` and the lead's `wakeNotices` in `S/context.mjs`.

### 6. The lead runs machine-time checks itself

Test suites, type checks and lint cost machine time, not tokens, until an agent reads their output. The lead runs them as shell commands on the head and quotes the pass or fail lines in the critic's brief (`briefs.md`, `--quote`); the critic then cites that run instead of running the full suite again (`guardrails.md`, Test runs). Screen checks are done once per unit, after the code critic passes, not every round.

Why: each agent that runs and reads a suite carries the output for the rest of its life.

Check: `verdict --full-suite yes` is recorded once per head.

### 7. Trim the fixed prefix before a long run

Every agent starts with a fixed prefix, resent on every turn. In the run above it was about 72k tokens, about 15% of cost. Before a long run, per project, turn off the plugins, skills and MCP servers the project does not use, and shorten project instructions and memory to what a builder needs.

`S/prefix.mjs report` lists what loads for the project (enabled plugins from the user, project and local settings, user skills, MCP servers) with counts and the skills' description characters. `S/prefix.mjs draft` prints a `.claude/settings.local.json` for this project only that turns off the plugins and skills not kept (coordinator, what the project's own config names and anything given with `--keep` stay), and `S/prefix.mjs write --confirm` writes it after the person approves the draft. `init` offers it (`commands/init.md`), and doctor's `prefix` line shows the counts and warns when a project loads many skills with no local trim. Plugin changes need a new Claude process; `/clear` keeps the old plugins. The token figure itself is `/context` in a session of the project.

Check: `subAgents.firstContextMedian` in `S/context.mjs` is roughly the prefix plus the brief. Write it and the `prefix.mjs report` counts in the retro (`learning.md`, step 7); a figure that grows run on run is a plugin or a memory file that grew.

### 8. Measure, and write the numbers in the retro

After a run, run `node S/context.mjs <the session's transcript folder>` and put the output's figures in the retro note: tokens by kind, cost share by agent type and by role, what each round cost, the largest contexts, cache rewrites, wake-ups, big tool results (`learning.md`). The next run sets its budgets from them. A lesson that a rule here saved or missed is added the usual way.

The script reads Claude Code transcripts (`~/.claude/projects/<project>/<session>.jsonl` and the `<session>/subagents/` folder). It prints counts only, never transcript text, and it calls no network. Cost shares use relative weights (input 1, cache write 1.25, cache read 0.1, output 5), so they rank agents; they are not a bill. A sub-agent's type comes from its `.meta.json`.

Rounds come from the marker line that starts every brief `run.mjs brief` prints: `[coordinator-brief run=<run> unit=<unit> round=<n> role=builder|critic|integrator]`. The script reads that one line from what the lead sent the agent (never from tool results) and prints the ids in it: `costShareByRole` splits builders from critics even when they share an agent type, and `rounds` has one row per run, unit, round and role. An agent launched without a printed brief (an investigator, a researcher, a hand-written brief) counts as `unmarked`.

## Why these numbers

The thresholds (250k, 300k, 150k, one hour) come from one run. Change them when the retro numbers say so, and say which run in the commit.
