const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const SECRET = 'Tq7vR2mZp9Lk4Wx8Bn3Hc6Jd1Fs5Gy0Ae';
const TT = 'Zb4Kq8Wm2Xr6Tn0Vp3Ls7Hd1Gf5Jc9YaQe';
const ORIGIN = 'https://bigfoot-preview.ttawebdev.com';
const PNG = 'data:image/png;base64,' + Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13,73,72,68,82]).toString('base64');
const GEN = { projectId: 1, imageUrl: PNG };
const hdrs = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
let falCalls = 0; let falBodies = []; let falHeaders = [];
const fakeFetch = async (url, init = {}) => {
  if (String(url).startsWith('https://v3.fal.media/')) return { ok: true, status: 200, headers: hdrs({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]) };
  if (String(url).startsWith('https://api.fal.ai/')) return { ok: true, status: 200, json: async () => ({ cdn_delete_results: [] }) };
  falCalls += 1; falBodies.push(String(init.body || '')); falHeaders.push(init.headers || {});
  return { ok: true, status: 200, headers: hdrs({ 'x-fal-request-id': 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' }), text: async () => JSON.stringify({ images: [{ url: 'https://v3.fal.media/files/x.jpg' }], seed: 1 }) };
};

const ENVK = ['REMODEL_TOKEN_SECRET', 'REMODEL_SERVICE_TOKEN', 'REMODEL_TEST_TOKEN', 'CORS_ORIGINS', 'REMODEL_PER_IP_DAILY', 'REMODEL_GLOBAL_DAILY', 'REMODEL_GLOBAL_MONTHLY', 'REMODEL_RENDER_MAX_USD', 'FAL_KEY', 'FAL_STORE_IO'];
let logs = [];
function capture() {
  const orig = {}; for (const m of ['log', 'info', 'warn', 'error']) { orig[m] = console[m]; console[m] = (...a) => { logs.push(a.map(String).join(' ')); }; }
  return () => Object.assign(console, orig);
}
async function start(env, capStore) {
  for (const k of ENVK) delete process.env[k];
  Object.assign(process.env, { FAL_KEY: 'fake-fal', REMODEL_TOKEN_SECRET: SECRET, ...env });
  for (const m of ['../remodelGenerate.cjs', '../remodelApi.cjs', '../security.cjs']) delete require.cache[require.resolve(m)];
  require('../remodelGenerate.cjs').sessionSpend.clear();
  const caps = require('../capStore.cjs');
  const store = capStore || caps.createMemoryCapStore();
  const imgs = new Map();
  const imageStore = { put: (b, t) => { imgs.set('i', { b, t }); return 'i'; }, get: () => null, sweep() {} };
  const server = http.createServer(require('../remodelApi.cjs').createApp({ fetchImpl: fakeFetch, capStore: store, imageStore }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, store, close: () => new Promise((r) => server.close(r)) };
}
async function gen(base, { tt, origin, ip = '203.0.113.9', body = GEN, bearer } = {}) {
  const h = { 'Content-Type': 'application/json', 'X-Forwarded-For': ip };
  if (tt !== undefined) h['X-Remodel-Test-Token'] = tt;
  if (origin) h.Origin = origin;
  if (bearer) h.Authorization = `Bearer ${bearer}`;
  const res = await fetch(base + '/api/remodel/generate', { method: 'POST', headers: h, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, headers: [...res.headers].map((x) => x.join(':')).join('\n') };
}
function assertNoSecret(...blobs) { for (const b of blobs) assert.ok(!String(b).includes(TT), 'secret leaked'); }

test.beforeEach(() => { falCalls = 0; falBodies = []; falHeaders = []; logs = []; });

test('(3) unset or empty REMODEL_TEST_TOKEN: header is ignored, normal Origin/token gate applies', async () => {
  for (const v of [undefined, '', '   ']) {
    const s = await start(v === undefined ? {} : { REMODEL_TEST_TOKEN: v });
    try {
      const r = await gen(s.base, { tt: TT });
      assert.equal(r.status, 403); // no Origin => origin gate
      const r2 = await gen(s.base, { tt: TT, origin: ORIGIN });
      assert.equal(r2.status, 401); // no session token
      assert.equal(s.store.total(), 0); assert.equal(falCalls, 0);
    } finally { await s.close(); }
  }
});

test('(3) weak REMODEL_TEST_TOKEN disables the bypass', async () => {
  const s = await start({ REMODEL_TEST_TOKEN: 'short' });
  try { assert.equal((await gen(s.base, { tt: 'short' })).status, 403); assert.equal(falCalls, 0); } finally { await s.close(); }
});

test('(3) wrong token (incl. different length, empty, prefix) -> 401, no reservation, no fal call, not echoed', async () => {
  const s = await start({ REMODEL_TEST_TOKEN: TT });
  const restore = capture();
  try {
    for (const bad of ['x', TT.slice(0, -1), TT + 'a', TT.toLowerCase(), '']) {
      const r = await gen(s.base, { tt: bad, origin: ORIGIN });
      assert.equal(r.status, 401, JSON.stringify(bad.length));
      assertNoSecret(r.text, r.headers);
      if (bad) assert.ok(!r.text.includes(bad));
    }
    assert.equal(s.store.total(), 0); assert.equal(falCalls, 0);
  } finally { restore(); await s.close(); }
  assertNoSecret(logs.join('\n'));
});

test('(1)(4) correct token bypasses Origin + session token; marker logged; secret never logged/echoed/sent upstream', async () => {
  const s = await start({ REMODEL_TEST_TOKEN: TT });
  const restore = capture();
  let r;
  try { r = await gen(s.base, { tt: TT }); } finally { restore(); await s.close(); }
  assert.equal(r.status, 200, r.text);
  assert.equal(falCalls, 1);
  assert.ok(logs.includes('test_bypass_used'));
  assertNoSecret(r.text, r.headers, logs.join('\n'), falBodies.join('\n'), JSON.stringify(falHeaders));
  assert.ok(!/test[-_]?token|X-Remodel-Test/i.test(r.text));
});

test('(1) compare is constant-time and length-safe', () => {
  const sec = require('../security.cjs');
  assert.equal(sec.testTokenMatches(TT, TT), true);
  for (const b of ['', 'a', TT + TT, TT.slice(1)]) assert.equal(sec.testTokenMatches(TT, b), false);
  assert.equal(sec.testTokenMatches('', ''), false);
  assert.match(require('fs').readFileSync(require.resolve('../security.cjs'), 'utf8'), /timingSafeEqual\(a, b\)/);
});

test('(2) bypass still counts D1 month/day/IP caps and is refused at each cap with no fal call', async () => {
  const caps = require('../capStore.cjs');
  for (const [env, which] of [[{ REMODEL_GLOBAL_MONTHLY: '1' }, 'Monthly'], [{ REMODEL_GLOBAL_DAILY: '1' }, 'Daily preview limit reached. Try'], [{ REMODEL_PER_IP_DAILY: '1' }, 'network']]) {
    const s = await start({ REMODEL_TEST_TOKEN: TT, ...env }, caps.createMemoryCapStore());
    try {
      assert.equal((await gen(s.base, { tt: TT })).status, 200);
      falCalls = 0;
      const r = await gen(s.base, { tt: TT });
      assert.equal(r.status, 429); assert.ok(r.text.includes(which), r.text); assert.equal(falCalls, 0);
    } finally { await s.close(); }
  }
});

test('(2) a fresh egress IP per request does not escape the global caps', async () => {
  const s = await start({ REMODEL_TEST_TOKEN: TT, REMODEL_GLOBAL_DAILY: '2' });
  try {
    assert.equal((await gen(s.base, { tt: TT, ip: '198.51.100.1' })).status, 200);
    assert.equal((await gen(s.base, { tt: TT, ip: '198.51.100.2' })).status, 200);
    assert.equal((await gen(s.base, { tt: TT, ip: '198.51.100.3' })).status, 429);
    assert.equal(falCalls, 2);
  } finally { await s.close(); }
});

test('(2) cap store down -> bypass fails closed (503), no fal call', async () => {
  const broken = { reserve: async () => { throw new Error('down'); }, release: async () => {}, total: () => 0 };
  const s = await start({ REMODEL_TEST_TOKEN: TT }, broken);
  try { assert.equal((await gen(s.base, { tt: TT })).status, 503); assert.equal(falCalls, 0); } finally { await s.close(); }
});

test('(2) per-render $ ceiling refuses before any reservation', async () => {
  const s = await start({ REMODEL_TEST_TOKEN: TT, REMODEL_RENDER_MAX_USD: '0.01' });
  try {
    const r = await gen(s.base, { tt: TT });
    assert.equal(r.status, 400); assert.equal(s.store.total(), 0); assert.equal(falCalls, 0);
  } finally { await s.close(); }
});

test('(2) all bypass renders share one session $ budget regardless of session header/IP', async () => {
  const g = () => require('../remodelGenerate.cjs');
  const s = await start({ REMODEL_TEST_TOKEN: TT, REMODEL_PER_IP_DAILY: '99', REMODEL_GLOBAL_DAILY: '99' });
  try {
    let ok = 0;
    for (let i = 0; i < 10; i++) { const r = await gen(s.base, { tt: TT, ip: `198.51.100.${i}` }); if (r.status === 200) ok += 1; else assert.equal(r.status, 429); }
    assert.equal(ok, Math.min(g().MAX_GENERATES_PER_SESSION ?? 99, Math.floor(g().MAX_SESSION_SPEND_USD / g().falModel().usd + 1e-9)));
    assert.ok(g().sessionSpend.has('test-bypass'));
  } finally { await s.close(); }
});

test('(2) validation still runs on the bypass, before caps', async () => {
  const s = await start({ REMODEL_TEST_TOKEN: TT });
  try {
    for (const body of [{ projectId: 1, imageUrl: 'https://evil.example/x.jpg' }, { projectId: 0, imageUrl: PNG }, { projectId: 1, imageUrl: PNG, hasPeople: true }]) {
      assert.equal((await gen(s.base, { tt: TT, body })).status, 400);
    }
    assert.equal(s.store.total(), 0); assert.equal(falCalls, 0);
  } finally { await s.close(); }
});

test('(2) EXIF/metadata stripped before upload on the bypass; no-storage header sent to fal', async () => {
  const exif = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 16]), Buffer.from('Exif\0\0GPSLAT12')]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), exif, Buffer.from([0xff, 0xda, 0, 4, 1, 2, 9, 9, 0xff, 0xd9])]);
  const s = await start({ REMODEL_TEST_TOKEN: TT });
  try {
    const r = await gen(s.base, { tt: TT, body: { projectId: 1, imageUrl: 'data:image/jpeg;base64,' + jpg.toString('base64') } });
    assert.equal(r.status, 200, r.text);
    const sent = JSON.parse(falBodies[0]).image_url;
    const bytes = Buffer.from(sent.split(',')[1], 'base64');
    assert.ok(!bytes.includes(Buffer.from('Exif')) && !bytes.includes(Buffer.from('GPSLAT')));
    assert.equal(falHeaders[0]['X-Fal-Store-IO'], '0');
    assert.ok(!r.text.includes('fal.media'));
  } finally { await s.close(); }
});

test('normal public path unchanged: no Origin still 403 without test header', async () => {
  const s = await start({ REMODEL_TEST_TOKEN: TT });
  try { assert.equal((await gen(s.base, {})).status, 403); assert.equal((await gen(s.base, { origin: ORIGIN })).status, 401); } finally { await s.close(); }
});
