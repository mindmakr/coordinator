// The event log's schemas: one JSON Schema per event kind, checked on every
// write and every read. references/durability.md describes the format.
import { check } from './schema.mjs';

export const V = 1;

const ID = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' };
// Ops address the state by key, by array index (lists without ids: notes,
// rounds), or by { id } (lists of records with ids: units, behaviours,
// evidence). Prototype keys never appear.
const KEY = { anyOf: [
  { type: 'string', maxLength: 200, not: { enum: ['__proto__', 'constructor', 'prototype'] } },
  { type: 'integer', minimum: 0 },
  { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', maxLength: 200 } } },
] };
const PATH = { type: 'array', maxItems: 32, items: KEY };
const SET = { type: 'object', required: ['op', 'path', 'value'], additionalProperties: false, properties: { op: { const: 'set' }, path: PATH, value: true } };
const DEL = { type: 'object', required: ['op', 'path'], additionalProperties: false, properties: { op: { const: 'del' }, path: { ...PATH, minItems: 1 } } };
const PUSH = { type: 'object', required: ['op', 'path', 'values'], additionalProperties: false, properties: { op: { const: 'push' }, path: PATH, values: { type: 'array', minItems: 1 } } };
const OPS = { type: 'array', minItems: 1, items: { anyOf: [SET, DEL, PUSH] } };
// A whole run: the shape every version of state.json has had.
const RUN = { type: 'object', required: ['id', 'units'], properties: { id: ID, units: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: ID } } }, snapshot: false } };

const changes = { type: 'object', required: ['ops'], additionalProperties: false, properties: { ops: OPS } };

// unit: 'required' | 'optional' | 'none'; first: only as event 1.
export const KINDS = {
  'run.imported': { unit: 'none', first: true, payload: { type: 'object', required: ['state'], additionalProperties: false, properties: { state: RUN, from: { type: 'string', maxLength: 200 } } } },
  'run.init': { unit: 'none', first: true, payload: { type: 'object', required: ['ops'], additionalProperties: false, properties: { ops: { type: 'array', minItems: 1, maxItems: 1, items: { ...SET, properties: { ...SET.properties, path: { type: 'array', maxItems: 0 }, value: RUN } } } } } },
  'run.freeze': { unit: 'none', payload: changes },
  'run.integrate': { unit: 'none', payload: changes },
  'run.stop': { unit: 'none', payload: changes },
  'run.close': { unit: 'none', payload: changes },
  'unit.add': { unit: 'required', payload: changes },
  'unit.start': { unit: 'required', payload: changes },
  'unit.beat': { unit: 'required', payload: changes },
  'unit.built': { unit: 'required', payload: changes },
  'unit.reset': { unit: 'required', payload: changes },
  'unit.verdict': { unit: 'required', payload: changes },
  'unit.strategy': { unit: 'required', payload: changes },
  'unit.detect': { unit: 'required', payload: changes },
  'unit.link': { unit: 'required', payload: changes },
  behaviour: { unit: 'optional', payload: changes },
  evidence: { unit: 'optional', payload: changes },
  note: { unit: 'optional', payload: changes },
  study: { unit: 'none', payload: changes },
  // The release notes the lead stored for the run's report (run.mjs report --file).
  report: { unit: 'none', payload: changes },
  question: { unit: 'optional', payload: changes },
  answer: { unit: 'optional', payload: changes },
  'answer.used': { unit: 'optional', payload: changes },
  // state.json was changed outside run.mjs (by hand, or by an older version): the difference, kept.
  'state.edited': { unit: 'none', payload: changes },
};

const ISO = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$';

// The full JSON Schema of one kind's event line.
export function schemaFor(kind) {
  const k = KINDS[kind];
  return {
    type: 'object', required: ['v', 'seq', 'at', 'kind', 'payload', ...(k.unit === 'required' ? ['unit'] : [])], additionalProperties: false,
    properties: {
      v: { const: V }, seq: k.first ? { const: 1 } : { type: 'integer', minimum: 2 }, at: { type: 'string', pattern: ISO },
      kind: { const: kind }, unit: k.unit === 'none' ? false : ID, payload: k.payload,
    },
  };
}

// Throws on an event that does not fit its kind's schema. `where` prefixes the message.
export function validateEvent(e, where = 'event') {
  const kind = e && typeof e === 'object' ? e.kind : undefined;
  if (!Object.hasOwn(KINDS, kind)) throw new Error(`${where}: unknown event kind ${JSON.stringify(kind)}`);
  const err = check(schemaFor(kind), e);
  if (err) throw new Error(`${where} (${kind}): ${err}`);
  return e;
}

// The snapshot's own record of what it was built from.
export const SNAPSHOT = {
  type: 'object', required: ['v', 'seq', 'sha256', 'stateSha256'], additionalProperties: false,
  properties: { v: { const: V }, seq: { type: 'integer', minimum: 1 }, sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, stateSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' } },
};
export const validSnapshot = (m) => check(SNAPSHOT, m) === null;
export const validRun = (s) => check(RUN, s);
