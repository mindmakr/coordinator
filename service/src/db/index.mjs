// The read model's data layer. Two adapters share this contract: Postgres
// (db/postgres.mjs) and an in-memory one for tests and quick local runs
// (db/memory.mjs). Every query about a repo or a run is scoped by the GitHub
// installation id; guard() refuses a call without one, for both adapters.
//
// Rows hold only what GitHub already shows the reader: run state copied from
// the state branch (masked again on the way in), repo names, installation ids.
// Sessions hold encrypted tokens and a hash of the cookie, never the cookie.

const SCOPED = ['repos', 'removeRepo', 'setRepoSync', 'runs', 'run', 'putRun', 'dropRunsExcept', 'deleteInstallation'];

export function guard(db) {
  const out = { ...db };
  for (const name of SCOPED) {
    out[name] = (installationId, ...rest) => {
      if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error(`db.${name}: an installation id is required`);
      return db[name](installationId, ...rest);
    };
  }
  return out;
}

export async function openDb(url) {
  if (!url) return guard((await import('./memory.mjs')).memoryDb());
  const { postgresDb } = await import('./postgres.mjs');
  return guard(await postgresDb(url));
}
