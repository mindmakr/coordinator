// Spot text that looks like a credential, so nothing secret is stored.
// Lessons refuse it; run state (goal, notes, evidence) gets it masked.
// Best-effort and tuned for evidence: "token: undefined in handler" is prose,
// "DB_PASSWORD=Sup3rS3cret!" is a secret. A named value counts only when it
// looks like a credential (mixed letters and digits/symbols, or quoted).
//
// Linear time on any input: the text is read in bounded windows, every regex
// below has bounded repeats or a single place to start, and the named-value
// rule ("<name> = <value>", "<name> is <value>") is a small tokenizer rather
// than one regex (a regex for it backtracks catastrophically on "token_token_…").

// Windows break at a newline (else a space) near their end, so a secret is never cut in two in practice.
export const WINDOW = 8192;
const SLACK = 1024;

// Private keys span lines, so they are found on the whole text first.
const PEM = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/g;
const PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\b(sk|rk|pk)[-_](live|test|proj)?[-_]?[A-Za-z0-9]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
  /\beyJ[A-Za-z0-9_-]{8,256}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bauthorization\s*:\s*[A-Za-z]+\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(bearer|basic)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^/\s:@]{1,256}:[^@\s]{1,256}@/gi,
];

// Long random-looking runs are likely keys. No '/' or '.', so paths survive.
const ENTROPIC = /(?<![A-Za-z0-9_/.-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_/.-])/g;
const looksRandom = (s) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s) && new Set(s).size >= 16;

// ---- Named values: a name holding a credential word, then ":"/"=" or " is ", then a value.
// The name is a run of [A-Za-z0-9] segments joined by single "_" or "-"; one segment (or two
// adjacent ones) must be the credential word, e.g. DB_PASSWORD, api-key, JWT_SECRET_KEY.
const WORDS = new Set(['secret', 'token', 'pass', 'pwd', 'jwt', 'auth', 'passwd', 'passwod', 'passwrd', 'password', 'apikey', 'privatekey', 'accesskey', 'clientsecret', 'stripekey']);
const PAIRS = new Set(['api key', 'private key', 'access key', 'client secret', 'stripe key']);
const isAlnum = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isSep = (c) => c === 95 || c === 45; // _ -
const isQuote = (c) => c === 34 || c === 39;
const SPACE = /\s/;
const isSpace = (t, i) => i < t.length && SPACE.test(t[i]);
const isLetter = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isWord = (c) => isAlnum(c) || c === 95;
const SYMBOL = new Set('0123456789!@#$%^&*+/='.split('').map((c) => c.charCodeAt(0)));
const BREAK = (c) => c === 34 || c === 39; // plus whitespace, checked with SPACE
const STOP2 = new Set([34, 39, 44, 59, 41]); // " ' , ; )

// Per-text facts for the unquoted value rule, each found in one right-to-left pass.
function facts(t) {
  const n = t.length;
  const brk = new Int32Array(n + 1); const sym = new Int32Array(n + 1); const letter = new Int32Array(n + 1);
  const slash = new Int32Array(n + 1); const trig = new Int32Array(n + 1); const stop = new Int32Array(n + 1);
  brk[n] = sym[n] = letter[n] = slash[n] = trig[n] = stop[n] = n;
  for (let i = n - 1; i >= 0; i--) {
    const c = t.charCodeAt(i);
    const space = SPACE.test(t[i]);
    brk[i] = BREAK(c) || space ? i : brk[i + 1];
    stop[i] = STOP2.has(c) || space ? i : stop[i + 1];
    sym[i] = SYMBOL.has(c) ? i : sym[i + 1];
    letter[i] = isLetter(c) ? i : letter[i + 1];
    slash[i] = c === 47 || c === 92 ? i : slash[i + 1];
    // A path's tail: ".ext" (1-5 letters, then no word character) or ":<digit>".
    let pathy = false;
    if (c === 58) pathy = i + 1 < n && t.charCodeAt(i + 1) >= 48 && t.charCodeAt(i + 1) <= 57;
    else if (c === 46) { let k = 0; while (k < 6 && i + 1 + k < n && isLetter(t.charCodeAt(i + 1 + k))) k++; pathy = k >= 1 && k <= 5 && !(i + 1 + k < n && isWord(t.charCodeAt(i + 1 + k))); }
    trig[i] = pathy ? i : trig[i + 1];
  }
  return { brk, sym, letter, slash, trig, stop };
}

// The end of a credential-like value starting at p, or -1.
function valueEnd(t, p, f) {
  const c = t.charCodeAt(p);
  if (isQuote(c)) {
    const j = t.indexOf(t[p], p + 1);
    return j >= 0 && j - p - 1 >= 6 ? j + 1 : -1;
  }
  const F = f();
  const end = F.brk[p]; // the token: up to whitespace or a quote
  if (F.sym[p] >= end || F.letter[p] >= end) return -1; // needs a digit or symbol, and a letter
  const s = F.slash[p];
  if (s < end && F.trig[Math.min(s + 1, t.length)] < end) return -1; // a file path, not a credential
  return F.stop[p] - p >= 8 ? F.stop[p] : -1;
}

