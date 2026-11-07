// c14: where webhook deliveries come from. Client addresses are grouped (IPv6 by /64, since one
// host is usually given a whole /64; IPv4 by /24 for the webhook budget), and an address is
// checked against GitHub's published hook ranges ("hooks" in GET /meta), fetched at start and
// once a day. Until a fetch succeeds, or when one fails, the built-in list below is used.
import { isIP } from 'node:net';

// api.github.com/meta "hooks", 2026-11-07.
export const GITHUB_HOOKS = ['9.234.106.48/28', '9.234.98.160/28', '9.234.98.176/28', '192.30.252.0/22', '185.199.108.0/22', '140.82.112.0/20', '143.55.64.0/20', '2a0a:a440::/29', '2606:50c0::/32'];
export const HOOKS_REFRESH_MS = 24 * 3600_000;
const FETCH_MS = 10_000;

// An address as bytes (4 for IPv4, 16 for IPv6), or null. An IPv4-mapped IPv6 address
// (::ffff:a.b.c.d, as a dual-stack socket reports IPv4 clients) is IPv4.
export function ipBytes(raw) {
  const s = String(raw ?? '').trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const kind = isIP(s);
  if (kind === 4) return s.split('.').map(Number);
  if (kind !== 6) return null;
  // A dotted tail (::ffff:1.2.3.4) becomes its two hex words.
  const text = s.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_, a, b, c, d) => `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`);
  const [head, rest] = text.split('::');
  const words = (part) => (part ? part.split(':').map((w) => parseInt(w, 16)) : []);
  const a = words(head); const b = words(rest);
  const all = rest === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill(0), ...b];
  const bytes = all.flatMap((w) => [w >> 8, w & 255]);
  const mapped = bytes.slice(0, 10).every((x) => x === 0) && bytes[10] === 255 && bytes[11] === 255;
  return mapped ? bytes.slice(12) : bytes;
}

// The group an address counts under: its first v4Bits (IPv4) or v6Bits (IPv6) bits, as text.
// Anything that is not an address is its own group.
export function groupOf(raw, { v4Bits = 32, v6Bits = 64 } = {}) {
  const b = ipBytes(raw);
  if (!b) return String(raw);
  const bits = b.length === 4 ? v4Bits : v6Bits;
  const kept = b.map((x, i) => { const left = bits - i * 8; return left >= 8 ? x : left <= 0 ? 0 : x & (0xff << (8 - left)) & 0xff; });
  return b.length === 4 ? `${kept.join('.')}/${bits}` : `${kept.map((x) => x.toString(16).padStart(2, '0')).join('').replace(/(.{4})/g, '$1:').slice(0, -1)}/${bits}`;
}

// "a.b.c.d/n" or "x::/n" → { bytes, bits }, or null.
export function parseCidr(s) {
  const m = /^([^/\s]+)\/(\d{1,3})$/.exec(String(s ?? '').trim());
  const bytes = m && ipBytes(m[1]);
  if (!bytes || (m[1].includes(':') && bytes.length === 4)) return null;
  const bits = Number(m[2]);
  return bits <= bytes.length * 8 ? { bytes, bits } : null;
}
const inside = (bytes, c) => {
  if (bytes.length !== c.bytes.length) return false;
  for (let i = 0, left = c.bits; left > 0; i++, left -= 8) {
    const mask = left >= 8 ? 0xff : (0xff << (8 - left)) & 0xff;
    if ((bytes[i] & mask) !== (c.bytes[i] & mask)) return false;
  }
  return true;
};

// mode: 'github' (GitHub's hook ranges, fetched from `${api}/meta`), 'any' (every address counts as
// a delivery source: no reserve, no header trust by address), or a list of CIDRs (fixed, no fetch).
export function hookSources({ mode = 'github', api = 'https://api.github.com', fetchImpl = globalThis.fetch, log = null } = {}) {
  let ranges = (Array.isArray(mode) ? mode : GITHUB_HOOKS).map(parseCidr).filter(Boolean);
  let fetched = null; // when the list last came from GitHub
  let timer = null;
  async function refresh() {
    if (mode !== 'github') return false;
    try {
      const r = await fetchImpl(`${api}/meta`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'coordinator-service' }, signal: AbortSignal.timeout(FETCH_MS) });
      if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
      const list = (await r.json())?.hooks;
      const parsed = Array.isArray(list) ? list.slice(0, 1000).map(parseCidr).filter(Boolean) : [];
      if (!parsed.length) throw new Error('no hook ranges in the answer');
      ranges = parsed; fetched = new Date();
      log?.info('GitHub hook addresses fetched', { ranges: parsed.length });
      return true;
    } catch (e) {
      log?.warn('GitHub hook addresses not fetched; keeping the list in use', { error: e, fetched: fetched?.toISOString() ?? 'built-in' });
      return false;
    }
  }
  return {
    mode: Array.isArray(mode) ? 'list' : mode,
    any: mode === 'any',
    // Whether a delivery from this address comes from GitHub (always false in 'any' mode).
    trusted(ip) { if (mode === 'any') return false; const b = ipBytes(ip); return !!b && ranges.some((c) => inside(b, c)); },
    refresh,
    start(everyMs = HOOKS_REFRESH_MS) { refresh(); if (mode === 'github' && everyMs) { timer = setInterval(refresh, everyMs); timer.unref?.(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
