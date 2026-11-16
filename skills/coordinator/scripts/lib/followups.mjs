// Follow-ups are triaged as they arrive (the owner's rule, 2026-11-16): small items (a doc fix, a test tightening,
// a one-line code fix) ride in one batch unit that builds last, with one test run and one critic; anything bigger
// is an issue with a priority (P1-P3; P1 and P2 are filed); or it is dropped with the reason. Never a unit or a
// round each. Pure: run.mjs followup records it, rules.mjs holds the batch unit until every other unit is done.

export const TRIAGE = ['batch', 'P1', 'P2', 'P3', 'drop'];
export const BATCH = 'batch'; // the batch unit's id

// The batch items on the run: follow-up notes triaged batch, in the order they came.
export const batchItems = (s) => (s.notes ?? []).filter((n) => n.kind === 'follow-up' && n.triage === 'batch');

// The batch unit's bar: its items as a closed list.
export const BAR_MAX = 2000;
export const batchBar = (items) => `every batch item is done, with one test run: ${items.map((n, i) => `(${i + 1}) ${n.text}`).join('; ')}`;

// Records one follow-up (a note) and, for a batch item, makes or extends the batch unit. Returns
// { note, unit?, file? }: unit is the batch unit's id when one was made or extended; file says to file it (P1, P2).
export function addFollowup(s, { text, triage, reason, unit = null, at }) {
  if (!TRIAGE.includes(triage)) throw new Error(`--triage must be one of: ${TRIAGE.join(', ')}`);
  const note = { kind: 'follow-up', text, triage, reason, at, ...(unit ? { unit } : {}) };
  if (triage === 'batch') {
    let b = s.units.find((u) => u.id === BATCH);
    if (b && !b.batch) throw new Error(`a unit named "${BATCH}" exists and is not the batch unit: triage this item P1-P3 or drop`);
    if (b && !['open'].includes(b.status)) throw new Error(`the batch unit is ${b.status}: triage this item P1-P3 (an issue) or drop it`);
    // Every item is in the bar the critic judges: a batch the bar cannot hold takes no more.
    if (batchBar([...batchItems(s), note]).length > BAR_MAX) throw new Error(`the batch is full (its bar would pass ${BAR_MAX} characters): triage this item P1-P3 (an issue) or drop it`);
    if (!b) {
      // Making the batch unit is adding a unit: the same caps as run.mjs add, and after freeze a scope note.
      if (s.units.length >= (s.budget?.maxUnits ?? Infinity)) throw new Error(`unit cap reached (${s.budget.maxUnits}): no room for the batch unit; triage this item P1-P3 (an issue) or drop it`);
      if (s.frozen) {
        if ((s.addedAfterFreeze ?? 0) >= (s.budget?.maxAdded ?? Infinity)) throw new Error('scope cap reached: no room for the batch unit after freeze; triage this item P1-P3 (an issue) or drop it');
        s.addedAfterFreeze = (s.addedAfterFreeze ?? 0) + 1;
        s.notes.push({ kind: 'scope', text: `added ${BATCH}: ${reason}`, at });
      }
    }
    s.notes.push(note);
    if (!b) {
      b = { id: BATCH, batch: true, bar: '', title: 'Small items', link: null, after: null, status: 'open', rounds: [], strategyChanges: 0, strategyAt: -1, heartbeatAt: null, stopReason: null };
      s.units.push(b);
    }
    b.bar = batchBar(batchItems(s));
    return { note, unit: BATCH };
  }
  s.notes.push(note);
  return { note, ...(['P1', 'P2'].includes(triage) ? { file: `file it as an issue (${triage}) and link it: run.mjs link ${s.id} <unit> --issue owner/repo#n` } : {}) };
}

// A batch unit waits until every other unit has passed or stopped: it builds last, as one unit.
export function batchWait(unit, run) {
  if (!unit.batch || unit.status !== 'open') return null;
  const busy = run.units.filter((u) => u.id !== unit.id && !['pass', 'stopped'].includes(u.status)).map((u) => u.id);
  return busy.length ? { action: 'wait', reason: `batch: builds last, after ${busy.join(', ')}` } : null;
}
