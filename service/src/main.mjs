// Starts the service: settings from the environment, the database (Postgres
// when DATABASE_URL is set, else in memory), then the HTTP server.
import { loadConfig } from './config.mjs';
import { openDb } from './db/index.mjs';
import { github } from './github.mjs';
import { logger } from './log.mjs';
import { createApp } from './server.mjs';

const log = logger();
try {
  const config = loadConfig();
  const db = await openDb(config.databaseUrl);
  if (db.kind === 'memory') log.warn('DATABASE_URL is not set: using an in-memory store, gone on restart');
  const app = createApp({ config, db, gh: github(config.github), log });
  app.server.listen(config.port, () => log.info('listening', { port: app.server.address().port, base: config.baseUrl, db: db.kind }));
  if (config.resyncMs) app.startResync(config.resyncMs);
  app.startAlerts(config.alerts.sweepMs);
  const stop = async () => {
    log.info('stopping');
    app.stopResync();
    app.stopAlerts();
    app.server.close();
    await app.idle();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (e) {
  // An AggregateError (a refused Postgres connection tried on IPv4 and IPv6) has an empty
  // message; its parts carry the cause.
  const parts = [e, ...(Array.isArray(e?.errors) ? e.errors : [])];
  const cause = [...new Set(parts.map((x) => [x?.code, x?.message].filter(Boolean).join(' ')).filter(Boolean))].join('; ') || String(e);
  log.error('could not start', { error: cause });
  process.exit(1);
}
