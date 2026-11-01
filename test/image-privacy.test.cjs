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
    if (url.startsWith('https://api.fal.ai/')) return { ok: deleteOk, status: deleteOk ? 200 : 403, json: async () => ({ cdn_delete_results: [{ link: 'https://v3.fal.media/files/out.jpg', exception: null }] }) };
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

test('P2-1 magic bytes must match declared type (HTML-as-PNG refused)', () => {
  assert.ok(store.magicMatches('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0])));
  assert.ok(store.magicMatches('image/png', Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0])));
  assert.ok(store.magicMatches('image/webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')));
  assert.ok(!store.magicMatches('image/png', Buffer.from('<html><script>x</script></html>')));
  assert.ok(!store.magicMatches('image/png', Buffer.from([0xff, 0xd8, 0xff, 0])), 'JPEG bytes labeled PNG');
  assert.ok(!store.magicMatches('image/webp', Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'latin1')));
});

test('P2-1 end-to-end: fal returns HTML labeled image/png -> 502, nothing stored, no fal URL', async () => {
  const st = store.createImageStore();
  const f = async (url, init = {}) => {
    url = String(url);
    if (url.startsWith('https://fal.run/')) return { ok: true, status: 200, headers: hdrs({ 'x-fal-request-id': RID }), text: async () => JSON.stringify({ images: [{ url: 'https://v3.fal.media/files/o.png' }] }) };
    if (url.includes('fal.media')) return { ok: true, status: 200, headers: hdrs({ 'content-type': 'image/png' }), arrayBuffer: async () => Buffer.from('<html>evil</html>') };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const s = await boot(f, st);
  try {
    const g = await generate(s.base);
    assert.equal(g.status, 502);
    assert.equal(st.size(), 0);
    assert.ok(!JSON.stringify(g.json).includes('fal.media'));
  } finally { await s.close(); }
});

test('P3 streamed download aborts once it passes 10MB; Content-Length precheck', async () => {
  let cancelled = false, pulled = 0;
  const chunk = new Uint8Array(1024 * 1024).fill(0xff);
  const body = { getReader: () => ({ read: async () => { pulled++; return pulled > 50 ? { done: true } : { done: false, value: chunk }; }, cancel: async () => { cancelled = true; } }) };
  await assert.rejects(store.readCapped({ body }, store.MAX_IMAGE_BYTES), /size/);
  assert.ok(cancelled); assert.ok(pulled <= 12, 'stopped early: ' + pulled);
  const big = async () => ({ ok: true, headers: hdrs({ 'content-type': 'image/jpeg', 'content-length': String(11 * 1024 * 1024) }), arrayBuffer: async () => { throw new Error('should not read'); } });
  await assert.rejects(store.fetchFalImage('https://v3.fal.media/x.jpg', big), /size/);
});

test('P3 session budget is charged when fal succeeds even if download fails', async () => {
  const f = async (url) => {
    url = String(url);
    if (url.startsWith('https://fal.run/')) return { ok: true, status: 200, headers: hdrs({ 'x-fal-request-id': RID }), text: async () => JSON.stringify({ images: [{ url: 'https://v3.fal.media/files/o.jpg' }] }) };
    if (url.includes('fal.media')) return { ok: false, status: 500, headers: hdrs({}) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const s = await boot(f);
  try {
    const g = await generate(s.base);
    assert.equal(g.status, 502);
    const budgets = [...require('../remodelGenerate.cjs').sessionSpend.values()];
    assert.equal(budgets.length, 1);
    assert.equal(budgets[0].count, 1);
    assert.ok(budgets[0].spendUsd > 0);
  } finally { await s.close(); }
});

test('P3 sweep timer is unref-ed and cleared on close', async () => {
  const { createApp } = require('../remodelApi.cjs');
  const app = createApp({ fetchImpl: async () => { throw new Error('x'); } });
  assert.equal(typeof app.stopSweep, 'function');
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  assert.ok(srv.listeners('close').includes(app.stopSweep), 'stopSweep wired to close');
  let stopped = false; const orig = app.stopSweep; srv.removeAllListeners('close'); srv.on('close', () => { orig(); stopped = true; });
  await new Promise((r) => srv.close(r));
  assert.ok(stopped);
});

test('fal delete failure raises ALERT log with no URL, key or request id', async () => {
  const log = []; const s = await boot(mockFal(log, { deleteOk: false }));
  const orig = console.error; const errs = []; console.error = (...a) => errs.push(a.join(' '));
  try {
    const g = await generate(s.base);
    assert.equal(g.status, 200);
    const alert = errs.find((e) => e.includes('ALERT fal_payload_delete_failed'));
    assert.ok(alert, 'alert emitted');
    assert.ok(!/fal\.media|fake-fal/.test(alert) && !alert.includes(RID));
  } finally { console.error = orig; await s.close(); }
});
