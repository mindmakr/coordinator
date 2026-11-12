// The fake GitHub with writes moved to src/demo/fakegithub.mjs (the local demo uses it too).
export { fakeGitWrites } from '../src/demo/fakegithub.mjs';

// The log on the fake branch, as text.
export const branchLog = (gh, full, run) => gh.repos.get(full).files.get(`runs/${run}/events.jsonl`).toString('utf8');
