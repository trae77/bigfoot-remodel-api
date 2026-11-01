// Region targeting: mocked fal only, zero live/paid calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const ORIGIN = 'https://bigfoot-preview.ttawebdev.com';
const PNG = (w, h) => { const b = Buffer.alloc(24); Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13,73,72,68,82]).copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return 'data:image/png;base64,' + b.toString('base64'); };
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const hdrs = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
const ALL = { floor: 'light oak', cabinets: 'white shaker', counters: 'white quartz', walls: 'soft gray' };

function stubFal(runs, { failPass = 0 } = {}) {
  return async (url, init = {}) => {
    url = String(url);
    if (url.startsWith('https://fal.run/')) {
      const n = runs.length + 1; runs.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      if (n === failPass) return { ok: false, status: 500, headers: hdrs({}), text: async () => '{}' };
      return { ok: true, status: 200, headers: hdrs({ 'x-fal-request-id': `req-${n}` }), text: async () => JSON.stringify({ images: [{ url: `https://v3.fal.media/files/p${n}.jpg` }] }) };
    }
    if (url.includes('fal.media')) return { ok: true, status: 200, headers: hdrs({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => JPG };
    throw new Error('unexpected outbound ' + url);
  };
}
const ENV_KEYS = ['REMODEL_REGIONS', 'REMODEL_REGION_ENGINE', 'REMODEL_FILL_USD', 'REMODEL_TWO_PASS', 'REMODEL_PER_IP_DAILY', 'REMODEL_GLOBAL_DAILY', 'REMODEL_REQUESTS_PER_TOKEN', 'REMODEL_FAL_MODEL'];
async function boot(fetchImpl, env = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, { REMODEL_TOKEN_SECRET: 'Tq7vR2mZp9Lk4Wx8Bn3Hc6Jd1Fs5Gy0Ae', FAL_KEY: 'fake-fal', REMODEL_REGIONS: '1' }, env);
  delete process.env.FAL_STORE_IO; delete process.env.FAL_MEDIA_EXPIRATION_SEC; delete process.env.CORS_ORIGINS;
  for (const m of ['../remodelGenerate.cjs', '../remodelApi.cjs', '../engines.cjs']) delete require.cache[require.resolve(m)];
  require('../remodelGenerate.cjs').sessionSpend.clear();
  const server = http.createServer(require('../remodelApi.cjs').createApp({ fetchImpl }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
async function gen(base, finishes = ALL, token) {
  const t = token || (await (await fetch(base + '/api/remodel/token', { method: 'POST', headers: { Origin: ORIGIN } })).json()).token;
  const r = await fetch(base + '/api/remodel/generate', { method: 'POST', headers: { Origin: ORIGIN, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 1, room: 'kitchen', image_url: PNG(1600, 900), finishes }) });
  return { status: r.status, json: await r.json(), token: t };
}
test.afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

test('planRegions: one pass per region in floor, cabinets, counters order; walls ride on the last', () => {
  const { planRegions } = require('../regionTargeting.cjs');
  const p = planRegions('kitchen', ALL);
  assert.deepEqual(p.map((c) => c.region), ['floor', 'cabinets', 'counters']);
  assert.deepEqual(p[2].extras, ['walls']);
  assert.match(p[0].prompt, /Change only the floor/);
  assert.doesNotMatch(p[0].prompt, /quartz|shaker/i);
  assert.doesNotMatch(p[1].prompt, /oak|quartz/i);
  assert.match(p[2].prompt, /soft gray/);
  assert.deepEqual(planRegions('kitchen', { counters: 'granite' }).map((c) => c.region), ['counters']);
  assert.deepEqual(planRegions('kitchen', { walls: 'sage' }).map((c) => c.region), ['finishes']);
  assert.deepEqual(planRegions('kitchen', {}), []);
});

test('every region prompt excludes tables/chairs; counters pass says a table is not a countertop', () => {
  const { planRegions } = require('../regionTargeting.cjs');
  for (const c of planRegions('kitchen', ALL)) {
    assert.match(c.prompt, /Do not change any table, dining table, table top, chairs, stools/);
    assert.match(c.prompt, /Do not add people, text/);
    assert.match(c.prompt, /table, chairs/);
    assert.ok(c.negative.some((n) => /table/.test(n)), c.region);
  }
  const counters = planRegions('kitchen', ALL)[2];
  assert.match(counters.prompt, /A table in the room is not a countertop/);
  assert.ok(counters.negative.includes('dining table top turned into countertop'));
});

test('floor pass carries the anti-stripe guard and never names an unwanted pattern', () => {
  const { planRegions, FLOOR_GUARD } = require('../regionTargeting.cjs');
  const p = planRegions('kitchen', { floor: 'oak' })[0];
  assert.ok(p.prompt.includes(FLOOR_GUARD));
  assert.match(p.prompt, /no stripes/);
  assert.ok(p.negative.includes('stripes') && p.negative.includes('banding'));
  assert.doesNotMatch(p.prompt, /herringbone|parquet|chevron/i);
});

test('flag default OFF: unset or junk REMODEL_REGIONS keeps the existing plan', () => {
  for (const v of [undefined, '', '0', 'maybe']) {
    if (v === undefined) delete process.env.REMODEL_REGIONS; else process.env.REMODEL_REGIONS = v;
    delete process.env.REMODEL_TWO_PASS;
    delete require.cache[require.resolve('../remodelGenerate.cjs')];
    const g = require('../remodelGenerate.cjs');
    assert.equal(g.regionsOn(), false);
    const calls = g.planCalls({ room: 'kitchen', finishes: ALL, prompt: 'x' });
    assert.equal(calls.length, 2); assert.ok(!calls[0].region);
  }
});

test('regions ON, kontext: 3 fal calls chained, each counted, negatives sent, Store-IO 0 + TTL 3600 kept', async () => {
  const runs = []; const s = await boot(stubFal(runs));
  try {
    const r = await gen(s.base);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(runs.length, 3);
    assert.ok(runs.every((x) => x.url === 'https://fal.run/fal-ai/flux-pro/kontext'));
    assert.match(runs[0].body.prompt, /Change only the floor/); assert.match(runs[2].body.prompt, /countertops/);
    assert.ok(runs.every((x) => /\nAvoid: .*table/.test(x.body.prompt)));
    assert.equal(runs[1].body.image_url, 'https://v3.fal.media/files/p1.jpg');
    assert.equal(runs[2].body.image_url, 'https://v3.fal.media/files/p2.jpg');
    assert.ok(runs.every((x) => !('mask_url' in x.body)));
    for (const x of runs) { assert.equal(x.headers['X-Fal-Store-IO'], '0'); assert.deepEqual(JSON.parse(x.headers['X-Fal-Object-Lifecycle-Preference']), { expiration_duration_seconds: 3600 }); }
    assert.ok(runs.every((x) => x.body.prompt.length <= require('../remodelGenerate.cjs').MAX_PROMPT_CHARS));
    assert.equal(r.json.remainingSessionGenerates, 2);
    assert.ok(!JSON.stringify(r.json).includes('fal.media'));
  } finally { await s.close(); }
});

test('durable caps count each region call: per-IP daily 4 allows one 3-call render, refuses the next with no call', async () => {
  const runs = []; const s = await boot(stubFal(runs), { REMODEL_PER_IP_DAILY: '4' });
  try {
    assert.equal((await gen(s.base)).status, 200);
    assert.equal(runs.length, 3);
    const r2 = await gen(s.base);
    assert.equal(r2.status, 429);
    assert.equal(runs.length, 3);
    assert.equal((await gen(s.base, { floor: 'oak' })).status, 200);
    assert.equal(runs.length, 4);
  } finally { await s.close(); }
});

test('a failing middle pass returns 502 and stops (no further calls); missing key 503 with no call', async () => {
  const runs = []; const s = await boot(stubFal(runs, { failPass: 2 }));
  try {
    const r = await gen(s.base);
    assert.equal(r.status, 502); assert.equal(runs.length, 2);
  } finally { await s.close(); }
  const runs2 = []; const s2 = await boot(stubFal(runs2), { FAL_KEY: '' });
  try { const r = await gen(s2.base); assert.equal(r.status, 503); assert.equal(runs2.length, 0); } finally { await s2.close(); }
});

test('fill fails closed (503, no call) when REMODEL_FILL_USD is unset, junk, or above 0.16', async () => {
  for (const v of [undefined, 'abc', '0', '-1', '0.17', '0.5', '5']) {
    const env = { REMODEL_REGION_ENGINE: 'fill' }; if (v !== undefined) env.REMODEL_FILL_USD = v;
    const runs = []; const s = await boot(stubFal(runs), env);
    try { const r = await gen(s.base, { counters: 'granite' }); assert.equal(r.status, 503, String(v)); assert.equal(runs.length, 0, String(v)); } finally { await s.close(); }
  }
  const runs = []; const s = await boot(stubFal(runs), { REMODEL_REGION_ENGINE: 'fill', REMODEL_FILL_USD: '0.16' });
  try { assert.equal((await gen(s.base, { counters: 'granite' })).status, 200); assert.equal(runs[0].url, 'https://fal.run/fal-ai/flux-pro/v1/fill'); } finally { await s.close(); }
});

test('regions OFF: engine and provider forced to kontext even with REMODEL_REGION_ENGINE=fill and a price', async () => {
  const runs = []; const s = await boot(stubFal(runs), { REMODEL_REGIONS: '0', REMODEL_REGION_ENGINE: 'fill', REMODEL_FILL_USD: '0.05' });
  try {
    const r = await gen(s.base);
    assert.equal(r.status, 200);
    assert.ok(runs.length >= 1 && runs.every((x) => x.url.startsWith('https://fal.run/fal-ai/flux-pro/kontext') && !('mask_url' in x.body)));
    assert.match(r.json.provider, /kontext/);
  } finally { await s.close(); }
});

test('fill engine refuses to run without a PNG mask (NO_MASK, no fetch)', async () => {
  const runs = []; const s = await boot(stubFal(runs), { REMODEL_REGION_ENGINE: 'fill', REMODEL_FILL_USD: '0.05' });
  await s.close();
  const e = require('../engines.cjs').ENGINES.fill;
  for (const m of [undefined, '', 'https://x/mask.png', 'data:image/jpeg;base64,AA']) {
    await assert.rejects(e.run({ prompt: 'p', mask_url: m }, 'data:image/png;base64,AA', { fetchImpl: stubFal(runs) }), (x) => x.code === 'NO_MASK');
  }
  assert.equal(runs.length, 0);
});

test('monthly dollar cap (D1, cents) counts every call: 0.12 cap allows one 3-call kontext render, refuses the next with no call', async () => {
  const runs = []; const s = await boot(stubFal(runs), { REMODEL_MONTHLY_USD_CAP: '0.12' });
  try {
    assert.equal((await gen(s.base)).status, 200); assert.equal(runs.length, 3);
    const r2 = await gen(s.base, { floor: 'oak' });
    assert.equal(r2.status, 429); assert.match(r2.json.error, /Monthly/); assert.equal(runs.length, 3);
  } finally { await s.close(); delete process.env.REMODEL_MONTHLY_USD_CAP; }
});

test('monthly dollar cap default is 10 USD; invalid or above 19 falls back to 10', () => {
  const { monthlyUsdCapCents } = require('../capStore.cjs');
  assert.equal(monthlyUsdCapCents({}), 1000);
  for (const v of ['abc', '0', '-5', '19.01', '500']) assert.equal(monthlyUsdCapCents({ REMODEL_MONTHLY_USD_CAP: v }), 1000, v);
  assert.equal(monthlyUsdCapCents({ REMODEL_MONTHLY_USD_CAP: '5' }), 500);
});

test('monthly dollar cap counts the fill price per call: 0.32 cap allows two 0.16 fill calls, third refused with no call', async () => {
  const runs = []; const s = await boot(stubFal(runs), { REMODEL_REGION_ENGINE: 'fill', REMODEL_FILL_USD: '0.16', REMODEL_MONTHLY_USD_CAP: '0.32' });
  try {
    assert.equal((await gen(s.base, { counters: 'granite' })).status, 200);
    assert.equal((await gen(s.base, { counters: 'granite' })).status, 200);
    const r = await gen(s.base, { counters: 'granite' });
    assert.equal(r.status, 429); assert.equal(runs.length, 2);
  } finally { await s.close(); delete process.env.REMODEL_MONTHLY_USD_CAP; }
});

test('API security headers: nosniff, no-referrer, CSP default-src none', async () => {
  const s = await boot(stubFal([]));
  try {
    const r = await fetch(s.base + '/api/remodel/tiers');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  } finally { await s.close(); }
});

test('fill engine with price set: sends a heuristic PNG mask sized to the photo, same retention headers', async () => {
  const runs = []; const s = await boot(stubFal(runs), { REMODEL_REGION_ENGINE: 'fill', REMODEL_FILL_USD: '0.05' });
  try {
    const r = await gen(s.base, { floor: 'oak', counters: 'granite' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(runs.length, 2);
    assert.ok(runs.every((x) => x.url === 'https://fal.run/fal-ai/flux-pro/v1/fill'));
    for (const x of runs) {
      assert.match(x.body.mask_url, /^data:image\/png;base64,/);
      const b = Buffer.from(x.body.mask_url.split(',')[1], 'base64');
      assert.equal(b.readUInt32BE(16), 1600); assert.equal(b.readUInt32BE(20), 900);
      assert.equal(x.headers['X-Fal-Store-IO'], '0');
    }
    assert.notEqual(runs[0].body.mask_url, runs[1].body.mask_url);
    assert.equal(r.json.provider, 'fal-ai/flux-pro/v1/fill');
  } finally { await s.close(); }
});

test('heuristic mask: valid PNG (CRC ok), white only inside the region band', () => {
  const { bandMask, crc32 } = require('../regionTargeting.cjs');
  const b = Buffer.from(bandMask(4, 10, [0.7, 1]).split(',')[1], 'base64');
  let i = 8; let idat;
  while (i < b.length) { const len = b.readUInt32BE(i); const type = b.toString('latin1', i + 4, i + 8);
    assert.equal(b.readUInt32BE(i + 8 + len), crc32(b.subarray(i + 4, i + 8 + len)), type);
    if (type === 'IDAT') idat = b.subarray(i + 8, i + 8 + len); i += 12 + len; }
  const raw = zlib.inflateSync(idat);
  const row = (y) => raw[y * 5 + 1];
  assert.equal(row(0), 0); assert.equal(row(6), 0); assert.equal(row(7), 255); assert.equal(row(9), 255);
  assert.throws(() => bandMask(0, 10, [0, 1])); assert.throws(() => bandMask(9000, 10, [0, 1]));
});

test('unknown engine id fails safe to kontext; engine interface is pluggable', () => {
  process.env.REMODEL_REGION_ENGINE = 'gemini';
  delete require.cache[require.resolve('../engines.cjs')]; delete require.cache[require.resolve('../remodelGenerate.cjs')];
  require('../remodelGenerate.cjs');
  const e = require('../engines.cjs');
  assert.equal(e.engineId(), 'kontext');
  e.register('gemini', { usesMask: false, available: () => true, model: () => 'mock', usdPerCall: () => 0.01, run: async () => ({ images: [{ url: 'x' }] }) });
  assert.equal(e.engineId(), 'gemini');
});
