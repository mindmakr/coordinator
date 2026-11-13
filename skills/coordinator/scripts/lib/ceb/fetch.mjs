// Fetches a CEB suite's manifest and its signature from the public tasks
// repository (references/ceb-bench.md). The only network call of `run.mjs bench
// plan`, made when the person runs it: two https GETs to one fixed host, no
// redirects, no credentials, a size limit and a timeout. What comes back is
// untrusted until lib/ceb/manifest.mjs has verified the signature.
import { MAX_BYTES } from './manifest.mjs';

export const SUITE_URL = 'https://raw.githubusercontent.com/mindmakr/coordinator-bench/main/suites';
export const SUITE_ID = /^CEB-\d{4}\.\d{2}$/;
const SIG_MAX = 4096;

export function suiteId(v) {
  if (typeof v !== 'string' || !SUITE_ID.test(v)) throw new Error(`--suite must look like CEB-2026.12, got: ${v}`);
  return v;
}

async function get(url, max, fetchFn, timeoutMs) {
  let res;
  try {
    res = await fetchFn(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json, text/plain' } });
  } catch (e) {
    throw new Error(`could not fetch ${url}: ${e.name === 'TimeoutError' ? `no answer in ${Math.round(timeoutMs / 1000)} s` : e.message}. Offline? Pass --manifest <file> --sig <file>`);
  }
  if (!res.ok) throw new Error(`could not fetch ${url}: HTTP ${res.status}`);
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new Error(`${url} is larger than ${max} bytes`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > max) throw new Error(`${url} is larger than ${max} bytes`);
  return bytes;
}

// { manifest: Buffer, signature: string }, exactly as published.
export async function fetchSuite(suite, { fetch: fetchFn = globalThis.fetch, timeoutMs = 15_000, base = SUITE_URL } = {}) {
  const dir = `${base}/${suiteId(suite)}`;
  const manifest = await get(`${dir}/manifest.json`, MAX_BYTES, fetchFn, timeoutMs);
  const signature = await get(`${dir}/manifest.json.sig`, SIG_MAX, fetchFn, timeoutMs);
  return { manifest, signature: signature.toString('utf8') };
}
