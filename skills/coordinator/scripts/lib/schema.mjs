// A small JSON Schema checker (the subset the event schemas use), so the log
// is validated with Node built-ins only. The schemas themselves are plain JSON
// Schema: any full validator (e.g. Ajv, in the hosted service) reads them too.
//
// Supported: true/false schemas, type (one or a list), const, enum, pattern,
// minimum, maxLength, minItems, maxItems, items, properties, required,
// additionalProperties (false or a schema), anyOf, not.

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const is = (v, t) => typeOf(v) === t || (t === 'number' && typeOf(v) === 'integer');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// Returns the first problem as "path: message", or null when the value fits.
export function check(schema, v, at = '$') {
  if (schema === true) return null;
  if (schema === false) return `${at}: not allowed`;
  const s = schema;
  if (s.type && ![].concat(s.type).some((t) => is(v, t))) return `${at}: expected ${[].concat(s.type).join(' or ')}, got ${typeOf(v)}`;
  if (own(s, 'const') && !same(s.const, v)) return `${at}: expected ${JSON.stringify(s.const)}`;
  if (s.enum && !s.enum.some((x) => same(x, v))) return `${at}: expected one of ${s.enum.map((x) => JSON.stringify(x)).join(', ')}`;
  if (typeof v === 'string') {
    if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) return `${at}: does not match ${s.pattern}`;
    if (s.maxLength !== undefined && v.length > s.maxLength) return `${at}: longer than ${s.maxLength}`;
  }
  if (typeof v === 'number' && s.minimum !== undefined && v < s.minimum) return `${at}: below ${s.minimum}`;
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) return `${at}: fewer than ${s.minItems} items`;
    if (s.maxItems !== undefined && v.length > s.maxItems) return `${at}: more than ${s.maxItems} items`;
    if (s.items !== undefined) for (let i = 0; i < v.length; i++) { const e = check(s.items, v[i], `${at}[${i}]`); if (e) return e; }
  }
  if (typeOf(v) === 'object') {
    for (const k of s.required ?? []) if (!own(v, k)) return `${at}: missing ${k}`;
    for (const k of Object.keys(v)) {
      const sub = s.properties && own(s.properties, k) ? s.properties[k] : s.additionalProperties;
      if (sub === undefined) continue;
      const e = check(sub, v[k], `${at}.${k}`); if (e) return e;
    }
  }
  if (s.anyOf) {
    const errs = s.anyOf.map((x) => check(x, v, at));
    if (errs.every(Boolean)) return `${at}: fits none of the allowed shapes (${errs.join('; ')})`;
  }
  if (s.not && !check(s.not, v, at)) return `${at}: not allowed`;
  return null;
}
