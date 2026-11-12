// The CEB suite manifest (references/ceb-manifest.md): which tasks a suite version
// holds, each with its image pinned by digest, and the detached Ed25519 signature
// that says the manifest is ours. Node built-ins only. Pure: bytes and keys in,
// a manifest or an error out; nothing is read, written or fetched here.
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';
import { isSafeId } from '../store.mjs';
import { SUITE_KEYS } from './keys.mjs';

export const SCHEMA = 1;
export const CATEGORIES = ['bug-fix', 'feature', 'refactor', 'security-fix', 'ui'];
export const MAX_BYTES = 1024 * 1024;
const MAX_TASKS = 200;
const MAX_MINUTES = 10_080; // a week
// Signed with the manifest's bytes, so a signature made for anything else never fits a manifest.
const CONTEXT = 'coordinator-ceb-manifest-v1\n';

const SUITE = /^CEB-\d{4}\.(0[1-9]|1[0-2])$/;
const TASK_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HOST = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::\d{1,5})?$/;
const PATH = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const KEY_ID = /^[0-9a-f]{16}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const shown = (v) => { const s = JSON.stringify(v) ?? String(v); return s.length > 120 ? `${s.slice(0, 117)}...` : s; };

function realDate(v) {
  const m = typeof v === 'string' ? DATE.exec(v) : null;
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

// Why an image reference is refused, or null. Only `registry/path@sha256:<64 hex>` is
// accepted: a tag can be moved to other bytes, a digest cannot.
export function imageProblem(v) {
  if (typeof v !== 'string' || !v) return 'image is missing';
  if (v.length > 300) return 'image is longer than 300 characters';
  const at = v.indexOf('@');
  const name = at < 0 ? v : v.slice(0, at);
  const tagged = name.slice(name.lastIndexOf('/') + 1).includes(':');
  if (at < 0) {
    return tagged
      ? `image must be pinned by digest (name@sha256:<64 hex>), but ${shown(v)} has a tag: a tag can be moved to other bytes`
      : `image must be pinned by digest (name@sha256:<64 hex>), but ${shown(v)} has none`;
  }
  if (tagged) return `image must have a digest and no tag, got ${shown(v)}`;
  if (!DIGEST.test(v.slice(at + 1))) return `image digest must be sha256: and 64 lowercase hex characters, got ${shown(v)}`;
  const [host, ...path] = name.split('/');
  if (!path.length || !HOST.test(host) || !path.every((p) => PATH.test(p))) return `image name must be registry/path in lowercase, got ${shown(name)}`;
  return null;
}

function extraKeys(o, allowed, at) {
  return Object.keys(o).filter((k) => !allowed.includes(k)).map((k) => `${at}: unknown field ${shown(k)}`);
}

function taskProblems(t, at) {
  if (!isObject(t)) return [`${at}: must be an object`];
  const out = extraKeys(t, ['id', 'category', 'image', 'created', 'humanMinutes'], at);
  const idOk = typeof t.id === 'string' && TASK_ID.test(t.id) && isSafeId(t.id);
  const who = idOk ? `task ${t.id}` : at;
  if (!idOk) out.push(`${at}: id must be lowercase letters, digits and hyphens, at most 63 characters, got ${shown(t.id)}`);
  if (!CATEGORIES.includes(t.category)) out.push(`${who}: category must be one of ${CATEGORIES.join(', ')}, got ${shown(t.category)}`);
  const image = imageProblem(t.image);
  if (image) out.push(`${who}: ${image}`);
  if (!realDate(t.created)) out.push(`${who}: created must be a date as YYYY-MM-DD, got ${shown(t.created)}`);
  if (!Number.isInteger(t.humanMinutes) || t.humanMinutes < 1 || t.humanMinutes > MAX_MINUTES) out.push(`${who}: humanMinutes must be a whole number of minutes from 1 to ${MAX_MINUTES}, got ${shown(t.humanMinutes)}`);
  return out;
}

// Every problem with a parsed manifest, in plain words; [] when it is valid.
export function manifestProblems(m) {
  if (!isObject(m)) return ['the manifest must be a JSON object'];
  const out = extraKeys(m, ['schema', 'suite', 'canary', 'tasks'], 'manifest');
  if (m.schema !== SCHEMA) {
    out.push(Number.isInteger(m.schema) && m.schema > SCHEMA
      ? `manifest schema ${m.schema} is newer than this release reads (${SCHEMA}): update the coordinator`
      : `schema must be ${SCHEMA}, got ${shown(m.schema)}`);
  }
  if (typeof m.suite !== 'string' || !SUITE.test(m.suite)) out.push(`suite must look like CEB-2026.12 (year and month), got ${shown(m.suite)}`);
  if (typeof m.canary !== 'string' || !UUID.test(m.canary)) out.push(`canary must be a lowercase GUID (8-4-4-4-12 hex), got ${shown(m.canary)}`);
  if (!Array.isArray(m.tasks) || !m.tasks.length || m.tasks.length > MAX_TASKS) {
    out.push(`tasks must be a list of 1 to ${MAX_TASKS} tasks`);
    return out;
  }
  const ids = new Set(); const images = new Map();
  m.tasks.forEach((t, i) => {
    out.push(...taskProblems(t, `tasks[${i}]`));
    if (!isObject(t)) return;
    if (typeof t.id === 'string') {
      if (ids.has(t.id)) out.push(`task id ${shown(t.id)} is used twice`);
      ids.add(t.id);
    }
    if (typeof t.image === 'string' && !imageProblem(t.image)) {
      const first = images.get(t.image);
      if (first !== undefined) out.push(`tasks ${shown(first)} and ${shown(t.id)} name the same image: each task has its own`);
      else images.set(t.image, t.id);
    }
  });
  return out;
}

const bytesOf = (v, what) => {
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  throw new Error(`${what} must be bytes or text`);
};

// The manifest in these bytes, or an error that lists every problem. This checks the
// format only: `openManifest` is the one that also checks who signed it.
export function parseManifest(bytes) {
  const buf = bytesOf(bytes, 'the manifest');
  if (buf.length > MAX_BYTES) throw new Error(`the manifest is larger than ${MAX_BYTES} bytes`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); } catch { throw new Error('the manifest is not valid UTF-8'); }
  if (text.startsWith('﻿')) throw new Error('the manifest starts with a byte-order mark: save it as UTF-8 without one');
  let value;
  try { value = JSON.parse(text); } catch (e) { throw new Error(`the manifest is not valid JSON: ${e.message}`); }
  const problems = manifestProblems(value);
  if (problems.length) throw new Error(`the manifest is not valid:\n- ${problems.join('\n- ')}`);
  return value;
}

