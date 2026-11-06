// c12: answers and notes from the HUD and from comment commands, written to the state branch.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { parseLog } from '../src/core.mjs';
import { parseCommand } from '../src/commands.mjs';
import { SCOPES } from '../src/github.mjs';
import { commitRun, stateBranchOnly } from '../src/writes.mjs';
import { branchLog, fakeGitWrites } from './fakegit.mjs';
import { appendEvent, makeRun, signIn, startApp, stateFiles } from './helpers.mjs';

async function world() {
  const gh = fakeGitWrites();
  const t = await startApp({ gh });
  gh.addRepo('acme/web', { id: 70, installationId: 7, files: stateFiles({ r1: makeRun('r1', { issues: ['acme/web#12'] }), r2: makeRun('r2', { closed: true }) }) });
  gh.addUser('tok-writer', { id: 2, login: 'writer', read: ['acme/web'] });
  gh.addUser('tok-reader', { id: 1, login: 'reader', read: ['acme/web'] });
  gh.allowPush('writer', 'acme/web');
  await t.db.upsertInstallation({ id: 7, account: 'acme' });
  await t.app.ingest.syncInstallation(7);
  t.get = async (path, cookie) => { const r = await fetch(`${t.base}${path}`, { headers: { Cookie: cookie }, redirect: 'manual' }); return { status: r.status, html: await r.text() }; };
  t.post = async (path, cookie, fields, { origin = t.cfg.baseUrl, csrf } = {}) => {
    const page = await t.get('/r/acme/web/run/r1', cookie);
    const token = csrf ?? /name="csrf" value="([^"]+)"/.exec(page.html)[1];
    const body = new URLSearchParams([['csrf', token], ...fields]);
    const r = await fetch(`${t.base}${path}`, { method: 'POST', body, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    return { status: r.status, location: r.headers.get('location'), html: await r.text() };
  };
  return t;
}

const events = (gh, run = 'r1') => parseLog(Buffer.from(branchLog(gh, 'acme/web', run))).events;

test('parseCommand: one strict line, outside quotes and code fences', () => {
  assert.deepEqual(parseCommand('/coordinator answer q3 server'), { verb: 'answer', question: 'q3', choice: 'server' });
  assert.deepEqual(parseCommand('thanks!\n/coordinator answer q3 "use the server total; drop the client sum"\nmore'), { verb: 'answer', question: 'q3', other: 'use the server total; drop the client sum' });
  assert.deepEqual(parseCommand('/coordinator note QA found the same on the export screen'), { verb: 'note', text: 'QA found the same on the export screen' });
  assert.deepEqual(parseCommand('/coordinator note "quoted note"'), { verb: 'note', text: 'quoted note' });
  assert.equal(parseCommand('> /coordinator answer q1 server'), null, 'a quoted command is someone else\'s');
  assert.equal(parseCommand('```\n/coordinator answer q1 server\n```'), null, 'inside a code fence');
  assert.equal(parseCommand('Type this:\n\n    /coordinator answer q1 server\n'), null, 'inside an indented code block');
  assert.equal(parseCommand('\t/coordinator answer q1 server'), null, 'indented with a tab');
  assert.deepEqual(parseCommand('   /coordinator answer q1 server'), { verb: 'answer', question: 'q1', choice: 'server' }, 'three spaces is still a line');
  assert.equal(parseCommand('please run /coordinator answer q1 server'), null, 'not at the start of a line');
  assert.equal(parseCommand('/coordinatorx answer q1 a'), null);
  assert.equal(parseCommand(null), null);
  assert.ok(parseCommand('/coordinator approve q1').error, 'unknown verb');
  assert.ok(parseCommand('/coordinator answer q0 a').error, 'q0 is no question');
  assert.ok(parseCommand('/coordinator answer q1').error, 'no answer');
  assert.ok(parseCommand('/coordinator note').error, 'empty note');
  assert.ok(parseCommand(`/coordinator note ${'x'.repeat(1001)}`).error, 'too long');
  assert.deepEqual(parseCommand('/coordinator answer q1 a\n/coordinator note b'), { verb: 'answer', question: 'q1', choice: 'a' }, 'the first command only');
});

