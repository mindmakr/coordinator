// The helper models' one network call: POST <endpoint>/chat/completions (and
// GET <endpoint>/models for `helper.mjs ping`), only when the person set
// `helpers` in .coordinator/coordinator.json. The key, if any, is read from the
// environment variable named in helpers.keyEnv and never written or printed.
// See references/helpers.md and AGENTS.md.
import { endpointProblem } from './helpers.mjs';

function headers(cfg, env) {
  const h = { 'content-type': 'application/json', accept: 'application/json' };
  if (cfg.keyEnv) {
    const key = env[cfg.keyEnv];
    if (!key && !cfg.local) throw new Error(`helpers: set the environment variable ${cfg.keyEnv} to your ${cfg.provider} key (it is never stored)`);
    if (key) h.authorization = `Bearer ${key}`;
  }
  return h;
}

async function send(url, init, { fetchImpl, timeoutMs }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctl.signal, redirect: 'error' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, json };
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`helpers: ${new URL(url).host} gave no answer in ${Math.round(timeoutMs / 1000)} s`);
    throw new Error(`helpers: cannot reach ${new URL(url).host} (${e?.cause?.code ?? e?.message ?? 'network error'}); is the server running?`);
  } finally { clearTimeout(timer); }
}

const errorText = (r) => String(r.json?.error?.message ?? r.json?.error ?? `HTTP ${r.status}`).slice(0, 200);

// The chat completion for a request from buildRequest. A server that refuses structured output
// (HTTP 400 naming response_format or json_schema) is asked once more without it; readAnswer still checks the reply.
export async function complete(cfg, req, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 120_000 } = {}) {
  const p = endpointProblem(cfg.endpoint);
  if (p) throw new Error(`helpers: ${p}`);
  if (typeof fetchImpl !== 'function') throw new Error('helpers need Node 18 or newer (no fetch)');
  const init = (body) => ({ method: 'POST', headers: headers(cfg, env), body: JSON.stringify(body) });
  let r = await send(req.url, init(req.body), { fetchImpl, timeoutMs });
  if (r.status === 400 && /response_format|json_schema|structured/i.test(errorText(r))) {
    const { response_format: _drop, ...plain } = req.body;
    r = await send(req.url, init(plain), { fetchImpl, timeoutMs });
  }
  if (!r.ok) throw new Error(`helpers: ${cfg.host} answered ${errorText(r)}`);
  return r.json;
}

// GET <endpoint>/models: what the server offers.
export async function listModels(cfg, { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const p = endpointProblem(cfg.endpoint);
  if (p) throw new Error(`helpers: ${p}`);
  const r = await send(`${cfg.endpoint}/models`, { method: 'GET', headers: headers(cfg, env) }, { fetchImpl, timeoutMs });
  if (!r.ok) throw new Error(`helpers: ${cfg.host} answered ${errorText(r)}`);
  return r.json;
}