// An Ed25519 public key from base64 SPKI DER (lib/ceb/keys.mjs), with its id:
// the first 16 hex characters of the SHA-256 of that DER.
function publicKey(spki) {
  let der; let key;
  try {
    if (typeof spki !== 'string' || !BASE64.test(spki)) throw new Error('not base64');
    der = Buffer.from(spki, 'base64');
    key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch { throw new Error('a suite key is not a public key in base64 SPKI DER'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`a suite key is ${key.asymmetricKeyType}, not ed25519`);
  return { key, id: createHash('sha256').update(der).digest('hex').slice(0, 16) };
}
export const keyId = (spki) => publicKey(spki).id;

const message = (buf) => Buffer.concat([Buffer.from(CONTEXT, 'ascii'), buf]);

// The signature file's fields, or an error.
export function parseSignature(text) {
  let s;
  try { s = JSON.parse(bytesOf(text, 'the signature').toString('utf8').replace(/^﻿/, '')); } catch { throw new Error('the signature file is not valid JSON'); }
  if (!isObject(s)) throw new Error('the signature file must be a JSON object');
  if (s.schema !== SCHEMA) throw new Error(`signature schema must be ${SCHEMA}, got ${shown(s.schema)}`);
  if (s.algorithm !== 'ed25519') throw new Error(`signature algorithm must be ed25519, got ${shown(s.algorithm)}`);
  if (typeof s.keyId !== 'string' || !KEY_ID.test(s.keyId)) throw new Error('signature keyId must be 16 hex characters');
  const sig = typeof s.signature === 'string' && BASE64.test(s.signature) ? Buffer.from(s.signature, 'base64') : null;
  if (!sig || sig.length !== 64) throw new Error('signature must be 64 bytes in base64');
  return { keyId: s.keyId, signature: sig };
}

// Checks the signature over the manifest's exact bytes against the trusted keys, then
// the format. Returns { manifest, keyId, sha256 }; throws with the reason otherwise.
// Nothing in the manifest is read before its signature fits.
export function openManifest(bytes, signature, keys = SUITE_KEYS) {
  const buf = bytesOf(bytes, 'the manifest');
  if (buf.length > MAX_BYTES) throw new Error(`the manifest is larger than ${MAX_BYTES} bytes`);
  const sig = parseSignature(signature);
  if (!Array.isArray(keys) || !keys.length) throw new Error('this release of the coordinator ships no suite key, so no manifest can be verified: update the coordinator');
  const trusted = keys.map(publicKey).find((k) => k.id === sig.keyId);
  if (!trusted) throw new Error(`the manifest is signed with key ${sig.keyId}, which this release of the coordinator does not trust: update the coordinator, or the manifest is not ours`);
  if (!edVerify(null, message(buf), trusted.key, sig.signature)) throw new Error('the signature does not fit the manifest: it was changed after it was signed, or signed for something else');
  return { manifest: parseManifest(buf), keyId: trusted.id, sha256: createHash('sha256').update(buf).digest('hex') };
}

function privateKey(pem) {
  let key;
  try { key = createPrivateKey(pem); } catch { throw new Error('the signing key is not a private key in PEM'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`the signing key is ${key.asymmetricKeyType}, not ed25519`);
  return key;
}

// The public half of a private key (PEM), as lib/ceb/keys.mjs holds it, with its id.
export function publicOf(privatePem) {
  const spki = createPublicKey(privateKey(privatePem)).export({ format: 'der', type: 'spki' }).toString('base64');
  return { publicKey: spki, keyId: keyId(spki) };
}

// The signature file for these manifest bytes. An invalid manifest is refused: it is
// never signed. The key is used and dropped; nothing here keeps or prints it.
export function signManifest(bytes, privatePem) {
  const buf = bytesOf(bytes, 'the manifest');
  parseManifest(buf);
  return { schema: SCHEMA, algorithm: 'ed25519', keyId: publicOf(privatePem).keyId, signature: edSign(null, message(buf), privateKey(privatePem)).toString('base64') };
}
