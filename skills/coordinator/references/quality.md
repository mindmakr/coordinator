# The run's report: release notes and quality signals

Every run has a report page beside its dashboard: `report.html` in the snapshot, `/report` on `serve`, linked from the dashboard's header. It is written for the people who take the release further: devops and testers. **Export PDF** prints it.

## Release notes

1. `S/run.mjs report <run> --draft` reads what the run can show by itself and prints a Markdown draft: each unit's issues, PRs and merges from the state, and, from git between the base and head each unit's gaming check recorded (`detect.mjs`): migrations and scripts added, `.env.example` variables added or removed (names only, never values), lines that schedule or queue jobs, and notes that mention copy awaiting approval. A range git cannot read (another repo, not fetched) is named, not guessed. The draft is kept in the run folder (`report/draft.md`, `report/draft.json`) and its facts show on the page under **For devops, from git**.
2. The lead (or the integrator) writes the notes with `sub-skills/release-notes.md`, starting from the draft: each change in plain words; for testers, the role and screen, steps, expected result, and the locales and sizes to check; for devops, migrations, env vars, scripts, jobs, deploy order, rollback and copy awaiting approval. Every TODO in the draft gets an answer or "None".
3. `S/run.mjs report <run> --file notes.md` stores them in the run's event log, masked: known key shapes, a value on the line after "password:" or "token:", a table row whose name holds TOKEN, KEY, SECRET or PASSWORD, and logins written as "login: user / password" or "user: x password: y" (`lib/secrets.mjs`, so `push` masks them too). A line that still pairs a credential word with a password-like value is refused with its file:line, never its value; remove it, or add `--i-checked` once you are sure it is not one. They survive deleted worktrees and travel with `push`. Storing again replaces them. The page renders them escaped: headings, lists, tables, code and links only. Until then it says **Not written yet** with these commands.

`S/run.mjs report <run>` says what is stored.

## Code quality and compliance signals

`S/run.mjs quality <run>` measures the files the run changed (the union of every unit's recorded diff) and the whole project, stores `quality.json` in the run folder and refreshes the report. `S/run.mjs quality --project` measures the project alone and stores nothing. `--json` prints the full result. Node built-ins only; it reads the project and never writes to it. Code files come from git's list (dependencies, build output and hidden folders never count); files over 400 KB or minified are skipped and counted.

**No secret is ever copied.** The secrets signal shows only the file, the line number and the kind (key or token literal, credential assigned a literal, private key), never the value or the line. Lines longer than 400 characters are read in overlapping windows; a long line that holds a credential is withheld whole. Every other evidence line is masked before it reaches stdout, `quality.json`, the report or its PDF (`lib/quality/secretline.mjs`), and stored release notes are masked the same way.

**Signals, not a verdict.** Every signal names the file and line to check. They are found by patterns, so some are false positives, and none is a compliance certification, an audit or legal advice. Tests, fixtures, seeds and generated files are left out of the signals.

| Area | What is measured | Threshold |
|---|---|---|
| Duplication (DRY) | Runs of 6 significant lines (normalised; blanks, comments, imports and bracket-only lines ignored) found in two places: the share of lines, and the largest sites with where else they appear | 6 lines |
| Structure | File and function length (p50, p90, max), functions found by pattern (JS/TS, Go and other brace languages) or indentation (Python); block nesting inside a function (`if`, loops, `try`, callbacks; object literals and JSX braces do not count) | file over 500 lines, function over 80, nesting 4 deep |
| Naming | Declared names against the language's convention (JS/TS camelCase, PascalCase for classes and components, UPPER_SNAKE constants; Python snake_case and PascalCase classes; Go never snake_case); one-word names are not counted | – |
| Redundancy | From the run's project map (`run.mjs map`): code files no file imports (pages, routes, scripts, configs, index files and tests are entry points, never dead) and functions with the same shape in several places. Unused exports are not measured: the map records only shared helpers | – |
| Security | Credentials in string literals (`lib/secrets.mjs`; placeholders, env reads, error codes and stand-in URLs skipped); `eval`, `new Function`, shell commands built from strings, `shell=True`; SQL text joined with `+` or interpolated outside a tagged template (`sql\`…\`` parameterises); TLS checks turned off; CORS open to any origin; write routes with no auth word on the route or a hook in the file (low: a parent plugin may guard them) | – |
| Privacy (PDPL, GDPR) | Personal data (national id or iqama, email, phone, IBAN, date of birth, passport, SSN, recognised by the words of a name) passed to a log call, unless masked or only a boolean or length; personal data in a URL's query or route parameters; sensitive columns (national id, IBAN, passport, date of birth) in database files with no encryption in that file; personal data or tokens in browser storage; personal data stored with no deletion, anonymisation or retention path anywhere, or no consent or privacy-notice text | – |

**Known limits.** Line patterns, not a parser: a credential split across lines, SQL built over several statements, or an auth check applied by a parent plugin are missed or flagged wrongly. Personal data inside a string or an f-string is not seen. The changed files are read as they stand in the main checkout.

The report shows each area for the changed files and for the project, with the evidence in toggles, and the personal-data summary (fields found, the first deletion path, the first consent text).
