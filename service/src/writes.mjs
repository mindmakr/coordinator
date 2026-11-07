// Answers and notes from people, written to a run's event log on the
// coordinator-state branch as one commit. The event is the one `run.mjs
// answer` or `run.mjs note --kind person` appends (the skill's own questions
// lib makes the change, its events lib turns it into ops), so the lead's
// `run.mjs pull` fast-forwards onto it and `watch` prints it, unchanged.
//
// - From the web HUD the commit is made with the person's own user token, so
//   git history shows who answered; push access is re-checked on every write.
// - From a comment command (commands.mjs) it is made with an installation
//   token narrowed to contents (SCOPES.write), authored as the commenter.
// - Writes are optimistic: read the branch tip, build on it, move the branch
//   without force; if it moved meanwhile, read again and retry (5 tries).
// - Only the state branch is ever written, and only when it holds the
//   coordinator marker (stateBranchOnly, commitRun: the one place a ref moves).
import { canonical, decide, diff, findQuestion, answerQuestion, fromForm, maskSecrets, parseLog, personNote, replay, snapshotText, V, validateEvent, validRun, workbench } from './core.mjs';
import { SCOPES } from './github.mjs';
import { LIMITS } from './ingest.mjs';
import { limiter } from './ratelimit.mjs';

const MARKER = '.coordinator-state';
const NEVER = new Set(['main', 'master', 'HEAD']);
export const TRIES = 5;

export class WriteError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// The branch a write may move: the configured state branch, never a default-looking one.
export function stateBranchOnly(branch, configured) {
  if (typeof branch !== 'string' || branch !== configured || NEVER.has(branch) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(branch)) {
    throw new Error('refused: the service writes only to the coordinator state branch');
  }
  return branch;
}

// Clipped before masking: a form or comment field is at most 1000 characters once saved, so masking
// never reads more than twice that.
export const CLIP = 2000;
const mask = (v) => (typeof v === 'string' ? maskSecrets(v.slice(0, CLIP)) : v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Appends one event to runs/<runId>/events.jsonl and rewrites the run's snapshot and README, in
// one commit on the state branch. mutate(state) changes the state as run.mjs would (and may
// throw: the message goes back to the person). → { commit, seq, unchanged? }
export async function commitRun({ gh, token, fullName, branch, configured, runId, kind, unit = null, mutate, message, author = null, pause = (n) => sleep(50 * n + Math.floor(Math.random() * 100)) }) {
  stateBranchOnly(branch, configured);
  const path = `runs/${runId}`;
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    const head = await gh.ref(token, fullName, branch);
    if (!head) throw new WriteError(404, 'this repo has no coordinator state branch');
    const tree = await gh.tree(token, fullName, head);
    const entries = tree.tree ?? [];
    if (!entries.some((e) => e.path === MARKER && e.type === 'blob')) throw new WriteError(409, `${branch} holds no coordinator state`);
    const logEntry = entries.find((e) => e.path === `${path}/events.jsonl` && e.type === 'blob');
    if (!logEntry) throw new WriteError(404, 'this run is not on the state branch');
    if (logEntry.size > LIMITS.logBytes) throw new WriteError(413, 'the run log is too large to write to');
    const buf = await gh.blob(token, fullName, logEntry.sha);
    let log;
    try { log = parseLog(buf, `${path}/events.jsonl`); } catch (e) { throw new WriteError(409, `the run log on the state branch is not readable: ${maskSecrets(String(e.message).slice(0, 400)).slice(0, 200)}`); }
    const state = replay(log.events);
    if (validRun(state) || state.id !== runId) throw new WriteError(409, 'the run log on the state branch is not readable');
    if (state.closed) throw new WriteError(409, 'this run is closed; it takes no more answers or notes');
    const work = clone(state);
    try { mutate(work); } catch (e) { throw new WriteError(400, maskSecrets(String(e.message).slice(0, 600)).slice(0, 300)); }
    const next = canonical(work);
    const ops = diff(state, next);
    if (!ops.length) return { commit: head, seq: log.events.length, unchanged: true };
    const seq = log.events.length + 1;
    const line = validateEvent({ v: V, seq, at: new Date().toISOString(), kind, ...(unit ? { unit } : {}), payload: { ops } }, `new event ${seq}`);
    const events = Buffer.concat([buf, Buffer.from(`${JSON.stringify(line)}\n`)]);
    const files = { [`${path}/events.jsonl`]: events, [`${path}/state.json`]: snapshotText(next, seq, events), [`${path}/README.md`]: workbench(next, decide(next)) };
    const blobs = [];
    for (const [p, content] of Object.entries(files)) blobs.push({ path: p, sha: await gh.createBlob(token, fullName, Buffer.from(content)) });
    const treeSha = await gh.createTree(token, fullName, tree.sha, blobs);
    const commit = await gh.createCommit(token, fullName, { message, tree: treeSha, parents: [head], ...(author ? { author } : {}) });
    if (await gh.moveBranch(token, fullName, branch, commit)) return { commit, seq };
    if (attempt < TRIES) await pause(attempt);
  }
  throw new WriteError(503, 'the state branch kept moving while saving; try again');
}

