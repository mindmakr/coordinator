// c14 round 4: who a webhook delivery comes from. Address groups (IPv6 /64, IPv4 /24 for the
// budget), GitHub's hook ranges and their daily refresh, the App header trusted only from them,
// proxy hops behind a CDN, and alert-address keys folded to the mailbox.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { connect } from 'node:net';
import { test } from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { GITHUB_HOOKS, groupOf, hookSources, ipBytes, parseCidr } from '../src/hooksource.mjs';
import { normalEmail } from '../src/alerts/routes.mjs';
import { MAX_WEBHOOK_PER_IP } from '../src/server.mjs';
import { startApp } from './helpers.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const sign = (secret, body) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
// A delivery from `xff` (TRUST_PROXY): signed with the App's secret, or wrongly; `app` names the App it is for.
const post = async (t, xff, { good = true, app = null, pad = '' } = {}) => {
  const b = JSON.stringify({ zen: 'hi', hook_id: 1, installation: { id: 7 }, pad });
  const r = await fetch(`${t.base}/webhook`, { method: 'POST', body: b, headers: { 'X-Forwarded-For': xff, 'X-GitHub-Event': 'ping', 'X-GitHub-Delivery': `s-${++n}`, 'X-Hub-Signature-256': good ? sign(t.cfg.github.webhookSecret, b) : `sha256=${'0'.repeat(64)}`, ...(app ? { 'X-GitHub-Hook-Installation-Target-ID': app } : {}) } });
  await r.arrayBuffer();
  return r.status;
};
function stall(t, ip, length, send) {
  const s = connect(Number(new URL(t.base).port), '127.0.0.1');
  const status = new Promise((ok) => { let got = ''; s.on('data', (d) => { got += d; }); s.on('close', () => ok(Number(/^HTTP\/1\.1 (\d+)/.exec(got)?.[1]) || 'closed')); s.on('error', () => {}); });
  s.write(`POST /webhook HTTP/1.1\r\nHost: x\r\nX-Forwarded-For: ${ip}\r\nContent-Length: ${length}\r\n\r\n`);
  if (send) s.write(Buffer.alloc(send, 0x61));
  return { status, socket: s };
}

test('c14: addresses are grouped, and checked against CIDR ranges', () => {
  assert.deepEqual(ipBytes('::ffff:140.82.115.1'), [140, 82, 115, 1], 'an IPv4-mapped address is IPv4');
  assert.equal(ipBytes('nope'), null);
  assert.equal(groupOf('2001:db8::1'), groupOf('2001:db8::ffff:1:2'), 'one /64');
  assert.notEqual(groupOf('2001:db8::1'), groupOf('2001:db8:0:1::1'));
  assert.equal(groupOf('192.0.2.1', { v4Bits: 24 }), groupOf('192.0.2.200', { v4Bits: 24 }));
  assert.notEqual(groupOf('192.0.2.1'), groupOf('192.0.2.2'), 'IPv4 is one address unless asked');
  assert.equal(parseCidr('1.2.3.0/33'), null);
  assert.equal(parseCidr('::ffff:1.2.3.4/24'), null);
  const gh = hookSources();
  for (const ip of ['140.82.115.1', '::ffff:192.30.252.9', '2a0a:a447::1', '2606:50c0:1::1']) assert.equal(gh.trusted(ip), true, ip);
  for (const ip of ['127.0.0.1', '2a0a:a448::1', '10.0.0.1', '-']) assert.equal(gh.trusted(ip), false, ip);
  assert.equal(hookSources({ mode: 'any' }).trusted('140.82.115.1'), false, 'with any, nobody is known to be GitHub');
  assert.equal(hookSources({ mode: ['198.51.100.0/24'] }).trusted('198.51.100.7'), true);
});

