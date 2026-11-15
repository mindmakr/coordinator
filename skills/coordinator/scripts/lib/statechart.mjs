// Accessible statecharts, Jev noul bar-feasibility pre-checks, and reins_state
// transition verification against declared statechart edges (#160). Pure logic;
// all HTML/SVG labels are escaped and every status is shown in text and shape,
// never colour alone.
import { askNoul } from './helpers.mjs';
import { esc } from './links.mjs';

export const FEASIBILITY_FLOOR = 0.30;
const MAX_STATES = 40;
const MAX_TRANSITIONS = 80;

const STATUS_META = {
  pass: { mark: '✓', word: 'pass', cls: 'sc-pass', dash: '' },
  fail: { mark: '✕', word: 'fail', cls: 'sc-fail', dash: '6 3' },
  unchecked: { mark: '·', word: 'open', cls: 'sc-open', dash: '2 3' },
};
const metaOf = (status) => STATUS_META[status] ?? STATUS_META.unchecked;
const clipText = (s, n = 60) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, Math.max(1, n - 1))}…` : t;
};
const cleanId = (s, fallback) => {
  const t = String(s ?? '').trim().slice(0, 64);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(t) ? t : fallback;
};
const normState = (s) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const cleanCell = (s) => String(s ?? '').replace(/[|\r\n]+/g, ' ').trim();
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// Parses and validates a caller-supplied statechart JSON string or object.
export function parseStatechartInput(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) throw new Error('--statechart requires a JSON object or file path');
    try { data = JSON.parse(trimmed); } catch (e) { throw new Error(`invalid statechart JSON: ${e.message}`); }
  }
  if (!isObj(data)) throw new Error('statechart must be a JSON object { states?, transitions }');
  if (!Array.isArray(data.transitions) && !Array.isArray(data.states)) {
    throw new Error('statechart must declare states or transitions arrays');
  }
  const rawStates = Array.isArray(data.states) ? data.states : [];
  const rawTransitions = Array.isArray(data.transitions) ? data.transitions : [];
  if (rawStates.length > MAX_STATES) throw new Error(`statechart allows at most ${MAX_STATES} states`);
  if (rawTransitions.length > MAX_TRANSITIONS) throw new Error(`statechart allows at most ${MAX_TRANSITIONS} transitions`);

  const stateMap = new Map();
  rawStates.forEach((st, idx) => {
    const id = typeof st === 'string' ? cleanId(st, `S${idx + 1}`) : cleanId(st?.id ?? st?.name, `S${idx + 1}`);
    const title = clipText(typeof st === 'string' ? st : (st?.title ?? st?.label ?? st?.name ?? id), 80) || id;
    const status = STATUS_META[st?.status] ? st.status : 'unchecked';
    const kind = ['initial', 'state', 'terminal'].includes(st?.kind) ? st.kind : (idx === 0 ? 'initial' : 'state');
    if (!stateMap.has(id)) stateMap.set(id, { id, title, status, kind });
  });

  const transitions = rawTransitions.map((tr, idx) => {
    if (!isObj(tr) || !String(tr.from ?? '').trim() || !String(tr.to ?? '').trim()) {
      throw new Error(`statechart transition at index ${idx} needs non-empty from and to states`);
    }
    const id = cleanId(tr.id, `T${idx + 1}`);
    const from = clipText(tr.from, 64);
    const to = clipText(tr.to, 64);
    const action = clipText(tr.action ?? tr.trigger ?? tr.event ?? id, 60) || id;
    const title = clipText(tr.title ?? tr.label ?? `${from} -> ${to}`, 120);
    const status = STATUS_META[tr.status] ? tr.status : 'unchecked';
    if (!stateMap.has(from) && from !== '*') stateMap.set(from, { id: from, title: from, status: 'unchecked', kind: stateMap.size === 0 ? 'initial' : 'state' });
    if (!stateMap.has(to)) stateMap.set(to, { id: to, title: to, status: 'unchecked', kind: 'state' });
    return { id, from, to, action, title, status };
  });

  return { states: [...stateMap.values()], transitions };
}

// Extracts an action phrase from a behaviour sentence ("when X runs/clicks Y, then ...").
function inferAction(text, featureMap, fallbackId) {
  const m = /\bwhen\b([^,;.]{3,70})/i.exec(String(text ?? ''));
  const actions = (featureMap?.actions ?? []).map((a) => (typeof a === 'string' ? a : a?.id ?? a?.name)).filter(Boolean);
  const matchedAction = actions.find((a) => String(text ?? '').toLowerCase().includes(String(a).toLowerCase()));
  if (matchedAction) return clipText(matchedAction, 50);
  if (m) return clipText(m[1], 50);
  return fallbackId;
}

// Extracts an explicit "from X to Y" or "X -> Y" transition pair when present in behaviour text.
function inferEdge(text) {
  const s = String(text ?? '');
  const arrow = /\b([A-Za-z][A-Za-z0-9._-]{1,40})\s*(?:->|→)\s*([A-Za-z][A-Za-z0-9._-]{1,40})\b/.exec(s);
  if (arrow) return { from: arrow[1], to: arrow[2] };
  const fromTo = /\btransitions?\s+from\s+([A-Za-z][A-Za-z0-9._ -]{1,36}?)\s+to\s+([A-Za-z][A-Za-z0-9._ -]{1,36}?)(?=[.,;]|$)/i.exec(s);
  if (fromTo) return { from: clipText(fromTo[1], 40), to: clipText(fromTo[2], 40) };
  return null;
}

function featureStates(featureMap) {
  const out = [];
  for (const entry of featureMap?.states ?? []) {
    if (typeof entry === 'string' && entry.trim()) out.push(clipText(entry, 48));
    else if (Array.isArray(entry?.states)) {
      for (const s of entry.states) if (typeof s === 'string' && s.trim()) out.push(clipText(s, 48));
    } else if (typeof entry?.name === 'string' && entry.name.trim()) {
      out.push(clipText(entry.name, 48));
    }
  }
  return [...new Set(out)].slice(0, MAX_STATES);
}

// True when a unit describes multiple steps/states/transitions or carries an explicit statechart.
export function isStatefulUnit(unit, featureMap = null) {
  if (unit?.statechart) return true;
  if (featureStates(featureMap).length > 0) return true;
  if ((unit?.behaviours?.length ?? 0) >= 2) return true;
  const corpus = [unit?.bar ?? '', ...(unit?.behaviours ?? []).map((b) => b.text ?? '')].join('\n');
  return /\b(state|states|transition|transitions|workflow|step|steps|phase|lifecycle|snapshot|reins_state)\b|->|→/i.test(corpus);
}

// Formats a compact Markdown transition table attached to the unit record and briefs.
export function formatStateTransitionTable(transitions) {
  if (!transitions?.length) return '';
  const rows = transitions.map((t) => {
    const m = metaOf(t.status);
    return `| ${cleanCell(t.id)} | ${cleanCell(t.from)} | ${cleanCell(t.action)} | ${cleanCell(t.to)} | ${m.mark} ${m.word} |`;
  });
  return ['| ID | From | Action | To | Status |', '| --- | --- | --- | --- | --- |', ...rows].join('\n');
}

// Recomputes state & transition status marks from unit.behaviours and refreshes textTable.
export function syncStatechartStatuses(unit) {
  const chart = unit?.statechart;
  if (!chart) return null;
  const byId = new Map((unit.behaviours ?? []).map((b) => [String(b.id).toUpperCase(), b]));
  const transitions = (chart.transitions ?? []).map((t) => {
    const b = byId.get(String(t.id).toUpperCase());
    return b ? { ...t, status: STATUS_META[b.status] ? b.status : 'unchecked' } : t;
  });
  const states = (chart.states ?? []).map((st) => {
    const linked = transitions.filter((t) => t.to === st.id || t.from === st.id);
    if (!linked.length) return st;
    if (linked.some((t) => t.status === 'fail')) return { ...st, status: 'fail' };
    if (linked.every((t) => t.status === 'pass')) return { ...st, status: 'pass' };
    return { ...st, status: 'unchecked' };
  });
  const next = { ...chart, states, transitions, textTable: formatStateTransitionTable(transitions) };
  unit.statechart = next;
  return next;
}

// Builds a statechart from explicit input or unit bar/behaviours + feature-map.json states.
export function buildStatechart(unit, featureMap = null, { raw = null } = {}) {
  const base = raw !== null && raw !== undefined ? parseStatechartInput(raw) : null;
  if (base) {
    const chart = {
      id: unit.id,
      title: unit.title ?? unit.id,
      generated: false,
      states: base.states,
      transitions: base.transitions,
      textTable: '',
    };
    const holder = { ...unit, statechart: chart };
    return syncStatechartStatuses(holder);
  }

  const domainStates = featureStates(featureMap);
  const behaviours = unit.behaviours ?? [];
  const stateMap = new Map();
  const addState = (id, title = id, kind = 'state') => {
    const key = clipText(id, 64) || 'initial';
    if (!stateMap.has(key)) stateMap.set(key, { id: key, title: clipText(title, 80) || key, status: 'unchecked', kind });
    return key;
  };

  let transitions = [];
  if (behaviours.length) {
    let cursor = domainStates[0] ?? 'initial';
    addState(cursor, domainStates[0] ? domainStates[0] : 'Initial', 'initial');
    transitions = behaviours.slice(0, MAX_TRANSITIONS).map((b, idx) => {
      const explicitEdge = inferEdge(b.text);
      const from = explicitEdge ? addState(explicitEdge.from, explicitEdge.from, stateMap.size === 0 ? 'initial' : 'state') : cursor;
      const fallbackTo = domainStates[idx + 1] ?? `S${idx + 1}`;
      const to = explicitEdge
        ? addState(explicitEdge.to, explicitEdge.to, idx === behaviours.length - 1 ? 'terminal' : 'state')
        : addState(fallbackTo, domainStates[idx + 1] ?? clipText(b.text, 48), idx === behaviours.length - 1 ? 'terminal' : 'state');
      cursor = to;
      return {
        id: cleanId(b.id, `B${idx + 1}`),
        from,
        to,
        action: inferAction(b.text, featureMap, b.id),
        title: clipText(b.text, 90),
        status: STATUS_META[b.status] ? b.status : 'unchecked',
      };
    });
  } else if (domainStates.length >= 2) {
    for (let i = 0; i < domainStates.length; i++) {
      addState(domainStates[i], domainStates[i], i === 0 ? 'initial' : i === domainStates.length - 1 ? 'terminal' : 'state');
    }
    for (let i = 0; i < domainStates.length - 1; i++) {
      transitions.push({
        id: `T${i + 1}`,
        from: domainStates[i],
        to: domainStates[i + 1],
        action: `step_${i + 1}`,
        title: `${domainStates[i]} -> ${domainStates[i + 1]}`,
        status: 'unchecked',
      });
    }
  } else {
    const start = addState('initial', 'Initial', 'initial');
    const done = addState('verified', clipText(unit.bar || 'Bar satisfied', 64), 'terminal');
    transitions.push({
      id: 'T1',
      from: start,
      to: done,
      action: 'verify',
      title: clipText(unit.bar || unit.title || unit.id, 90),
      status: unit.status === 'pass' ? 'pass' : 'unchecked',
    });
  }

  const chart = {
    id: unit.id,
    title: unit.title ?? unit.id,
    generated: true,
    states: [...stateMap.values()],
    transitions,
    textTable: '',
  };
  const holder = { ...unit, statechart: chart };
  return syncStatechartStatuses(holder);
}

// Accessible SVG diagram with IDs, titles, and status marks independent of colour alone.
export function renderStatechartSvg(chart) {
  if (!chart?.states?.length) return '';
  const states = chart.states;
  const transitions = chart.transitions ?? [];
  const colW = 190;
  const boxW = 156;
  const boxH = 58;
  const cols = Math.min(4, Math.max(1, states.length));
  const rows = Math.ceil(states.length / cols);
  const rowH = 128;
  const padX = 24;
  const padY = 26;
  const w = padX * 2 + (cols - 1) * colW + boxW;
  const h = padY * 2 + (rows - 1) * rowH + boxH + (transitions.length ? 30 : 0);

  const pos = new Map();
  states.forEach((st, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = padX + col * colW;
    const y = padY + row * rowH;
    pos.set(st.id, { x, y, cx: x + boxW / 2, cy: y + boxH / 2 });
  });

  const markerId = `sc-arrow-${cleanId(chart.id, 'u').replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const defs = `<defs><marker id="${esc(markerId)}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 1L10 5L0 9z" fill="currentColor"/></marker></defs>`;

  const edgeSvg = transitions.map((tr, i) => {
    const from = pos.get(tr.from);
    const to = pos.get(tr.to);
    if (!from || !to) return '';
    const m = metaOf(tr.status);
    const label = `${m.mark} ${tr.id}: ${clipText(tr.action || tr.title, 22)}`;
    const aria = `Transition ${tr.id} (${tr.title}) from ${tr.from} to ${tr.to}: ${m.word}`;
    if (from.x === to.x && from.y === to.y) {
      const lx = from.cx;
      const ly = from.y - 16;
      const d = `M${from.cx - 18},${from.y} C${from.cx - 18},${ly - 14} ${from.cx + 18},${ly - 14} ${from.cx + 18},${from.y}`;
      return `<g class="sc-edge ${m.cls}" role="group" aria-label="${esc(aria)}"><title>${esc(aria)}</title><path d="${d}"${m.dash ? ` stroke-dasharray="${m.dash}"` : ''} marker-end="url(#${esc(markerId)})"/><text class="sc-elabel" x="${lx}" y="${ly}" text-anchor="middle">${esc(label)}</text></g>`;
    }
    const sx = from.x < to.x ? from.x + boxW : from.x > to.x ? from.x : from.cx;
    const sy = from.y === to.y ? from.cy : from.y + boxH;
    const tx = from.x < to.x ? to.x : from.x > to.x ? to.x + boxW : to.cx;
    const ty = from.y === to.y ? to.cy : to.y;
    const bend = from.y === to.y && Math.abs(to.cx - from.cx) > colW ? 26 * ((i % 2) ? 1 : -1) : (i % 2 ? 10 : -10);
    const mx = (sx + tx) / 2;
    const my = (sy + ty) / 2 + bend;
    const d = `M${sx},${sy} Q${mx},${my} ${tx},${ty}`;
    return `<g class="sc-edge ${m.cls}" role="group" aria-label="${esc(aria)}"><title>${esc(aria)}</title><path d="${d}"${m.dash ? ` stroke-dasharray="${m.dash}"` : ''} marker-end="url(#${esc(markerId)})"/><text class="sc-elabel" x="${mx}" y="${my - 4}" text-anchor="middle">${esc(label)}</text></g>`;
  }).join('');

  const nodeSvg = states.map((st) => {
    const p = pos.get(st.id);
    const m = metaOf(st.status);
    const aria = `State ${st.id} (${st.title}): ${m.mark} ${m.word}`;
    const ring = st.kind === 'initial' || st.kind === 'terminal'
      ? `<rect class="sc-ring ${m.cls}" x="${p.x + 3}" y="${p.y + 3}" width="${boxW - 6}" height="${boxH - 6}" rx="6"/>` : '';
    return `<g class="sc-node ${m.cls}" role="group" aria-label="${esc(aria)}"><title>${esc(aria)}</title>`
      + `<rect class="sc-box ${m.cls}" x="${p.x}" y="${p.y}" width="${boxW}" height="${boxH}" rx="8"${m.dash ? ` stroke-dasharray="${m.dash}"` : ''}/>${ring}`
      + `<text class="sc-id" x="${p.x + 10}" y="${p.y + 21}">${esc(`${m.mark} ${st.id}`)} <tspan class="sc-word">[${esc(m.word)}]</tspan></text>`
      + `<text class="sc-title" x="${p.x + 10}" y="${p.y + 41}">${esc(clipText(st.title, 21))}</text></g>`;
  }).join('');

  const desc = `${states.length} states, ${transitions.length} transitions: ${transitions.map((t) => `${t.id} ${t.from}->${t.to} [${metaOf(t.status).word}]`).join('; ')}`;
  const ariaLabel = `Statechart for ${chart.title || chart.id}: ${states.length} states, ${transitions.length} transitions`;
  return `<div class="sc-boxwrap"><svg class="statechart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(ariaLabel)}">`
    + `<title>${esc(ariaLabel)}</title><desc>${esc(desc)}</desc>${defs}${edgeSvg}${nodeSvg}</svg></div>`;
}

