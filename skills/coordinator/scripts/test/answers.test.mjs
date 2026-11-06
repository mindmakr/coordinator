import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hud } from '../lib/hud.mjs';
import { events, questions } from '../lib/questions.mjs';
import { decide } from '../lib/rules.mjs';
import { serve } from '../lib/serve.mjs';
import { view } from '../lib/view.mjs';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'coordinator-answers-'));
const env = { ...process.env, COORDINATOR_DIR: dir };
const children = [];
after(() => { for (const c of children) c.kill(); rmSync(dir, { recursive: true, force: true }); });

const json = (s) => { try { return JSON.parse(s); } catch { return s; } };
const run = (...a) => { const r = spawnSync(process.execPath, [join(scripts, 'run.mjs'), ...a], { env, encoding: 'utf8' }); return { code: r.status, out: json(r.stdout), err: r.stderr }; };
const state = (r) => JSON.parse(readFileSync(join(dir, 'runs', r, 'state.json'), 'utf8'));
const setup = (r) => { run('init', r, '--goal', 'g', '--bar', 'b', '--fence', 'f'); run('add', r, 'u1', '--bar', 'b'); run('add', r, 'u2', '--bar', 'b'); run('freeze', r); };
const ask = (r, ...extra) => run('ask', r, '--question', 'Merge u1 now?', '--header', 'Merge', '--option', 'Yes|the review says READY', '--option', 'No|wait for a second review', ...extra);

// Starts a child that prints lines; resolves each `until(line)` as lines arrive.
function child(args) {
  const c = spawn(process.execPath, [join(scripts, 'run.mjs'), ...args], { env });
  children.push(c);
  const lines = []; let buf = ''; const waiters = [];
  c.stdout.on('data', (d) => {
    buf += d; const parts = buf.split('\n'); buf = parts.pop();
    for (const l of parts) { lines.push(l); for (const w of [...waiters]) if (w.test(l)) { waiters.splice(waiters.indexOf(w), 1); w.ok(l); } }
  });
  const until = (re, ms = 8000) => new Promise((ok, fail) => {
    const hit = lines.find((l) => re.test(l)); if (hit) return ok(hit);
    const w = { test: (l) => re.test(l), ok }; waiters.push(w);
    setTimeout(() => fail(new Error(`no line matching ${re} in: ${lines.join(' | ')}`)), ms);
  });
  return { c, lines, until };
}

function post(url, path, body, headers = {}) {
  const u = new URL(url);
  return new Promise((ok, fail) => {
    const req = request({ host: u.hostname, port: u.port, path, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers } }, (res) => {
      let data = ''; res.on('data', (d) => { data += d; }); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', fail); req.end(body);
  });
}
const get = (url, headers = {}) => new Promise((ok, fail) => {
  const u = new URL(url);
  request({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
    let data = ''; res.on('data', (d) => { data += d; }); res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: data }));
  }).on('error', fail).end();
});

test('ask, answer, change, use: every answer is kept and a used one cannot change', () => {
  setup('a1');
  assert.equal(ask('a1').out.asked, 'q1');
  assert.equal(run('answer', 'a1', 'q1', '--choice', 'Maybe').code, 1, 'not an option');
  assert.equal(run('answer', 'a1', 'q1', '--choice', 'yes', '--other', 'and tag it').code, 1, 'one answer for a single question');
  assert.equal(run('answer', 'a1', 'q1', '--choice', 'yes').code, 0);
  assert.equal(run('answer', 'a1', 'q1', '--other', 'after the demo', '--by', 'lead').code, 0, 'changed before use');
  let [q] = run('questions', 'a1').out;
  assert.equal(q.status, 'answered');
  assert.deepEqual(q.history.map((a) => [a.choices, a.other, a.by]), [[['Yes'], null, 'person'], [[], 'after the demo', 'lead']]);
  assert.match(run('show', 'a1').out, /^answered {3}q1: "after the demo" \(by lead; the lead has not used it yet\)$/m);
  assert.equal(run('use-answer', 'a1', 'q1').code, 0);
  assert.equal(run('answer', 'a1', 'q1', '--choice', 'No').code, 1, 'used: refused');
  assert.match(run('answer', 'a1', 'q1', '--choice', 'No').err, /already used/);
  assert.equal(run('use-answer', 'a1', 'q1').code, 1, 'used once');
  [q] = run('questions', 'a1').out;
  assert.equal(q.status, 'used');
  assert.equal(q.history.length, 2);
});