test('c14: the hook ranges come from GitHub at start and daily; a failed or empty answer keeps the list in use', async () => {
  const answers = [{ hooks: ['198.51.100.0/24'] }, new Error('down'), { hooks: [] }, { hooks: ['not a range'] }];
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return { ok: true, json: async () => a };
  };
  const s = hookSources({ api: 'https://api.example', fetchImpl });
  assert.equal(s.trusted('140.82.115.1'), true, 'the built-in list before the first fetch');
  assert.equal(await s.refresh(), true);
  assert.equal(urls[0], 'https://api.example/meta');
  assert.equal(s.trusted('198.51.100.9'), true);
  assert.equal(s.trusted('140.82.115.1'), false, 'replaced by what GitHub published');
  for (let i = 0; i < 3; i++) assert.equal(await s.refresh(), false);
  assert.equal(s.trusted('198.51.100.9'), true, 'kept through a failure, an empty list and a bad one');
  const fallback = hookSources({ fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(await fallback.refresh(), false);
  assert.equal(fallback.trusted('140.82.115.1'), true, 'never fetched: the built-in list');
  assert.ok(GITHUB_HOOKS.every(parseCidr));
  assert.equal(await hookSources({ mode: ['198.51.100.0/24'], fetchImpl: () => assert.fail('a fixed list is not fetched') }).refresh(), false);
});

test('c14: six addresses of one IPv6 /64 hold one share of the budget; GitHub keeps getting through', async () => {
  const t = await startApp({ over: { trustProxy: true, webhookBodyMs: 3000 } });
  const open = [];
  try {
    const M = MAX_WEBHOOK_PER_IP;
    const first = stall(t, '2001:db8::1', M, M - 1); open.push(first);
    await wait(200);
    for (let i = 2; i <= 6; i++) open.push(stall(t, `2001:db8::${i}`, M, M - 1));
    const codes = await Promise.all(open.slice(1).map((x) => x.status));
    assert.ok(codes.every((c) => c === 429), String(codes));
    assert.ok(t.app.webhookBytes().used < M, 'one share held, not six');
    const big = stall(t, '2001:db8:1::1', M + 1, 10); open.push(big);
    assert.equal(await big.status, 413, 'a body larger than a share is refused before it is read');
    assert.equal(await post(t, '140.82.115.1', { pad: 'x'.repeat(6000) }), 200);
  } finally { for (const x of open) x.socket.destroy(); await t.close(); }
});

test('c14: the App header skips the refusal limit only from GitHub\'s hook addresses', async () => {
  const t = await startApp({ over: { trustProxy: true } });
  try {
    const app = t.cfg.github.appId;
    for (let i = 0; i < 31; i++) await post(t, '203.0.113.5', { good: false });
    assert.equal(await post(t, '203.0.113.5', { app }), 429, 'a forged header from elsewhere is still limited');
    assert.equal(await post(t, '2001:db8::7', { good: false }), 401);
    for (let i = 0; i < 31; i++) await post(t, `2001:db8::${i + 100}`, { good: false });
    assert.equal(await post(t, '2001:db8::ffff', { app }), 429, 'one /64 shares one count');
    for (let i = 0; i < 31; i++) await post(t, '140.82.115.1', { good: false, app: '999' });
    assert.equal(await post(t, '140.82.115.1', { app: '999' }), 429, 'another App from GitHub: turned away');
    assert.equal(await post(t, '140.82.115.1', { app }), 200, 'ours from GitHub gets through');
  } finally { await t.close(); }
  const any = await startApp({ over: { trustProxy: true, webhookSources: 'any' } });
  try {
    for (let i = 0; i < 31; i++) await post(any, '203.0.113.5', { good: false });
    assert.equal(await post(any, '203.0.113.5', { app: any.cfg.github.appId }), 200, 'WEBHOOK_SOURCES=any believes the header from anyone');
  } finally { await any.close(); }
});

test('c14: WEBHOOK_SOURCES=any keeps the reserve for small bodies from anyone, and every group capped', async () => {
  const t = await startApp({ over: { trustProxy: true, webhookSources: 'any', webhookInflightBytes: 8 * MAX_WEBHOOK_PER_IP, webhookReserveBytes: 2 * MAX_WEBHOOK_PER_IP, webhookBodyMs: 3000 } });
  const open = [];
  try {
    const M = MAX_WEBHOOK_PER_IP;
    for (let i = 1; i <= 6; i++) open.push(stall(t, `10.${i}.0.1`, M, M - 1));
    await wait(300);
    const over = stall(t, '10.99.0.1', M, 10); open.push(over);
    assert.equal(await over.status, 503, 'large bodies stop at the reserve');
    assert.equal(await post(t, '192.0.2.1'), 200, 'a small one from anywhere uses it');
    const gh = stall(t, '140.82.115.1', M + 1, 10); open.push(gh);
    assert.equal(await gh.status, 413, 'GitHub\'s addresses are capped like any other');
  } finally { for (const x of open) x.socket.destroy(); await t.close(); }
});

test('c14: TRUSTED_PROXY_HOPS=2 reads the client behind a CDN and the proxy', async () => {
  const cdn = '104.16.0.1';
  const one = await startApp({ over: { trustProxy: true } });
  try {
    for (let i = 0; i < 31; i++) await post(one, `203.0.113.${i}, ${cdn}`, { good: false });
    assert.equal(await post(one, `198.51.100.1, ${cdn}`), 429, 'one hop: every client is the CDN');
  } finally { await one.close(); }
  const two = await startApp({ over: { trustProxy: true, trustedProxyHops: 2 } });
  try {
    for (let i = 0; i < 31; i++) await post(two, `203.0.113.5, ${cdn}`, { good: false });
    assert.equal(await post(two, `203.0.113.5, ${cdn}`), 429, 'the client behind the CDN is limited');
    assert.equal(await post(two, `198.51.100.1, ${cdn}`), 200, 'others behind the same CDN are not');
    assert.equal(await post(two, `forged, 140.82.115.1, ${cdn}`, { app: two.cfg.github.appId }), 200, 'GitHub through the CDN is GitHub');
    assert.equal(await post(two, '198.51.100.2'), 200, 'fewer entries than hops: the first one');
  } finally { await two.close(); }
  const base = { BASE_URL: 'http://localhost:3000', SESSION_SECRET: 'x'.repeat(40), GITHUB_APP_ID: '1', GITHUB_CLIENT_ID: 'c', GITHUB_CLIENT_SECRET: 's', GITHUB_WEBHOOK_SECRET: 'w', GITHUB_APP_PRIVATE_KEY: 'k' };
  assert.equal(loadConfig(base).trustedProxyHops, 1);
  assert.equal(loadConfig({ ...base, TRUSTED_PROXY_HOPS: '2' }).trustedProxyHops, 2);
  assert.throws(() => loadConfig({ ...base, TRUSTED_PROXY_HOPS: '0' }), /out of range/);
  assert.equal(loadConfig(base).webhookSources, 'github');
  assert.equal(loadConfig({ ...base, WEBHOOK_SOURCES: 'any' }).webhookSources, 'any');
  assert.deepEqual(loadConfig({ ...base, WEBHOOK_SOURCES: '192.0.2.0/24, 2001:db8::/32' }).webhookSources, ['192.0.2.0/24', '2001:db8::/32']);
  assert.throws(() => loadConfig({ ...base, WEBHOOK_SOURCES: 'githb' }), /WEBHOOK_SOURCES/);
});

test('c14: the confirmation limiter counts a mailbox, however its address is tagged or dotted', () => {
  const key = (s) => normalEmail(s).key;
  assert.equal(key('Ann+alerts@Example.org'), 'ann@example.org');
  assert.equal(normalEmail('Ann+alerts@Example.org').address, 'Ann+alerts@example.org', 'the address is kept as given');
  assert.equal(key('a.n.n+x@gmail.com'), 'ann@gmail.com');
  assert.equal(key('ANN@googlemail.com'), 'ann@gmail.com');
  assert.equal(key('a.n.n@example.org'), 'a.n.n@example.org', 'dots count elsewhere');
  assert.equal(key('+x@example.org'), '+x@example.org', 'nothing left before the tag: kept');
});