// One atomic Jev noul proposition per behaviour (valid against checkAtomicProposition).
export function buildFeasibilityPropositions(unit) {
  const items = (unit?.behaviours ?? []).length
    ? unit.behaviours.map((b) => ({ id: b.id, text: b.text }))
    : [{ id: 'BAR', text: unit?.bar ?? unit?.title ?? unit?.id ?? 'unit bar' }];
  return items.map((item) => {
    const cleaned = String(item.text ?? '').replace(/\s+/g, ' ').replace(/\?/g, '.').trim();
    return {
      id: item.id,
      proposition: `This requirement is deterministically verifiable from observable state or shared coordination: ${clipText(cleaned, 700)}`,
    };
  });
}

// Evaluates unit behaviours against Jev noul; scores < 0.30 block freeze/worktree dispatch.
export async function checkBarFeasibility(unit, helpersCfg, { askNoulFn = askNoul, threshold = FEASIBILITY_FLOOR, completeFn, env, fetchImpl, timeoutMs } = {}) {
  const propositions = buildFeasibilityPropositions(unit);
  if (!helpersCfg?.on) {
    return { ok: true, skipped: true, why: helpersCfg?.why ?? 'helpers disabled', threshold, scores: [], blocked: [] };
  }
  const ctx = `Unit ${unit.id}${unit.title ? ` (${unit.title})` : ''}\nBar: ${unit.bar ?? ''}\nRule: Reject wishes requiring impossible guarantees such as exact-once delivery or linearizable state across unlinked parties sharing no state.`;
  const res = await askNoulFn(helpersCfg, { propositions, context: ctx }, { completeFn, env, fetchImpl, timeoutMs });
  if (res?.fallback) {
    return { ok: true, skipped: true, fallback: true, why: res.why ?? 'helper unreachable', threshold, scores: [], blocked: [] };
  }
  const rawResults = Array.isArray(res?.results)
    ? res.results
    : [{ id: propositions[0].id, proposition: propositions[0].proposition, probability: res?.probability ?? null, verdict: res?.verdict ?? 'uncertain', rationale: res?.rationale }];
  const scores = rawResults.map((r, idx) => ({
    id: r.id ?? propositions[idx]?.id ?? `P${idx + 1}`,
    probability: typeof r.probability === 'number' && Number.isFinite(r.probability) ? r.probability : null,
    verdict: r.verdict ?? 'uncertain',
    rationale: r.rationale ?? null,
  }));
  const blocked = scores.filter((s) => s.probability !== null && s.probability < threshold);
  if (blocked.length) {
    const detail = blocked.map((b) => `${b.id} (${b.probability.toFixed(2)}${b.rationale ? `: ${clipText(b.rationale, 120)}` : ''})`).join('; ');
    return {
      ok: false,
      skipped: false,
      fallback: false,
      threshold,
      scores,
      blocked,
      message: `Agree the bar blocked: Jev noul feasibility < ${threshold.toFixed(2)} for ${detail}. Revise or clarify the bar before creating a worktree.`,
    };
  }
  return { ok: true, skipped: false, fallback: false, threshold, scores, blocked: [] };
}

