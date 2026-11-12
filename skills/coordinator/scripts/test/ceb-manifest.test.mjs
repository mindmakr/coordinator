// The CEB suite manifest (references/ceb-manifest.md): the format is checked, an image
// is pinned by digest, and only a manifest signed with a trusted key is opened.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { SUITE_KEYS } from '../lib/ceb/keys.mjs';
import { imageProblem, keyId, manifestProblems, openManifest, parseManifest, publicOf, signManifest } from '../lib/ceb/manifest.mjs';

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pem: privateKey.export({ format: 'pem', type: 'pkcs8' }), spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), privateKey };
}
const owner = keyPair();
const digest = (c) => `sha256:${c.repeat(64)}`;
const task = (over = {}) => ({ id: 'refund-crosses-month', category: 'bug-fix', image: `ghcr.io/mindmakr/ceb-refund-crosses-month@${digest('a')}`, created: '2026-11-20', humanMinutes: 45, ...over });
const suite = (over = {}) => ({
  schema: 1,
  suite: 'CEB-2026.12',
  canary: '3f6c1e0a-7b2d-4c58-9e41-0d5a8b7c6f12',
  tasks: [task(), task({ id: 'page-size-cap', category: 'feature', image: `ghcr.io/mindmakr/ceb-page-size-cap@${digest('b')}`, humanMinutes: 90 })],
  ...over,
});
const bytes = (m) => Buffer.from(`${JSON.stringify(m, null, 2)}\n`);
const sigText = (s) => JSON.stringify(s);
// A signature made outside the module, as the reference documents it: Ed25519 over the context line and the bytes.
const rawSign = (buf, key = owner.privateKey, context = 'coordinator-ceb-manifest-v1\n') => sigText({ schema: 1, algorithm: 'ed25519', keyId: keyId(owner.spki), signature: sign(null, Buffer.concat([Buffer.from(context), buf]), key).toString('base64') });

test('a valid manifest signed with a trusted key opens, with the key and the hash of its bytes', () => {
  const buf = bytes(suite());
  const sig = signManifest(buf, owner.pem);
  assert.deepEqual(Object.keys(sig), ['schema', 'algorithm', 'keyId', 'signature']);
  assert.equal(sig.keyId, keyId(owner.spki));
  assert.deepEqual(publicOf(owner.pem), { publicKey: owner.spki, keyId: sig.keyId });
  const opened = openManifest(buf, sigText(sig), [keyPair().spki, owner.spki]);
  assert.deepEqual(opened.manifest, suite());
  assert.equal(opened.keyId, sig.keyId);
  assert.match(opened.sha256, /^[0-9a-f]{64}$/);
  // The documented rule gives the same signature: Ed25519 is deterministic.
  assert.equal(rawSign(buf), sigText(sig));
});

test('one changed byte in the manifest fails verification', () => {
  const buf = bytes(suite());
  const sig = sigText(signManifest(buf, owner.pem));
  for (const at of [0, buf.indexOf('45'), buf.indexOf('aaaa') + 10, buf.length - 1]) {
    const changed = Buffer.from(buf); changed[at] ^= 1;
    assert.throws(() => openManifest(changed, sig, [owner.spki]), /signature does not fit the manifest/, `byte ${at}`);
  }
  // A still-valid manifest with another digest is refused the same way.
  const swapped = bytes(suite({ tasks: [task({ image: `ghcr.io/mindmakr/ceb-refund-crosses-month@${digest('c')}` })] }));
  assert.throws(() => openManifest(swapped, sig, [owner.spki]), /signature does not fit/);
});

test('a changed, short or malformed signature is refused', () => {
  const buf = bytes(suite());
  const sig = signManifest(buf, owner.pem);
  const raw = Buffer.from(sig.signature, 'base64'); raw[5] ^= 1;
  assert.throws(() => openManifest(buf, sigText({ ...sig, signature: raw.toString('base64') }), [owner.spki]), /signature does not fit/);
  assert.throws(() => openManifest(buf, sigText({ ...sig, signature: raw.subarray(0, 32).toString('base64') }), [owner.spki]), /64 bytes/);
  assert.throws(() => openManifest(buf, sigText({ ...sig, algorithm: 'rsa' }), [owner.spki]), /algorithm must be ed25519/);
  assert.throws(() => openManifest(buf, sigText({ ...sig, schema: 2 }), [owner.spki]), /signature schema/);
  assert.throws(() => openManifest(buf, 'not json', [owner.spki]), /not valid JSON/);
  assert.throws(() => openManifest(buf, '[]', [owner.spki]), /JSON object/);
});

