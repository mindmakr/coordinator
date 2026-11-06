// What one JS/TS file says about itself, by pattern over the lexed text
// (lib/map/lex.mjs), not a parser: imports and re-exports with the names
// they take, exports, function bodies (hashed for reuse), env vars, settings
// keys, routes, client API calls and message keys. Best effort by design;
// references/map.md lists what it misses.
import { createHash } from 'node:crypto';
import { lex, lines, match } from './lex.mjs';

const KEYWORDS = new Set('if for while switch catch with function return else do try finally typeof instanceof new delete void in of yield await async class extends super this import export default const let var case break continue throw debugger null undefined true false static get set constructor'.split(' '));
const METHODS = 'get|post|put|patch|delete|head|options|all';
const SERVER = /^(app|router|fastify|server|instance|srv|api[A-Z]\w*Router|\w*[Rr]outer|\w*[Aa]pp|\w*[Ss]erver|f|r|route|routes)$/;
const CLIENT = /^(axios|api|apiClient|client|http|https?Client|\$http|ky|fetcher|request|instance\w*|\w*[Aa]pi|\w*[Cc]lient)$/;
// Anchored on the keyword, then widened by hand: far cheaper than a pattern that starts at every identifier.
const SETTINGS = /(?:[sS]ettings|[cC]onfig|[pP]references|[pP]refs)(?=\s*\??\.\s*[A-Za-z_$])/g;
const PROPS = /(?:\s*\??\.\s*[A-Za-z_$][\w$]*){1,3}/y;
// The identifier ending at `end` (exclusive), and where it starts.
function identBefore(text, end) {
  let s = end;
  while (s > 0 && /[\w$]/.test(text[s - 1])) s--;
  return { name: text.slice(s, end), start: s };
}
export const MIN_BODY = { lines: 4, chars: 120 };
export const TEST = /(^|\/)(__tests__|__mocks__|tests?|e2e|spec)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$/;

const strings = /(['"])(?:\\.|(?!\1)[^\\\n])*\1|`(?:\\.|[^\\`])*`/g;

// Import clause → names taken ('default', '*' for a namespace, or the exported
// names) and the local name each is bound to.
function clauseNames(clause) {
  const names = []; const locals = {}; let ns = null;
  const brace = /\{([^}]*)\}/.exec(clause);
  if (brace) {
    for (const part of brace[1].split(',')) {
      const m = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?/.exec(part);
      if (m) { names.push(m[1]); locals[m[2] ?? m[1]] = m[1]; }
    }
  }
  const head = clause.replace(/\{[^}]*\}/, '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const h of head) {
    const star = /^\*\s+as\s+([\w$]+)$/.exec(h);
    if (star) { ns = star[1]; names.push('*'); locals[ns] = '*'; } else if (/^[\w$]+$/.test(h) && h !== 'type') { names.push('default'); locals[h] = 'default'; }
  }
  return { names, ns, locals };
}

// Alpha-renamed, literal-free text of a body: renamed copies hash alike.
export function shape(body) {
  const ids = new Map();
  return body.replace(strings, '"s"').replace(/\b\d[\d_.eExXa-fA-F]*\b/g, '0')
    .replace(/(\.\s*)?([A-Za-z_$][\w$]*)/g, (m, dot, id) => {
      if (dot || KEYWORDS.has(id)) return m;
      if (!ids.has(id)) ids.set(id, `v${ids.size}`);
      return ids.get(id);
    }).replace(/\s+/g, ' ').trim();
}

// The names a stretch of code refers to (not property names after a dot).
export const idsIn = (text) => new Set(text.match(/(?<![\w$.])[A-Za-z_$][\w$]*/g) ?? []);