test('the service writes only to the state branch', async () => {
  assert.equal(stateBranchOnly('coordinator-state', 'coordinator-state'), 'coordinator-state');
  for (const [b, c] of [['main', 'main'], ['master', 'master'], ['HEAD', 'HEAD'], ['other', 'coordinator-state'], ['-x', '-x']]) assert.throws(() => stateBranchOnly(b, c), /only to the coordinator state branch/, b);
  const gh = fakeGitWrites();
  await assert.rejects(commitRun({ gh, token: 't', fullName: 'acme/web', branch: 'main', configured: 'main', runId: 'r1', kind: 'note', mutate: () => {}, message: 'm' }), /only to the coordinator state branch/);
  assert.equal(gh.calls.length, 0, 'refused before any call');
  // A branch without the coordinator marker is never written, whatever its name.
  gh.addRepo('acme/web', { id: 70, installationId: 7, files: { 'runs/r1/events.jsonl': makeRun('r1') } });
  await assert.rejects(commitRun({ gh, token: 't', fullName: 'acme/web', branch: 'coordinator-state', configured: 'coordinator-state', runId: 'r1', kind: 'note', mutate: () => {}, message: 'm' }), /holds no coordinator state/);
  assert.equal(gh.moves.length, 0);
});

test('HUD: a writer answers and adds notes; each is the event run.mjs writes, committed with their own token', async () => {
  const t = await world();
  try {
    const cookie = await signIn(t, 'writer');
    const page = await t.get('/r/acme/web/run/r1', cookie);
    assert.match(page.html, /action="\/r\/acme\/web\/run\/r1\/answer"/);
    assert.equal(page.html.includes('<fieldset disabled>'), false, 'a writer gets live forms');
    assert.match(page.html, /can answer/);
    const before = events(t.gh).length;
    let r = await t.post('/r/acme/web/run/r1/answer', cookie, [['q', 'q1'], ['choice', 'server']]);
    assert.equal(r.status, 303, r.html);
    assert.equal(r.location, '/r/acme/web/run/r1#q1');
    const ev = events(t.gh);
    assert.equal(ev.length, before + 1);
    assert.equal(ev.at(-1).kind, 'answer');
    assert.equal(ev.at(-1).unit, undefined, 'like run.mjs answer: no unit on the event');
    assert.deepEqual(Object.keys(ev.at(-1)), ['v', 'seq', 'at', 'kind', 'payload'], 'the skill\'s key order');
    assert.equal(t.gh.moves.at(-1).token, 'tok-writer', 'committed with the person\'s token');
    assert.equal(t.gh.moves.at(-1).commit.author, undefined, 'GitHub records the person as author');
    assert.match(t.gh.moves.at(-1).commit.message, /answer q1 on r1 \(web, @writer\)/);
    const state = JSON.parse(t.gh.repos.get('acme/web').files.get('runs/r1/state.json'));
    assert.equal(state.snapshot.seq, before + 1, 'the snapshot follows the log');
    assert.match(t.gh.repos.get('acme/web').files.get('runs/r1/README.md').toString(), /# Run r1/);
    // Changed until used: a second answer is a second event; the page shows it at once.
    r = await t.post('/r/acme/web/run/r1/answer', cookie, [['q', 'q1'], ['choice', '__other'], ['other', 'both, side by side']]);
    assert.equal(r.status, 303);
    assert.match((await t.get('/r/acme/web/run/r1', cookie)).html, /both, side by side/);
    // A note on a unit, from the unit page: back to the unit page.
    r = await t.post('/r/acme/web/run/r1/note', cookie, [['text', 'QA saw it on export too'], ['unit', 'u1'], ['back', '/unit/u1']]);
    assert.equal(r.status, 303);
    assert.equal(r.location, '/r/acme/web/run/r1/unit/u1');
    const note = events(t.gh).at(-1);
    assert.equal(note.kind, 'note');
    assert.equal(note.unit, 'u1');
    assert.equal(note.payload.ops[0].values[0].kind, 'person');
    // A bad answer is refused with the reason, and nothing is written.
    const n = events(t.gh).length;
    r = await t.post('/r/acme/web/run/r1/answer', cookie, [['q', 'q1'], ['choice', 'nope']]);
    assert.equal(r.status, 400);
    assert.match(r.html, /has no option/);
    r = await t.post('/r/acme/web/run/r1/answer', cookie, [['q', 'q9'], ['choice', 'server']]);
    assert.equal(r.status, 400);
    r = await t.post('/r/acme/web/run/r2/note', cookie, [['text', 'late']]);
    assert.equal(r.status, 409, 'a closed run takes no notes');
    assert.equal(events(t.gh).length, n);
    assert.ok(t.db.auditLog?.().some((a) => a.kind === 'write.answer' && a.login === 'writer') ?? true);
  } finally { await t.close(); }
});

test('HUD: a reader sees disabled forms with the reason, and the server refuses their post too', async () => {
  const t = await world();
  try {
    const cookie = await signIn(t, 'reader');
    const page = await t.get('/r/acme/web/run/r1', cookie);
    assert.match(page.html, /<fieldset disabled>/);
    assert.match(page.html, /<button type="submit" disabled>/);
    assert.match(page.html, /Only people who can push to acme\/web can answer or add notes/);
    const unit = await t.get('/r/acme/web/run/r1/unit/u1', cookie);
    assert.match(unit.html, /<textarea name="text" rows="2" maxlength="1000" required disabled>/);
    const n = events(t.gh).length;
    const r = await t.post('/r/acme/web/run/r1/answer', cookie, [['q', 'q1'], ['choice', 'server']]);
    assert.equal(r.status, 403);
    assert.match(r.html, /Only people who can push/);
    assert.equal(events(t.gh).length, n);
    assert.equal(t.gh.count('createCommit'), 0);
    // Access lost after the page loaded: the write asks GitHub again and refuses.
    const w = await signIn(t, 'writer');
    await t.get('/r/acme/web/run/r1', w);
    t.gh.writers.delete('writer');
    assert.equal((await t.post('/r/acme/web/run/r1/note', w, [['text', 'x']])).status, 403);
  } finally { await t.close(); }
});

test('HUD writes need the session\'s CSRF token and this site\'s origin; outsiders get 404', async () => {
  const t = await world();
  try {
    const cookie = await signIn(t, 'writer');
    assert.equal((await t.post('/r/acme/web/run/r1/note', cookie, [['text', 'x']], { csrf: 'wrong' })).status, 403);
    assert.equal((await t.post('/r/acme/web/run/r1/note', cookie, [['text', 'x']], { origin: 'https://evil.example' })).status, 403);
    t.gh.addUser('tok-out', { id: 3, login: 'out', read: [] });
    const out = await signIn(t, 'out');
    const r = await fetch(`${t.base}/r/acme/web/run/r1/note`, { method: 'POST', body: 'text=x', headers: { Cookie: out, Origin: t.cfg.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    assert.equal(r.status, 404);
    const anon = await fetch(`${t.base}/r/acme/web/run/r1/note`, { method: 'POST', body: 'text=x', headers: { Origin: t.cfg.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(anon.status, 403);
    assert.equal(t.gh.count('createCommit'), 0);
  } finally { await t.close(); }
});

test('a write that races a push is rebuilt on the new tip; nothing is lost', async () => {
  const t = await world();
  try {
    const cookie = await signIn(t, 'writer');
    t.gh.beforeMove = (full) => {
      const files = t.gh.repos.get(full).files;
      const log = files.get('runs/r1/events.jsonl');
      t.gh.setFiles(full, { ...Object.fromEntries(files), 'runs/r1/events.jsonl': appendEvent(log, 'note', { ops: [{ op: 'push', path: ['notes'], values: [{ kind: 'info', text: 'from the lead', at: new Date().toISOString() }] }] }) });
    };
    const r = await t.post('/r/acme/web/run/r1/answer', cookie, [['q', 'q1'], ['choice', 'client']]);
    assert.equal(r.status, 303, r.html);
    const ev = events(t.gh);
    assert.equal(ev.at(-2).payload.ops[0].values[0].text, 'from the lead', 'the lead\'s push kept');
    assert.equal(ev.at(-1).kind, 'answer', 'the answer on top');
    assert.equal(t.gh.count('moveBranch'), 2);
  } finally { await t.close(); }
});

const sign = (secret, body) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
let deliveries = 0;
async function comment(t, body, { login = 'writer', id = 2, commentId = 501, issue = 12, delivery = `c${++deliveries}`, extra = {} } = {}) {
  const payload = { action: 'created', installation: { id: 7 }, repository: { id: 70, full_name: 'acme/web' }, issue: { number: issue }, comment: { id: commentId, body, html_url: `https://github.example/acme/web/issues/${issue}#issuecomment-${commentId}`, user: { login, id, type: 'User' } }, sender: { login, type: 'User' }, ...extra };
  const raw = JSON.stringify(payload);
  const r = await fetch(`${t.base}/webhook`, { method: 'POST', body: raw, headers: { 'X-GitHub-Event': 'issue_comment', 'X-GitHub-Delivery': delivery, 'X-Hub-Signature-256': sign(t.cfg.github.webhookSecret, raw) } });
  await t.app.idle();
  return { status: r.status, body: await r.text() };
}
const replies = (t) => (t.gh.comments.get('acme/web#12') ?? []).filter((c) => !c.body.includes('coordinator:tracker'));

test('comment commands: a pusher answers and notes; 👀 then 👍; authored as them with a contents-only token', async () => {
  const t = await world();
  try {
    const before = events(t.gh).length;
    let r = await comment(t, 'Looked at it.\n/coordinator answer q1 Server', { commentId: 601 });
    assert.equal(r.status, 202);
    const ev = events(t.gh);
    assert.equal(ev.length, before + 1);
    assert.equal(ev.at(-1).kind, 'answer');
    const q = JSON.parse(t.gh.repos.get('acme/web').files.get('runs/r1/state.json')).notes.find((n) => n.kind === 'question');
    assert.deepEqual(q.history.at(-1).choices, ['server'], 'matched by label, any case');
    const move = t.gh.moves.at(-1);
    assert.equal(move.token, 'inst-7');
    assert.deepEqual(move.commit.author, { name: 'writer', email: '2+writer@users.noreply.github.com' });
    assert.match(move.commit.message, /comment by @writer/);
    const writeToken = t.gh.calls.find((c) => c[0] === 'installationToken' && JSON.stringify(c[2]) === JSON.stringify(SCOPES.write));
    assert.ok(writeToken, 'the write token is narrowed to contents');
    assert.deepEqual(writeToken[3], { repositoryIds: [70] }, 'and to the state repo alone');
    assert.deepEqual(t.gh.reactions.filter((x) => x.id === 601).map((x) => x.content), ['eyes', '+1']);
    assert.equal(replies(t).length, 0, 'success needs no reply');
    // A note on the issue: the note is about the unit the issue belongs to.
    await comment(t, '/coordinator note "QA found the same on the export screen"', { commentId: 602 });
    const note = events(t.gh).at(-1);
    assert.equal(note.kind, 'note');
    assert.equal(note.unit, 'u1');
    // Free text in quotes.
    await comment(t, '/coordinator answer q1 "use the server total; drop the client sum"', { commentId: 603 });
    assert.equal(JSON.parse(t.gh.repos.get('acme/web').files.get('runs/r1/state.json')).notes.find((n) => n.kind === 'question').history.at(-1).other, 'use the server total; drop the client sum');
    // The read model shows it without waiting for the push webhook.
    assert.match((await t.get('/r/acme/web/run/r1', await signIn(t, 'reader'))).html, /use the server total/);
  } finally { await t.close(); }
});

test('comment commands: refusals say why, quote nothing, and write nothing', async () => {
  const t = await world();
  try {
    const n = events(t.gh).length;
    await comment(t, '/coordinator answer q1 server', { login: 'reader', id: 1, commentId: 701 });
    assert.match(replies(t).at(-1).body, /Only people with push access/);
    assert.deepEqual(t.gh.reactions.filter((x) => x.id === 701).map((x) => x.content), ['eyes', 'confused']);
    await comment(t, '/coordinator answer q1 <b>nope</b>', { commentId: 702 });
    const notOption = replies(t).at(-1).body;
    assert.match(notOption, /not one of q1's options/);
    assert.equal(/nope|server|client/.test(notOption), false, 'neither the comment nor the run\'s options are echoed');
    await comment(t, '/coordinator answer q7 server', { commentId: 703 });
    assert.match(replies(t).at(-1).body, /no question q7/);
    await comment(t, '/coordinator approve q1', { commentId: 704 });
    assert.match(replies(t).at(-1).body, /Commands:/);
    t.gh.comments.set('acme/web#99', []);
    await comment(t, '/coordinator note hi', { commentId: 705, issue: 99 });
    assert.match(t.gh.comments.get('acme/web#99').at(-1).body, /not linked to an open coordinator run/);
    assert.equal(events(t.gh).length, n, 'nothing written');
    assert.equal(t.gh.count('createCommit'), 0);
  } finally { await t.close(); }
});

test('comment commands: bots, edits, quotes and redeliveries are ignored; a used answer cannot change', async () => {
  const t = await world();
  try {
    const n = events(t.gh).length;
    assert.match((await comment(t, '/coordinator note hi', { extra: { sender: { login: 'bot', type: 'Bot' } } })).body, /a bot/);
    assert.match((await comment(t, '/coordinator note hi', { extra: { action: 'edited' } })).body, /ignored/);
    assert.match((await comment(t, '> /coordinator note hi')).body, /no command/);
    await comment(t, '/coordinator note once', { commentId: 801, delivery: 'x1' });
    await comment(t, '/coordinator note once', { commentId: 801, delivery: 'x2' }); // GitHub redelivers under a new id
    assert.equal(events(t.gh).length, n + 1, 'one note for one comment');
    // The lead used q1's answer: a later command is refused, the answer stays.
    await comment(t, '/coordinator answer q1 server', { commentId: 802 });
    const files = t.gh.repos.get('acme/web').files;
    const log = files.get('runs/r1/events.jsonl');
    const idx = JSON.parse(files.get('runs/r1/state.json')).notes.findIndex((x) => x.kind === 'question');
    t.gh.setFiles('acme/web', { ...Object.fromEntries(files), 'runs/r1/events.jsonl': appendEvent(log, 'answer.used', { ops: [{ op: 'set', path: ['notes', idx, 'usedAt'], value: new Date().toISOString() }] }) });
    await comment(t, '/coordinator answer q1 client', { commentId: 803 });
    assert.match(replies(t).at(-1).body, /already used/);
    assert.equal(events(t.gh).at(-1).kind, 'answer.used');
  } finally { await t.close(); }
});
