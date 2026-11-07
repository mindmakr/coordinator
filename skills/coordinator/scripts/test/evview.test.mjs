import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hud, liveCtx, staticCtx } from '../lib/hud.mjs';
import { csp } from '../lib/parts.mjs';
import { decide } from '../lib/rules.mjs';
import { runTimeline } from '../lib/timeline.mjs';
import { unitPage } from '../lib/unitpage.mjs';
import { view } from '../lib/view.mjs';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (min) => new Date(T0 + min * 60_000).toISOString();
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const HOSTILE = '<img src=x onerror=alert(1)>"><script>alert(2)</script>';

// One unit with a screenshot, a log file, inline test output, a PDF, a missing screenshot and a link.
function state({ label = 'list ar 360', shot = 'u1/E1-list-ar-360.png' } = {}) {
  const ev = [
    { id: 'E1', kind: 'screenshot', label, behaviour: null, at: at(5), file: shot, type: 'image' },
    { id: 'E2', kind: 'log', label: 'server log', behaviour: null, at: at(6), file: 'u1/E2-server.log', type: 'text' },
    { id: 'E3', kind: 'test', label: 'unit tests', behaviour: null, at: at(7), text: '12 passed <b>ok</b>' },
    { id: 'E4', kind: 'pdf', label: 'report', behaviour: null, at: at(8), file: 'u1/E4-report.pdf', type: 'doc' },
    { id: 'E5', kind: 'screenshot', label: 'gone', behaviour: null, at: at(9), file: 'u1/E5-gone.png', type: 'image' },
    { id: 'E6', kind: 'link', label: 'preview', behaviour: null, at: at(10), url: 'https://example.com/p' },
  ];
  return {
    id: 'r1', tag: 'code', goal: 'g', bar: 'b', fence: 'f', paths: [],
    budget: { maxRounds: 4, maxMinutes: 240, maxUnits: 6, maxAdded: 2, staleMinutes: 45 },
    createdAt: at(0), frozen: true, addedAfterFreeze: 0, integration: { rounds: [] }, closed: null, notes: [],
    units: [{
      id: 'u1', bar: 'b', after: null, status: 'open', strategyChanges: 0, strategyAt: -1,
      rounds: [{ n: 1, verdict: 'fail', score: 4, gap: 'gap', evidence: 'e', at: at(6.5) }],
      evidence: ev,
      log: ev.map((e) => ({ kind: 'evidence', text: `${e.id} ${e.kind}: ${e.label}`, at: e.at })),
    }],
  };
}
function runDir(s) {
  const dir = mkdtempSync(join(tmpdir(), 'evview-'));
  mkdirSync(join(dir, 'artifacts', 'u1'), { recursive: true });
  try { writeFileSync(join(dir, 'artifacts', ...s.units[0].evidence[0].file.split('/')), PNG); } catch { /* a name this file system refuses: missing */ }
  writeFileSync(join(dir, 'artifacts', 'u1', 'E2-server.log'), 'GET /x 200\n<script>alert(3)</script> & done');
  writeFileSync(join(dir, 'artifacts', 'u1', 'E4-report.pdf'), '%PDF-1.4');
  return dir;
}
const render = (s, ctx, page = 'hud') => {
  const v = view(s, decide(s, T0 + 30 * 60_000), T0 + 30 * 60_000);
  return page === 'hud' ? hud(v, T0, ctx) : unitPage(v, 'u1', T0, ctx);
};
const row = (html, id) => html.match(new RegExp(`<li[^>]*data-badge="evidence"[^>]*>(?:(?!</li>).)*${id} (?:(?!</li>).)*</li>`, 's'))?.[0] ?? '';
const overlay = (html, id) => html.match(new RegExp(`<div class="evv" id="ev-u1-${id}"(?:(?!<div class="evv" ).)*`, 's'))?.[0] ?? '';

test('an evidence event points at its stored item', () => {
  const e = runTimeline(state()).find((x) => x.text.startsWith('E1 '));
  assert.deepEqual(e.ev, { target: 'u1', id: 'E1', kind: 'screenshot', label: 'list ar 360', file: 'u1/E1-list-ar-360.png', type: 'image', inline: false });
  const old = state(); old.units[0].log.push({ kind: 'evidence', text: 'E99 log: never stored', at: at(11) }, { kind: 'beat', text: 'E1 is next', at: at(12) });
  assert.ok(runTimeline(old).filter((x) => /^E99|^E1 is/.test(x.text)).every((x) => !x.ev), 'no item, or not an evidence entry: plain text');
});

