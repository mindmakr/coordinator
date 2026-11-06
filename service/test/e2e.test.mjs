// c12 end to end: a running lead (the skill's own CLI) parks a question and pushes; a person
// answers on the web HUD (and then by a comment command); the lead's next loop step pulls the
// state branch, sees the answer and uses it. The fake GitHub stands in for the state branch;
// the lead reads and writes the same files through `push --to` / `pull --from` a folder.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { fakeGitWrites } from './fakegit.mjs';
import { signIn, startApp } from './helpers.mjs';

const RUN_MJS = fileURLToPath(new URL('../../skills/coordinator/scripts/run.mjs', import.meta.url));

function lead(dir) {
  return (...a) => {
    const r = spawnSync(process.execPath, [RUN_MJS, ...a], { cwd: dir, env: { ...process.env, COORDINATOR_DIR: join(dir, '.coordinator') }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`run.mjs ${a.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
}
const walk = (root, d = root) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(root, join(d, f)) : [relative(root, join(d, f)).split('\\').join('/')]));
// The branch on "GitHub" ⇄ the folder the lead pushes to and pulls from.
const toGitHub = (gh, folder) => gh.setFiles('acme/web', Object.fromEntries(walk(folder).map((p) => [p, readFileSync(join(folder, p))])));
const toFolder = (gh, folder) => { for (const [p, b] of gh.repos.get('acme/web').files) { mkdirSync(dirname(join(folder, p)), { recursive: true }); writeFileSync(join(folder, p), b); } };
const sign = (secret, body) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

test('a question parked by a running lead is answered on the HUD, then by a comment, and used within one loop step each', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coord-e2e-lead-'));
  const folder = mkdtempSync(join(tmpdir(), 'coord-e2e-branch-'));
  const gh = fakeGitWrites();
  const t = await startApp({ gh });
  try {
    const cli = lead(dir);
    const json = (...a) => JSON.parse(cli(...a));
    // The lead: plan, start, park a question, pit stop.
    cli('init', 'r1', '--goal', 'Totals match', '--bar', 'tests pass', '--fence', 'web only', '--repo', 'acme/web');
    cli('add', 'r1', 'u1', '--bar', 'the total is right', '--title', 'Totals');
    cli('link', 'r1', 'u1', '--issue', 'acme/web#12');
    cli('freeze', 'r1');
    cli('start', 'r1', 'u1');
    assert.equal(json('ask', 'r1', '--question', 'Which total?', '--header', 'Total', '--option', 'server|use the server total', '--option', 'client|sum on the client', '--unit', 'u1').asked, 'q1');
    cli('push', 'r1', '--to', folder);

    // GitHub has the branch; the service reads it.
    gh.addRepo('acme/web', { id: 70, installationId: 7, files: {} });
    toGitHub(gh, folder);
    gh.addUser('tok-ana', { id: 5, login: 'ana', read: ['acme/web'] });
    gh.allowPush('ana', 'acme/web');
    await t.db.upsertInstallation({ id: 7, account: 'acme' });
    await t.app.ingest.syncInstallation(7);

    // Ana answers on her phone.
    const cookie = await signIn(t, 'ana');
    const page = await (await fetch(`${t.base}/r/acme/web/run/r1`, { headers: { Cookie: cookie, 'User-Agent': 'Mobile' } })).text();
    assert.match(page, /Which total\?/);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1];
    const r = await fetch(`${t.base}/r/acme/web/run/r1/answer`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ csrf, q: 'q1', choice: 'server' }), headers: { Cookie: cookie, Origin: t.cfg.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(r.status, 303);

    // One loop step of the lead: pull, see the answer, use it, next.
    toFolder(gh, folder);
    assert.equal(json('pull', 'r1', '--from', folder).status, 'fast-forward');
    let q = json('questions', 'r1').find((x) => x.id === 'q1');
    assert.equal(q.status, 'answered');
    assert.deepEqual(q.answer.choices, ['server']);
    assert.equal(q.answer.by, 'person');
    cli('use-answer', 'r1', 'q1');
    assert.ok(json('next', 'r1').decision);
    assert.equal(json('questions', 'r1').find((x) => x.id === 'q1').status, 'used');

    // Again, from a comment on the unit's issue.
    json('ask', 'r1', '--question', 'Round the total?', '--header', 'Rounding', '--option', 'yes|to cents', '--option', 'no|keep it exact');
    cli('push', 'r1', '--to', folder);
    toGitHub(gh, folder);
    await t.app.ingest.syncRepo(7, { id: 70, fullName: 'acme/web' });
    const payload = JSON.stringify({ action: 'created', installation: { id: 7 }, repository: { id: 70, full_name: 'acme/web' }, issue: { number: 12 }, comment: { id: 900, body: '/coordinator answer q2 no', html_url: 'https://github.example/acme/web/issues/12#issuecomment-900', user: { login: 'ana', id: 5, type: 'User' } }, sender: { login: 'ana', type: 'User' } });
    const hook = await fetch(`${t.base}/webhook`, { method: 'POST', body: payload, headers: { 'X-GitHub-Event': 'issue_comment', 'X-GitHub-Delivery': 'e2e-1', 'X-Hub-Signature-256': sign(t.cfg.github.webhookSecret, payload) } });
    assert.equal(hook.status, 202);
    await t.app.idle();
    assert.deepEqual(gh.reactions.map((x) => x.content), ['eyes', '+1']);
    toFolder(gh, folder);
    assert.equal(json('pull', 'r1', '--from', folder).status, 'fast-forward');
    q = json('questions', 'r1').find((x) => x.id === 'q2');
    assert.deepEqual(q.answer.choices, ['no']);
    cli('use-answer', 'r1', 'q2');
    assert.equal(json('questions', 'r1').find((x) => x.id === 'q2').status, 'used');
    // The lead's log and the branch agree: the next pit stop moves the branch forward.
    cli('push', 'r1', '--to', folder);
  } finally {
    await t.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  }
});
