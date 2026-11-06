// `watch --remote`: pulls the run from its state branch every `everyMs` (at
// most 60 s, so an answer made on the web HUD or by a comment command lands
// within a minute), and at once whenever the doorbell rings. One pull at a
// time; a ring during a pull pulls again right after. A failing pull is
// reported once per distinct error and retried at the next tick.
export function remoteWatch({ pullOnce, everyMs = 30_000, say = () => {}, startBell = null }) {
  let busy = false; let again = false; let lastError = null;
  const tick = () => {
    if (busy) { again = true; return; }
    busy = true;
    try {
      pullOnce();
      if (lastError) { say('pull works again'); lastError = null; }
    } catch (e) {
      const msg = String(e.message ?? e).split('\n')[0].slice(0, 200);
      if (msg !== lastError) say(`pull failed: ${msg}`);
      lastError = msg;
    } finally {
      busy = false;
      if (again) { again = false; setImmediate(tick); }
    }
  };
  const timer = setInterval(tick, everyMs);
  const bell = startBell ? startBell(tick) : null;
  tick();
  return { tick, stop() { clearInterval(timer); bell?.stop(); } };
}
