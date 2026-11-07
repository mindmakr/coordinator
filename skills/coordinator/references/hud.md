# The dashboard: a run at a glance

Three views of the same state, so the person never has to interrupt the loop to ask how it's going. All read `state.json` and nothing else.

## Text: `S/run.mjs show <run>`

About a dozen lines, for any harness and any terminal:

- **situation:** the lead's latest `note --kind situation`, or a count such as "3 of 6 tasks in progress, 1 done, 2 waiting";
- **needs you:** each open question with the lead's recommendation, or "nothing". `use-answer`, or `note --kind decision --answers q<N>`, closes question N;
- **answered:** each answer the lead has not used yet, and who gave it;
- **time left:** rough. The median minutes per try so far, times the tries still ahead on the longest chain of unfinished units, next to what the time budget has left;
- the budget used against its limits;
- one row per unit: status, round, score trend, next action and behaviours passing (`behaviours 1/2`); then its plain sentence, prefixed `[retrying]` or `[quiet]` when the lead is handling a problem, and its last gap;
- **goal:** met or not yet, with the goal's behaviours passing;
- the next step for the lead and the counts of questions, follow-ups and decisions.

`status` replies from it (`commands/status.md`).

## The live dashboard: `S/run.mjs serve <run> [--port P]`

A small server on 127.0.0.1 that renders the dashboard from the state on every request and keeps it current. It prints a URL with a token made fresh at each start; give it to the person once. Its rules are in `guardrails.md`.

- **Live, not reloading.** The page opens a Server-Sent Events stream (`/events`). When the state changes, and once a minute for the clocks, the server sends the page's content again, and the page updates itself in place (`lib/morph.mjs`): every row, card and section has a stable key, kept nodes stay, changed text and attributes are updated, and only new rows are inserted. Every key is unique on its page (unit ids are part of them), so the morph never confuses two rows. Because nodes are kept, the browser's own scroll anchoring (`overflow-anchor: auto`) keeps the reader's place; the page adds no scroll correction of its own. It never swaps a block while one of its form fields has focus or holds typed text. A pill in the header shows the connection, in words as well as colour: **Live** (green, pulsing), **Reconnecting** (amber, pulsing; retries with backoff, 1 s doubling to 30 s), **Disconnected** (red: the server refused the page's token, which means it restarted, or five tries in a row failed; it then stops trying and says "if the server restarted, open the new link it printed", with a **Retry** button), **Finished** (foreground colour, the run is closed). A 15-second heartbeat lets it notice a silent drop. With reduced motion set, nothing pulses.
- **Kept state.** Open toggles (behaviours, evidence, gaps, notes), the scroll position after a reload (restored once images and fonts have loaded), the theme and the timeline filters are remembered per browser (localStorage, per run and page), across live updates and reloads.
- **Theme toggle:** System, Light or Dark, top right.
- **At the top:** the situation; **Goal: met / not yet**, with each goal behaviour, its status and evidence; **Needs you** with answer forms (options as cards, the recommended one first, an Other box); a note box; time left and the next step.
- **Who acts:** only **Needs you** and the question cards address the person. A unit that failed twice in a row shows **Retrying**, one whose agent went silent shows **Quiet**; both mean the lead is on it, with the reason on hover. A legend above the units says so.
- **Times** show in the viewer's locale and time zone: relative ("5 min ago") within 24 hours, the local date and time otherwise, and the full local time with its zone on hover. Each is a `<time datetime="…">` with the ISO timestamp; the filters read the raw timestamps.
- **Unit dots:** each card and unit page starts with a dot: green and pulsing while building or being checked, amber while waiting or retrying, red when its agent is quiet, foreground when passed, grey when stopped (the words are in its label and tooltip). Active units come first; passed and stopped ones are dimmed, as are their timeline rows, and **Show finished** hides them (remembered per browser).
- **Tries and scores:** "Tries used: 2 of 4" with a bar (a try is one build plus one independent review; hover says so). It turns red only near the limit on a unit still running, and is grey once the unit is finished. "Score per try (0–10)" draws one dot per try, red for a failed try and green for a passed one; each dot is focusable and its tooltip says "Try 2: failed, 8/10 — <cause>". One try reads as words: "Passed on try 1 (9/10)". Budget cards explain themselves on hover; a full units bar is normal and not red. Once a unit has passed, an **escapes** card says how many defects turned up after a pass (`note --kind escape`), out of how many passed units, and lists them; `show` prints the same line when there are any.
- **Questions card:** open questions only, with their count. Answered ones (by the person, the lead, or a decision note that answers them) sit in a collapsed, dimmed **Answered** group: the question's header or first line, then "Answered: … — by you, 5 h ago" and the decision that closed it. On the timeline: "q1 answered: …".
- **Unit cards:** the plain sentence, issue and PR chips, the score per round, then toggles for **Behaviours** (each with pass, fail or unchecked), **Evidence** (test output in a monospace block, collapsed when long; screenshots as thumbnails that open full size in a new tab; links), and the raw gap. **Open <unit> →** goes to the unit's page.
- **A unit's page** (`/unit/<id>`, also live): its bar and behaviours with their evidence, other evidence and artifacts, every round (the builder's report, the critic's verdict, score, cause, gap and evidence, and each behaviour mark), its questions and notes with forms, its links, and **its own timeline**: start, beats with their milestone, built, verdicts with score and cause, strategy changes, evidence, behaviours set, questions, answers and notes on the unit, links, merges and the stop. A back link returns to the dashboard.
- **Timelines** (the run's on the dashboard, a unit's on its page): colour-coded badges by kind, each with its text label (decision, question, answer, note, verdict pass, verdict fail, stop, merge, evidence, strategy, behaviour, build, link, info). Above them: a search box over the event text; kind chips (several at once); unit chips on the run's timeline (`run` for run-level events); a time range (last 30 min, 120 min, 4 h, 8 h, 24 h; 2–7 days ago, meaning older than 24 h up to 7 days; 8+ days ago; All); and newest or oldest first. Search ignores case, accents and Arabic or Urdu diacritics, highlights every match in the visible rows (built from text nodes, so state text stays escaped) and shows "n matches"; highlights are cleared with the search and come back after each live update. The filter and the highlights are the same functions the tests check (`lib/timeline.mjs` `matches`, `lib/highlight.mjs`).
- **Links everywhere.** In any state text, http(s) URLs, `owner/repo#123`, and, against the run's repo, `#123`, commit shas and branch names (`feat/…`, `fix/…`) become links that open in a new tab with no referrer. Nothing else does. The run's repo is `init --repo owner/name`, else the project's `origin` remote on GitHub, else the repo most GitHub issue and PR links in the state point at.
- **Forms** go through the same locked code as `run.mjs answer` and `note --kind person`, so `watch` sees them within 2 seconds.

