# The project map

A dependency map of the code a run works on, so builders and critics see what a change touches before they touch it. Built from the code with Node built-ins only, read-only, capped in time.

## Commands

- `S/run.mjs map <run> [--root dir] [--max-seconds 60] [--unit U]` builds it into the run's folder. `--root` defaults to the project (the main checkout). `--unit` tags the build with the unit that just merged. `--fresh` moves the old `map/` aside (`map.old-<time>`) and starts a new log: the way out of a broken one that was never staged. `--reset-stage` is the way out once it was: it moves the map and the stage aside, starts a log whose first line is `map.reset` naming the SHA-256 of the staged log it replaces, and stages the new map at once. `push` accepts it over a copy with exactly that hash, and `pull` on another machine accepts it over a local log or stage with that hash (status `reset`, the old map kept aside). A reset that names any other history is refused like any divergence. After a `pull` that reports "kept the local map", the stage mirrors the copy, so `--reset-stage` then replaces exactly what is on the branch. `--force` records a build cut short by the time cap (see Storage).
- `S/run.mjs map <run> --pit-stop [--dest dir]` builds it and stages what ships, `events.jsonl` and `map.md`, in the run's own `pit-stop/map/` (never the project's tree). `map.json` does not ship: any reader rebuilds it from the log. Run it at a pit stop: a unit merged, or the run closing. Then `run.mjs push <run>` carries the staged files with the run's state to the `coordinator-state` branch as `runs/<run>/map/events.jsonl` and `map.md`, masked like the rest, and refused when the branch has map events the staged log lacks (pull first). `run.mjs pull <run>` restores them: a missing local map is restored, one behind is fast-forwarded, one ahead is kept, and one that differs is kept and named (`--fresh` starts over); the result says which under `map`. `--dest dir` copies the same files to a folder you name, with the same refusal.
- `S/run.mjs touches <run> <path> [--json]` prints what one file touches, for a builder's brief (`briefs.md`). The path is relative to the mapped root; an absolute path is matched by its tail. Surfaces come direct first (declared in the file, or the file is behind the handler), then those that reach it by import, nearest first: the closest 12, with the total, so a hub file does not list hundreds.

## What it holds

| Collection | Each record |
|---|---|
| `modules` | a source file: language, lines, the project files it imports, outside packages, unresolved specifiers |
| `helpers` | an exported function or class used by two or more files, with who uses it (followed through re-exports and barrels) |
| `settings` | `env:NAME` (from `process.env` / `import.meta.env`, plus names declared in `.env.example`-style templates) and `key:settings.x` (property chains on `*settings`, `*config`, `*prefs`; `config.get('x')`; `settings: { … }` literals), each with the `file:line` where it is read and written |
| `surfaces` | routes (Fastify/Express/Hono-style `app.get('/x')`, `.route({ method, url })`, Next.js `route.ts` and `pages/api`), with `register(plugin, { prefix })` / `use('/p', router)` prefixes and the services behind them: the imported files whose bindings the handler names, directly or through one function or variable it names (one step), resolved by scope: the declaration whose block holds the handler, so two handlers that each declare `data` never borrow each other's, else the file's service-like imports; screens (Next.js app and pages routers, Expo Router, `*Screen` components) with the routes their client calls reach (`api.get('/x')`, `fetch('/x')`, two import steps deep); message keys code uses or that miss a locale, with the files that use them |
| `reuse` | functions whose bodies have the same shape (strings, numbers and names normalised), in two or more places |

Build metadata: the root's folder name (never an absolute path), repo, commit, files scanned, time per phase, languages, outside packages, message catalogs.

