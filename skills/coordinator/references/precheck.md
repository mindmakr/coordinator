# Pre-checks

`run.mjs precheck <run> <unit> --base <base> --head <sha>` checks a unit's diff for classes of findings critics kept making, before any critic sees it, and records the result on the unit for that head. `built <run> <unit> --head <sha>` refuses a head whose precheck has a hit (with `--base` it runs the precheck itself); `--skip-precheck --reason "…"` keeps the hits and logs the reason as a decision. Builders run it before they report (their brief says so).

| Rule | A hit |
|---|---|
| `changelog` | the diff edits a changelog file (`CHANGELOG.md` by default): units never do; `built --changelog "<line>"` stores the line and `run.mjs changelog <run>` prints them for the release PR |
| `invisible` | an added line holds a zero-width, invisible or text-direction character typed literally (write it as an escape) |
| `pathname` | an added line uses a URL's `.pathname` as a file path (`fileURLToPath()` is the safe form) |
| `test-list` | a new test file is not named, or matched by a glob, in the project's test list file |
| `untested` | a new module in a module folder that no test file names |

The project's facts go in `"precheck"` in `.coordinator/coordinator.json`, never in the skill: `false` turns every rule off, or an object with any of:

- `changelog`: file names (or paths) that count as the changelog, default `["CHANGELOG.md"]`
- `testList`: files that list the test files the test command runs (for example `["package.json"]`); a file in a sub-folder covers that folder only. Unset: `test-list` checks nothing
- `modules`: folders whose new modules need a test (for example `["src/lib"]`). Unset: `untested` checks nothing
- `tests`: a regular expression for a test file's path, default `\.test\.[cm]?[jt]sx?$`
- `off`: rules to skip, by name

The logic is `lib/precheck.mjs` (pure); `lib/gitdiff.mjs` reads git with argument lists only and no network.