Stop it with Ctrl+C, or stop the background command, when the run ends.

**Why one script.** The page carries one inline script, allowed by a nonce made per response (`script-src 'nonce-…'`), plus `connect-src 'self'` for the stream and `img-src 'self'` for screenshots. Nothing else can run or load.

**Known issue.** In Chromium, when the top of the screen sits a few pixels below a growing list inside a tall card (for example a unit's open Evidence list), an item appended to that list can shift the view (measured once at 126 px), because the browser anchors to the card that straddles the top of the screen. Content added inside the visible area also moves what is below it, by design. Tracked in issue #23. To reproduce: in Chromium, serve a run with 8 units and 45 or more decisions, one unit with 22 or more evidence items and its Evidence list open; put the top of the screen 5–40 px below the end of that list; then add evidence to that unit from the CLI (`run.mjs evidence <run> <unit> --kind log --text …`).

## The coordinator's page: `S/run.mjs self` and `/coordinator`

About the coordinator itself, across every run in the state folder. `S/run.mjs self` prints it as text (`--json` for the model, `--html` writes `coordinator.html` beside `runs/`); `serve` shows it live at `/coordinator`, linked from the header of every page (the header lists the served run and Coordinator; a new page adds itself to `pages` in `liveCtx` and to `PAGE` in `lib/serve.mjs`). One section per entry of `SECTIONS` in `lib/selfpage.mjs`:

- **Age:** first run, number of runs (and how many are open), units, hours at work (each run's start to its close or last event).
- **Plans:** each open run: its decision, units finished, the next steps, and for each unit left what it waits on (its builder, a critic, the unit it stacks on, the lead, or you), and open questions.
- **Working stats:** counted over all runs, open included (the page says so), with the closed-runs-only figures that `run.mjs stats` prints beside them: pass rate and stopped share of finished units, rounds to pass (median and p80), median time per unit (first build to last verdict), the suggested `--max-rounds`, and a table of the same per run (the trend).
- **Learning:** every lesson of both scopes, best first: tag, text, seen, used, **promote** once seen 3 or more times, the runs it came from (links) and its sources.
- **Memory:** `COORDINATOR.md` by section, and your answers from past runs (with the decision notes that closed questions).
- **History:** closed runs with outcome, units passed and stopped, start and close, each linking to its dashboard.
- **Proposals:** follow-ups, retro notes and `upstream:` notes from every run, and lessons ready to promote, newest first, linkified.
- **Side study:** the rule, each run's studies against its cap, and the study log with sources and lessons (`learning.md`).

Run links go to `/run/<run>`: any other run of the folder, live and **read-only** (no forms; answer those on that run's own `serve`). Its unit pages are `/run/<run>/unit/<id>`. The page updates live when any run, lesson file or `COORDINATOR.md` changes. Tokens per unit are not recorded yet, so they are not shown.

## The maps: `/maps` and `maps.html`

Five pictures of one run, drawn as inline SVG from the same view model as the dashboard (`lib/maps.mjs` and `lib/heat.mjs` build the data, `lib/mapsvg.mjs` draws it). Live at `/maps` on `serve` (in the header, and **Maps →** on the dashboard; `/run/<run>/maps` for another run), and as `maps.html` beside `hud.html` in the snapshot. No script and no network; colours are theme classes, so light, dark and a project theme apply. Each map's box is focusable too (a named region with a focus ring), so a wide map can be scrolled from the keyboard on a phone. Every node is a link you can tab to, with its words in a tooltip and `aria-label`: a unit opens its page, the goal opens the dashboard, an issue or PR opens GitHub in a new tab. One section per entry of `MAPS` in `lib/mapspage.mjs`:

- **Mind map:** the goal at the centre, units on the first ring, their behaviours on the second, evidence outside (six per parent, then `+n`). Coloured by status: the unit's dot, a behaviour's pass, fail or unchecked.
- **Flow:** units in columns by stacking depth (`--after`), then the issues and PRs they link (one node per issue, so two units on one issue show it; another repo's are dashed), then follow-ups, attached to the unit they name, the note's unit, or an issue the unit links. **Critical path:** the stacked chain with the most work in it. A finished unit weighs its minutes worked (first start to last verdict); an unfinished one the median a finished unit took (30 min if none), or its minutes so far once past that. Drawn thick, with a line above saying how long and how many units are left. With no stacking it says so and draws no path. Follow-up lines are drawn above the issue nodes they cross.
- **Activity by hour:** units against time in UTC, one column per hour since the start (wider columns past 48 hours). Darker means more happened (a try counts double, a heartbeat or other event once); red holds a failed try; amber is time waiting for a critic (built to verdict) or an answer, overlaps counted once. Hover a cell for its counts; a row's link says its totals and busiest hour.
- **Behaviours:** units against their behaviours (B1, B2, … by position, the goal's row first): pass ✓, fail ✗ or unchecked ·.
- **Goal relevance:** goal behaviours on the left, units on the right. A unit is **named** when its title, bar or behaviours name a goal behaviour's id (with no goal behaviours: the goal names the unit or an issue it links), **inferred** when they share three or more words, and **off goal** otherwise, grouped at the bottom with an amber dashed border.

**Labels and panels** (`lib/maptips.mjs`): every unit box shows a status mark (✓ pass, ✗ fail, ■ stopped, ○ open, ▶ building, ◆ judging; never colour alone) and its id, with the title clipped by an ellipsis and in full on hover. The mind map's ring grows with the unit count so neighbouring boxes never overlap. Hovering, focusing or tapping a unit's box, in any map, shows its panel: status, round n/max, the scores trail, time spent, the last gap and cause, linked issues and PRs, and files touched (`files` in the view model, from the gaming check's last diff count). The boxes it connects to and their edges stay lit; the rest dims. Stacked edges are labelled "waits on" and point to the unit waited for; issue and PR boxes name the units that link them, follow-ups the unit that filed them, goal behaviours the units that serve them. Maps are drawn at their own size, never shrunk, and scroll inside their box (a hint says so on a phone, or when wider than the page). The panel is a non-modal dialog. CSS shows it and does the dimming, so the snapshot works with no script; on the live page a small script places it clear of the box and what it lights, pins it on a tap (a second tap opens the unit), lets Tab enter it from its box and leave past its last link, and closes it on Escape or a tap elsewhere. The project map's boxes do the same with a module's files, helpers, surfaces, settings and import counts.

**Walking Flow and Goal relevance** (`lib/mapnav.mjs`, `lib/mapnav.client.js`): on these two maps, hovering or focusing a box lights it and its direct children only (Flow: the units stacked after it, the issues and PRs it links, the follow-ups it filed; Goal relevance: the units that serve a goal behaviour), never its parent or grandchildren. Every line has a wide invisible hit area, is focusable and named ("m3 waits on m1"); hovering or focusing it lights its two ends. CSS does this, so the snapshot has it. On the live page, a click, tap, Enter or Space selects a box instead of opening it: it stays lit with its children until clicked again, Escape or **Clear selection**. A panel above the map shows a breadcrumb back to a root, the box's words, **Open unit** (or Open issue, PR, follow-up, the dashboard), **More…**, **Up to parent** and its children as buttons; → goes to the first child, ↑ ↓ to the next or previous child, ← back up. Right-click, long-press, the Menu key or Shift+F10 opens a menu: open, open in a new tab, select children, copy a link. **Find** selects a box by id or title (Enter picks the first match); **Focus** hides what is not selected. Counts above each map say how many units, issues and PRs, follow-ups and lines it holds. Flow's line ends each mean one thing: a filled arrowhead points to the unit waited for (`--after`), blue on the critical path; a ring sits at the issue or PR a unit links; an open arrowhead points to a follow-up. Goal relevance has no arrowheads: lines run from a goal behaviour to a unit serving it, solid green when named, dashed when inferred.

**What survives a reload and a live update:** the selection (in the URL hash, `#sel=<map>/<keys>`, so a copied link opens on it, and in sessionStorage), Find and Focus, a pinned panel, scroll inside each map, open toggles, timeline filters, the page's scroll and the theme. The live update resets classes, so after each patch the page puts the selection and pin back (`coordinator:patched`). Storage blocked: everything works, nothing is remembered.

**Export PDF:** every page (dashboard, unit pages, maps, project map, coordinator page) has an **Export PDF** button on the live page that opens the browser's print dialog (choose Save as PDF); the snapshot runs no script, so it says "Ctrl+P or ⌘P, then Save as PDF". The print styles are in both: always the light theme, every toggle printed open (and closed again after), live controls, panels and menus hidden, maps scaled to the page width (at most 190 mm tall), cards, rows, maps and panels kept whole and headings kept with what follows where they fit, the page title at the top of every page and "Page n of m" at the bottom.

## The snapshot: `hud.html` and `units/<unit>.html`

`.coordinator/runs/<run>/hud.html`, `maps.html` and one page per unit under `units/` are rewritten after every change, in the same lock as the state. `S/run.mjs hud <run>` rewrites them on demand.

- They are read-only snapshots: no scripts, no network, no reload (its content security policy blocks all three), so they open from `file://` and can be published as a page. Open questions show their options; the page says to answer in the chat or ask for the live dashboard.
- The theme toggle works without a script there but is not remembered; toggles start closed. Times are ISO with "UTC" spelled out.
- Screenshots up to 150 KB are embedded; larger ones are links to the file under `artifacts/`.

## Looking like the project

The dashboard can take its colours, fonts, radius and spacing from the project's design system: `init --theme <file.css>`, or a `Theme: <path>` line in `COORDINATOR.md` (relative to the project). The CSS file is read, never loaded:

- custom properties from `:root`, `@theme`, daisyUI theme blocks, and dark ones from `.dark`, `[data-theme=dark]`, `prefers-color-scheme: dark` or a theme named dark;
- `--background`, `--card`, `--foreground`, `--muted-foreground`, `--border`, `--primary`, `--primary-foreground`, `--success`, `--warning`, `--destructive`, `--radius`, `--font-sans`, `--font-mono`, `--spacing`, also as `--color-*`, and daisyUI's `--color-base-100/200/300/content`, `--color-error`, `--radius-box`. `var()` is resolved within the file; shadcn's bare `222 47% 11%` becomes `hsl(…)`;
- a value that is not a plain colour or length, or holds `url(`, `@`, braces or angle brackets, is dropped. A font set at runtime (`var(--font-geist-sans)`) is dropped and the rest of the list kept. Anything missing keeps the built-in theme; a project without dark values keeps the built-in dark.

The Coordinator mark stays in the foreground colour, so it fits any theme.

## The project map

When the run has a map (`S/run.mjs map <run>`), the header links **Project map →** to `map.html` in the snapshot and `/map` (or `/run/<run>/map` for another run) on the live dashboard: the import graph with its filters, surfaces, settings, shared helpers and reuse candidates (`map.md`).

## Hearing the person: `S/run.mjs watch <run>`

Polls the state every 2 seconds and prints one line per new or changed answer and per note from the person, then keeps going:

```
answer q2 (u1) by person: No · Merge
note by person on u3: Check the Arabic labels
```

At start it prints the answers still waiting for the lead. `S/run.mjs questions <run>` prints every question with its options, latest answer, history and status.

## Showing it to the person

- **Live:** start `serve` and give the person its URL, once.
- **Claude Code:** you may also publish `hud.html` as an Artifact (private by default) at milestones; it does not follow the file.
- State is masked for secrets on a best-effort basis. Read the page before publishing it.