test('ask checks its shape: 2-4 options, a short header, distinct labels; --multi takes several', () => {
  setup('a2');
  assert.equal(run('ask', 'a2', '--question', 'Q', '--header', 'H', '--option', 'only one').code, 1);
  assert.equal(ask('a2', '--option', 'c', '--option', 'd', '--option', 'e').code, 1, 'five options');
  assert.equal(run('ask', 'a2', '--question', 'Q', '--header', 'Thirteen char', '--option', 'a', '--option', 'b').code, 1, 'header over 12');
  assert.equal(run('ask', 'a2', '--question', 'Q', '--header', 'H', '--option', 'a', '--option', 'A').code, 1, 'same label');
  assert.equal(run('ask', 'a2', '--question', 'Which screens?', '--header', 'Screens', '--option', 'Home', '--option', 'Pay', '--option', 'Help', '--multi').code, 0);
  assert.equal(run('answer', 'a2', 'q1', '--choice', 'Home', '--choice', 'help', '--other', 'Settings too').code, 0);
  assert.deepEqual(run('questions', 'a2').out[0].answer.choices, ['Home', 'Help']);
});

test('questions and person notes are global or per unit', () => {
  setup('a3');
  assert.equal(ask('a3', '--unit', 'nope').code, 1, 'unknown unit');
  ask('a3', '--unit', 'u1'); ask('a3');
  assert.deepEqual(run('questions', 'a3').out.map((q) => q.unit), ['u1', null]);
  assert.equal(run('note', 'a3', '--kind', 'person', '--text', 'Use the staging data', '--unit', 'u2').code, 0);
  assert.equal(run('note', 'a3', '--kind', 'person', '--text', 'Lunch until 2').code, 0);
  assert.equal(run('note', 'a3', '--kind', 'info', '--text', 'x', '--unit', 'u1').code, 1, '--unit is for person notes');
  assert.equal(run('note', 'a3', '--kind', 'person', '--text', 'x', '--unit', 'nope').code, 1);
  const notes = state('a3').notes.filter((n) => n.kind === 'person');
  assert.deepEqual(notes.map((n) => n.unit), ['u2', null]);
  const html = readFileSync(join(dir, 'runs', 'a3', 'hud.html'), 'utf8');
  assert.match(html, /<section class="card" id="unit-u2">.*<b>From you:<\/b> Use the staging data/s);
  assert.match(html, /<b>q1<\/b> Merge u1 now\? <span class="cause">· u1<\/span>/);
  assert.match(html, /This copy is read-only\. Answer in the chat, or ask the lead for the answer page \(<code>run\.mjs serve a3<\/code>\)/);
  assert.doesNotMatch(html, /<form|<script/, 'the file takes no answers and runs nothing');
});

test('an old state file loads: its questions have no options, take free text, and close by decision', () => {
  setup('a4');
  run('note', 'a4', '--kind', 'question', '--text', 'Keep the old route?', '--recommend', 'yes');
  const [q] = run('questions', 'a4').out;
  assert.deepEqual([q.options, q.header, q.status, q.recommend], [[], null, 'open', 'yes']);
  assert.equal(run('answer', 'a4', 'q1', '--choice', 'yes').code, 1, 'no options to choose');
  assert.equal(run('answer', 'a4', 'q1', '--other', 'yes, keep it').code, 0);
  run('note', 'a4', '--kind', 'decision', '--text', 'kept', '--answers', 'q1');
  assert.equal(run('questions', 'a4').out[0].status, 'decided');
  assert.equal(run('answer', 'a4', 'q1', '--other', 'no').code, 1, 'closed by a decision');
  const old = { id: 'o', notes: [{ kind: 'question', text: 'Q', at: '2026-01-01T00:00:00Z' }], units: [] };
  assert.equal(questions(old)[0].history.length, 0);
  assert.deepEqual(events(null, { id: 'o', units: [] }), [], 'no notes at all');
});

