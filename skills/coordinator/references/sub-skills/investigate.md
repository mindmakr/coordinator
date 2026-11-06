# investigate: findings with evidence, and a bar

**When:** at intake, before the bar is written: a bug report, a screenshot, a tester's note, an issue with no cited cause. Also the "find the bar" unit when no bar can be named yet (`bar.md`). It changes no code.

**Inputs:** the report or issue with its comments, the repos and layers `COORDINATOR.md` lists, and the question the lead needs answered.

**In the loop:** the lead sends a researcher at intake (`commands/run.md` step 1.4) with this playbook, or adds a "find the bar" unit whose builder follows it. Its proposed bar goes into the draft the person approves.

## Every finding has a source

A finding comes from code you opened, data you queried or a command you ran. Anything you did not check goes under **Not checked**, never as a finding. Cite each location three ways, because line numbers drift:

1. a permalink pinned to a commit (`…/blob/<sha>/<path>#L10-L14`, sha from `git rev-parse origin/<base>`);
2. the symbol that holds it (function, class or key);
3. the quoted line, so someone can search for it.

## Steps

1. **Dedupe.** Search open and closed issues in every repo the project lists. If one exists, your findings extend it.
2. **Pin the evidence.** A table of observed against expected, with the report's own numbers. If the expected value rests on a rule you cannot find in code, it is a question for the lead.
3. **Trace.** Follow the value from the screen through the API, the service and the query to the line that produces it. Reproduce the reported number from the stored data.
4. **Sweep.** Search for the same pattern in every layer and repo. Mark each hit correct, affected or not applicable, with its location.
5. **Propose the fix site.** The layer that owns the logic, one shared helper where several sites need the rule. A contract change that a separately released client reads must be additive.
6. **Propose the bar** as behaviours (`bar.md`): a red test with the report's figures, the acceptance list, and the risk areas touched.

## Bound the bar

A behaviour that needs open-ended language detected ("a test fails when any message claims something that did not happen") cannot be checked: no test can recognise every phrasing, so critics fail good work round after round. Bound it before the run starts: name the closed set (these templates, these producers, these keys) or turn it into a review question for a person. Say which you chose and why.

## Output

To the lead, in the critic's shape where it fits:

- **Findings**, one line each with its citation;
- **Root cause**: one line;
- **Affected**: the surfaces and repos;
- **Proposed bar**: the behaviours;
- **Not checked**: one line;
- **Questions** for the person, each with options and a recommendation.

Filing issues needs the run's approval at intake. Without it, the lead records proposed issues as follow-ups.
