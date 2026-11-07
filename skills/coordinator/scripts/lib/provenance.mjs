// Which event last wrote one piece of a run's state. An approval only counts
// when the answer or note was last written by the command that records it
// (`answer`, `note`, or the same events replayed by `pull` or written by the
// service), never by a hand edit of state.json (recorded as `state.edited`).
import { apply, canonical } from './events.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));
const key = (v) => JSON.stringify(canonical(v ?? null));

// events: the run's log; locate(state) → the value to trace; current: the state
// in hand, which may hold a hand edit not yet in the log. Returns the event kind
// that last changed the value, 'state.edited' when the state in hand differs
// from the log, or null when the value never appeared.
export function lastWriter(events, locate, current) {
  let s = null; let last = null; let prev = key(null);
  for (const e of events) {
    s = e.kind === 'run.imported' ? clone(e.payload.state) : apply(s, e.payload.ops);
    let v; try { v = key(locate(s)); } catch { v = key(null); }
    if (v !== prev) { last = e.kind; prev = v; }
  }
  if (current !== undefined && key(locate(current)) !== prev) return 'state.edited';
  return last;
}
