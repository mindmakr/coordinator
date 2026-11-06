# Improving the coordinator itself

Every run is also a test of this skill. When a run shows the skill could be better, the coordinator sends that improvement upstream, so everyone who uses it benefits.

Upstream: https://github.com/mindmakr/coordinator

## What counts

- A rule that was missing, wrong or unclear, and cost a round, a stop or a wrong turn.
- A script bug, or a guard that didn't fire, or fired when it shouldn't have.
- A lesson seen 3 or more times that is general, not specific to one project.
- A new playbook (command or domain) that worked well and would help others.

Project facts never go upstream: they belong in that project's `COORDINATOR.md`.

## How

1. **In the retro, note it:** `run.mjs note <run> --kind follow-up --text "upstream: <one line>"`.
2. **Strip everything private:** project names, paths, people, data, secrets. Describe the general case and the evidence (for example "the stuck stop never fired at default budgets": the steps and the numbers).
3. **Check whether it's already known:** `gh issue list -R mindmakr/coordinator --search "<key words>" --state all`. If it is, add your evidence as a comment.
4. **Open an issue**, or a PR if the fix is small and you have tests: follow `CONTRIBUTING.md` in the upstream repo.
5. **Ask first.** Posting to a public repository counts as sending a message, so it needs the person's approval. Ask at intake once: "May this run open issues or PRs on the coordinator repo for skill improvements it finds?" Record the answer. With a yes, post at the end of the run and include the links in the report. With a no, put the drafted issue text in the report, so the person can post it.

## Applying a lesson locally right away

If the person keeps a local clone of the skill, the same change can be proposed there first, as a branch for them to review. The skill never edits its own installed files during a run.