function unwrapState(snap) {
  if (!isObj(snap)) return {};
  if (isObj(snap.state)) return snap.state;
  const copy = {};
  for (const [k, v] of Object.entries(snap)) {
    if (!['action', 'tool', 'at', 'timestamp', 'panel', '__proto__', 'constructor', 'prototype'].includes(k)) copy[k] = v;
  }
  return Object.keys(copy).length ? copy : snap;
}

function collectScalars(obj, prefix = '', out = new Map(), depth = 0) {
  if (depth > 4 || !isObj(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out.set(key, v);
    else if (isObj(v)) collectScalars(v, key, out, depth + 1);
    else if (Array.isArray(v)) out.set(key, JSON.stringify(v).slice(0, 120));
  }
  return out;
}

const STATE_FIELD = /(?:^|\.)(state|status|phase|mode|step|stage|screen)$/i;

// Extracts ordered state transitions from reins_state snapshots, packets, or transition arrays.
export function extractObservedTransitions(input) {
  if (!input) return [];
  if (isObj(input) && Array.isArray(input.transitions)) {
    return input.transitions.filter(isObj).map((t, index) => ({
      index,
      from: String(t.from ?? ''),
      to: String(t.to ?? ''),
      action: t.action ?? t.trigger ?? t.event ?? null,
      changedKeys: [`${t.from ?? ''} -> ${t.to ?? ''}`],
      before: t.before ?? { state: t.from },
      after: t.after ?? { state: t.to },
    })).filter((t) => t.from || t.to);
  }
  let snaps = Array.isArray(input) ? input
    : isObj(input) && Array.isArray(input.snapshots) ? input.snapshots
      : isObj(input) && Array.isArray(input.states) ? input.states
        : isObj(input) && input.before !== undefined && input.after !== undefined ? [{ state: input.before }, { state: input.after, action: input.action }]
          : [];
  const out = [];
  for (let i = 1; i < snaps.length; i++) {
    const prev = snaps[i - 1];
    const curr = snaps[i];
    const a = unwrapState(prev);
    const b = unwrapState(curr);
    const flatA = collectScalars(a);
    const flatB = collectScalars(b);
    const keys = new Set([...flatA.keys(), ...flatB.keys()]);
    const changed = [];
    const primaryChanges = [];
    for (const k of keys) {
      const va = flatA.get(k);
      const vb = flatB.get(k);
      if (va !== vb) {
        changed.push({ key: k, from: va, to: vb });
        if (STATE_FIELD.test(k)) primaryChanges.push({ key: k, from: va, to: vb });
      }
    }
    if (!changed.length) continue;
    const action = isObj(curr) ? (curr.action ?? curr.tool ?? null) : null;
    if (primaryChanges.length) {
      for (const ch of primaryChanges) {
        out.push({
          index: i,
          from: String(ch.from ?? 'unset'),
          to: String(ch.to ?? 'unset'),
          action,
          changedKeys: changed.map((c) => `${c.key}: ${c.from} -> ${c.to}`),
          before: a,
          after: b,
        });
      }
    } else {
      out.push({
        index: i,
        from: changed.map((c) => `${c.key}=${c.from ?? 'unset'}`).join(','),
        to: changed.map((c) => `${c.key}=${c.to ?? 'unset'}`).join(','),
        action,
        changedKeys: changed.map((c) => `${c.key}: ${c.from} -> ${c.to}`),
        before: a,
        after: b,
      });
    }
  }
  return out;
}

// Verifies observed reins_state transitions against declared statechart edges.
export function verifyStateTransitions(chart, input) {
  const declared = chart?.transitions ?? [];
  const observed = extractObservedTransitions(input);
  if (!declared.length) {
    return { ok: true, checked: observed.length, declared: 0, undeclared: [], evidenceText: null, summary: null };
  }
  const undeclared = [];
  for (const obs of observed) {
    const fromN = normState(obs.from);
    const toN = normState(obs.to);
    const actN = obs.action ? normState(obs.action) : null;
    const match = declared.find((edge) => {
      const eFrom = normState(edge.from);
      const eTo = normState(edge.to);
      const stateOk = (edge.from === '*' || eFrom === fromN) && eTo === toN;
      if (!stateOk) return false;
      if (!actN || !edge.action || edge.action === edge.id) return true;
      const eAct = normState(edge.action);
      return eAct === actN || eAct.includes(actN) || actN.includes(eAct);
    });
    if (!match) {
      undeclared.push({
        index: obs.index,
        from: obs.from,
        to: obs.to,
        action: obs.action,
        changedKeys: obs.changedKeys,
        before: obs.before,
        after: obs.after,
      });
    }
  }
  if (!undeclared.length) {
    return { ok: true, checked: observed.length, declared: declared.length, undeclared: [], evidenceText: null, summary: null };
  }
  const summary = `${undeclared.length} undeclared state transition${undeclared.length === 1 ? '' : 's'}: ${undeclared.map((u) => `${u.from} -> ${u.to}${u.action ? ` (${u.action})` : ''}`).join('; ')}`;
  const lines = undeclared.map((u) => `- step ${u.index}: ${u.from} -> ${u.to}${u.action ? ` via ${u.action}` : ''} | diff: ${u.changedKeys.join(', ')} | before=${clipText(JSON.stringify(u.before), 180)} | after=${clipText(JSON.stringify(u.after), 180)}`);
  return {
    ok: false,
    checked: observed.length,
    declared: declared.length,
    undeclared,
    summary: clipText(summary, 400),
    evidenceText: `Statechart transition violation (${undeclared.length} undeclared):\n${lines.join('\n')}`,
  };
}
