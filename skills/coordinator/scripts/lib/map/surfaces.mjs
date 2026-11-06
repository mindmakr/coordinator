// Surfaces found by where a file sits: Next.js app router pages and route
// handlers, pages-router pages and API routes, Expo Router screens and
// *Screen components; plus message catalogs (locale JSON) flattened to keys.
import { posix } from 'node:path';

const PAGE = /^(.*?\/)?(?:src\/)?app\/((?:.*\/)?)page\.[jt]sx?$/;
const ROUTE = /^(.*?\/)?(?:src\/)?app\/((?:.*\/)?)route\.[jt]s$/;
const PAGES = /^(.*?\/)?(?:src\/)?pages\/(.+)\.[jt]sx?$/;
const HTTP = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
// Two letters, with an optional region (en, ar, pt-BR, zh_Hant): three-letter names are too often other files (map.json, app.json).
const LOCALE = /^[a-z]{2}(?:[-_][A-Za-z]{2,4})?$/;
const CATALOG_DIR = /(^|\/)(locales?|messages|i18n|lang|langs|translations|intl)(\/|$)/i;

// Folder segments to a URL: route groups (x) and parallel slots @x drop out, [id] stays.
const urlOf = (segs) => `/${segs.split('/').filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@')).join('/')}`.replace(/\/$/, '') || '/';

export function fileSurfaces(files, exportsOf) {
  const out = [];
  const expoRoots = new Set(files.filter((f) => /(^|\/)app\/_layout\.[jt]sx?$/.test(f)).map((f) => f.replace(/_layout\.[jt]sx?$/, '')));
  for (const f of files) {
    let m;
    if ((m = PAGE.exec(f))) out.push({ kind: 'screen', path: urlOf(m[2]), file: f });
    else if ((m = ROUTE.exec(f))) {
      const methods = (exportsOf(f) ?? []).map((e) => e.name).filter((n) => HTTP.includes(n));
      for (const method of methods.length ? methods : ['ALL']) out.push({ kind: 'route', method, path: urlOf(m[2]), file: f });
    } else if ((m = PAGES.exec(f)) && !/(^|\/)_(app|document|error)$/.test(m[2])) {
      const p = m[2].replace(/(^|\/)index$/, '');
      if (p.startsWith('api/') || p === 'api') out.push({ kind: 'route', method: 'ALL', path: `/${p}`, file: f });
      else out.push({ kind: 'screen', path: `/${p}`, file: f });
    } else if ([...expoRoots].some((r) => f.startsWith(r)) && /\.[jt]sx$/.test(f) && !/(^|\/)[_+]/.test(posix.basename(f))) {
      const root = [...expoRoots].find((r) => f.startsWith(r));
      out.push({ kind: 'screen', path: urlOf(f.slice(root.length).replace(/\.[jt]sx$/, '').replace(/(^|\/)index$/, '')), file: f });
    } else if (/(^|\/)[A-Z]\w*Screen\.[jt]sx?$/.test(f)) out.push({ kind: 'screen', path: posix.basename(f).replace(/\.[jt]sx?$/, ''), file: f });
  }
  return out;
}

const isCatalog = (f) => /\.json$/.test(f) && !/(^|\/)(package|tsconfig|jsconfig|composer|app|eas|vercel|components)\.json$|lock|meta\/|snapshot/i.test(f)
  && (CATALOG_DIR.test(posix.dirname(f)) || /messages?/i.test(posix.basename(f)) || LOCALE.test(posix.basename(f, '.json')));

function flatten(obj, prefix, out, depth = 0) {
  if (depth > 12 || out.size > 50_000) return;
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.add(key);
    else if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out, depth + 1);
  }
}

// Message keys: key → { locales, dirs }, and per catalog folder its locales and key count.
export function catalogs(files, read) {
  const keys = new Map(); const sources = []; const dirs = new Map();
  for (const f of files.filter(isCatalog)) {
    let j; try { j = JSON.parse(read(f) ?? ''); } catch { continue; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) continue;
    const name = posix.basename(f, '.json'); const dir = posix.basename(posix.dirname(f));
    const top = Object.keys(j);
    const byLocale = top.length && top.every((k) => LOCALE.test(k)) ? top.map((k) => [k, j[k], '']) // { en: {…}, ar: {…} }
      : [[LOCALE.test(name) ? name : LOCALE.test(dir) ? dir : 'default', j, LOCALE.test(name) || !LOCALE.test(dir) ? '' : name]];
    let found = 0;
    for (const [loc, tree, ns] of byLocale) {
      if (!tree || typeof tree !== 'object') continue;
      const set = new Set(); flatten(tree, ns, set);
      const d = posix.dirname(f);
      if (!dirs.has(d)) dirs.set(d, { locales: new Set(), keys: new Set() });
      if (set.size) dirs.get(d).locales.add(loc);
      for (const k of set) { if (!keys.has(k)) keys.set(k, { locales: new Set(), dirs: new Set() }); keys.get(k).locales.add(loc); keys.get(k).dirs.add(d); dirs.get(d).keys.add(k); }
      found += set.size;
    }
    if (found) sources.push(f);
  }
  // A key misses the locales its folders have and it lacks.
  for (const v of keys.values()) v.missing = [...new Set([...v.dirs].flatMap((d) => [...dirs.get(d).locales]))].filter((l) => !v.locales.has(l) && l !== 'default').sort();
  const list = [...dirs].filter(([, v]) => v.keys.size).map(([dir, v]) => `${dir} ${[...v.locales].sort().join('/')} ${v.keys.size}`).sort();
  return { keys, sources, dirs: list };
}

// '/v1/employees/:id', '/employees/[id]' and `/employees/${id}` compare alike.
// A leading `${API_URL}` is a base URL, not a segment.
export const segs = (p) => String(p).replace(/^https?:\/\/[^/]+/, '').replace(/^\$\{[^}]*\}/, '').replace(/\$\{[^}]*\}/g, ':p').split('?')[0].split('/').filter(Boolean)
  .map((s) => (/^(:|\[)/.test(s) || s === ':p' ? ':' : s));

// A client call matches a route when the route's path ends with the call's.
export function callMatches(call, route) {
  const c = segs(call); const r = segs(route);
  if (!c.length || c.length > r.length || !c.some((s) => s !== ':')) return false;
  const tail = r.slice(r.length - c.length);
  return c.every((s, i) => s === ':' || tail[i] === ':' || s === tail[i]);
}