// Questions are q1, q2, …; anything else is refused before the log is read.
const QID = /^q[1-9]\d{0,3}$/;

// The change an answer makes: the HUD's form fields, or a comment command's parsed parts.
// cmd: { choices: [labels], other } (form) or { choice: text, other } (comment, labels matched here).
export function answerChange(id, pick) {
  if (!QID.test(String(id ?? ''))) throw new WriteError(400, 'no such question');
  let unit = null;
  const mutate = (s) => {
    const q = findQuestion(s, id);
    unit = q.unit ?? null;
    answerQuestion(s, id, { ...pick(q), by: 'person', via: 'web' });
  };
  return { mutate, unit: () => unit };
}

const refused = (repo) => `You can read this run. Only people who can push to ${repo.fullName} can answer or add notes.`;

export function writer({ db, gh, config, ingest, acl = null, log, now = Date.now }) {
  const branch = config.stateBranch;
  const perUser = limiter({ max: 30, windowMs: 60_000, now });
  const shown = new Map(); // display only: may this person write here, per person and repo, ≤ 60 s

  // { ok, reason }: whether GitHub, asked with this person's own token, says they can push to the repo.
  async function canWrite(session, repo, { fresh = false } = {}) {
    const k = `${session.userId}\u0000${repo.installationId}:${repo.id}`;
    const hit = shown.get(k);
    if (!fresh && hit && hit.until > now()) return hit.v;
    // The page's read check asked GitHub moments ago and kept its push answer too: no second call.
    const seen = fresh ? null : acl?.pushCached(session, repo);
    if (seen === true) return { ok: true, reason: null };
    if (seen === false) return { ok: false, reason: refused(repo) };
    const token = await session.token();
    let v;
    if (!token) v = { ok: false, reason: 'Sign in again to answer or add notes.' };
    else {
      const r = await gh.repoAccess(token, repo.fullName);
      const ok = !!r.repo && Number(r.repo.id) === repo.id && r.repo.permissions?.push === true;
      v = ok ? { ok: true, reason: null } : { ok: false, reason: refused(repo) };
    }
    if (shown.size > 20_000) for (const [x, e] of shown) if (e.until <= now()) shown.delete(x);
    shown.set(k, { v, until: now() + Math.min(config.accessTtlMs ?? 60_000, 60_000) });
    return v;
  }

  // Re-reads the branch into the read model so the next page shows the write. A failure here
  // is healed by the push webhook GitHub sends for the commit, or the periodic resync.
  async function refresh(installationId, repo) {
    try { await ingest.syncRepo(installationId, { id: repo.id, fullName: repo.fullName }); } catch (e) { log.warn('sync after write failed', { repo: repo.fullName, error: e }); }
  }

  // A form post from the HUD: kind 'answer' (q, choice…, other) or 'note' (text, unit).
  async function fromHud(session, repo, runId, kind, form) {
    if (perUser.hit(String(session.userId))) throw new WriteError(429, 'too many answers and notes in a minute; wait a little');
    const may = await canWrite(session, repo, { fresh: true });
    if (!may.ok) {
      await db.audit('write.refused', { installationId: repo.installationId, login: session.login, detail: { repo: repo.fullName, run: runId, kind } });
      throw new WriteError(403, may.reason);
    }
    const token = await session.token();
    if (!token) throw new WriteError(403, 'Sign in again to answer or add notes.');
    let change; let unit = null; let what;
    if (kind === 'answer') {
      const id = form.get('q');
      const a = answerChange(id, (q) => fromForm(q, form.getAll('choice').map(mask), mask(form.get('other'))));
      change = a.mutate; what = `answer ${id}`;
    } else {
      unit = form.get('unit') || null;
      change = (s) => personNote(s, { text: mask(form.get('text')), unit: unit ?? undefined, via: 'web' });
      what = unit ? `note on ${unit}` : 'note';
    }
    const r = await commitRun({ gh, token, fullName: repo.fullName, branch, configured: branch, runId, kind, unit, mutate: change, message: `coordinator: ${what} on ${runId} (web, @${session.login})` });
    await db.audit(`write.${kind}`, { installationId: repo.installationId, login: session.login, detail: { repo: repo.fullName, run: runId, what, commit: r.commit, seq: r.seq } });
    if (!r.unchanged) await refresh(repo.installationId, repo);
    return r;
  }

  // A comment command, already parsed and permission-checked (commands.mjs). Committed with an
  // installation token that can only write contents, authored as the commenter.
  async function fromCommand({ installationId, repo, runId, login, userId, cmd, unit = null, source }) {
    const token = await gh.installationToken(installationId, SCOPES.write, { repositoryIds: [repo.id] });
    const author = { name: login, email: `${Number(userId)}+${login}@users.noreply.github.com` };
    let change; let eventUnit = null; let what;
    if (cmd.verb === 'answer') {
      const a = answerChange(cmd.question, (q) => pickFromComment(q, cmd));
      change = a.mutate; what = `answer ${cmd.question}`;
    } else {
      eventUnit = unit;
      change = (s) => personNote(s, { text: mask(cmd.text), unit: unit ?? undefined, via: 'web' });
      what = unit ? `note on ${unit}` : 'note';
    }
    const r = await commitRun({ gh, token, fullName: repo.fullName, branch, configured: branch, runId, kind: cmd.verb, unit: eventUnit, mutate: change, author, message: `coordinator: ${what} on ${runId} (comment by @${login})\n\n${source}` });
    await db.audit(`command.${cmd.verb}`, { installationId, login, detail: { repo: repo.fullName, run: runId, what, commit: r.commit, seq: r.seq } });
    if (!r.unchanged) await refresh(installationId, repo);
    return r;
  }

  return { canWrite, fromHud, fromCommand };
}

export class NotAnOption extends WriteError { constructor() { super(400, 'not an option'); } }

// A comment's answer: quoted text is the person's own answer; unquoted text names an option
// by its label (several, comma separated, on a multi-choice question). A question with no
// options takes unquoted text as the answer too.
export function pickFromComment(q, cmd) {
  if (cmd.other !== null && cmd.other !== undefined) return { choices: [], other: mask(cmd.other) };
  if (!q.options?.length) return { choices: [], other: mask(cmd.choice) };
  const labels = new Map(q.options.map((o) => [o.label.toLowerCase(), o.label]));
  const wanted = q.multi ? cmd.choice.split(',').map((x) => x.trim()).filter(Boolean) : [cmd.choice.trim()];
  const picked = wanted.map((w) => labels.get(w.toLowerCase()));
  if (!picked.length || picked.some((x) => !x)) throw new NotAnOption();
  return { choices: picked, other: null };
}
