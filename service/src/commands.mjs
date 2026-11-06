// Comment commands, for people who live in GitHub notifications:
//
//   /coordinator answer q3 server
//   /coordinator answer q3 "use the server total; drop the client sum"
//   /coordinator note QA found the same on the export screen
//
// Comment text is untrusted data. One line is read: the first that starts with
// `/coordinator`, outside quotes (`>`), code fences and indented code; the rest of the comment
// is ignored. The issue or PR must be linked to exactly one open run; the
// commenter must have push access to that run's state repo (asked of GitHub,
// not taken from author_association). The service reacts 👀 on reading the
// command, then 👍 once it is written, or 😕 with a short reply saying why not.
// Replies never quote the comment or the run (the issue may be public and the
// run private). A command can only answer a question the lead asked or add a
// note; neither grants anything (design 11.3).
import { SCOPES } from './github.mjs';
import { refsOf } from './ingest.mjs';
import { limiter } from './ratelimit.mjs';
import { WriteError } from './writes.mjs';

const MAX_TEXT = 1000;
// Commands handled per installation an hour. Each costs the App several API calls, so a flood of
// command comments on one installation's public issues cannot use up the App's quota for the rest.
export const COMMANDS_PER_HOUR = 60;
const USAGE = 'Commands: `/coordinator answer q3 <option>`, `/coordinator answer q3 "your own answer"`, or `/coordinator note <text>`.';