// Whether the name ending at b (a run of name characters starting at a) holds a credential word,
// and where the match starts (or -1). from: where the previous match ended.
function nameStart(t, a, b, from, quoted) {
  const segs = [];
  let p = b;
  for (;;) {
    let q = p;
    while (q > a && isAlnum(t.charCodeAt(q - 1))) q--;
    if (q === p) break;
    segs.unshift([q, p]);
    if (q - 1 > a && isSep(t.charCodeAt(q - 1)) && isAlnum(t.charCodeAt(q - 2))) { p = q - 1; continue; }
    break;
  }
  // Mid-word after an earlier match: the name cannot start right after a letter or digit.
  if (segs.length && segs[0][0] === from && from > 0 && isAlnum(t.charCodeAt(from - 1))) segs.shift();
  if (!segs.length) return -1;
  const words = segs.map(([x, y]) => t.slice(x, y).toLowerCase());
  const hit = words.some((w, i) => WORDS.has(w) || (i + 1 < words.length && PAIRS.has(`${w} ${words[i + 1]}`)));
  if (!hit) return -1;
  const s = segs[0][0];
  // An opening quote belongs to the match when nothing word-like comes before it.
  if (quoted && s === a && s - 1 >= from && isQuote(t.charCodeAt(s - 1)) && !(s - 2 >= 0 && isAlnum(t.charCodeAt(s - 2)))) return s - 1;
  return s;
}

// [start, end] pairs of every "<name> : value" (form 'assign') or "<name> is value" (form 'is'), left to right.
function* named(t, form) {
  let F = null;
  const f = () => (F ??= facts(t));
  const RUN = /[A-Za-z0-9_-]+/g;
  let from = 0;
  RUN.lastIndex = 0;
  let m;
  while ((m = RUN.exec(t))) {
    const a = m.index; const b = a + m[0].length;
    let p = b;
    if (form === 'assign') {
      if (isQuote(t.charCodeAt(p))) p++;
      while (isSpace(t, p)) p++;
      if (t[p] !== ':' && t[p] !== '=') continue;
      p++;
      while (isSpace(t, p)) p++;
    } else {
      if (!isSpace(t, p)) continue;
      while (isSpace(t, p)) p++;
      if (t.slice(p, p + 2).toLowerCase() !== 'is' || !isSpace(t, p + 2)) continue;
      p += 2;
      while (isSpace(t, p)) p++;
    }
    if (p >= t.length) continue;
    const start = nameStart(t, a, b, from, form === 'assign');
    if (start < 0) continue;
    const end = valueEnd(t, p, f);
    if (end < 0) continue;
    yield [start, end];
    from = end;
    RUN.lastIndex = end;
  }
}

function replaceNamed(t, form) {
  let out = ''; let last = 0;
  for (const [s, e] of named(t, form)) { out += `${t.slice(last, s)}[redacted]`; last = e; }
  return last ? out + t.slice(last) : t;
}

// The text in windows of at most WINDOW characters, each ending at a line break or space when one is near.
function windows(text) {
  if (text.length <= WINDOW) return [text];
  const out = [];
  for (let i = 0; i < text.length;) {
    let j = Math.min(text.length, i + WINDOW);
    if (j < text.length) {
      const tail = text.slice(j - SLACK, j);
      let k = tail.lastIndexOf('\n');
      if (k < 0) { k = SLACK - 1; while (k >= 0 && !SPACE.test(tail[k])) k--; }
      if (k >= 0) j = j - SLACK + k + 1;
    }
    out.push(text.slice(i, j)); i = j;
  }
  return out;
}

function findIn(w) {
  for (const re of PATTERNS) { re.lastIndex = 0; if (re.test(w)) return true; }
  if (!named(w, 'assign').next().done || !named(w, 'is').next().done) return true;
  return (w.match(ENTROPIC) ?? []).some(looksRandom);
}

function maskIn(w) {
  let out = w;
  for (const re of PATTERNS) { re.lastIndex = 0; out = out.replace(re, '[redacted]'); }
  out = replaceNamed(replaceNamed(out, 'assign'), 'is');
  return out.replace(ENTROPIC, (m) => (looksRandom(m) ? '[redacted]' : m));
}

export function findSecret(text) {
  const s = String(text ?? '');
  PEM.lastIndex = 0;
  if (PEM.test(s)) return true;
  return windows(s).some(findIn);
}

export function maskSecrets(text) {
  const s = String(text ?? '');
  PEM.lastIndex = 0;
  return windows(s.replace(PEM, '[redacted]')).map(maskIn).join('');
}
