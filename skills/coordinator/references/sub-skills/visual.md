# visual: screens in every language, direction and width

**When:** every `judge` on a unit with a visible change, as the visual critic. Builders also use it to take their own screenshots as pointers.

**Inputs:** the changed screens (from the brief, or the diff's files mapped to routes), the local run steps, seeded logins, locales and screen widths per surface from `COORDINATOR.md`, and the references the bar names (`craft.md`).

**In the loop:** the lead sends it as a second critic beside `review.md` on UI units (`team.md`, Visual critic); both must pass.

## Steps

1. **Local only.** Start the stack as `COORDINATOR.md` says: database, migrations, seed, servers. Use your own database and free ports. Never point a browser at a shared or production environment, and never sign in with a real account.
2. **Your own browser.** Launch your own headless browser (Playwright or the harness's browser tool in its own session). A browser shared with other agents changes pages under you.
3. **Cover the matrix, only for what the diff touches.** Screens the diff does not reach are not checked; from round 2, only screens the delta touches (`review.md`, Delta review), and an untouched screen passes by reference. For each touched screen and each role that sees it: every locale, each text direction, at the widths `COORDINATOR.md` declares for that surface (for example, admin desktop only, end-user phone and desktop). With none declared, a phone width (about 390 px) and a desktop width. A backend-only unit gets no visual check. Save every screenshot with a name that says screen, role, locale and width.
4. **Look, don't just run.** Automatic checks catch the obvious: horizontal overflow, wrong `dir`, raw translation keys, console and network errors, broken images. When a helper model is set up, the lead's pre-screen flags screenshots to look at first; it never passes one (`helpers.md`, Visual pre-screen). Then open every screenshot and look for:
   - clipped, overlapping or truncated text;
   - unmirrored layout in right-to-left locales;
   - base-language text left in other locales;
   - wrong number, currency or date formats;
   - empty, loading and error states that look broken;
   - spacing or components that differ from sibling screens and from the reference.

   Record a finding only when you can point at it in a screenshot.
5. **Side by side** with the bar's reference when it has one.
6. **Trace** each finding to its component or string (`investigate.md`, cite three ways), or mark it "not traced".
7. **Clean up.** Stop every server and browser you started.

## Output

The critic reply from `briefs.md`. Attach screenshots with `run.mjs evidence --kind screenshot --file …` on the behaviour they show. EVIDENCE lists what was covered (screens × locales × widths) and what was not.