// Function bodies: hashed for reuse (when big enough), and every named body's
// identifiers (`uses`), so a route handler can be traced one call deep.
function functions(code, bare, lineOf) {
  const out = []; const seen = new Set(); const uses = new Map();
  const add = (name, open) => {
    if (open < 0 || seen.has(open) || bare[open] !== '{') return;
    const end = match(bare, open);
    if (end < 0) return;
    seen.add(open);
    if (name !== 'anonymous' && !uses.has(name)) uses.set(name, idsIn(bare.slice(open, end)));
    const body = code.slice(open + 1, end - 1);
    const first = lineOf(open); const last = lineOf(end - 1);
    if (last - first + 1 < MIN_BODY.lines) return;
    const sh = shape(body);
    if (sh.length < MIN_BODY.chars) return;
    out.push({ name, line: first, lines: last - first + 1, hash: createHash('sha1').update(sh).digest('hex').slice(0, 12) });
  };
  // After the parameter list: an optional return type, then `{` or `=> {`.
  const bodyAfter = (paren) => {
    const close = match(bare, paren);
    if (close < 0) return -1;
    const m = /^\s*(?::\s*[^{=;]*?)?\s*(=>\s*)?\{/.exec(bare.slice(close, close + 300));
    return m ? close + m[0].length - 1 : -1;
  };
  for (const m of bare.matchAll(/\bfunction\b\s*\*?\s*([\w$]+)?\s*(?:<[^>{}()]*>)?\s*\(/g)) add(m[1] ?? 'anonymous', bodyAfter(m.index + m[0].length - 1));
  for (const m of bare.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=\n]+)?=\s*(?:async\s+)?(?:<[^>{}()]*>\s*)?\(/g)) add(m[1], bodyAfter(m.index + m[0].length - 1));
  for (const m of bare.matchAll(/^[ \t]*(?:(?:public|private|protected|static|async|override|readonly)\s+)*([\w$]+)\s*(?:<[^>{}()]*>)?\s*\(/gm)) {
    if (!KEYWORDS.has(m[1])) add(m[1], bodyAfter(m.index + m[0].length - 1));
  }
  out.sort((a, b) => a.line - b.line);
  return { fns: out, uses };
}

// The top-level keys of the object literal opening at `open`.
function objectKeys(bare, open) {
  const end = match(bare, open);
  if (end < 0) return [];
  const keys = []; let depth = 0; let start = open + 1;
  for (let i = open + 1; i < end - 1; i++) {
    const c = bare[i];
    if ('{[('.includes(c)) depth++; else if ('}])'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { keys.push(bare.slice(start, i)); start = i + 1; }
  }
  keys.push(bare.slice(start, end - 1));
  return keys.map((k) => /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*(?::|,|$|\()/.exec(k)?.[1]).filter((k) => k && !k.startsWith('...'));
}

export function analyse(src, file = '') {
  const { code, bare } = lex(src);
  const lineOf = lines(src);
  const at = (i) => lineOf(i);
  const imports = []; const exports = []; const env = []; const settings = []; const routes = []; const calls = []; const msgs = []; const mounts = [];
  const nsNames = new Map();

  for (const m of code.matchAll(/\bimport\s+(type\s+)?([\w$]+\s*,\s*(?:\*\s*as\s+[\w$]+|\{[^}]*\})|[\w$]+|\*\s*as\s+[\w$]+|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\3/g)) {
    const { names, ns, locals } = clauseNames(m[2]);
    imports.push({ spec: m[4], names, locals, line: at(m.index), type: !!m[1] });
    if (ns) nsNames.set(ns, imports.at(-1));
  }
  for (const m of code.matchAll(/\bimport\s*(['"])([^'"\n]+)\1/g)) imports.push({ spec: m[2], names: [], line: at(m.index) });
  for (const m of code.matchAll(/\bexport\s+(type\s+)?(\*(?:\s+as\s+([\w$]+))?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\4/g)) {
    const star = m[2].startsWith('*');
    const pairs = star ? [] : m[2].slice(1, -1).split(',').map((p) => /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?/.exec(p)).filter(Boolean).map((x) => [x[1], x[2] ?? x[1]]);
    imports.push({ spec: m[5], names: star ? ['*'] : pairs.map((p) => p[0]), line: at(m.index), reexport: star && !m[3] ? '*' : pairs, type: !!m[1] });
    if (m[3]) exports.push({ name: m[3], kind: 'const', line: at(m.index) });
  }
  for (const m of code.matchAll(/(?:\b(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*)?\brequire\s*\(\s*(['"])([^'"\n]+)\2\s*\)/g)) {
    const names = m[1]?.startsWith('{') ? m[1].slice(1, -1).split(',').map((p) => /^\s*([\w$]+)/.exec(p)?.[1]).filter(Boolean) : ['*'];
    imports.push({ spec: m[3], names, locals: m[1] && !m[1].startsWith('{') ? { [m[1]]: '*' } : {}, line: at(m.index) });
    if (m[1] && !m[1].startsWith('{')) nsNames.set(m[1], imports.at(-1));
  }
  // import('x'), and `const { a, b } = await import('x')`, which names what it takes.
  for (const m of code.matchAll(/(?:\b(?:const|let|var)\s*(\{[^}]*\}|[\w$]+)\s*=\s*(?:await\s+)?)?\bimport\s*\(\s*(['"])([^'"\n]+)\2\s*\)/g)) {
    const named = m[1]?.startsWith('{') ? m[1].slice(1, -1).split(',').map((p) => /^\s*([\w$]+)(?:\s*:\s*([\w$]+))?/.exec(p)).filter(Boolean) : null;
    imports.push({ spec: m[3], names: named ? named.map((x) => x[1]) : ['*'], locals: named ? Object.fromEntries(named.map((x) => [x[2] ?? x[1], x[1]])) : m[1] ? { [m[1]]: '*' } : {}, line: at(m.index), dynamic: true });
  }
  // `ns.name` after `import * as ns` or `const ns = require(…)` counts as taking `name`.
  for (const [ns, imp] of nsNames) for (const m of bare.matchAll(new RegExp(`(?<![\\w$.])${ns.replace(/\$/g, '\\$')}\\.([A-Za-z_$][\\w$]*)`, 'g'))) if (!imp.names.includes(m[1])) imp.names.push(m[1]);

  for (const m of bare.matchAll(/\bexport\s+(default\s+)?(?:declare\s+)?(async\s+)?(function\s*\*?|class|abstract\s+class|const|let|var|enum)\s*([\w$]+)?/g)) {
    const kind = /function/.test(m[3]) ? 'function' : /class/.test(m[3]) ? 'class' : 'const';
    let k = kind;
    if (kind === 'const' && m[4]) { const rest = bare.slice(m.index + m[0].length, m.index + m[0].length + 200); if (/^\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>|<)/.test(rest)) k = 'function'; }
    exports.push({ name: m[1] ? 'default' : (m[4] ?? 'default'), kind: k, line: at(m.index) });
    if (m[1] && m[4]) exports.push({ name: m[4], kind: k, line: at(m.index), local: true });
  }
  for (const m of bare.matchAll(/\bexport\s+default\s+(?!function|class|async)/g)) exports.push({ name: 'default', kind: 'const', line: at(m.index) });
  for (const m of bare.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from)/g)) {
    for (const p of m[1].split(',')) { const x = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?/.exec(p); if (x) exports.push({ name: x[2] ?? x[1], kind: 'const', line: at(m.index), local: x[1] }); }
  }
  for (const m of bare.matchAll(/\b(?:module\.)?exports\.([\w$]+)\s*=/g)) exports.push({ name: m[1], kind: 'const', line: at(m.index) });
  for (const m of bare.matchAll(/\bmodule\.exports\s*=\s*\{/g)) for (const k of objectKeys(bare, m.index + m[0].length - 1)) exports.push({ name: k, kind: 'const', line: at(m.index) });

  const { fns, uses } = functions(code, bare, lineOf);
  // A variable stands for what its initialiser names (`const costSvc = new CostTypeService()`), so a handler reaches the import through it.
  for (const m of bare.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=\n]+)?=(?!>)\s*([^;\n]{1,200})/g)) if (!uses.has(m[1])) uses.set(m[1], idsIn(m[2]));
  // A named export of a local function is a function export.
  const fnNames = new Set(fns.map((f) => f.name));
  for (const e of exports) if (e.kind === 'const' && fnNames.has(typeof e.local === 'string' ? e.local : e.name)) e.kind = 'function';
  for (const m of bare.matchAll(/\b(?:async\s+)?function\s+([\w$]+)/g)) fnNames.add(m[1]);
  for (const m of bare.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=\n]+)?=\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>)/g)) fnNames.add(m[1]);
  for (const e of exports) if (e.kind === 'const' && typeof e.local === 'string' && fnNames.has(e.local)) e.kind = 'function';

  // Env vars: process.env.X, process.env['X'], import.meta.env.X, destructuring.
  const assigned = (end) => /^\s*(?:=(?!=)|\+=|\|\|=|\?\?=)/.test(bare.slice(end, end + 5));
  for (const m of bare.matchAll(/(?:process|import\.meta)\.env\s*(?:\.\s*([A-Za-z_]\w*)|\[)/g)) {
    if (/[\w$.]/.test(bare[m.index - 1] ?? '')) continue;
    const del = /\bdelete\s+$/.test(bare.slice(Math.max(0, m.index - 10), m.index));
    let key = m[1]; let end = m.index + m[0].length;
    if (!key) { const s = /^\s*(['"])([^'"\n]+)\1\s*\]/.exec(code.slice(end, end + 120)); if (!s) continue; key = s[2]; end += s[0].length; }
    env.push({ key, line: at(m.index), write: del || assigned(end) });
  }
  for (const m of bare.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*process\.env\b/g)) {
    for (const p of m[1].split(',')) { const x = /^\s*([A-Za-z_]\w*)/.exec(p); if (x) env.push({ key: x[1], line: at(m.index), write: false }); }
  }

  // Settings and config keys: property chains and key-string getters/setters.
  for (const m of bare.matchAll(SETTINGS)) {
    const after = m.index + m[0].length;
    const id = identBefore(bare, after);
    PROPS.lastIndex = after;
    const chain = PROPS.exec(bare);
    if (!chain) continue;
    const props = chain[0].replace(/[\s?]/g, '').split('.').filter(Boolean);
    const end = PROPS.lastIndex;
    if (/^\s*\(/.test(bare.slice(end, end + 3))) props.pop(); // a method call, not a key
    if (props.at(-1) === 'length') props.pop();
    if (!props.length || props[0] === 'env') continue;
    const dot = /\??\.\s*$/.exec(bare.slice(Math.max(0, id.start - 4), id.start));
    const owner = dot ? identBefore(bare, id.start - dot[0].length).name : null;
    settings.push({ key: [id.name, ...props].join('.'), owner: owner && owner !== 'this' ? owner : null, line: at(m.index), write: assigned(end) });
  }
  for (const m of code.matchAll(/(?:[sS]ettings?|[cC]onfig)\s*\.\s*(get|set|has|update)\s*\(\s*(['"])([\w.:-]+)\2/g)) {
    const recv = identBefore(code, m.index + /^\w+/.exec(m[0])[0].length).name;
    settings.push({ key: `${recv}.${m[3]}`, owner: null, line: at(m.index), write: m[1] === 'set' || m[1] === 'update' });
  }
  for (const m of code.matchAll(/\b(get|set|update)Setting\s*\(\s*(['"])([\w.:-]+)\2/g)) settings.push({ key: `settings.${m[3]}`, owner: null, line: at(m.index), write: m[1] !== 'get' });
  for (const m of bare.matchAll(/[sS]ettings\s*:\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    if (bare.slice(open, match(bare, open)).includes(';')) continue; // a type literal ({ a: boolean; b: number }), not a value
    const name = identBefore(bare, m.index + 8).name;
    for (const k of objectKeys(bare, m.index + m[0].length - 1)) settings.push({ key: `${name}.${k}`, owner: null, line: at(m.index), write: true });
  }

  // Routes: receiver.get('/path', …), .route({ method, url }); client calls: api.get('/x'), fetch('/x').
  // Tests call routes (app.inject, supertest) rather than declare them: skipped.
  const isTest = TEST.test(file);
  for (const m of bare.matchAll(new RegExp(`\\.\\s*(${METHODS})\\s*(?=[<(])`, 'g'))) {
    let i = m.index + m[0].length;
    if (bare[i] === '<') { // type arguments, nested: get<Api<{ a: B }>>(…)
      let depth = 0;
      for (const stop = i + 400; i < stop && i < bare.length; i++) { if (bare[i] === '<') depth++; else if (bare[i] === '>' && --depth === 0) { i++; break; } else if (bare[i] === ';') break; }
    }
    const arg = /^\s*\(\s*(['"`])([^'"`\n]*)\1/.exec(code.slice(i, i + 300));
    if (!arg || isTest) continue;
    const method = m[1].toUpperCase(); const path = arg[2];
    const before = code.slice(Math.max(0, m.index - 80), m.index).trimEnd();
    const recv = identBefore(before, before.length).name;
    const client = CLIENT.test(recv) && !SERVER.test(recv);
    if (client && (/^(\/|https?:|\$\{)/.test(path) || /^[\w-]+\/[\w${}:./-]*$/.test(path))) calls.push({ method, path: path.startsWith('/') || /^(https?:|\$\{)/.test(path) ? path : `/${path}`, line: at(m.index) });
    else if (!client && path.startsWith('/') && (SERVER.test(recv) || /(^|\/)(routes?|server|api|controllers?|handlers?)(\/|\.|$)/.test(file))) {
      // What the handler refers to: the call's own arguments, so services come from the handler, not the whole file.
      const open = i + arg[0].indexOf('(');
      const close = match(bare, open);
      routes.push({ method, path, line: at(m.index), ids: [...idsIn(bare.slice(open, close < 0 ? open + 2000 : close))] });
    }
  }
  for (const m of isTest ? [] : bare.matchAll(/\.\s*route\s*\(\s*\{/g)) {
    const end = match(bare, m.index + m[0].length - 1);
    const obj = code.slice(m.index, end < 0 ? m.index + 400 : end);
    const url = /\b(?:url|path)\s*:\s*(['"`])([^'"`\n]+)\1/.exec(obj);
    const meth = /\bmethod\s*:\s*(\[[^\]]*\]|(['"])\w+\2)/.exec(obj);
    if (url) for (const x of (meth ? meth[1].match(/\w+/g) : ['ALL'])) routes.push({ method: x.toUpperCase(), path: url[2], line: at(m.index), ids: [...idsIn(bare.slice(m.index, end < 0 ? m.index + 400 : end))] });
  }
  for (const m of isTest ? [] : code.matchAll(/\bfetch\s*\(\s*(['"`])([^'"`\n]+)\1(?:\s*,\s*\{[^}]*?method\s*:\s*(['"])(\w+)\3)?/g)) calls.push({ method: (m[4] ?? 'GET').toUpperCase(), path: m[2], line: at(m.index) });
  // register(plugin, { prefix }) (Fastify) and use('/prefix', router) (Express).
  // A register without a prefix still chains: the plugin's routes sit under its parent's prefix.
  for (const m of code.matchAll(/\.\s*register\s*\(\s*([\w$]+)\s*(?:,\s*\{([^{}]*)\})?\s*\)/g)) mounts.push({ ident: m[1], prefix: /\bprefix\s*:\s*(['"`])([^'"`\n]+)\1/.exec(m[2] ?? '')?.[2] ?? '' });
  for (const m of code.matchAll(/\.\s*use\s*\(\s*(['"`])(\/[^'"`\n]*)\1\s*,\s*([\w$]+)/g)) mounts.push({ ident: m[3], prefix: m[2] });

  // Message keys: t('a.b'), i18n.t, $t, formatMessage({ id }), i18nKey="…", with a namespace from useTranslations('ns').
  // A translator bound to a namespace (`const tA = useTranslations('admin')`) prefixes its keys.
  const tvars = new Map([['t', null], ['i18n.t', null], ['$t', null], ['translate', null]]);
  const ns = new Set();
  for (const m of code.matchAll(/(?:\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?)?\b(?:useTranslations?|getTranslations)\s*\(\s*(?:\{[^}]*?namespace\s*:\s*)?(['"])([\w.-]+)\2/g)) {
    ns.add(m[3]);
    if (m[1]) tvars.set(m[1], m[3]);
  }
  for (const [v, space] of tvars) {
    const re = new RegExp(`(?<![\\w$.])${v.replace(/[.$]/g, '\\$&')}(?:\\.rich|\\.raw|\\.markup)?\\s*\\(\\s*(['"\`])([\\w.:-]+)\\1`, 'g');
    for (const m of code.matchAll(re)) msgs.push({ key: m[2].replace(':', '.'), ns: space, line: at(m.index) });
  }
  for (const m of code.matchAll(/\b(?:formatMessage\s*\(\s*\{\s*id\s*:\s*|i18nKey\s*=\s*\{?\s*)(['"`])([\w.:-]+)\1/g)) msgs.push({ key: m[2].replace(':', '.'), ns: null, line: at(m.index) });

  return { imports, exports, fns, uses, env, settings, routes, calls, mounts, msgs, ns: [...ns], lines: lineOf(src.length) };
}
