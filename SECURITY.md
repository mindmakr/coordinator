# Security

Report a vulnerability privately through GitHub: on this repository's **Security** tab, choose **Report a vulnerability**. Please don't open a public issue.

These areas are in scope:
- shell or argument injection through the scripts;
- path traversal out of the `.coordinator/` state folder;
- secrets reaching stored state or lessons;
- a way to make the loop skip its gated actions;
- a way for files that come with a repo to send your tokens somewhere you did not choose.

## Where your tokens can go

Two settings decide where a token is sent: `service` (the coordinator service that `run.mjs watch --remote` gives your GitHub token to, to mint a short-lived doorbell token) and `helpers` (the model server that gets the key named in `helpers.keyEnv`). Both live in `.coordinator/coordinator.json`, which is per-machine and meant to be git-ignored.

A copy of that file that is **committed to git** was written by whoever wrote the repo, not by you. The scripts ignore its `service` and `helpers`, `helper.mjs setup` refuses to write to it, and `doctor` fails with the fix: `git rm --cached .coordinator/coordinator.json`, and add `.coordinator/` to `.gitignore`. `COORDINATOR_SERVICE` in your own environment still works.

We aim to reply within a week.
