# visual: screens in every language, direction and width

**When:** once per unit with a visible change, as the visual critic, after the code critic has passed the head. Not on every round: if it fails and the builder fixes, it runs again, on the screens the delta touches (step 3). Builders also use it to take their own screenshots as pointers.

**Inputs:** the changed screens (from the brief, or the diff's files mapped to routes), the local run steps, seeded logins, locales and screen widths per surface from `COORDINATOR.md`, and the references the bar names (`craft.md`).

**In the loop:** the lead sends it once the code critic (`review.md`) has passed, on UI units (`team.md`, Visual critic); both must pass. It costs screenshots and tokens, so it does not repeat on rounds the code critic fails (`context.md`, rule 6).

## Steps

1. **Local only.** Start the stack as `COORDINATOR.md` says: database, migrations, seed, servers. Use your own database and free ports. Never point a browser at a shared or production environment, and never sign in with a real account.
2. **Your own browser.** Launch your own headless browser (Playwright or the harness's browser tool in its own session). A browser shared with other agents changes pages under you. When the app sets up [reins](https://github.com/mindmakr/reins), pair `reins bridge` and use its MCP tools (`reins_run_action` to sign in and switch locales, `reins_state`, `reins_network` and `reins_errors` for state and calls, `reins_perf` for page lifecycle, component mount and API timings, `reins_dom` for computed CSS and overflow/clipping flags, and `reins_snap` for panel screenshots) instead of clicking by pixels. When the app's backend uses `reins/node`, `reins_server` shows each request's route, spans and outbound calls, joined to the browser call that made it. End with `reins_report` and attach the Markdown it saves as evidence (`run.mjs evidence <run> <unit> --kind reins --file .reins/sessions/<file>.md`); its Findings (slow calls, duplicate calls, render loops, clipped layout) are read into the item and shown on the unit's page for you to check. For a fix, attach the compare too: `npx reins report --compare <before.json> <after.json> --out compare.md`, then `--kind reins --file compare.md`, which shows what was resolved, what is new and what is still open.
3. **Cover the matrix, only for what the diff touches.** Screens the diff does not reach are not checked; from round 2, only screens the delta touches (`review.md`, Delta review), and an untouched screen passes by reference. For each touched screen and each role that sees it: every locale, each text direction, at the widths `COORDINATOR.md` declares for that surface (for example, admin desktop only, end-user phone and desktop). With none declared, a phone width (about 390 px) and a desktop width. A backend-only unit gets no visual check. Save every screenshot with a name that says screen, role, locale and width.
4. **Look, don't just run.** Automatic checks catch the obvious: horizontal overflow, wrong `dir`, raw translation keys, console and network errors, broken images. When a helper model is set up, the lead's pre-screen flags screenshots to look at first; it never passes one (`helpers.md`, Visual pre-screen). Then open every screenshot and look for:
   - clipped, overlapping or truncated text;
   - unmirrored layout in right-to-left locales;
   - base-language text left in other locales;
   - wrong number, currency or date formats;
   - empty, loading and error states that look broken;
   - spacing or components that differ from sibling screens and from the reference.

   Record a finding only when you can point at it in a screenshot.
5. **Side by side** with the bar's reference when it has one. When the project has `.prism/`, its tokens and anchors are that reference.
6. **Run the visual gate, when the project has `.prism/`.** Check out the commit you were given, run Prism's gate there yourself, and attach its report: `run.mjs evidence <run> <unit> --kind prism --file <worktree>/.prism/gate-report.json`. A report the builder made does not count. A FAIL report blocks the pass; your verdict as the `prism` specialist passes only on a PASS report (`prism.md`). A change to the contract itself (`tokens.json`, `anchors/`, `dials.json`, `brief.json`) is a finding, unless this is the look-dev unit.
7. **Trace** each finding to its component or string (`investigate.md`, cite three ways), or mark it "not traced".
8. **Clean up.** Stop every server and browser you started.

## Output

The critic reply from `briefs.md`. Attach screenshots with `run.mjs evidence --kind screenshot --file …` on the behaviour they show. EVIDENCE lists what was covered (screens × locales × widths) and what was not.
