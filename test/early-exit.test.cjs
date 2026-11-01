// QA R65: every early exit leaves the D1 count caps, the dollar cap and the token allowance unchanged. Mocked fal only.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const ORIGIN = 'https://bigfoot-preview.ttawebdev.com';
const PNG = (w, h) => { const b = Buffer.alloc(24); Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13,73,72,68,82]).copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return 'data:image/png;base64,' + b.toString('base64'); };
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const hdrs = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
const ALL = { floor: 'light oak', cabinets: 'white shaker', counters: 'white quartz', walls: 'soft gray' };
const KEYS = ['REMODEL_REGIONS', 'REMODEL_DECLUTTER', 'REMODEL_FAILOVER', 'REMODEL_QWEN_USD', 'REMODEL_RENDER_MAX_USD', 'REMODEL_REGION_ENGINE', 'REMODEL_FILL_USD', 'REMODEL_REQUESTS_PER_TOKEN', 'REMODEL_PER_IP_DAILY', 'REMODEL_GLOBAL_DAILY', 'REMODEL_MONTHLY_USD_CAP', 'REMODEL_TWO_PASS', 'REMODEL_FAL_MODEL'];

function stub(runs, { fail = false } = {}) {
  return async (url, init = {}) => {
    url = String(url);
    if (url.startsWith('https://fal.run/')) {
      runs.push({ url, body: JSON.parse(init.body) });
      if (fail && url.includes('kontext')) return { ok: false, status: 500, headers: hdrs({}), text: async () => '{}' };
      return { ok: true, status: 200, headers: hdrs({ 'x-fal-request-id': `r${runs.length}` }), text: async () => JSON.stringify({ images: [{ url: `https://v3.fal.media/files/p${runs.length}.jpg` }] }) };
    }
    if (url.includes('fal.media')) return { ok: true, status: 200, headers: hdrs({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => JPG };
    throw new Error('unexpected outbound ' + url);
  };
}
async function boot(fetchImpl, env) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { REMODEL_TOKEN_SECRET: 'Tq7vR2mZp9Lk4Wx8Bn3Hc6Jd1Fs5Gy0Ae', FAL_KEY: 'fake-fal' }, env);
  delete process.env.FAL_STORE_IO; delete process.env.CORS_ORIGINS;
  for (const m of ['../remodelGenerate.cjs', '../remodelApi.cjs', '../engines.cjs', '../capStore.cjs']) delete require.cache[require.resolve(m)];
  require('../remodelGenerate.cjs').sessionSpend.clear();
  const capStore = require('../capStore.cjs').createMemoryCapStore();
  const server = http.createServer(require('../remodelApi.cjs').createApp({ fetchImpl, capStore }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { capStore, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
async function token(base) { return (await (await fetch(base + '/api/remodel/token', { method: 'POST', headers: { Origin: ORIGIN } })).json()).token; }
async function gen(base, t, finishes = ALL, img = PNG(1600, 900), session) {
  const h = { Origin: ORIGIN, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' };
  if (session) h['X-Remodel-Session'] = session;
  const r = await fetch(base + '/api/remodel/generate', { method: 'POST', headers: h, body: JSON.stringify({ projectId: 1, room: 'kitchen', image_url: img, finishes }) });
  return { status: r.status, json: await r.json() };
}
test.afterEach(() => { for (const k of KEYS) delete process.env[k]; });

test('4-call plan with REQUESTS_PER_TOKEN=3: 429 Try fewer changes, nothing reserved, no call, token still usable', async () => {
  const runs = []; const s = await boot(stub(runs), { REMODEL_REGIONS: '1', REMODEL_DECLUTTER: '1', REMODEL_REQUESTS_PER_TOKEN: '3' });
  try {
    const t = await token(s.base);
    const r = await gen(s.base, t);
    assert.equal(r.status, 429); assert.equal(r.json.error, 'Try fewer changes');
    assert.equal(s.capStore.total(), 0); assert.equal(runs.length, 0);
    // The token was not charged: a 3-call regions render (declutter off) still fits all 3 uses.
    process.env.REMODEL_DECLUTTER = '0';
    assert.equal((await gen(s.base, t)).status, 200); assert.equal(runs.length, 3);
  } finally { await s.close(); }
});

test('cap refusal (per-IP) gives the token uses back and reserves nothing', async () => {
  const runs = []; const s = await boot(stub(runs), { REMODEL_REGIONS: '1', REMODEL_PER_IP_DAILY: '2' });
  try {
    const t = await token(s.base);
    assert.equal((await gen(s.base, t)).status, 429);
    assert.equal(s.capStore.total(), 0); assert.equal(runs.length, 0);
    assert.equal((await gen(s.base, t, { counters: 'granite' })).status, 200);
  } finally { await s.close(); }
});

test('dollar-cap refusal releases the count reservations and the token', async () => {
  const runs = []; const s = await boot(stub(runs), { REMODEL_REGIONS: '1', REMODEL_MONTHLY_USD_CAP: '0.08' });
  try {
    const t = await token(s.base);
    assert.equal((await gen(s.base, t)).status, 429);
    assert.equal(s.capStore.total(), 0); assert.equal(runs.length, 0);
  } finally { await s.close(); }
});

test('engine unavailable (fill without price): 503 before any reservation', async () => {
  const runs = []; const s = await boot(stub(runs), { REMODEL_REGIONS: '1', REMODEL_REGION_ENGINE: 'fill' });
  try { assert.equal((await gen(s.base, await token(s.base))).status, 503); assert.equal(s.capStore.total(), 0); assert.equal(runs.length, 0); } finally { await s.close(); }
});

test('handler early exits after reservation release everything: render ceiling, unreadable image size, session limit', async () => {
  // ceiling
  let runs = []; let s = await boot(stub(runs), { REMODEL_REGIONS: '1', REMODEL_RENDER_MAX_USD: '0.08' });
  try { const r = await gen(s.base, await token(s.base)); assert.equal(r.status, 429); assert.equal(s.capStore.total(), 0); assert.equal(runs.length, 0); } finally { await s.close(); }
  // mask engine + unreadable size (valid JPEG magic, no SOF)
  runs = []; s = await boot(stub(runs), { REMODEL_REGIONS: '1', REMODEL_REGION_ENGINE: 'fill', REMODEL_FILL_USD: '0.05' });
  try {
    const jpg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]).toString('base64');
    const r = await gen(s.base, await token(s.base), { counters: 'granite' }, jpg);
    assert.equal(r.status, 400); assert.equal(s.capStore.total(), 0); assert.equal(runs.length, 0);
  } finally { await s.close(); }
  // session limit: 5 calls per session; same session header, fresh tokens, high caps
  runs = []; s = await boot(stub(runs), { REMODEL_REGIONS: '1', REMODEL_PER_IP_DAILY: '50', REMODEL_GLOBAL_DAILY: '50' });
  try {
    assert.equal((await gen(s.base, await token(s.base), ALL, PNG(1600, 900), 'sess-1')).status, 200); // 3 calls
    const before = s.capStore.total();
    const r = await gen(s.base, await token(s.base), ALL, PNG(1600, 900), 'sess-1'); // 3 more > 2 left
    assert.equal(r.status, 429); assert.equal(s.capStore.total(), before); assert.equal(runs.length, 3);
  } finally { await s.close(); }
});

test('missing FAL_KEY after reservation: 503 and everything released', async () => {
  const runs = []; const s = await boot(stub(runs), { REMODEL_REGIONS: '1' });
  try {
    const t = await token(s.base); process.env.FAL_KEY = '';
    assert.equal((await gen(s.base, t)).status, 503); assert.equal(s.capStore.total(), 0); assert.equal(runs.length, 0);
  } finally { await s.close(); }
});

test('failover: token take fails -> no extra count or dollar reservation, no qwen call', async () => {
  const runs = []; const s = await boot(stub(runs, { fail: true }), { REMODEL_REGIONS: '1', REMODEL_FAILOVER: '1', REMODEL_QWEN_USD: '0.05', REMODEL_REQUESTS_PER_TOKEN: '1' });
  try {
    const r = await gen(s.base, await token(s.base), { counters: 'granite' });
    assert.equal(r.status, 502); assert.equal(runs.length, 1);
    const { periodKeys } = require('../capStore.cjs'); const { day, month } = periodKeys();
    assert.equal(s.capStore.peek(`d:${day}:global`), 1);
    assert.equal(s.capStore.peek(`m:${month}:usd_cents`), 4); // only the planned kontext call
  } finally { await s.close(); }
});

// ---- QA R66: tests that fail if a release line is removed ----
test('R66-1 handler early exit restores token uses (same token then runs a full 3-call render at REQUESTS_PER_TOKEN=3)', async () => {
  const runs = []; const s = await boot(stub(runs), { REMODEL_REGIONS: '1', REMODEL_REQUESTS_PER_TOKEN: '3' });
  try {
    const t = await token(s.base);
    process.env.FAL_KEY = '';
    assert.equal((await gen(s.base, t)).status, 503);
    process.env.FAL_KEY = 'fake-fal';
    const r = await gen(s.base, t);
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(runs.length, 3);
  } finally { await s.close(); }
});

test('R66-2 failover $ refusal releases the extra count slots', async () => {
  const runs = []; const s = await boot(stub(runs, { fail: true }), { REMODEL_REGIONS: '1', REMODEL_FAILOVER: '1', REMODEL_QWEN_USD: '0.16', REMODEL_MONTHLY_USD_CAP: '0.10' });
  try {
    assert.equal((await gen(s.base, await token(s.base), { counters: 'granite' })).status, 502);
    assert.equal(runs.length, 1);
    const { periodKeys } = require('../capStore.cjs'); const { day, month } = periodKeys();
    assert.equal(s.capStore.peek(`d:${day}:global`), 1);
    assert.equal(s.capStore.peek(`m:${month}:global`), 1);
    assert.equal(s.capStore.get('ip:*'), 1);
    assert.equal(s.capStore.peek(`m:${month}:usd_cents`), 4);
  } finally { await s.close(); }
});

test('R66-3 failover count refusal gives the token use back', async () => {
  const runs = []; const s = await boot(stub(runs, { fail: true }), { REMODEL_REGIONS: '1', REMODEL_FAILOVER: '1', REMODEL_QWEN_USD: '0.05', REMODEL_PER_IP_DAILY: '1', REMODEL_REQUESTS_PER_TOKEN: '2' });
  try {
    const t = await token(s.base);
    assert.equal((await gen(s.base, t, { counters: 'granite' })).status, 502); // planned call used 1 token use; retry refused by per-IP
    process.env.REMODEL_PER_IP_DAILY = '10'; process.env.REMODEL_FAILOVER = '0';
    const r = await gen(s.base, t, { counters: 'granite' }); // needs the 2nd use: only there if the retry gave it back
    assert.notEqual(r.status, 401, JSON.stringify(r.json));
  } finally { await s.close(); }
});

test('R66-P3a throw before the first fal call (mask build fails) releases everything: 500, caps and token unchanged', async () => {
  const runs = []; const s = await boot(stub(runs), { REMODEL_REGIONS: '1', REMODEL_REGION_ENGINE: 'fill', REMODEL_FILL_USD: '0.05', REMODEL_REQUESTS_PER_TOKEN: '1' });
  try {
    const t = await token(s.base);
    const r = await gen(s.base, t, { counters: 'granite' }, PNG(9000, 900)); // > 8192 px: heuristicMask throws
    assert.equal(r.status, 500); assert.equal(runs.length, 0); assert.equal(s.capStore.total(), 0);
    assert.equal((await gen(s.base, t, { counters: 'granite' })).status, 200); // token use was given back
  } finally { await s.close(); }
});

test('R66-P3b NO_MASK on the first call releases everything: 503, caps and token unchanged', async () => {
  const runs = []; const s = await boot(stub(runs), { REMODEL_REGIONS: '1', REMODEL_REGION_ENGINE: 'fill', REMODEL_FILL_USD: '0.05', REMODEL_REQUESTS_PER_TOKEN: '1' });
  const regions = require('../regionTargeting.cjs'); const orig = regions.heuristicMask;
  try {
    const t = await token(s.base);
    regions.heuristicMask = () => '';
    const r = await gen(s.base, t, { counters: 'granite' });
    assert.equal(r.status, 503); assert.equal(runs.length, 0); assert.equal(s.capStore.total(), 0);
    regions.heuristicMask = orig;
    assert.equal((await gen(s.base, t, { counters: 'granite' })).status, 200);
  } finally { regions.heuristicMask = orig; await s.close(); }
});
