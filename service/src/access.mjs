// Who may see what. A person sees a repo's runs only while GitHub, asked with
// that person's own token, says they can read the repo. Answers are cached per
// person and repo for a short time (ACCESS_TTL_SECONDS, at most 60), never
// shared between people. Anything else is answered as "not found", so a page
// never confirms that a private repo exists.

export function access({ gh, db, ttlMs = 60_000, now = Date.now }) {
  const cache = new Map();
  const remember = (k, v) => {
    if (cache.size > 20_000) for (const [x, e] of cache) if (e.until <= now()) cache.delete(x);
    cache.set(k, { v, until: now() + ttlMs });
    return v;
  };
  const cached = (k) => { const e = cache.get(k); return e && e.until > now() ? e : null; };

  // The repo row when this person may read it, else null.
  // A repo the service does not know is asked about the same way (and cached the same way), so the
  // time to answer cannot tell an unknown repo from a known one the viewer cannot read.
  async function readable(session, fullName) {
    if (!session) return null;
    const repo = await db.repoForPage(fullName); // the URL names no installation; GitHub's answer below checks the id
    const k = `${session.userId}\u0000repo\u0000${repo ? `${repo.installationId}:${repo.id}` : `?${String(fullName).toLowerCase()}`}`;
    const hit = cached(k);
    if (hit) return hit.v && repo ? repo : null;
    const token = await session.token();
    if (!token) return null;
    const r = await gh.repoAccess(token, repo?.fullName ?? fullName);
    // The id must match too: a repo deleted and re-created under the same name is another repo.
    const ok = !!repo && !!r.repo && Number(r.repo.id) === repo.id && r.repo.permissions?.pull === true;
    remember(k, ok);
    return ok ? repo : null;
  }

  // Every repo in the read model this person can read, via the App's user installations.
  async function projects(session) {
    const k = `${session.userId}\u0000projects`;
    const hit = cached(k);
    if (hit) return hit.v;
    const token = await session.token();
    if (!token) return [];
    const known = new Set(await db.installationIds());
    const out = [];
    for await (const inst of gh.userInstallations(token)) {
      if (!known.has(Number(inst.id))) continue;
      const rows = new Map((await db.repos(Number(inst.id))).map((r) => [r.id, r]));
      for await (const r of gh.userInstallationRepos(token, inst.id)) {
        const row = rows.get(Number(r.id));
        if (row && r.permissions?.pull !== false) { out.push(row); remember(`${session.userId}\u0000repo\u0000${row.installationId}:${row.id}`, true); }
      }
    }
    out.sort((a, b) => a.fullName.localeCompare(b.fullName));
    return remember(k, out);
  }

  return { readable, projects, forget: (userId) => { for (const k of cache.keys()) if (k.startsWith(`${userId}\u0000`)) cache.delete(k); } };
}
