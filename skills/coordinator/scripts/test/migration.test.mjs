// Run folders from older releases load and render with today's scripts.
// fixtures/old-runs/v0.N was written by release 0.N's own run.mjs (tools/make-old-runs.mjs).
// COORDINATOR_MIGRATION_SOURCES adds real state folders (".coordinator"), separated by the
// path delimiter (";" on Windows, ":" elsewhere). Each is copied first and only the copy is
// touched; the test fails if a source file changed while it ran.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, relative } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseLog, readRun, replay } from '../lib/events.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(scripts, 'test', 'fixtures', 'old-runs');
const tmp = mkdtempSync(join(tmpdir(), 'coordinator-migration-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const json = (s) => { try { return JSON.parse(s); } catch { return s; } };
const cli = (dir, ...a) => { const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...a], { env: { ...process.env, COORDINATOR_DIR: dir }, encoding: 'utf8' }); return { code: r.status, out: json(r.stdout), raw: r.stdout, err: r.stderr }; };
const files = (d) => readdirSync(d, { recursive: true }).map((f) => join(d, String(f))).filter((f) => statSync(f).isFile()).sort();
const digest = (d) => Object.fromEntries(files(d).map((f) => [relative(d, f), createHash('sha256').update(readFileSync(f)).digest('hex')]));

const sources = [
  ...readdirSync(fixtures).filter((v) => v.startsWith('v')).map((v) => ({ name: v, dir: join(fixtures, v), real: false })),
  ...(process.env.COORDINATOR_MIGRATION_SOURCES ?? '').split(delimiter).filter(Boolean).map((dir, i) => ({ name: `real${i + 1}-${basename(dirname(dir))}`, dir, real: true })),
];

for (const src of sources) {
  test(`${src.name}: every run loads, renders, takes a write, pushes and pulls`, () => {
    const before = digest(src.dir);
    const dir = join(tmp, src.name);
    cpSync(src.dir, dir, { recursive: true });
    const runs = readdirSync(join(dir, 'runs')).filter((r) => existsSync(join(dir, 'runs', r, 'state.json')));
    assert.ok(runs.length, 'the folder has runs');

    const listed = cli(dir, 'list');
    assert.equal(listed.code, 0, listed.err);
    assert.deepEqual(listed.out.map((r) => r.run).sort(), [...runs].sort());
    for (const cmd of [['stats'], ['self'], ['self', '--html']]) assert.equal(cli(dir, ...cmd).code, 0, `${cmd.join(' ')}: ${cli(dir, ...cmd).err}`);

    for (const run of runs) {
      const rd = join(dir, 'runs', run);
      const had = readRun(rd);
      const units = had.state.units.map((u) => u.id);

      const show = cli(dir, 'show', run);
      assert.equal(show.code, 0, `${run} show: ${show.err}`);
      assert.match(show.raw, new RegExp(`^${run} `));
      assert.ok(Array.isArray(cli(dir, 'questions', run).out), `${run} questions`);

      const hud = cli(dir, 'hud', run);
      assert.equal(hud.code, 0, `${run} hud: ${hud.err}`);
      const page = readFileSync(join(rd, 'hud.html'), 'utf8');
      assert.match(page, /<\/html>\s*$/);
      assert.ok(page.includes(run), `${run}: hud.html names the run`);
      for (const u of units) assert.ok(existsSync(join(rd, 'units', `${u}.html`)), `${run}: a page for unit ${u}`);

      const closed = Boolean(had.state.closed);
      const next = cli(dir, 'next', run);
      if (closed) assert.match(next.err, /is closed/);
      else assert.equal(next.code, 0, `${run} next: ${next.err}`);

      // A write turns an old state.json into a log whose replay is the snapshot.
      const note = cli(dir, 'note', run, '--kind', closed ? 'retro' : 'info', '--text', 'migration check');
      assert.equal(note.code, 0, `${run} note: ${note.err}`);
      const log = parseLog(readFileSync(join(rd, 'events.jsonl')));
      if (had.legacy) assert.equal(log.events[0].kind, 'run.imported');
      const now = readRun(rd);
      assert.ok(!now.rebuilt && !now.edited, `${run}: the snapshot matches the log`);
      assert.deepEqual(replay(log.events), now.state);
      assert.equal(now.state.goal, had.state.goal);
      assert.deepEqual(now.state.units.map((u) => u.id), units);

      // Pit stop and back, as another machine would.
      const pit = join(tmp, `${src.name}-pit`);
      const pushed = cli(dir, 'push', run, '--to', pit);
      assert.equal(pushed.code, 0, `${run} push: ${pushed.err}`);
      const other = join(tmp, `${src.name}-other`);
      const pulled = cli(other, 'pull', run, '--from', pit);
      assert.equal(pulled.code, 0, `${run} pull: ${pulled.err}`);
      const there = readRun(join(other, 'runs', run));
      assert.equal(there.seq, log.events.length);
      assert.deepEqual(there.state.units.map((u) => u.id), units);
      assert.equal(cli(other, 'show', run).code, 0);
    }
    assert.deepEqual(digest(src.dir), before, 'the source folder was not written to');
  });
}