test('option text is escaped in the file and on the answer page', () => {
  setup('a5');
  run('ask', 'a5', '--question', 'Pick <b>one</b>', '--header', '<i>H</i>', '--option', '<img src=x onerror=alert(1)>|"><script>alert(2)</script>', '--option', 'Plain|ok');
  const s = state('a5');
  for (const html of [readFileSync(join(dir, 'runs', 'a5', 'hud.html'), 'utf8'), hud(view(s, decide(s)), Date.now(), { token: 'tok"en', nonce: 'n0nce' })]) {
    assert.doesNotMatch(html, /<img|<script>alert|<b>one/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /&quot;&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  }
  const live = hud(view(s, decide(s)), Date.now(), { token: 'tok"en', nonce: 'n0nce' });
  assert.match(live, /value="tok&quot;en"/);
  assert.match(live, /script-src 'nonce-n0nce'/);
  assert.equal(live.match(/<script/g).length, 1, 'only the nonce script');
  assert.doesNotMatch(live, /http-equiv="refresh"/, 'no meta refresh on the answer page');
  assert.match(live, /<input type="radio" name="choice" value="Plain">/);
  assert.match(live, /Recommended/);
});

test('serve: 127.0.0.1 only; GET and POST need the token; POST needs the same origin', async () => {
  const writes = [];
  const { server, url, token } = await serve({ page: ({ nonce }) => `page ${nonce}`, post: { '/note': (f) => { writes.push(f.get('text')); return ''; } } });
  try {
    assert.equal(server.address().address, '127.0.0.1');
    const origin = new URL(url).origin;
    assert.equal((await get(url)).status, 200);
    assert.match((await get(url)).headers['content-security-policy'], /script-src 'nonce-[^']+'; form-action 'self'/);
    assert.equal((await get(url)).headers['referrer-policy'], 'same-origin', 'no-referrer makes browsers post Origin: null');
    assert.equal((await post(url, '/note', `t=${token}&text=x`, { Origin: 'null' })).status, 403, 'an opaque origin is refused');
    assert.equal((await get(`${origin}/`)).status, 403, 'no token');
    assert.equal((await get(url, { Host: 'evil.example' })).status, 403, 'another host (DNS rebinding)');
    const body = (t) => `t=${encodeURIComponent(t)}&text=hello`;
    assert.equal((await post(url, '/note', body(token))).status, 403, 'no Origin');
    assert.equal((await post(url, '/note', body(token), { Origin: 'https://evil.example' })).status, 403, 'another origin');
    assert.equal((await post(url, '/note', body('wrong'), { Origin: origin })).status, 403, 'wrong token');
    assert.equal((await post(url, '/note', 'text=hello', { Origin: origin })).status, 403, 'no token');
    assert.equal((await post(url, '/note', body(token), { Origin: origin, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await post(url, '/note', body(token), { Origin: origin, 'Content-Type': 'text/plain' })).status, 415);
    assert.deepEqual(writes, [], 'nothing refused was written');
    const ok = await post(url, '/note', body(token), { Origin: origin });
    assert.equal(ok.status, 303);
    assert.equal((await post(url, '/note', 'text=hi', { Origin: origin, 'X-Coordinator-Token': token })).status, 303, 'token in a header');
    assert.deepEqual(writes, ['hello', 'hi']);
  } finally { server.close(); }
});

test('serve and watch end to end: an answer from the page wakes the lead', async () => {
  setup('a6');
  ask('a6', '--unit', 'u1');
  const w = child(['watch', 'a6']);
  const s = child(['serve', 'a6', '--port', '0']);
  const { url } = JSON.parse(await s.until(/"url"/));
  const origin = new URL(url).origin;
  const token = new URL(url).searchParams.get('t');
  const page = await get(url);
  assert.match(page.body, /<form class="ask" method="post" action="\/answer">/);
  assert.match(page.body, /<button type="submit">Submit<\/button>/);
  let r = await post(url, '/answer', `t=${token}&q=q1&choice=No`, { Origin: origin });
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, `/?t=${token}#q1`);
  await w.until(/^answer q1 \(u1\) by person: No · Merge$/);
  r = await post(url, '/answer', `t=${token}&q=q1&choice=__other&other=${encodeURIComponent('Yes, after the demo')}`, { Origin: origin });
  await w.until(/^changed q1 \(u1\) by person: "Yes, after the demo"/);
  assert.match((await get(url)).body, /<button type="submit">Change answer<\/button>/);
  await post(url, '/note', `t=${token}&unit=u2&text=${encodeURIComponent('Check the Arabic labels')}`, { Origin: origin });
  await w.until(/^note by person on u2: Check the Arabic labels$/);
  run('use-answer', 'a6', 'q1');
  r = await post(url, '/answer', `t=${token}&q=q1&choice=No`, { Origin: origin });
  assert.equal(r.status, 400);
  assert.match(r.body, /Not saved: q1 is already used/);
  assert.doesNotMatch((await get(url)).body, /action="\/answer"/, 'a used question has no form');
  assert.deepEqual(state('a6').notes.find((n) => n.kind === 'question').history.map((a) => a.by), ['person', 'person']);
});
