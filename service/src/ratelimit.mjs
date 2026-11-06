// Fixed-window counters per key, in memory (one container). hit() returns 0
// when allowed, else the seconds until the window resets.
export function limiter({ max, windowMs, now = Date.now }) {
  const hits = new Map();
  return {
    hit(key) {
      const t = now();
      let w = hits.get(key);
      if (!w || t >= w.reset) {
        if (hits.size > 50_000) for (const [k, x] of hits) if (t >= x.reset) hits.delete(k);
        w = { n: 0, reset: t + windowMs };
        hits.set(key, w);
      }
      w.n += 1;
      return w.n > max ? Math.ceil((w.reset - t) / 1000) : 0;
    },
    // Like hit(), without counting: the seconds to wait when the next hit would be refused, else 0.
    blocked(key) {
      const t = now();
      const w = hits.get(key);
      return w && t < w.reset && w.n >= max ? Math.ceil((w.reset - t) / 1000) : 0;
    },
  };
}
