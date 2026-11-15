// run.mjs called in process, for the tests that call it hundreds of times (#perf: a new node process per call cost
// ~0.1 s of start-up and module compile each). One worker thread loads run.mjs once and runs main() for each call;
// the caller blocks until it is done, so a call stays synchronous and returns what spawnSync would:
// { status, stdout, stderr }. Every call gets its own environment and working folder.
//
// Commands that keep running or start processes of their own (serve, watch, dashboard) still get a real process,
// as does every call when COORDINATOR_TEST_SPAWN=1 (to compare the two). Tests of process behaviour (exit codes of a
// crashed child, signals, a detached dashboard) keep their own spawnSync.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageChannel, receiveMessageOnPort, Worker } from 'node:worker_threads';

export const RUN_MJS = join(dirname(fileURLToPath(import.meta.url)), '..', 'run.mjs');
const OWN_PROCESS = new Set(['serve', 'watch', 'dashboard']);
const CALL_MS = 120_000;

let worker = null; let port = null; let signal = null;
function start() {
  const channel = new MessageChannel();
  signal = new Int32Array(new SharedArrayBuffer(4));
  worker = new Worker(new URL('./inproc.worker.mjs', import.meta.url), { workerData: { port: channel.port2, signal, run: RUN_MJS }, transferList: [channel.port2], stdout: false, stderr: false });
  worker.unref();
  worker.on('error', () => { worker = null; });
  port = channel.port1;
}

// run.mjs <args…> with env (default process.env) in cwd (default this process's): { status, stdout, stderr }.
export function runSync(args, { env = process.env, cwd } = {}) {
  if (OWN_PROCESS.has(args[0]) || process.env.COORDINATOR_TEST_SPAWN === '1') {
    const r = spawnSync(process.execPath, [RUN_MJS, ...args], { env, cwd, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  if (!worker) start();
  Atomics.store(signal, 0, 0);
  // As spawnSync does, a variable set to undefined is left out.
  port.postMessage({ args: args.map(String), env: Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])), cwd: resolve(cwd ?? process.cwd()) });
  if (Atomics.wait(signal, 0, 0, CALL_MS) === 'timed-out') {
    worker.terminate(); worker = null;
    throw new Error(`run.mjs ${args.join(' ')}: no result in ${CALL_MS / 1000} s`);
  }
  return receiveMessageOnPort(port).message;
}
