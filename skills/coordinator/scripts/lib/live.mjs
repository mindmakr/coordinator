// Server-Sent Events for the live dashboard. One timer checks the state's
// version (cheap: its file's mtime and size); on a change, and once a minute
// for the clocks, each client gets its page's <main> again and patches it in
// place. A ping every 15 s keeps proxies and the page's watchdog content.
const MAIN = /<main id="app">([\s\S]*)<\/main>/;
export const main = (html) => MAIN.exec(html ?? '')?.[1] ?? null;

export function hub({ version, render, pollMs = 500, pingMs = 15_000, refreshMs = 60_000 }) {
  const clients = new Set();
  let seen = null; let lastPing = Date.now(); let lastSend = Date.now();
  const write = (c, s) => { try { c.res.write(s); } catch { clients.delete(c); } };

  function push(force = false) {
    const cache = new Map();
    for (const c of clients) {
      if (!cache.has(c.path)) { try { cache.set(c.path, main(render(c.path))); } catch { cache.set(c.path, null); } }
      const html = cache.get(c.path);
      if (html !== null && (force || html !== c.last)) { c.last = html; write(c, `event: patch\ndata: ${JSON.stringify({ html })}\n\n`); }
    }
    lastSend = Date.now();
  }

  const timer = setInterval(() => {
    if (!clients.size) return;
    let v; try { v = version(); } catch { v = seen; }
    if (v !== seen || Date.now() - lastSend >= refreshMs) { seen = v; push(); }
    if (Date.now() - lastPing >= pingMs) { lastPing = Date.now(); for (const c of clients) write(c, 'event: ping\ndata: {}\n\n'); }
  }, pollMs);
  timer.unref?.();

  return {
    add(req, res, path) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
      res.write('retry: 2000\n\n');
      const c = { res, path, last: null };
      clients.add(c);
      req.on('close', () => clients.delete(c));
      seen = version();
      push(); // the current page at once: a reconnect never misses a change
    },
    size: () => clients.size,
    close() { clearInterval(timer); for (const c of clients) try { c.res.end(); } catch { /* gone */ } clients.clear(); },
  };
}
