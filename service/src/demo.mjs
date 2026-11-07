// npm run demo -- --runs <project>/.coordinator/runs/<run> [--runs …] [--port 7480] [--host 127.0.0.1]
// The service on this machine only, with copies of real runs and a pretend GitHub
// (src/demo/index.mjs). Ctrl+C stops it and deletes the copies.
import { parseArgs } from 'node:util';
import { startDemo } from './demo/index.mjs';

const USAGE = 'usage: npm run demo -- --runs <project>/.coordinator/runs/<run> [--runs …] [--port 7480] [--host 127.0.0.1|::1]';

let args;
try {
  args = parseArgs({ options: { runs: { type: 'string', multiple: true }, port: { type: 'string', default: '7480' }, host: { type: 'string', default: '127.0.0.1' }, help: { type: 'boolean' } } }).values;
} catch (e) { console.error(`${e.message}\n${USAGE}`); process.exit(2); }
if (args.help || !args.runs?.length) { console.error(USAGE); process.exit(args.help ? 0 : 2); }
const port = Number(args.port);
if (!Number.isInteger(port) || port < 0 || port > 65_535) { console.error(`--port: not a port: ${args.port}`); process.exit(2); }

try {
  const demo = await startDemo({ runs: args.runs, host: args.host, port });
  const runs = demo.projects.flatMap((p) => p.runs.map((r) => `  ${p.repo}  ${r.id}`));
  console.log(`Coordinator local demo — nothing here is real or shared.\n\nCopied ${runs.length} run${runs.length === 1 ? '' : 's'} (the folders you passed are only read):\n${runs.join('\n')}`);
  for (const w of demo.warnings) console.log(`  not loaded: ${w}`);
  console.log(`\nOpen ${demo.url}/ and press "Demo sign in".\nControls: ${demo.url}/demo   Alerts outbox: ${demo.url}/demo/outbox\nCtrl+C stops it and deletes the copies (pid ${process.pid}).`);
  const stop = async () => { await demo.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (e) {
  console.error(`demo not started: ${e.message}`);
  process.exit(1);
}
