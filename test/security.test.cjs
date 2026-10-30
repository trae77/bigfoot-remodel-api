const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const ORIGIN = 'https://bigfoot-preview.ttawebdev.com';
const SECRET = 'x'.repeat(40);

function setEnv(env) {
  for (const k of ['REMODEL_TOKEN_SECRET', 'REMODEL_SERVICE_TOKEN', 'CORS_ORIGINS', 'REMODEL_PER_IP_DAILY', 'REMODEL_GLOBAL_DAILY', 'REMODEL_TOKENS_PER_IP_DAILY', 'FAL_KEY', 'FAL_KEY_A', 'FAL_KEY_B', 'FAL_KEY_B64', 'FAL_API_KEY', 'REMODEL_AI_API_KEY']) delete process.env[k];
  Object.assign(process.env, env);
}

let falCalls = 0;
const fakeFetch = async () => {
  falCalls += 1;
  return { ok: true, status: 200, text: async () => JSON.stringify({ images: [{ url: 'https://img/x.jpg' }], seed: 1 }) };
};

async function start(env) {
  setEnv({ FAL_KEY: 'fake-fal', REMODEL_TOKEN_SECRET: SECRET, ...env });
  delete require.cache[require.resolve('../remodelGenerate.cjs')];
  delete require.cache[require.resolve('../remodelApi.cjs')];
  require('../remodelGenerate.cjs').sessionSpend.clear();
  const { createApp } = require('../remodelApi.cjs');
  const server = http.createServer(createApp({ fetchImpl: fakeFetch }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

async function call(base, path, { origin = ORIGIN, token, ip, method = 'POST', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers.Origin = origin;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (ip) headers['X-Forwarded-For'] = ip;
  const res = await fetch(base + path, { method, headers, body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, headers: res.headers };
}

const GEN = { projectId: 1, imageUrl: 'https://example.com/a.jpg' };
async function getToken(base, ip) {
  const r = await call(base, '/api/remodel/token', { ip });
  assert.equal(r.status, 200);
  return r.json.token;
}

test('old pattern-based bearer tokens are rejected', async () => {
  const s = await start({});
  try {
    for (const t of ['preview-AAAAAAAA', 'demo-12345678abc', 'owner-ZZZZZZZZZZ']) {
      const r = await call(s.base, '/api/remodel/generate', { token: t, body: GEN });
      assert.equal(r.status, 401, t);
    }
    assert.equal(falCalls, 0);
  } finally { await s.close(); }
});

test('missing Origin and foreign Origin are rejected', async () => {
  const s = await start({});
  try {
    assert.equal((await call(s.base, '/api/remodel/token', { origin: null })).status, 403);
    assert.equal((await call(s.base, '/api/remodel/token', { origin: 'https://evil.example' })).status, 403);
    assert.equal((await call(s.base, '/api/remodel/token', { origin: 'http://localhost:5173' })).status, 403);
    const tok = await getToken(s.base, '1.1.1.1');
    assert.equal((await call(s.base, '/api/remodel/generate', { origin: null, token: tok, ip: '1.1.1.1', body: GEN })).status, 403);
    const pre = await call(s.base, '/api/remodel/generate', { method: 'OPTIONS', ip: '1.1.1.1' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
  } finally { await s.close(); }
});

test('fails closed when secret missing or too short', async () => {
  for (const env of [{ REMODEL_TOKEN_SECRET: '' }, { REMODEL_TOKEN_SECRET: 'short' }]) {
    const s = await start(env);
    try {
      assert.equal((await call(s.base, '/api/remodel/token')).status, 503);
      assert.equal((await call(s.base, '/api/remodel/generate', { token: 'rt1.a.b', body: GEN })).status, 503);
    } finally { await s.close(); }
  }
  assert.equal(falCalls, 0);
});

test('health no longer reveals fal configuration', async () => {
  const s = await start({});
  try {
    const r = await call(s.base, '/api/health', { method: 'GET' });
    assert.equal(r.status, 200);
    assert.equal(r.json.falConfigured, undefined);
  } finally { await s.close(); }
});

test('valid signed token works; tampered, wrong-IP, expired tokens fail', async () => {
  const s = await start({});
  try {
    const tok = await getToken(s.base, '2.2.2.2');
    const ok = await call(s.base, '/api/remodel/generate', { token: tok, ip: '2.2.2.2', body: GEN });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.afterImageUrl, 'https://img/x.jpg');
    const [a, p, sig] = tok.split('.');
    const bad = `${a}.${p}.${sig.slice(0, -2)}${sig.endsWith('AA') ? 'BB' : 'AA'}`;
    assert.equal((await call(s.base, '/api/remodel/generate', { token: bad, ip: '2.2.2.2', body: GEN })).status, 401);
    assert.equal((await call(s.base, '/api/remodel/generate', { token: tok, ip: '9.9.9.9', body: GEN })).status, 401);
    const sec = require('../security.cjs');
    const old = sec.issueToken(SECRET, { ip: '2.2.2.2', origin: ORIGIN, now: Date.now() - 31 * 60 * 1000 });
    assert.equal((await call(s.base, '/api/remodel/generate', { token: old, ip: '2.2.2.2', body: GEN })).status, 401);
    const other = sec.issueToken('y'.repeat(40), { ip: '2.2.2.2', origin: ORIGIN });
    assert.equal((await call(s.base, '/api/remodel/generate', { token: other, ip: '2.2.2.2', body: GEN })).status, 401);
  } finally { await s.close(); }
});

test('per-IP daily cap cannot be bypassed by minting new tokens', async () => {
  const s = await start({ REMODEL_PER_IP_DAILY: '3', REMODEL_GLOBAL_DAILY: '100', REMODEL_TOKENS_PER_IP_DAILY: '50' });
  try {
    falCalls = 0;
    const codes = [];
    for (let i = 0; i < 6; i++) {
      const tok = await getToken(s.base, '3.3.3.3');
      codes.push((await call(s.base, '/api/remodel/generate', { token: tok, ip: '3.3.3.3', body: { ...GEN, projectId: i + 1 } })).status);
    }
    assert.deepEqual(codes, [200, 200, 200, 429, 429, 429]);
    assert.equal(falCalls, 3);
  } finally { await s.close(); }
});

test('global daily cap applies across IPs', async () => {
  const s = await start({ REMODEL_PER_IP_DAILY: '5', REMODEL_GLOBAL_DAILY: '2' });
  try {
    falCalls = 0;
    const codes = [];
    for (const ip of ['4.0.0.1', '4.0.0.2', '4.0.0.3', '4.0.0.4']) {
      const tok = await getToken(s.base, ip);
      codes.push((await call(s.base, '/api/remodel/generate', { token: tok, ip, body: GEN })).status);
    }
    assert.deepEqual(codes, [200, 200, 429, 429]);
    assert.equal(falCalls, 2);
  } finally { await s.close(); }
});

test('token issuance is rate-limited per IP', async () => {
  const s = await start({ REMODEL_TOKENS_PER_IP_DAILY: '2' });
  try {
    assert.equal((await call(s.base, '/api/remodel/token', { ip: '5.5.5.5' })).status, 200);
    assert.equal((await call(s.base, '/api/remodel/token', { ip: '5.5.5.5' })).status, 200);
    assert.equal((await call(s.base, '/api/remodel/token', { ip: '5.5.5.5' })).status, 429);
  } finally { await s.close(); }
});

test('optional service token works only if long enough; spoofed leftmost XFF does not change IP', async () => {
  const svc = 's'.repeat(40);
  const s = await start({ REMODEL_SERVICE_TOKEN: svc, REMODEL_PER_IP_DAILY: '1' });
  try {
    assert.equal((await call(s.base, '/api/remodel/generate', { token: svc, ip: '6.6.6.6', body: GEN })).status, 200);
    assert.equal((await call(s.base, '/api/remodel/generate', { token: svc, ip: '7.7.7.7, 6.6.6.6', body: GEN })).status, 429);
  } finally { await s.close(); }
  const s2 = await start({ REMODEL_SERVICE_TOKEN: 'tooshort' });
  try {
    assert.equal((await call(s2.base, '/api/remodel/generate', { token: 'tooshort', body: GEN })).status, 401);
  } finally { await s2.close(); }
});
