// Which repos the service may write to for a run: its project (design 5).
//
// The state repo is always in. Another repo is in only when both sides say so:
//   1. the state branch's coordinator.json lists it in "repos", and
//   2. that repo's own default branch has a coordinator.json whose "primary"
//      names the state repo.
// The run log and the state branch are written by whoever can push to the
// state repo; side 2 can only be written by someone who can push to the linked
// repo's default branch (and pass its branch protection). So a person who can
// push only to the state repo can claim any link they like, but cannot steer
// the App's comments or board writes into a repo that did not opt in. Links
// outside the project stay visible, read-only, to viewers who can read them.
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const lower = (s) => String(s ?? '').toLowerCase();
const FILE_MAX = 64 * 1024;

// The repos coordinator.json lists: "repos": ["owner/name" | { "repo": "owner/name" }, ...].
export function listedRepos(config) {
  const list = Array.isArray(config?.repos) ? config.repos : [];
  return new Set(list.map((x) => lower(typeof x === 'string' ? x : x?.repo)).filter(Boolean));
}

export function projectFence({ gh, ttlMs = 60_000, now = Date.now }) {
  const cache = new Map();
  async function agrees(token, target, stateName, spend) {
    const k = `${lower(target)}\u0000${lower(stateName)}`;
    const hit = cache.get(k);
    if (hit && hit.until > now()) return hit.ok;
    spend?.(); // c14 round 5: the trail's read budget (it throws when spent)
    let ok = false;
    try {
      const buf = await gh.defaultBranchFile(token, target, 'coordinator.json');
      if (buf && buf.length <= FILE_MAX) { const c = JSON.parse(buf.toString('utf8')); ok = isObj(c) && lower(c.primary) === lower(stateName); }
    } catch { ok = false; }
    if (cache.size > 10_000) cache.clear();
    cache.set(k, { ok, until: now() + ttlMs });
    return ok;
  }

  // stateRepo: the run's repo row (with config); target: the repo row a unit links to.
  // token(): a read-only installation token, minted only if needed. spend (optional): see agrees.
  async function allows(stateRepo, target, token, spend = null) {
    if (!target || target.installationId !== stateRepo.installationId) return false;
    if (target.id === stateRepo.id) return true;
    if (!listedRepos(stateRepo.config).has(lower(target.fullName))) return false;
    return agrees(await token(), target.fullName, stateRepo.fullName, spend);
  }
  return { allows };
}
