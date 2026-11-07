#!/usr/bin/env node
// Operator commands, with the same settings as the service:
//   node src/cli.mjs sync <installation-id> [--force]   re-read every repo of an installation
//   node src/cli.mjs sync --all [--force]                every installation in the database
//   node src/cli.mjs migrate                             apply database migrations and exit
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { openDb } from './db/index.mjs';
import { github } from './github.mjs';
import { ingester } from './ingest.mjs';
import { logger } from './log.mjs';

// `sync` with its arguments. c14: an installation this service does not know is stored only once
// GitHub has confirmed it (it issues a token for it), and never one that was uninstalled.
export async function sync({ db, gh, ingest, args }) {
  const force = args.includes('--force');
  const ids = args.includes('--all') ? await db.installationIds() : args.filter((a) => !a.startsWith('--')).map(Number);
  if (!ids.length || ids.some((n) => !Number.isSafeInteger(n) || n <= 0)) throw new Error('usage: sync <installation-id> | --all [--force]');
  const out = [];
  for (const id of ids) {
    if (!(await db.installation(id))) {
      if (await db.wasUninstalled(id)) throw new Error(`installation ${id} was uninstalled; it is not read again`);
      await gh.installationToken(id); // throws when GitHub does not know the installation
      if (!(await db.upsertInstallation({ id, account: '' }))) throw new Error(`installation ${id} was uninstalled; it is not read again`);
    }
    out.push({ installation: id, repos: await ingest.syncInstallation(id, { force }) });
    await db.audit('sync.manual', { installationId: id, detail: { force } });
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...args] = process.argv.slice(2);
  const log = logger(process.stderr);
  const config = loadConfig();
  const db = await openDb(config.databaseUrl);
  let ingest = null;
  try {
    if (cmd === 'migrate') {
      console.log(JSON.stringify({ ok: true, db: db.kind }));
    } else if (cmd === 'sync') {
      const gh = github(config.github);
      ingest = ingester({ db, gh, branch: config.stateBranch, log });
      console.log(JSON.stringify(await sync({ db, gh, ingest, args }), null, 2));
    } else {
      throw new Error('usage: cli.mjs sync <installation-id> [--force] | sync --all | migrate');
    }
  } catch (e) {
    log.error(e.message);
    process.exitCode = 1;
  } finally {
    await ingest?.close();
    await db.close();
  }
}
