// Answers and notes that reached the state branch from away (the web HUD, comment
// commands) after the lead had already logged more events locally. The two logs
// share a prefix and then differ; the copy's extra events are taken only when
// every one is an `answer` or a person's `note`, and each is replayed on the
// local log through the same code as `run.mjs answer` and `note --kind person`.
import { apply, canonical, replay } from './events.mjs';
import { answer, answerText, personNote, questions } from './questions.mjs';
import { clip } from './plain.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
// The exact shapes run.mjs answer and note --kind person write: anything more is not replayed.
const keysAre = (o, keys) => !!o && typeof o === 'object' && JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...keys].sort());
const ENTRY = ['choices', 'other', 'by', 'at'];
const NOTE = ['kind', 'text', 'unit', 'at'];
const lines = (log) => log.events.map((_, i) => log.buf.subarray(i ? log.ends[i - 1] : 0, log.ends[i]).toString('utf8'));

// How many leading events two parsed logs share, line for line.
export function shared(a, b) {
  const x = lines(a); const y = lines(b);
  let k = 0;
  while (k < x.length && k < y.length && x[k] === y[k]) k++;
  return k;
}

// The copy's events after the first k, as replayable actions in seq order:
// [{ seq, kind, unit, acts: [{ q, entry } | { note }] }]. Returns null when any
// event is anything other than an answer or a person's note, or does more than that.
export function extras(theirs, k) {
  let s = replay(theirs.events.slice(0, k));
  const out = [];
  for (const e of theirs.events.slice(k)) {
    if (!['answer', 'note'].includes(e.kind)) return null;
    let next;
    try { next = canonical(apply(clone(s), e.payload.ops)); } catch { return null; }
    const acts = [];
    const sim = clone(s);
    if (e.kind === 'answer') {
      const was = questions(s);
      for (const q of questions(next)) {
        const old = was.find((w) => w.id === q.id);
        if (!old) return null;
        for (const entry of q.history.slice(old.history.length)) {
          if (!keysAre(entry, ENTRY)) return null;
          acts.push({ q: q.id, entry }); sim.notes.filter((n) => n.kind === 'question')[+q.id.slice(1) - 1].history.push(entry);
        }
      }
    } else {
      for (const note of (next.notes ?? []).slice((s.notes ?? []).length)) {
        if (note.kind !== 'person' || !keysAre(note, NOTE)) return null;
        acts.push({ note }); sim.notes.push(note);
      }
    }
    // The event must be exactly these answers or notes: nothing else may ride along.
    if (!acts.length || !same(sim, next)) return null;
    out.push({ seq: e.seq, kind: e.kind, unit: e.unit ?? null, acts });
    s = next;
  }
  return out;
}

const questionAt = (s, id) => s.notes.filter((n) => n.kind === 'question')[+id.slice(1) - 1];
const lateOf = (act) => ({ q: act.q, ...act.entry });

// Whether a state already holds an action (a replay done before, or the same answer made here).
// An answer that came after the lead used the question is held as its "changed after use" note.
export function holds(s, act) {
  if (act.note) return (s.notes ?? []).some((n) => same(n, act.note));
  const q = questions(s).find((x) => x.id === act.q);
  if (q && q.history.some((h) => same(h, act.entry))) return true;
  return (s.notes ?? []).some((n) => n.changedAfterUse && same(n.changedAfterUse, lateOf(act)));
}

// Applies one action through the CLI's own checks, keeping the time it was made away.
// An answer to a question the lead has already used (or closed by a decision) cannot change it:
// the lead keeps the used answer (or its decision), and the change is recorded as a person's note
// flagged changedAfterUse (design 9), shown with the notes and alerted by the service. The note's
// words say which: "answer changed after use", or "answer changed after the lead decided".
export function replayAct(s, act) {
  if (holds(s, act)) return;
  if (act.note) {
    personNote(s, { text: act.note.text, unit: act.note.unit ?? undefined });
    s.notes.at(-1).at = act.note.at;
  } else {
    const q = s.notes.length ? questionAt(s, act.q) : null;
    const status = questions(s).find((x) => x.id === act.q)?.status;
    if (q && (status === 'used' || status === 'decided')) {
      const text = status === 'used'
        ? `answer changed after use: ${act.q} → ${answerText(act.entry)} (the lead keeps the answer it used)`
        : `answer changed after the lead decided: ${act.q} → ${answerText(act.entry)} (the lead keeps its decision)`;
      personNote(s, { text: clip(text, 1000), unit: q.unit ?? undefined });
      Object.assign(s.notes.at(-1), { at: act.entry.at, changedAfterUse: lateOf(act) });
    } else {
      answer(s, act.q, { choices: act.entry.choices ?? [], other: act.entry.other ?? null, by: act.entry.by });
      questionAt(s, act.q).history.at(-1).at = act.entry.at;
    }
  }
  if (!holds(s, act)) throw new Error(`${act.q ?? 'a note'}: the copy's ${act.note ? 'note' : 'answer'} does not replay as it was given`);
}
