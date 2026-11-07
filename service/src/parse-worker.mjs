// The worker side of parser.mjs: the same pure readers ingest.mjs exports, run off the main thread.
import { parentPort } from 'node:worker_threads';
import { readJson, readLog, readMap } from './ingest.mjs';

const buf = (b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength);
parentPort.on('message', ({ id, op, args }) => {
  let result;
  try {
    result = op === 'log' ? readLog(args[0], buf(args[1])) : op === 'map' ? readMap(buf(args[0])) : op === 'json' ? readJson(args[0], buf(args[1])) : { error: `unknown read ${op}` };
  } catch (e) { result = { error: String(e?.message ?? e).slice(0, 200) }; }
  parentPort.postMessage({ id, result });
});
