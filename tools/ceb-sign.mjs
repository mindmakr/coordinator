#!/usr/bin/env node
// Signs a CEB suite manifest. For maintainers who hold the suite key: everyone else
// only verifies. The format and the signing rule are in
// skills/coordinator/references/ceb-manifest.md; the logic is lib/ceb/manifest.mjs.
//
//   node tools/ceb-sign.mjs keygen --out <file>        a new Ed25519 key pair: writes the private key to <file>
//                                                      (outside this repository, never over an existing file) and
//                                                      prints the public key for lib/ceb/keys.mjs
//   node tools/ceb-sign.mjs public --key <file>        the public key and id of a private key
//   node tools/ceb-sign.mjs check <manifest.json>      the format only: every problem, or ok
//   node tools/ceb-sign.mjs sign <manifest.json> --key <file> [--out <manifest.json.sig>]
//   node tools/ceb-sign.mjs verify <manifest.json> [--sig <file>] [--trust <public key>]
//                                                      against the keys in lib/ceb/keys.mjs, or the one given
//
// Prints JSON. The private key is read from the file you name, used and dropped: it is
// never printed, copied or sent anywhere. No network.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { helpAndExit, parse } from '../skills/coordinator/scripts/lib/args.mjs';
import { SUITE_KEYS } from '../skills/coordinator/scripts/lib/ceb/keys.mjs';
import { MAX_BYTES, openManifest, parseManifest, publicOf, signManifest } from '../skills/coordinator/scripts/lib/ceb/manifest.mjs';
import { writeAtomic } from '../skills/coordinator/scripts/lib/store.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const str = (v, name) => { if (typeof v !== 'string' || !v.trim()) throw new Error(`missing --${name}`); return v; };
function file(f, what, max = MAX_BYTES) {
  if (typeof f !== 'string' || !existsSync(f) || !statSync(f).isFile()) throw new Error(`${what}: no file ${f}`);
  if (statSync(f).size > max) throw new Error(`${what}: ${f} is larger than ${max} bytes`);
  return readFileSync(f);
}
const inRepo = (f) => { const rel = relative(repo, resolve(f)); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
const keyOf = (o) => file(str(o.key, 'key'), '--key', 16 * 1024).toString('utf8');
const summary = (m) => ({ suite: m.suite, tasks: m.tasks.length });

const commands = {
  keygen(_, o) {
    const out = str(o.out, 'out');
    if (inRepo(out)) throw new Error(`--out ${out} is inside this repository: keep the private key outside it`);
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
    try { writeFileSync(out, pem, { flag: 'wx', mode: 0o600 }); } catch (e) {
      throw new Error(e.code === 'EEXIST' ? `${out} exists: a key is never written over` : `cannot write ${out}: ${e.code ?? e.message}`);
    }
    return { privateKeyFile: resolve(out), ...publicOf(pem), next: 'Add publicKey to SUITE_KEYS in skills/coordinator/scripts/lib/ceb/keys.mjs. Keep the private key file where only you can read it, with a copy offline.' };
  },
  public: (_, o) => { const pub = publicOf(keyOf(o)); return { ...pub, trusted: SUITE_KEYS.includes(pub.publicKey) }; },
  check: ([manifest]) => ({ ok: true, ...summary(parseManifest(file(manifest, 'manifest'))) }),
  sign([manifest], o) {
    const bytes = file(manifest, 'manifest');
    const pem = keyOf(o);
    const sig = signManifest(bytes, pem);
    const pub = publicOf(pem);
    const text = `${JSON.stringify(sig, null, 2)}\n`;
    const opened = openManifest(bytes, text, [pub.publicKey]);
    const out = typeof o.out === 'string' ? o.out : `${manifest}.sig`;
    writeAtomic(out, text);
    const trusted = SUITE_KEYS.includes(pub.publicKey);
    return { signature: resolve(out), ...summary(opened.manifest), keyId: sig.keyId, sha256: opened.sha256, trusted, ...(trusted ? {} : { warning: 'this key is not in lib/ceb/keys.mjs, so no release of the coordinator will open this manifest' }) };
  },
  verify([manifest], o) {
    const bytes = file(manifest, 'manifest');
    const sig = file(typeof o.sig === 'string' ? o.sig : `${manifest}.sig`, 'signature', 4096);
    const opened = openManifest(bytes, sig, typeof o.trust === 'string' ? [o.trust] : SUITE_KEYS);
    return { ok: true, ...summary(opened.manifest), keyId: opened.keyId, sha256: opened.sha256 };
  },
};

helpAndExit(import.meta.url);
try {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!Object.hasOwn(commands, cmd ?? '')) throw new Error(`usage: ceb-sign.mjs ${Object.keys(commands).join('|')} … (--help for the options)`);
  const { pos, opt } = parse(argv, ['out', 'key', 'sig', 'trust']);
  console.log(JSON.stringify(commands[cmd](pos, opt), null, 2));
} catch (e) { console.error(`error: ${e.message}`); process.exitCode = 2; }