test('a manifest signed with a key this release does not trust is refused', () => {
  const buf = bytes(suite());
  const sig = sigText(signManifest(buf, keyPair().pem));
  assert.throws(() => openManifest(buf, sig, [owner.spki]), /does not trust/);
  assert.throws(() => openManifest(buf, sig, []), /ships no suite key/);
  // The right key id with another key's signature does not pass either.
  assert.throws(() => openManifest(buf, rawSign(buf, keyPair().privateKey), [owner.spki]), /signature does not fit/);
});

test('a signature made for something else does not fit a manifest', () => {
  const buf = bytes(suite());
  assert.throws(() => openManifest(buf, rawSign(buf, owner.privateKey, ''), [owner.spki]), /signature does not fit/);
  assert.throws(() => openManifest(buf, rawSign(buf, owner.privateKey, 'coordinator-ceb-ledger-v1\n'), [owner.spki]), /signature does not fit/);
});

test('an image with a tag instead of a digest is refused with a clear message', () => {
  const tagged = suite({ tasks: [task({ image: 'ghcr.io/mindmakr/ceb-refund-crosses-month:latest' })] });
  const said = manifestProblems(tagged);
  assert.equal(said.length, 1);
  assert.match(said[0], /^task refund-crosses-month: image must be pinned by digest \(name@sha256:<64 hex>\), but "ghcr\.io\/mindmakr\/ceb-refund-crosses-month:latest" has a tag/);
  assert.throws(() => parseManifest(bytes(tagged)), /pinned by digest/);
  // It is never signed, and a signature someone made anyway does not get it opened.
  assert.throws(() => signManifest(bytes(tagged), owner.pem), /pinned by digest/);
  assert.throws(() => openManifest(bytes(tagged), rawSign(bytes(tagged)), [owner.spki]), /pinned by digest/);
});

test('only registry/path@sha256:<64 hex> is an image reference', () => {
  assert.equal(imageProblem(`ghcr.io/mindmakr/ceb-a@${digest('a')}`), null);
  assert.equal(imageProblem(`localhost:5000/ceb/a_b.c@${digest('0')}`), null);
  assert.match(imageProblem('ghcr.io/mindmakr/ceb-a'), /has none/);
  assert.match(imageProblem('localhost:5000/ceb-a'), /has none/);
  assert.match(imageProblem(`ghcr.io/mindmakr/ceb-a:1.0@${digest('a')}`), /a digest and no tag/);
  assert.match(imageProblem('ghcr.io/mindmakr/ceb-a@sha256:abc'), /64 lowercase hex/);
  assert.match(imageProblem(`ghcr.io/mindmakr/ceb-a@${digest('A')}`), /64 lowercase hex/);
  assert.match(imageProblem(`ghcr.io/mindmakr/ceb-a@sha512:${'a'.repeat(128)}`), /64 lowercase hex/);
  assert.match(imageProblem(`ceb-a@${digest('a')}`), /registry\/path/);
  assert.match(imageProblem(`ghcr.io/Mindmakr/ceb-a@${digest('a')}`), /registry\/path/);
  assert.match(imageProblem(`--privileged/x@${digest('a')}`), /registry\/path/);
  assert.match(imageProblem(undefined), /missing/);
});

test('a task id used twice is refused', () => {
  const twice = suite({ tasks: [task(), task({ image: `ghcr.io/mindmakr/ceb-other@${digest('d')}` })] });
  assert.deepEqual(manifestProblems(twice), ['task id "refund-crosses-month" is used twice']);
  assert.throws(() => parseManifest(bytes(twice)), /used twice/);
  assert.throws(() => signManifest(bytes(twice), owner.pem), /used twice/);
});

