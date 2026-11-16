// The worker behind test/inproc.mjs: loads run.mjs once and runs its main() per message, with that call's
// environment and working folder, capturing what it prints and the code it exits with.
import { format } from 'node:util';
import { pathToFileURL } from 'node:url';
import { workerData } from 'node:worker_threads';

const { port, signal, run } = workerData;
class Exit { constructor(code) { this.code = code; } }
let mod = null;

port.on('message', async ({ args, env, cwd }) => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  const saved = { cwd: process.cwd, exit: process.exit, out: process.stdout.write, err: process.stderr.write, log: console.log, error: console.error, warn: console.warn, info: console.info };
  const out = []; const err = [];
  process.cwd = () => cwd;
  process.exit = (code = 0) => { throw new Exit(code); };
  process.stdout.write = (c) => { out.push(String(c)); return true; };
  process.stderr.write = (c) => { err.push(String(c)); return true; };
  console.log = console.info = (...a) => { out.push(`${format(...a)}\n`); };
  console.error = console.warn = (...a) => { err.push(`${format(...a)}\n`); };
  let status = 0;
  try {
    mod ??= await import(pathToFileURL(run).href);
    await mod.main(args);
    status = process.exitCode ?? 0;
  } catch (e) {
    if (e instanceof Exit) status = e.code ?? 0;
    else { err.push(`${e?.stack ?? e}\n`); status = 1; }
  } finally {
    process.exitCode = undefined;
    Object.assign(process, { cwd: saved.cwd, exit: saved.exit });
    process.stdout.write = saved.out; process.stderr.write = saved.err;
    Object.assign(console, { log: saved.log, error: saved.error, warn: saved.warn, info: saved.info });
  }
  port.postMessage({ status, stdout: out.join(''), stderr: err.join('') });
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
