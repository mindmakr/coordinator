// Loaded before every test file (package.json: node --import … --test). Points the
// machine-wide run register (lib/registry.mjs) at a temporary folder, so no test
// writes to the person's real ~/.coordinator. Child processes inherit it. With that
// register temporary too, COORDINATOR_REGISTRY=on lets it record the tests' runs, whose
// state folders are in the system temporary folder (which the real register leaves out).
// The service tests load this file too (service/package.json).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.COORDINATOR_HOME) {
  const home = mkdtempSync(join(tmpdir(), 'coord-home-'));
  process.env.COORDINATOR_HOME = home;
  process.env.COORDINATOR_REGISTRY ??= 'on';
  process.on('exit', () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* in use */ } });
}

// One lead per run (lib/lead.mjs): tests never take this machine's window as the lead. Every
// child process leads as the same fixed id unless a test names another (--lead or its own env).
for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID']) delete process.env[k];
process.env.COORDINATOR_LEAD = 'test-lead';
