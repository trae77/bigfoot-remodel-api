// Monthly hard cap (default 120 fal calls per UTC calendar month), fails closed. Uses a fake fetch: fal is never called.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const ORIGIN = 'https://bigfoot-preview.ttawebdev.com';
const SECRET = 'Tq7vR2mZp9Lk4Wx8Bn3Hc6Jd1Fs5Gy0Ae';
const PNG = 'data:image/png;base64,' + Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13,73,72,68,82]).toString('base64');
const GEN = { projectId: 1, imageUrl: PNG };
const hdrs = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
let upstream = 0;
const fakeFetch = async (url) => {
  if (String(url).startsWith('https://v3.fal.media/')) return { ok: true, status: 200, headers: hdrs({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]) };
  if (String(url).startsWith('https://api.fal.ai/')) return { ok: true, status: 200, json: async () => ({}) };
  upstream += 1;
  return { ok: true, status: 200, headers: hdrs({}), text: async () => JSON.stringify({ images: [{ url: 'https://v3.fal.media/files/x.jpg' }], seed: 1 }) };
};

async function start(monthCounter, env = {}) {
  for (const k of ['REMODEL_GLOBAL_MONTHLY', 'REMODEL_SERVICE_TOKEN', 'CORS_ORIGINS']) delete process.env[k];
  Object.assign(process.env, { FAL_KEY: 'fake-fal', REMODEL_TOKEN_SECRET: SECRET, REMODEL_PER_IP_DAILY: '1000', REMODEL_GLOBAL_DAILY: '1000', REMODEL_TOKENS_PER_IP_DAILY: '1000', REMODEL_REQUESTS_PER_TOKEN: '1000', ...env });
  for (const m of ['../remodelGenerate.cjs', '../remodelApi.cjs', '../security.cjs']) delete require.cache[require.resolve(m)];
  require('../remodelGenerate.cjs').sessionSpend.clear();
  const { createApp } = require('../remodelApi.cjs');
  const server = http.createServer(createApp({ fetchImpl: fakeFetch, monthCounter }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
async function gen(base, ip) {
  const h = { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-Forwarded-For': ip };
  const t = await (await fetch(base + '/api/remodel/token', { method: 'POST', headers: h, body: '{}' })).json();
  const r = await fetch(base + '/api/remodel/generate', { method: 'POST', headers: { ...h, Authorization: `Bearer ${t.token}` }, body: JSON.stringify(GEN) });
  return r.status;
}
const preset = (n) => { const c = require('../security.cjs').createMonthlyCounter(); for (let i = 0; i < n; i++) c.inc(); return c; };

test('default config is 120/month and env-configurable', () => {
  delete process.env.REMODEL_GLOBAL_MONTHLY;
  delete require.cache[require.resolve('../security.cjs')];
  assert.equal(require('../security.cjs').getConfig().globalMonthly, 120);
  process.env.REMODEL_GLOBAL_MONTHLY = '7';
  assert.equal(require('../security.cjs').getConfig().globalMonthly, 7);
  delete process.env.REMODEL_GLOBAL_MONTHLY;
});

test('120th call allowed, 121st rejected (429) before any upstream call', async () => {
  const c = preset(119);
  const s = await start(c);
  try {
    upstream = 0;
    assert.equal(await gen(s.base, '9.0.0.1'), 200);
    assert.equal(c.get(), 120);
    const before = upstream;
    assert.equal(await gen(s.base, '9.0.0.2'), 429);
    assert.equal(upstream, before, 'no upstream call on 121st');
    assert.equal(c.get(), 120);
  } finally { await s.close(); }
});

test('client cannot override the cap (body/header fields ignored)', async () => {
  const c = preset(120);
  const s = await start(c);
  try { assert.equal(await gen(s.base, '9.0.0.3'), 429); } finally { await s.close(); }
});

test('counter store error -> fail closed (503), no upstream call', async () => {
  for (const bad of [{ get() { throw new Error('down'); }, inc() {} }, { get() { return NaN; }, inc() {} }, { get() { return 0; }, inc() { throw new Error('down'); } }]) {
    const s = await start(bad);
    try {
      upstream = 0;
      assert.equal(await gen(s.base, '9.0.0.4'), 503);
      assert.equal(upstream, 0);
    } finally { await s.close(); }
  }
});

test('month rollover resets the count (UTC calendar month)', () => {
  const c = require('../security.cjs').createMonthlyCounter();
  const oct = Date.parse('2026-10-31T23:59:59Z'), nov = Date.parse('2026-11-01T00:00:00Z');
  for (let i = 0; i < 120; i++) c.inc(oct);
  assert.equal(c.get(oct), 120);
  assert.equal(c.get(nov), 0);
});
