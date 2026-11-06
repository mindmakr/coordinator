#!/usr/bin/env node
// Operator commands, with the same settings as the service:
//   node src/cli.mjs sync <installation-id> [--force]   re-read every repo of an installation
//   node src/cli.mjs sync --all [--force]                every installation in the database
//   node src/cli.mjs migrate                             apply database migrations and exit
import { loadConfig } from './config.mjs';
import { openDb } from './db/index.mjs';
import { github } from './github.mjs';
import { ingester } from './ingest.mjs';
import { logger } from './log.mjs';

const [cmd, ...args] = process.argv.slice(2);
const log = logger(process.stderr);
const config = loadConfig();
const db = await openDb(config.databaseUrl);
try {
  if (cmd === 'migrate') {
    console.log(JSON.stringify({ ok: true, db: db.kind }));
  } else if (cmd === 'sync') {
    const force = args.includes('--force');
    const ids = args.includes('--all') ? await db.installationIds() : args.filter((a) => !a.startsWith('--')).map(Number);
    if (!ids.length || ids.some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new Error('usage: sync <installation-id> | --all [--force]');
    const ingest = ingester({ db, gh: github(config.github), branch: config.stateBranch, log });
    const out = [];
    for (const id of ids) {
      if (!(await db.installation(id))) await db.upsertInstallation({ id, account: '' });
      out.push({ installation: id, repos: await ingest.syncInstallation(id, { force }) });
      await db.audit('sync.manual', { installationId: id, detail: { force } });
    }
    console.log(JSON.stringify(out, null, 2));
  } else {
    throw new Error('usage: cli.mjs sync <installation-id> [--force] | sync --all | migrate');
  }
} catch (e) {
  log.error(e.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