test('snapshot: evidence rows open the viewer, with a lazy thumbnail from the stored copy, never an outside URL', () => {
  const s = state(); const html = render(s, staticCtx(runDir(s), 0));
  const r1 = row(html, 'E1');
  assert.match(r1, /<a class="evlink" href="#ev-u1-E1" data-ev-open><img class="evt-thumb" src="artifacts\/u1\/E1-list-ar-360\.png" alt="" loading="lazy" decoding="async"><span>E1 screenshot: list ar 360<\/span><\/a>/);
  assert.match(row(html, 'E2'), /href="#ev-u1-E2" data-ev-open><span>E2 log/, 'a log opens too, without a thumbnail');
  assert.match(row(html, 'E3'), /href="#ev-u1-E3" data-ev-open/, 'inline test output opens too');
  assert.match(row(html, 'E4'), /<a href="artifacts\/u1\/E4-report\.pdf" target="_blank" rel="noopener noreferrer">E4 pdf: report<\/a> <span class="cause">PDF, opens in a new tab<\/span>/);
  assert.doesNotMatch(row(html, 'E6'), /data-ev-open/, 'a link stays a link');
  assert.doesNotMatch(html, /\bsrc=["']?(https?:)?\/\//i, 'nothing from outside');
  assert.match(html, /img-src 'self' data:/, 'the snapshot may show its own artifacts folder');
  assert.doesNotMatch(html, /<script/i, 'the snapshot still runs no script');
});

test('snapshot: each overlay has the image, the caption, Previous / Next, Open in new tab, Download and Close', () => {
  const s = state(); const html = render(s, staticCtx(runDir(s), 0));
  const o = overlay(html, 'E1');
  assert.match(o, /role="dialog" aria-modal="true" aria-labelledby="ev-u1-E1-t" data-evv-item/);
  assert.match(o, /<h2 class="evv-t" id="ev-u1-E1-t">E1 · list ar 360<\/h2>/);
  assert.match(o, /<a class="evv-btn" data-evv="prev" aria-disabled="true">← Previous<\/a><span class="evv-n">1 of 3<\/span><a class="evv-btn" data-evv="next" href="#ev-u1-E2">Next →<\/a>/);
  assert.match(o, /<input type="checkbox" class="evv-z sr" id="ev-u1-E1-z" aria-label="Actual size">/);
  assert.match(o, /<label class="evv-img" for="ev-u1-E1-z"[^>]*><img src="artifacts\/u1\/E1-list-ar-360\.png" alt="list ar 360" loading="lazy" decoding="async"><\/label>/);
  assert.match(o, /<a class="evv-btn" href="artifacts\/u1\/E1-list-ar-360\.png" target="_blank" rel="noopener noreferrer">Open in new tab<\/a><a class="evv-btn" href="artifacts\/u1\/E1-list-ar-360\.png" download="E1-list-ar-360\.png">Download<\/a>/);
  assert.match(o, /<a class="evv-btn evv-x" href="#_" data-evv="close"/);
  assert.match(o, /<p class="evv-cap">Unit u1 · E1 · screenshot · round 1 · <time datetime="2026-01-01T00:05:00.000Z"/);
  assert.match(overlay(html, 'E2'), /round 1/, 'before the first verdict: round 1');
  assert.match(overlay(html, 'E3'), /round 1 ·/, 'after the last verdict: still the last round');
  assert.match(overlay(html, 'E2'), /<pre class="evv-pre">GET \/x 200\n&lt;script&gt;alert\(3\)&lt;\/script&gt; &amp; done<\/pre>/, 'a stored log, escaped');
  assert.match(overlay(html, 'E3'), /<pre class="evv-pre">12 passed &lt;b&gt;ok&lt;\/b&gt;<\/pre>/);
  assert.equal(overlay(html, 'E4'), '', 'PDFs open in a new tab, not in the viewer');
  assert.match(overlay(html, 'E3'), /data-evv="next" aria-disabled="true"/, 'the last has no Next');
  assert.match(html, /<a class="evthumb" href="#ev-u1-E1" data-ev-open aria-label="View E1: list ar 360"><img class="thumb" src="data:image\/png;base64,/, 'the Evidence list thumbnail opens the viewer');
});

test('a unit page in the snapshot reaches the artifacts one folder up', () => {
  const s = state(); const html = render(s, staticCtx(runDir(s), 1), 'unit');
  assert.match(row(html, 'E1'), /src="\.\.\/artifacts\/u1\/E1-list-ar-360\.png"/);
  assert.match(overlay(html, 'E1'), /href="\.\.\/artifacts\/u1\/E1-list-ar-360\.png" download=/);
  assert.match(html, /<div data-k="timeline"[^>]* class="list-anchor"><ol class="timeline" data-tl-list data-ev-list>/);
});

test('a missing stored copy says missing and opens nothing', () => {
  const s = state(); const html = render(s, staticCtx(runDir(s), 0));
  assert.match(row(html, 'E5'), /E5 screenshot: gone <span class="chip s-fail" title="E5-gone\.png: the stored copy is gone">missing<\/span>/);
  assert.doesNotMatch(row(html, 'E5'), /data-ev-open|<img/);
  assert.equal(overlay(html, 'E5'), '');
  assert.match(html, /E5-gone\.png: missing \(the stored copy is gone\)/, 'the Evidence list says so too');
  assert.match(overlay(html, 'E3'), /data-evv="prev" href="#ev-u1-E2"/, 'Previous / Next skip it');
});

test('hostile labels and file names are escaped everywhere', () => {
  const s = state({ label: HOSTILE, shot: 'u1/E1-x"><script>alert(4)</script>.png' });
  const live = liveCtx({ token: 'tok', nonce: 'n0' }, 'r1'); live.has = () => true;
  for (const html of [render(s, staticCtx(runDir(s), 0)), render(s, live)]) {
    const body = html.replace(/<script nonce="n0">[\s\S]*?<\/script>/, '');
    assert.doesNotMatch(body, /<img src=x|<script>alert|onerror=alert\(1\)>|"><script/);
    assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  }
  const body = render(s, live);
  assert.match(body, /alt="&lt;img src=x onerror=alert\(1\)&gt;&quot;&gt;&lt;script&gt;/);
  assert.match(body, /download="E1-x&quot;&gt;&lt;script&gt;alert\(4\)&lt;\/script&gt;\.png"/);
  assert.match(body, /src="\/artifacts\/u1\/E1-x%22%3E%3Cscript%3Ealert\(4\)%3C\/script%3E\.png\?t=tok"/);
});

test('live: links carry the token, logs load on open, another run uses /run/<run>/artifacts, and the script is the nonce one', () => {
  const s = state();
  const ctx = liveCtx({ token: 'tok', nonce: 'n0' }, 'r1'); ctx.has = (f) => !f.includes('gone');
  const html = render(s, ctx);
  assert.match(row(html, 'E1'), /src="\/artifacts\/u1\/E1-list-ar-360\.png\?t=tok"/);
  assert.match(overlay(html, 'E2'), /<pre class="evv-pre" data-src="\/artifacts\/u1\/E2-server\.log\?t=tok">Loading…<\/pre>/);
  assert.match(html, /<script nonce="n0">[\s\S]*data-evv-item[\s\S]*<\/script>/, 'the viewer script rides in the nonce script');
  assert.equal(html.match(/<script/g).length, 1);
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline handlers');
  const other = liveCtx({ token: 'tok', nonce: 'n0' }, 'r0', null, 'r1'); other.has = () => true;
  const page = render(s, other, 'unit');
  assert.match(row(page, 'E1'), /src="\/run\/r1\/artifacts\/u1\/E1-list-ar-360\.png\?t=tok"/);
  assert.match(overlay(page, 'E1'), /href="\/run\/r1\/artifacts\/u1\/E1-list-ar-360\.png\?t=tok" target="_blank"/);
});

test('a copy without the files (the web service) shows no viewer', () => {
  const s = state();
  const html = render(s, { ...staticCtx(null, 0), artHref: () => null, has: undefined });
  assert.doesNotMatch(row(html, 'E1'), /data-ev-open/);
  assert.equal(overlay(html, 'E1'), '');
  assert.match(html, /E1-list-ar-360\.png: file kept locally/);
});

test('only a run snapshot may load its own artifacts; every other static page keeps the CSP the web service rewrites', () => {
  const s = state();
  const meta = (html) => /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)[1];
  assert.equal(meta(render(s, staticCtx(runDir(s), 0))), "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:", 'the snapshot');
  assert.equal(meta(render(s, staticCtx(runDir(s), 1), 'unit')), "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:", 'a unit page of the snapshot');
  const plain = meta(render(s, { ...staticCtx(null, 0), artHref: () => null }));
  assert.equal(plain, "default-src 'none'; style-src 'unsafe-inline'; img-src data:", 'pages without a run folder (the web service, the coordinator page)');
  assert.equal(csp(null), "default-src 'none'; style-src 'unsafe-inline'; img-src data:", 'the string service/src/alerts/routes.mjs replaces');
  assert.equal(csp({ nonce: 'n' }), "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; script-src 'nonce-n'; connect-src 'self'; form-action 'self'; base-uri 'none'", 'the live page, unchanged');
});
