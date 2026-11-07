// Loaded before every test file (package.json: node --import … --test). Points the
// machine-wide run register (lib/registry.mjs) at a temporary folder, so no test
// writes to the person's real ~/.coordinator. Child processes inherit it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.COORDINATOR_HOME) {
  const home = mkdtempSync(join(tmpdir(), 'coord-home-'));
  process.env.COORDINATOR_HOME = home;
  process.on('exit', () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* in use */ } });
}
