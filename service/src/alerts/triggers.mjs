// What deserves an alert (design 9), worked out from two reads of a run or
// from what GitHub said. Pure: no I/O, no clock except the one passed in.
import { questions } from '../core.mjs';

// trigger → urgency and the channels it uses by default. 'github' is a
// mention on the unit's issue or PR, kept to needs-you and high alerts.
export const TRIGGERS = {
  'needs-you': { urgency: 'normal', channels: ['push', 'email', 'github'], label: 'needs you' },
  'unit-stopped': { urgency: 'normal', channels: ['push', 'email'], label: 'unit stopped' },
  'run-finished': { urgency: 'low', channels: ['email'], label: 'run finished' },
  merged: { urgency: 'low', channels: ['push'], label: 'merged' },
  'checks-red': { urgency: 'normal', channels: ['push'], label: 'checks failed' },
  security: { urgency: 'high', channels: ['push', 'email', 'github'], label: 'security finding' },
  'lead-quiet': { urgency: 'normal', channels: ['push'], label: 'lead went quiet' },
  'answer-changed': { urgency: 'normal', channels: ['push'], label: 'answer changed after use' },
};

// A run seen for the first time only alerts for questions asked this recently,
// so a restart of an in-memory service does not replay a run's whole history.
export const FIRST_SIGHT_MS = 24 * 3600_000;
const RED = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
export const isRed = (conclusion) => RED.has(String(conclusion));

// [{ trigger, unit, ref? , question? }] between two states of one run (before may be null).
export function runTriggers(before, after, nowMs) {
  if (!after) return [];
  const out = [];
  const was = new Map((before ? questions(before) : []).map((q) => [q.id, q]));
  for (const q of questions(after)) {
    const prev = was.get(q.id);
    const fresh = before ? !prev : nowMs - Date.parse(q.at ?? 0) < FIRST_SIGHT_MS;
    if (q.open && fresh) out.push({ trigger: 'needs-you', unit: q.unit, ref: q.id, question: q.text });
    if (prev && q.usedAt && q.history.length > prev.history.length) out.push({ trigger: 'answer-changed', unit: q.unit, ref: q.id });
  }
  if (!before) return out;
  // An answer that reached the lead after it used the question: pull records it as a flagged note (lib/incoming.mjs).
  const seen = new Set((before.notes ?? []).filter((n) => n.changedAfterUse).map((n) => JSON.stringify(n.changedAfterUse)));
  for (const n of after.notes ?? []) {
    if (n.changedAfterUse && !seen.has(JSON.stringify(n.changedAfterUse))) out.push({ trigger: 'answer-changed', unit: n.unit ?? null, ref: String(n.changedAfterUse.q ?? '') || undefined });
  }
  const units = new Map(before.units.map((u) => [u.id, u]));
  for (const u of after.units) {
    if (u.status === 'stopped' && units.get(u.id)?.status !== 'stopped') out.push({ trigger: 'unit-stopped', unit: u.id });
  }
  if (after.closed && !before.closed) out.push({ trigger: 'run-finished', unit: null });
  return out;
}

// The newest sign of life the state shows: unit heartbeats, rounds, notes, the start.
export function lastSign(s) {
  const times = [s.createdAt];
  for (const u of s.units) {
    times.push(u.heartbeatAt, u.startedAt);
    for (const r of u.rounds ?? []) times.push(r.at);
  }
  for (const n of s.notes ?? []) times.push(n.at);
  return Math.max(0, ...times.map((t) => Date.parse(t ?? '')).filter(Number.isFinite));
}

// A run whose units are mid-work but whose state has shown no sign of life for
// twice the run's stale budget: the lead has gone quiet. Returns the time it went quiet, or null.
export function quietSince(s, nowMs) {
  if (!s || s.closed || !s.units.some((u) => ['building', 'judging'].includes(u.status))) return null;
  const last = lastSign(s);
  const limit = 2 * (s.budget?.staleMinutes ?? 45) * 60_000;
  return last && nowMs - last > limit ? last : null;
}