Other languages (Python, Go, Rust, Java, Kotlin, Ruby, PHP, C/C++, C#, Dart, Swift, Scala, Elixir) get the fallback: import lines by pattern, resolved against the file list where the spelling allows (relative paths, dotted modules, Go packages by directory). No helpers, settings or surfaces for them.

## Storage

In the run's folder, `map/`:

- `events.jsonl`: append-only. Each build writes `map.build` (its metadata), `map.delta` lines (records set or removed per collection, about 12 KB each) and `map.done` (counts and a SHA-256 digest of the result). Every line carries `v`, `seq` (1, 2, 3… with no gaps), `at`, `kind`, `build` and optional `unit`. A build with no change adds two lines.
- `map.json`: the snapshot rebuilt from the events. Keys sorted, arrays sorted by id, one record per line, `upTo: { seq, sha256 }` of the events applied.
- `map.md`: a short summary for github.com. `map.html` (beside `hud.html`): the graph view.

Every string is masked for secrets when it is recorded, so a pushed copy is the same log and replays cleanly. The map keeps its own files and its own lock (`map/events.jsonl.lock`), apart from the run's `events.jsonl` and `state.json`: a map build never waits on, or writes to, the run's log.

Every event is checked against its kind's schema on write and on read. A reader that finds the snapshot behind or its hash wrong replays the events; a line that is not JSON, a seq gap, an unknown kind or a replay that misses a build's digest fails loudly, naming the line, with `--fresh` as the way out. On the live dashboard `/map` shows the same cause instead of the map.

A build stopped by the time cap is marked `partial`. Over a complete map it is refused, so thinner records never replace full ones; `--force` records it anyway, and then it adds and updates records but never removes any; its message figures (unused keys, unknown lookups) stay those of the complete build, marked "counted in build N".

## The view

`map.html` (and `/map` or `/run/<run>/map` on the live dashboard, linked as **Project map →** from the run's header): an import graph in inline SVG, one box per file for small projects and per folder otherwise, importers on the left. Arrows carry the import count; cycles are dashed and hidden until **Cycles** is on or a box is hovered. Filters are checkboxes read by CSS, so the snapshot needs no script: areas (top folders), links (all, 3+, 10+ imports), tests. Below: routes with the files behind them, screens with the routes they call, message key counts, settings with read and write sites, shared helpers and reuse candidates (150 rows each; the rest are in `map.json`). Boxes and rows open the file on GitHub when the repo is known, at the commit when it is pushed, else at `HEAD`.

## Function calls

`S/run.mjs calls <run> <unit> [--base ref --head ref | --files a,b] [--root dir] [--max-seconds 60] [--json]` finds the JS/TS functions a unit changed and, for each, what it calls and what calls it, one level each way plus a second behind a toggle.

- **One version of the code:** every file is read at one commit with `git ls-tree` and `git cat-file`: the unit's head when its diff is known, else `HEAD`. The data and the GitHub links (`blob/<that commit>/file#L…`) therefore agree, whatever the working tree holds. Refs are resolved to commits first and stored as commits. When the unit's commits are gone (deleted, never fetched), the page says so in a note and reads the files its map build changed at `HEAD` instead; outside a git repository it reads the working tree and draws no links.
- **What the unit changed:** the lines of `git diff base...head` (default: the base and head its `detect.mjs --unit` run recorded); else `--files` (whole files); else the files whose module record changed in the last `map --unit U` build (not the first build, which has no baseline). With none of these it says so and records nothing. `run.mjs map <run> --unit U` computes it for U as well, within the same time cap.
- **The index:** every function, method, class and arrow bound to a name, with its line range and the calls in its body: `f()`, `ns.f()` and `Class.f()` through imports (named, default, namespace, `require`, destructured `require`, `await import()`, re-exports and barrels, tsconfig paths), `this.f()` (up the `extends` chain), `this.svc.f()` and `svc.f()` where the field or variable is typed or built with `new`, exported instances (`export const events = new EventsService()`), `new X()` (its constructor), object-literal methods (`module.exports = { … }`), and JSX elements in .jsx/.tsx (`<Card />`, `<ui.Button>`, marked JSX). A name passed as an argument (`setTimeout(fn)`, `app.get('/x', handler)`) or as a JSX handler (`onClick={save}`) counts as a call marked "passed". Functions in an object passed straight to a call (`useQuery({ queryFn: () => …, onSuccess() {} })`) belong to the function around them. A parameter or a local (`const`, `let`, `var`, destructured, `catch (e)`) hides a same-named function or import inside its own block only. Calls at module level belong to the file's "(top level)".
- **Scanner:** comments, string contents and JSX text are blanked before anything is matched, so a call in a comment, a string or between tags (`<p>call fn(x)</p>`) is not a call; template and JSX expressions are code. TS interfaces, type literals, function types and overload signatures are not functions. Never runs the code. The scanner is `lib/map/fns.mjs` with `fn-syntax`, `fn-defs`, `fn-locals`, `fn-jsx` and `fn-module`; the index is `calls-link.mjs`, git reads `calls-git.mjs`.
- **Speed:** each file's scan is cached in `map/calls-cache.json` by its git blob id, so a rerun rescans only changed blobs; a cache entry that does not have the expected shape is rescanned. The unit's own changed files are scanned first and are never cut by the time cap; past it, other unscanned files are skipped and the result is marked partial. On a 1,685-file TypeScript app: cold, 3 to 6 s to scan and under 1.1 s to link, depending on machine load; warm, about 0.2 s to scan; a whole `run.mjs calls` about 5 s cold and 1 s warm. The cache is about 7 MB there.
- **Storage:** `map/calls/<unit>.json`. Neither file ships at a pit stop; both are derived.
- **Where it shows:** the unit page's **Function calls** section (a small graph, callers left, touched functions centre, callees right, then a table) and the maps page's **Calls** view (pick a unit). A callee links to its definition; a caller links to the line that makes the call.

Not counted (the page says so too): decorators, calls through computed names (`handlers[name]()`), `.call`/`.apply`/`.bind`, a function held in a variable or passed on under another name, dependency injection by string. A method on a value whose type it cannot see (a parameter typed by an interface, a return value) stays unresolved, with its name. Two functions with the same qualified name in one file are told apart by a `~2` suffix. A nested function declared inside a block is still found from outside that block.

Spot check (2026-11-07, on 25 functions not used for tuning: 10 in this repo, 15 in a 1,685-file TypeScript app, checked by hand against grep): every edge listed was right; 32 of 32 calls to project functions and 55 of 57 callers were found. Both misses are methods called on an object a factory returned (`reader.close()`, `a.see()`). All 1,156 links on one unit's data from that app open a line that holds what they name; 281 of its 287 React components show who renders them (the other six are never rendered by its code).

## Limits

It reads patterns, not a type-checked AST:

- Imports built from variables, `require.resolve`, webpack aliases and tsconfig `extends` from a package are not followed; `paths` and relative `extends` are.
- A package's `exports` pointing at `dist/` is tried as `src/` too; anything else that only exists after a build is unresolved.
- Env vars read through a helper (`env(name)`), or keys built at runtime (`t(\`a.${b}\`)`), are not found. Settings in SQL (`jsonb_set`) are not seen.
- Route prefixes come from one `register`/`use` per file and its parents; Fastify autoload and prefixes set inside a plugin are missed. Routes in test files are skipped.
- Screens reach routes only through string paths; a call matches every route whose path ends the same way.
- Reuse needs 4+ lines and a non-trivial body; near-duplicates that differ in structure are missed.
- Secrets: `.env` files are never read, only templates (`.env.example`, `.sample`, `.template`, `.dist`), and only their names.

Timing on a 2,300-file TypeScript monorepo (1,685 source files): about 5 s warm, 16 s with a cold disk cache; the default cap is 60 s.