// The command in a comment body, or null when there is none.
// → { verb: 'answer', question, choice | other } | { verb: 'note', text } | { error }
export function parseCommand(body) {
  if (typeof body !== 'string' || body.length > 65_536) return null;
  let fence = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    const f = /^(`{3,}|~{3,})/.exec(line);
    if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; continue; }
    // Quotes, fenced code and indented code (four spaces or a tab) are text about a command, never one.
    if (fence || line.startsWith('>') || /^( {4}|\t)/.test(raw)) continue;
    if (/^\/coordinator(\s|$)/.test(line)) return parseLine(line);
  }
  return null;
}

function unquote(s) {
  const m = /^"([\s\S]*)"$/.exec(s) ?? /^“([\s\S]*)”$/.exec(s);
  return m ? m[1].trim() : null;
}

function parseLine(line) {
  const m = /^\/coordinator\s+(\S+)\s*(.*)$/.exec(line);
  if (!m) return { error: USAGE };
  const [, verb, rest] = m;
  if (verb === 'answer') {
    const a = /^(q[1-9]\d{0,3})\s+(.+)$/.exec(rest);
    if (!a) return { error: `Name the question and the answer. ${USAGE}` };
    const value = a[2].trim();
    const quoted = unquote(value);
    const text = quoted ?? value;
    if (!text) return { error: `The answer is empty. ${USAGE}` };
    if (text.length > MAX_TEXT) return { error: `An answer is ${MAX_TEXT} characters at most.` };
    return quoted !== null ? { verb, question: a[1], other: quoted } : { verb, question: a[1], choice: value };
  }
  if (verb === 'note') {
    const text = unquote(rest.trim()) ?? rest.trim();
    if (!text) return { error: `The note is empty. ${USAGE}` };
    if (text.length > MAX_TEXT) return { error: `A note is ${MAX_TEXT} characters at most.` };
    return { verb, text };
  }
  return { error: USAGE };
}

// Why a write was refused, in words that name nothing from the run but the question id.
function refusal(e, cmd) {
  const m = String(e.message);
  const q = cmd.question ?? '';
  if (m === 'not an option') return `That is not one of ${q}'s options. Use an option's label, or put your own answer in quotes.`;
  if (/already used/.test(m)) return `The lead has already used the answer to ${q}; it can no longer change. Add a note instead.`;
  if (/closed by a decision/.test(m)) return `${q} is already closed by a decision of the lead. Add a note instead.`;
  if (/no question|no such question/.test(m)) return `The run has no question ${q}.`;
  if (/takes one answer/.test(m)) return `${q} takes one answer.`;
  if (/run is closed/.test(m)) return 'The run is closed; it takes no more answers or notes.';
  if (e.status === 503) throw e; // busy: let GitHub redeliver
  return 'The command could not be written to the run.';
}

export function commands({ db, gh, writes, log, now = Date.now }) {
  const replies = limiter({ max: 20, windowMs: 3_600_000, now }); // refusal replies per installation
  const handled = limiter({ max: COMMANDS_PER_HOUR, windowMs: 3_600_000, now });

  async function reply(token, inst, full, n, text) {
    if (replies.hit(String(inst))) return; // over the cap: the 😕 reaction alone says it
    try { await gh.createComment(token, full, n, text); } catch (e) { log.warn('command reply failed', { repo: full, error: e }); }
  }
  const react = async (token, full, id, content) => { try { await gh.react(token, full, id, content); } catch (e) { log.warn('command reaction failed', { repo: full, error: e }); } };

  // { ok } or { refuse: text }
  async function execute(inst, p, cmd) {
    if (cmd.error) return { refuse: cmd.error };
    const where = String(p.repository.full_name);
    const key = `${where.toLowerCase()}#${Number(p.issue.number)}`;
    const repos = await db.repos(inst);
    const open = [];
    for (const r of await db.runsReferencing(inst, key)) {
      const repo = repos.find((x) => x.id === r.repoId);
      const row = repo && await db.run(inst, repo.id, r.runId);
      if (row?.state && !row.state.closed) open.push({ repo, runId: r.runId, units: [...new Set(refsOf(row.state).filter((x) => x.key === key).map((x) => x.unit))] });
    }
    if (!open.length) return { refuse: 'This issue or pull request is not linked to an open coordinator run.' };
    if (open.length > 1) return { refuse: 'This issue or pull request is linked to more than one open run; answer on the web dashboard instead.' };
    const [{ repo, runId, units }] = open;
    const login = String(p.comment.user?.login ?? '');
    const userId = Number(p.comment.user?.id);
    const token = await gh.installationToken(inst, SCOPES.comments);
    const perm = await gh.permission(token, repo.fullName, login);
    if (!perm.push) {
      await db.audit('command.refused', { installationId: inst, login, detail: { repo: repo.fullName, run: runId, reason: 'no push access' } });
      return { refuse: 'Only people with push access to the run\'s state repo can answer or add notes.' };
    }
    try {
      await writes.fromCommand({ installationId: inst, repo, runId, login, userId, cmd, unit: units.length === 1 ? units[0] : null, source: String(p.comment.html_url ?? '').slice(0, 300) });
      return { ok: true };
    } catch (e) {
      if (!(e instanceof WriteError) || e.status >= 500) throw e;
      return { refuse: refusal(e, cmd) };
    }
  }

  async function work(inst, p, cmd) {
    const cid = Number(p.comment.id);
    if (!(await db.claimCommand(inst, cid))) return; // already handled (a redelivery)
    const full = String(p.repository.full_name);
    const n = Number(p.issue.number);
    try {
      const token = await gh.installationToken(inst, SCOPES.comments);
      await react(token, full, cid, 'eyes');
      const out = await execute(inst, p, cmd);
      await db.finishCommand(inst, cid, out.ok ? 'done' : 'refused');
      if (out.ok) return react(token, full, cid, '+1');
      await react(token, full, cid, 'confused');
      return reply(token, inst, full, n, out.refuse);
    } catch (e) {
      await db.releaseCommand(inst, cid).catch(() => {}); // let GitHub's redelivery try again
      throw e;
    }
  }

  return {
    parseCommand,
    // An issue_comment delivery → { status, body, work? }.
    async handle(p) {
      if (p.action !== 'created') return { status: 202, body: `ignored: issue_comment ${p.action}` };
      const c = p.comment;
      if (!c || !Number.isSafeInteger(Number(c.id)) || !Number.isSafeInteger(Number(p.issue?.number))) return { status: 202, body: 'ignored: no comment' };
      if (c.performed_via_github_app || c.user?.type === 'Bot' || p.sender?.type === 'Bot') return { status: 202, body: 'ignored: a bot' };
      const cmd = parseCommand(c.body);
      if (!cmd) return { status: 202, body: 'ignored: no command' };
      const inst = Number(p.installation.id);
      if (!(await db.installation(inst))) return { status: 202, body: 'ignored: unknown installation' };
      if (handled.hit(String(inst))) {
        log.warn('comment commands over the hourly cap', { installation: inst });
        return { status: 202, body: 'ignored: too many commands this hour' };
      }
      return { status: 202, body: `command ${cmd.verb ?? 'refused'}`, work: () => work(inst, p, cmd) };
    },
  };
}
