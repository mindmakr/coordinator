// The built-in sub-skills: each playbook has the parts a brief relies on, each
// is discoverable as a plugin skill that points at it, and the loop's own
// playbooks (briefs, run) name the right one for each step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const refs = path.join(skill, 'references');
const plugin = path.resolve(skill, '..');
const NAMES = ['investigate', 'plan', 'fix', 'review', 'verify', 'visual', 'translations', 'release-notes', 'board'];
const read = (p) => fs.readFileSync(p, 'utf8');
const playbook = (n) => read(path.join(refs, 'sub-skills', `${n}.md`));

test('every playbook says when, what it takes, how it plugs in, what it does and what it returns', () => {
  for (const n of NAMES) {
    const s = playbook(n);
    for (const part of ['**When:**', '**Inputs:**', '**In the loop:**', '## Output']) assert.ok(s.includes(part), `${n}.md lacks ${part}`);
    assert.match(s, /^## .*(steps|moves)/im, `${n}.md has no steps`);
  }
});

test('every file a playbook names exists', () => {
  const known = new Set([
    ...fs.readdirSync(refs).filter((f) => f.endsWith('.md')),
    ...fs.readdirSync(path.join(refs, 'sub-skills')).map((f) => `sub-skills/${f}`),
    ...fs.readdirSync(path.join(refs, 'commands')).map((f) => `commands/${f}`),
    ...fs.readdirSync(path.join(refs, 'domains')).map((f) => `domains/${f}`),
  ]);
  const own = new Set(NAMES.map((n) => `${n}.md`));
  const project = new Set(['COORDINATOR.md', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md']);
  for (const file of [...NAMES.map((n) => `sub-skills/${n}.md`), 'sub-skills.md']) {
    for (const [, ref] of read(path.join(refs, file)).matchAll(/`((?:[\w-]+\/)?[\w-]+\.md)`/g)) {
      if (project.has(ref)) continue;
      const ok = known.has(ref) || known.has(`sub-skills/${ref}`) || own.has(ref);
      assert.ok(ok, `${file} names ${ref}, which does not exist`);
    }
  }
});

test('each sub-skill is a plugin skill that points at its playbook', () => {
  for (const n of NAMES) {
    const s = read(path.join(plugin, n, 'SKILL.md'));
    const front = s.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(front, `skills/${n}/SKILL.md has no frontmatter`);
    assert.match(front[1], new RegExp(`^name: ${n}$`, 'm'));
    assert.match(front[1], /^description: Use when .{40,}$/m);
    assert.ok(s.includes(`\${CLAUDE_SKILL_DIR}/../coordinator/references/sub-skills/${n}.md`), `skills/${n} does not point at its playbook`);
  }
});

test('the catalogue lists every playbook, and briefs and run name the right one per step', () => {
  const index = read(path.join(refs, 'sub-skills.md'));
  for (const n of NAMES) assert.ok(index.includes(`sub-skills/${n}.md`), `sub-skills.md does not list ${n}`);
  const briefs = read(path.join(refs, 'briefs.md'));
  for (const n of ['fix', 'review', 'visual', 'translations', 'verify', 'release-notes']) assert.ok(briefs.includes(`${n}.md`), `briefs.md does not name ${n}.md`);
  const run = read(path.join(refs, 'commands', 'run.md'));
  for (const n of ['investigate', 'plan', 'fix', 'review', 'visual', 'board', 'release-notes', 'verify']) assert.ok(run.includes(`${n}.md`), `run.md does not name ${n}.md`);
});

test('review keeps its depth and its security and project-rule passes', () => {
  const s = playbook('review');
  for (const part of ['## Depth is fixed', '**Security pass.**', '**Project-rule pass.**', '**Correctness pass.**', 'Specialist critic']) assert.ok(s.includes(part), `review.md lacks ${part}`);
  assert.match(s, /never cuts a pass/i);
});

test('the lessons from real runs are in the playbooks', () => {
  assert.match(playbook('fix'), /its own database/);
  assert.match(playbook('review'), /timing on auth paths/i);
  assert.match(playbook('translations'), /## Copy under approval/);
  assert.match(playbook('investigate'), /## Bound the bar/);
  assert.match(playbook('review'), /reuse its tag word for word/);
});
