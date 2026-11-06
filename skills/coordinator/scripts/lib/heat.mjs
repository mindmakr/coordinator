// The heatmaps as data, from the view model only (lib/view.mjs).
// Units × time: one column per hour from the run's start (wider buckets past
// MAX_COLS hours), counting tries (verdicts), failed tries, heartbeats, other
// work events, and minutes spent waiting (for a critic after `built`, or for an
// answer to the unit's question). Units × behaviours: each behaviour's status.
const HOUR = 3_600_000;
const MIN = 60_000;
export const MAX_COLS = 48;

// Intervals a unit spent waiting: built → its verdict (or reset), and each of its questions → the first answer.
export function waits(u, endMs) {
  const out = []; let from = null;
  for (const e of u.timeline ?? []) {
    if (e.label === 'built') from ??= Date.parse(e.at);
    else if (from !== null && (/^verdict /.test(e.label) || e.label === 'reset' || e.label === 'start')) { out.push([from, Date.parse(e.at)]); from = null; }
  }
  if (from !== null && u.status === 'judging') out.push([from, endMs]);
  for (const q of u.asks ?? []) {
    const end = q.history?.[0]?.at ? Date.parse(q.history[0].at) : q.open ? endMs : null;
    if (q.at && end) out.push([Date.parse(q.at), end]);
  }
  return out.filter(([a, b]) => b > a);
}

// Overlapping waits (a critic and an answer at once) count once.
export function merge(list) {
  const out = [];
  for (const [a, b] of [...list].sort((x, y) => x[0] - y[0])) { const last = out.at(-1); if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]); }
  return out;
}

const kindOf = (e) => (e.label === 'beat' ? 'beats' : e.label === 'verdict fail' ? 'fail' : e.label === 'verdict pass' ? 'pass' : e.badge === 'question' || e.badge === 'answer' ? null : 'other');

export function heat(v, nowMs = Date.now()) {
  const events = v.units.flatMap((u) => u.timeline ?? []);
  const last = Math.max(...events.map((e) => Date.parse(e.at)).filter(Number.isFinite), Date.parse(v.started));
  const start = Math.floor(Date.parse(v.started) / HOUR) * HOUR;
  const end = v.open ? Math.max(nowMs, last) : (v.closedAt ? Date.parse(v.closedAt) : last);
  const hours = Math.max(1, Math.ceil((end - start) / HOUR));
  const step = Math.ceil(hours / MAX_COLS);
  const n = Math.ceil(hours / step);
  const width = step * HOUR;
  const col = (ms) => Math.min(n - 1, Math.max(0, Math.floor((ms - start) / width)));
  const cols = Array.from({ length: n }, (_, i) => ({ at: new Date(start + i * width).toISOString() }));
  const rows = v.units.map((u) => {
    const cells = cols.map(() => ({ rounds: 0, fails: 0, beats: 0, other: 0, waitMin: 0 }));
    for (const e of u.timeline ?? []) {
      const ms = Date.parse(e.at); const k = kindOf(e);
      if (!Number.isFinite(ms) || !k) continue;
      const c = cells[col(ms)];
      if (k === 'beats') c.beats++; else if (k === 'other') c.other++; else { c.rounds++; if (k === 'fail') c.fails++; }
    }
    for (const [a, b] of merge(waits(u, end))) {
      for (let i = col(a); i <= col(b - 1); i++) {
        const lo = Math.max(a, start + i * width); const hi = Math.min(b, start + (i + 1) * width);
        if (hi > lo) cells[i].waitMin += Math.round((hi - lo) / MIN);
      }
    }
    const total = cells.reduce((t, c) => ({ rounds: t.rounds + c.rounds, fails: t.fails + c.fails, beats: t.beats + c.beats, other: t.other + c.other, waitMin: t.waitMin + c.waitMin }), { rounds: 0, fails: 0, beats: 0, other: 0, waitMin: 0 });
    return { unit: u.id, status: u.dot, cells, total };
  });
  const score = (c) => c.beats + c.other + 2 * c.rounds;
  const max = Math.max(1, ...rows.flatMap((r) => r.cells.map(score)));
  for (const r of rows) for (const c of r.cells) {
    const s = score(c);
    c.level = s ? Math.max(1, Math.ceil((4 * s) / max)) : 0;
    c.kind = c.fails ? 'fail' : s ? 'busy' : c.waitMin ? 'wait' : 'none';
  }
  return { start: new Date(start).toISOString(), step, cols, rows };
}

// Units × behaviours (B1, B2, … by position; the goal's own row first when it has behaviours).
export function behaviourGrid(v) {
  const rows = [];
  if (v.goalCheck.behaviours.length) rows.push({ unit: null, label: 'Goal', cells: v.goalCheck.behaviours.map((b) => ({ id: b.id, status: b.status, text: b.text })) });
  for (const u of v.units) rows.push({ unit: u.id, label: u.id, cells: u.behaviours.map((b) => ({ id: b.id, status: b.status, text: b.text })) });
  const cols = Math.max(0, ...rows.map((r) => r.cells.length));
  const count = (s) => rows.reduce((n, r) => n + r.cells.filter((c) => c.status === s).length, 0);
  return { cols, rows, pass: count('pass'), fail: count('fail'), unchecked: count('unchecked') };
}
