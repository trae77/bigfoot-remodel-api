const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const SECRET = 'Tq7vR2mZp9Lk4Wx8Bn3Hc6Jd1Fs5Gy0Ae';
const ORIGIN = 'https://bigfoot-preview.ttawebdev.com';
const PNG = 'data:image/png;base64,' + Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13,73,72,68,82]).toString('base64');
const store = require('../imageStore.cjs');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const hdrs = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
const RID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function mockFal(log, { imgHost = 'https://v3.fal.media/files/out.jpg', deleteOk = true } = {}) {
  return async (url, init = {}) => {
    url = String(url); log.push((init.method || 'GET') + ' ' + url);
    if (url.startsWith('https://fal.run/')) return { ok: true, status: 200, headers: hdrs({ 'x-fal-request-id': RID }), text: async () => JSON.stringify({ images: [{ url: imgHost }], seed: 7 }) };
    if (url.includes('fal.media') || url.startsWith('https://evil')) return { ok: true, status: 200, headers: hdrs({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => JPG };
    if (url.startsWith('https://api.fal.ai/')) return { ok: deleteOk, status: deleteOk ? 200 : 403, json: async () => ({}) };
    throw new Error('unexpected ' + url);
  };
}

async function boot(fetchImpl, imageStore) {
  process.env.REMODEL_TOKEN_SECRET = SECRET; process.env.FAL_KEY = 'fake-fal'; delete process.env.CORS_ORIGINS;
  for (const m of ['../remodelGenerate.cjs', '../remodelApi.cjs']) delete require.cache[require.resolve(m)];
  require('../remodelGenerate.cjs').sessionSpend.clear();
  const { createApp } = require('../remodelApi.cjs');
  const server = http.createServer(createApp({ fetchImpl, imageStore }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

async function generate(base) {
  const t = await (await fetch(base + '/api/remodel/token', { method: 'POST', headers: { Origin: ORIGIN } })).json();
  const r = await fetch(base + '/api/remodel/generate', { method: 'POST', headers: { Origin: ORIGIN, Authorization: 'Bearer ' + t.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 1, room: 'kitchen', image_url: PNG, finishes: {} }) });
  return { status: r.status, json: await r.json() };
}

test('render is copied private, fal URL never returned, fal payload deleted, signed URL serves bytes', async () => {
  const log = []; const s = await boot(mockFal(log));
  try {
    const g = await generate(s.base);
    assert.equal(g.status, 200, JSON.stringify(g.json));
    assert.ok(!JSON.stringify(g.json).includes('fal.media'));
    assert.ok(g.json.afterImageExpiresIn <= 900);
    assert.ok(log.includes(`DELETE https://api.fal.ai/v1/models/requests/${RID}/payloads`));
    const img = await fetch(s.base + g.json.afterImageUrl);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.match(img.headers.get('cache-control'), /no-store/);
    assert.deepEqual(Buffer.from(await img.arrayBuffer()), JPG);
    const bad = await fetch(s.base + g.json.afterImageUrl.replace(/sig=./, 'sig=A'));
    assert.equal(bad.status, 403);
  } finally { await s.close(); }
});

test('URL carries no PII: only id, exp, sig', async () => {
  const p = store.signedImagePath(SECRET, 'abcdefghijklmnopqrstuvwx');
  const u = new URL('http://x' + p);
  assert.deepEqual([...u.searchParams.keys()].sort(), ['exp', 'sig']);
  assert.ok(!/kitchen|p1|127\.0\.0\.1|@/.test(p));
});

test('signed URL expires after <=15 min and rejects far-future exp', () => {
  const now = Date.now();
  const p = new URL('http://x' + store.signedImagePath(SECRET, 'abcdefghijklmnopqrstuvwx', { ttlSec: 99999, now }));
  const exp = p.searchParams.get('exp'), sig = p.searchParams.get('sig');
  assert.ok(Number(exp) - Math.floor(now / 1000) <= 900);
  assert.ok(store.verifyImageSig(SECRET, 'abcdefghijklmnopqrstuvwx', exp, sig, now));
  assert.ok(!store.verifyImageSig(SECRET, 'abcdefghijklmnopqrstuvwx', exp, sig, now + 901 * 1000));
  assert.ok(!store.verifyImageSig('other-secret-other-secret-other-xx', 'abcdefghijklmnopqrstuvwx', exp, sig, now));
});

test('retention: entries deleted at TTL; TTL hard-capped at 7 days', () => {
  let t = 0; const st = store.createImageStore({ retentionMs: 60_000, now: () => t });
  const id = st.put(JPG, 'image/jpeg');
  assert.ok(st.get(id)); t = 60_001; assert.equal(st.get(id), null);
  assert.equal(store.createImageStore({ retentionMs: 30 * 24 * 3600 * 1000 }).retentionMs, store.MAX_RETENTION_MS);
});

test('non-fal image host is refused (no SSRF), returns 502, nothing stored', async () => {
  const log = []; const st = store.createImageStore(); const s = await boot(mockFal(log, { imgHost: 'https://evil.example/x.jpg' }), st);
  try {
    const g = await generate(s.base);
    assert.equal(g.status, 502);
    assert.equal(st.size(), 0);
    assert.ok(!log.some((l) => l.includes('evil')));
    assert.ok(log.some((l) => l.startsWith('DELETE https://api.fal.ai/')), 'still tries fal delete');
  } finally { await s.close(); }
});

test('fal delete failure does not leak fal URL to client', async () => {
  const log = []; const s = await boot(mockFal(log, { deleteOk: false }));
  try {
    const g = await generate(s.base);
    assert.equal(g.status, 200);
    assert.ok(!JSON.stringify(g.json).includes('fal.media'));
  } finally { await s.close(); }
});