test('two tasks cannot share an image', () => {
  const shared = suite({ tasks: [task(), task({ id: 'other' })] });
  assert.deepEqual(manifestProblems(shared), ['tasks "refund-crosses-month" and "other" name the same image: each task has its own']);
});

test('every field is checked, and every problem is listed', () => {
  assert.deepEqual(manifestProblems(suite()), []);
  const one = (over, re) => { const said = manifestProblems(over); assert.equal(said.length, 1, said.join(' | ')); assert.match(said[0], re); };
  one(suite({ suite: 'CEB-2026.13' }), /suite must look like CEB-2026\.12/);
  one(suite({ suite: 'ceb-2026.12' }), /suite must look like/);
  one(suite({ canary: '3F6C1E0A-7B2D-4C58-9E41-0D5A8B7C6F12' }), /canary must be a lowercase GUID/);
  one(suite({ schema: 2 }), /newer than this release reads/);
  one(suite({ schema: '1' }), /schema must be 1/);
  one(suite({ tasks: [] }), /1 to 200 tasks/);
  one(suite({ prices: {} }), /manifest: unknown field "prices"/);
  one(suite({ tasks: [task({ note: 'x' })] }), /tasks\[0\]: unknown field "note"/);
  one(suite({ tasks: [task({ id: 'Refund' })] }), /tasks\[0\]: id must be lowercase/);
  one(suite({ tasks: [task({ id: 'nul' })] }), /tasks\[0\]: id must be/);
  one(suite({ tasks: [task({ category: 'bugfix' })] }), /category must be one of bug-fix, feature, refactor, security-fix, ui/);
  one(suite({ tasks: [task({ created: '2026-02-30' })] }), /created must be a date as YYYY-MM-DD/);
  one(suite({ tasks: [task({ created: '20 Nov 2026' })] }), /created must be a date/);
  one(suite({ tasks: [task({ humanMinutes: 0 })] }), /humanMinutes must be a whole number/);
  one(suite({ tasks: [task({ humanMinutes: 45.5 })] }), /humanMinutes must be a whole number/);
  one(suite({ tasks: [task({ humanMinutes: '45' })] }), /humanMinutes must be a whole number/);
  one(suite({ tasks: ['refund'] }), /tasks\[0\]: must be an object/);
  assert.deepEqual(manifestProblems([]), ['the manifest must be a JSON object']);
  const many = manifestProblems(suite({ suite: 'x', tasks: [task({ category: 'x', created: 'x' })] }));
  assert.equal(many.length, 3);
  assert.throws(() => parseManifest(bytes(suite({ suite: 'x', canary: 'x' }))), /not valid:\n- suite must.*\n- canary must/);
});

test('bytes that are not a UTF-8 JSON manifest are refused', () => {
  assert.throws(() => parseManifest('{'), /not valid JSON/);
  assert.throws(() => parseManifest(Buffer.from([0xff, 0xfe, 0x7b, 0x7d])), /not valid UTF-8/);
  assert.throws(() => parseManifest(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(suite())])), /byte-order mark/);
  assert.throws(() => parseManifest(Buffer.alloc(1024 * 1024 + 1, 0x20)), /larger than/);
  assert.throws(() => parseManifest(42), /bytes or text/);
  assert.deepEqual(parseManifest(JSON.stringify(suite())), suite());
});

test('only Ed25519 keys sign or verify', () => {
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const buf = bytes(suite());
  assert.throws(() => signManifest(buf, ec.privateKey.export({ format: 'pem', type: 'pkcs8' })), /not ed25519/);
  assert.throws(() => signManifest(buf, 'not a key'), /not a private key in PEM/);
  const sig = sigText(signManifest(buf, owner.pem));
  assert.throws(() => openManifest(buf, sig, [ec.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')]), /not ed25519/);
  assert.throws(() => openManifest(buf, sig, ['AAAA']), /not a public key/);
});

test('every key shipped with the skill is a distinct Ed25519 public key', () => {
  const ids = SUITE_KEYS.map(keyId);
  assert.equal(new Set(ids).size, ids.length);
});
