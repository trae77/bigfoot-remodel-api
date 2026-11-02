// Recipe (William via CEO 2026-11-02): Kontext pro two-pass, keep rugs/mats, hex paint, max only on hard photos, Fill dropped. Mocked fal only.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const ORIGIN = 'https://bigfoot-preview.ttawebdev.com';
const PNG = (w, h) => { const b = Buffer.alloc(24); Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13,73,72,68,82]).copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return 'data:image/png;base64,' + b.toString('base64'); };
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const hdrs = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
const ALL = { floor: 'light oak', cabinets: 'white shaker', counters: 'white quartz', walls: 'soft gray' };
const KEYS = ['REMODEL_MAX_ON_HARD', 'REMODEL_HARD_ENGINE', 'REMODEL_REGIONS', 'REMODEL_DECLUTTER', 'REMODEL_FAILOVER', 'REMODEL_QWEN_USD', 'REMODEL_RENDER_MAX_USD', 'REMODEL_REGION_ENGINE', 'REMODEL_FILL_ENABLE', 'REMODEL_FILL_USD', 'REMODEL_REQUESTS_PER_TOKEN', 'REMODEL_PER_IP_DAILY', 'REMODEL_GLOBAL_DAILY', 'REMODEL_MONTHLY_USD_CAP', 'REMODEL_TWO_PASS', 'REMODEL_FAL_MODEL', 'REMODEL_ROOM_PRESETS'];

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
async function gen(base, t, finishes = ALL, img = PNG(1600, 900), session, extra = {}) {
  const h = { Origin: ORIGIN, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' };
  if (session) h['X-Remodel-Session'] = session;
  const r = await fetch(base + '/api/remodel/generate', { method: 'POST', headers: h, body: JSON.stringify({ projectId: 1, room: "kitchen", image_url: img, finishes, ...extra }) });
  return { status: r.status, json: await r.json() };
}
test.afterEach(() => { for (const k of KEYS) delete process.env[k]; });
const usd = (s) => { const { month } = require('../capStore.cjs').periodKeys(); return s.capStore.peek(`m:${month}:usd_cents`); };
const TWO = { floor: 'light oak', cabinets: 'white shaker' };

test('default recipe: two-pass Kontext pro, 2 counted calls, 8 cents reserved', async () => {
  const runs = []; const s = await boot(stub(runs), {});
  try {
    const r = await gen(s.base, await token(s.base), TWO);
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(runs.length, 2);
    for (const x of runs) assert.equal(x.url, 'https://fal.run/fal-ai/flux-pro/kontext');
    assert.equal(usd(s), 8); assert.equal(s.capStore.get('global'), 2);
  } finally { await s.close(); }
});

test('hardPhoto: true routes both passes to Kontext max (only with MAX_ON_HARD=1 + HARD_ENGINE=kontext-max), 16 cents on the $ cap', async () => {
  const runs = []; const s = await boot(stub(runs), { REMODEL_MAX_ON_HARD: '1', REMODEL_HARD_ENGINE: 'kontext-max' });
  try {
    const r = await gen(s.base, await token(s.base), TWO, PNG(1600, 900), null, { hardPhoto: true });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(runs.length, 2);
    for (const x of runs) assert.equal(x.url, 'https://fal.run/fal-ai/flux-pro/kontext/max');
    assert.equal(usd(s), 16); assert.equal(s.capStore.get('global'), 2);
  } finally { await s.close(); }
});

test('hardPhoto max route obeys the ONE ceiling: 0.12 refuses a 2-pass max (0.16) with 400, nothing reserved, no call; pro still fits', async () => {
  const runs = []; const s = await boot(stub(runs), { REMODEL_RENDER_MAX_USD: '0.12', REMODEL_MAX_ON_HARD: '1', REMODEL_HARD_ENGINE: 'kontext-max' });
  try {
    const r = await gen(s.base, await token(s.base), TWO, PNG(1600, 900), null, { hardPhoto: true });
    assert.equal(r.status, 400); assert.equal(s.capStore.total(), 0); assert.equal(runs.length, 0);
    assert.equal((await gen(s.base, await token(s.base), TWO)).status, 200); assert.equal(runs.length, 2);
  } finally { await s.close(); }
});

test('hardPhoto max route respects the monthly $ cap: 0.10 cap refuses 16 cents, nothing reserved', async () => {
  const runs = []; const s = await boot(stub(runs), { REMODEL_MONTHLY_USD_CAP: '0.10', REMODEL_MAX_ON_HARD: '1', REMODEL_HARD_ENGINE: 'kontext-max' });
  try {
    const r = await gen(s.base, await token(s.base), TWO, PNG(1600, 900), null, { hardPhoto: true });
    assert.notEqual(r.status, 200); assert.equal(s.capStore.total(), 0); assert.equal(runs.length, 0);
  } finally { await s.close(); }
});

test('REMODEL_MAX_ON_HARD=0 keeps hard photos on pro; hardPhoto must be a strict boolean', async () => {
  const runs = []; const s = await boot(stub(runs), { REMODEL_MAX_ON_HARD: '0' });
  try {
    assert.equal((await gen(s.base, await token(s.base), TWO, PNG(1600, 900), null, { hardPhoto: true })).status, 200);
    for (const x of runs) assert.equal(x.url, 'https://fal.run/fal-ai/flux-pro/kontext');
    for (const bad of ['true', 1, {}]) {
      const r = await gen(s.base, await token(s.base), TWO, PNG(1600, 900), null, { hardPhoto: bad });
      assert.equal(r.status, 400);
    }
    assert.equal(runs.length, 2);
  } finally { await s.close(); }
});

test('kontext-max is never chosen by env (REMODEL_REGION_ENGINE=kontext-max stays pro)', async () => {
  const runs = []; const s = await boot(stub(runs), { REMODEL_REGIONS: '1', REMODEL_REGION_ENGINE: 'kontext-max' });
  try {
    assert.equal((await gen(s.base, await token(s.base), { cabinets: 'white shaker' })).status, 200);
    assert.deepEqual(runs.map((x) => x.url), ['https://fal.run/fal-ai/flux-pro/kontext']);
  } finally { await s.close(); }
});

test('Fill dropped: REMODEL_REGION_ENGINE=fill with a price but no REMODEL_FILL_ENABLE runs Kontext, never Fill', async () => {
  const runs = []; const s = await boot(stub(runs), { REMODEL_REGIONS: '1', REMODEL_REGION_ENGINE: 'fill', REMODEL_FILL_USD: '0.05' });
  try {
    assert.equal((await gen(s.base, await token(s.base), { cabinets: 'white shaker' })).status, 200);
    assert.ok(runs.length >= 1); assert.ok(!runs.some((x) => x.url.includes('fill')));
  } finally { await s.close(); }
});

test('keep rugs/mats in every prompt: legacy two-pass, regions and presets; floor guard no longer says "no rug"', () => {
  for (const k of KEYS) delete process.env[k];
  delete require.cache[require.resolve('../remodelGenerate.cjs')]; delete require.cache[require.resolve('../regionTargeting.cjs')];
  const g = require('../remodelGenerate.cjs'); const R = require('../regionTargeting.cjs');
  for (const c of g.planCalls({ room: 'kitchen', finishes: TWO })) assert.match(c.prompt, /rugs(,| and) mats/);
  for (const c of R.planRegions('kitchen', ALL)) assert.match(c.prompt, /rugs and mats/);
  for (const room of ['bathroom', 'living', 'bedroom']) for (const c of R.planPreset(room, { floor: 'gray tile', walls: 'white' })) assert.match(c.prompt, /rugs and mats/);
  assert.doesNotMatch(R.FLOOR_GUARD, /\bno rug/);
});

test('paintHex (old name for colorHex): matched to our generic color, repaints the walls with the hex; bad hex is 400 with no call', async () => {
  const runs = []; const s = await boot(stub(runs), {});
  try {
    const r = await gen(s.base, await token(s.base), { floor: 'light oak', walls: 'sage green' }, PNG(1600, 900), null, { paintHex: '#9caf88' });
    assert.equal(r.status, 200);
    assert.match(runs[1].body.prompt, /sage green, repaint the walls \(#9CAF88\), a muted matte paint/);
    assert.equal(r.json.meta.colorMatch, 'hex'); assert.equal(r.json.meta.colorHexUsed, '#9CAF88');
    for (const [f, h] of [[{ walls: 'sage' }, '9CAF88'], [{ walls: 'sage' }, '#9CAF8'], [{ walls: 'sage' }, '#GGGGGG'], [{ walls: 'sage' }, 123]]) {
      assert.equal((await gen(s.base, await token(s.base), f, PNG(1600, 900), null, { paintHex: h })).status, 400, JSON.stringify([f, h]));
    }
    assert.equal(runs.length, 2);
  } finally { await s.close(); }
});

test('worst-case prompts with hex + keep rugs/mats stay within 1200 chars per call', () => {
  for (const k of KEYS) delete process.env[k];
  const g = require('../remodelGenerate.cjs');
  const long = 'a'.repeat(90);
  const f = { floor: long, cabinets: long + ' shaker', counters: long, walls: long + ', paint color hex #9CAF88', backsplash: long };
  for (const c of g.planCalls({ room: 'kitchen', finishes: f })) assert.ok(c.prompt.length <= 1200, String(c.prompt.length));
});
