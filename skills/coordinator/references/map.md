# The project map

A dependency map of the code a run works on, so builders and critics see what a change touches before they touch it. Built from the code with Node built-ins only, read-only, capped in time.

## Commands

- `S/run.mjs map <run> [--root dir] [--max-seconds 60] [--unit U]` builds it into the run's folder. `--root` defaults to the project (the main checkout). `--unit` tags the build with the unit that just merged.
- `S/run.mjs map <run> --pit-stop [--dest dir]` builds it and also copies it **into the repo** (default `<root>/coordinator/runs/<run>/map/`, laid out like the state branch in the design). Run it only at a pit stop: a unit merged, or the run closing. It writes files; you commit them, once per pit stop. It refuses when the repo's `events.jsonl` has lines the run's log lacks (written from another machine): merge first.
- `S/run.mjs touches <run> <path> [--json]` prints what one file touches, for a builder's brief (`briefs.md`). The path is relative to the mapped root; an absolute path is matched by its tail.

## What it holds

| Collection | Each record |
|---|---|
| `modules` | a source file: language, lines, the project files it imports, outside packages, unresolved specifiers |
| `helpers` | an exported function or class used by two or more files, with who uses it (followed through re-exports and barrels) |
| `settings` | `env:NAME` (from `process.env` / `import.meta.env`, plus names declared in `.env.example`-style templates) and `key:settings.x` (property chains on `*settings`, `*config`, `*prefs`; `config.get('x')`; `settings: { … }` literals), each with the `file:line` where it is read and written |
| `surfaces` | routes (Fastify/Express/Hono-style `app.get('/x')`, `.route({ method, url })`, Next.js `route.ts` and `pages/api`), with `register(plugin, { prefix })` / `use('/p', router)` prefixes and the services behind them; screens (Next.js app and pages routers, Expo Router, `*Screen` components) with the routes their client calls reach (`api.get('/x')`, `fetch('/x')`, two import steps deep); message keys code uses or that miss a locale |
| `reuse` | functions whose bodies have the same shape (strings, numbers and names normalised), in two or more places |

Build metadata: the root's folder name (never an absolute path), repo, commit, files scanned, time per phase, languages, outside packages, message catalogs.

Other languages (Python, Go, Rust, Java, Kotlin, Ruby, PHP, C/C++, C#, Dart, Swift, Scala, Elixir) get the fallback: import lines by pattern, resolved against the file list where the spelling allows (relative paths, dotted modules, Go packages by directory). No helpers, settings or surfaces for them.

## Storage

In the run's folder, `map/`:

- `events.jsonl`: append-only. Each build writes `map.build` (its metadata), `map.delta` lines (records set or removed per collection, about 12 KB each) and `map.done` (counts and a SHA-256 digest of the result). Every line carries `v`, `seq` (1, 2, 3… with no gaps), `at`, `kind`, `build` and optional `unit`. A build with no change adds two lines.
- `map.json`: the snapshot rebuilt from the events. Keys sorted, arrays sorted by id, one record per line, `upTo: { seq, sha256 }` of the events applied.
- `map.md`: a short summary for github.com. `map.html` (beside `hud.html`): the graph view.

Every event is checked against its kind's schema on write and on read. A reader that finds the snapshot behind or its hash wrong replays the events; a line that is not JSON, a seq gap, an unknown kind or a replay that misses a build's digest fails loudly. A build stopped by the time cap is marked `partial` and adds or updates records but never removes any.

## The view

`map.html` (and `/map` on the live dashboard, linked as **Project map →** from the run's header): an import graph in inline SVG, one box per file for small projects and per folder otherwise, importers on the left. Arrows carry the import count; cycles are dashed and hidden until **Cycles** is on or a box is hovered. Filters are checkboxes read by CSS, so the snapshot needs no script: areas (top folders), links (all, 3+, 10+ imports), tests. Below: routes with the files behind them, screens with the routes they call, message key counts, settings with read and write sites, shared helpers and reuse candidates (150 rows each; the rest are in `map.json`). Boxes and rows open the file on GitHub when the repo is known, at the commit when it is pushed, else at `HEAD`.

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
