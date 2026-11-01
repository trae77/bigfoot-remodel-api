// R59 option A: REMODEL_TWO_PASS floor-first edit. fal is stubbed; no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const ORIGIN = 'https://bigfoot-preview.ttawebdev.com';
const PNG = (w, h) => { const b = Buffer.alloc(24); Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13,73,72,68,82]).copy(b); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return 'data:image/png;base64,' + b.toString('base64'); };
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const hdrs = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
const FINISHES = { floor: 'light oak', cabinets: 'white shaker', counters: 'white quartz', walls: 'soft gray' };

function stubFal(runs, { failPass = 0 } = {}) {
  return async (url, init = {}) => {
    url = String(url);
    if (url.startsWith('https://fal.run/')) {
      const n = runs.length + 1; runs.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      if (n === failPass) return { ok: false, status: 500, headers: hdrs({}), text: async () => '{"detail":"boom"}' };
      return { ok: true, status: 200, headers: hdrs({ 'x-fal-request-id': `req-pass-${n}` }), text: async () => JSON.stringify({ images: [{ url: `https://v3.fal.media/files/pass${n}.jpg` }] }) };
    }
    if (url.includes('fal.media')) return { ok: true, status: 200, headers: hdrs({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => JPG };
    throw new Error('unexpected ' + url);
  };
}
async function boot(fetchImpl, env = {}, appOpts = {}) {
  Object.assign(process.env, { REMODEL_TOKEN_SECRET: 'Tq7vR2mZp9Lk4Wx8Bn3Hc6Jd1Fs5Gy0Ae', FAL_KEY: 'fake-fal', FAL_STORE_IO: '0', REMODEL_TWO_PASS: '1' }, env);
  delete process.env.CORS_ORIGINS; delete process.env.REMODEL_FLOOR_GUIDANCE;
  if (!('REMODEL_FAL_MODEL' in env)) delete process.env.REMODEL_FAL_MODEL;
  for (const m of ['../remodelGenerate.cjs', '../remodelApi.cjs']) delete require.cache[require.resolve(m)];
  require('../remodelGenerate.cjs').sessionSpend.clear();
  const server = http.createServer(require('../remodelApi.cjs').createApp({ fetchImpl, ...appOpts }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
async function gen(base, finishes = FINISHES, img = PNG(1600, 900), token) {
  const t = token || (await (await fetch(base + '/api/remodel/token', { method: 'POST', headers: { Origin: ORIGIN } })).json()).token;
  const r = await fetch(base + '/api/remodel/generate', { method: 'POST', headers: { Origin: ORIGIN, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 1, room: 'kitchen', image_url: img, finishes }) });
  return { status: r.status, json: await r.json(), token: t };
}
test.afterEach(() => { for (const k of ['REMODEL_TWO_PASS', 'REMODEL_FAL_MODEL', 'REMODEL_PER_IP_DAILY', 'REMODEL_GLOBAL_DAILY', 'REMODEL_REQUESTS_PER_TOKEN']) delete process.env[k]; });

test('two calls: floor-only at 5.0 first, then the rest on pass 1 output; headers on both', async () => {
  const runs = []; const s = await boot(stubFal(runs));
  try {
    const g = await gen(s.base);
    assert.equal(g.status, 200, JSON.stringify(g.json));
    assert.equal(runs.length, 2);
    const [p1, p2] = runs;
    assert.equal(p1.body.guidance_scale, 5);
    assert.match(p1.body.prompt, /^Change only the floor\./);
    assert.ok(!/cabinet.*(white|shaker)|quartz|soft gray/i.test(p1.body.prompt), p1.body.prompt);
    assert.equal(p2.body.image_url, 'https://v3.fal.media/files/pass1.jpg', 'pass 2 edits pass 1 output');
    assert.equal(p2.body.guidance_scale, 3.5);
    assert.ok(!/oak|plank/i.test(p2.body.prompt), 'pass 2 does not re-ask for the floor');
    assert.match(p2.body.prompt, /the floor/);
    assert.match(p2.body.prompt, /^Edit this photo of a kitchen.\nChange these finishes:/);
    for (const r of runs) { assert.equal(r.headers['X-Fal-Store-IO'], '0'); assert.ok(r.headers['X-Fal-Object-Lifecycle-Preference']); }
    assert.ok(!JSON.stringify(g.json).includes('fal.media'));
  } finally { await s.close(); }
});

test('cap is checked for both calls before the first: no fal call when only 1 fits', async () => {
  const runs = []; const s = await boot(stubFal(runs), { REMODEL_FAL_MODEL: 'max', REMODEL_REQUESTS_PER_TOKEN: '10' });
  try {
    const a = await gen(s.base); assert.equal(a.status, 200); assert.equal(runs.length, 2); // $0.16 of $0.25 used
    const b = await gen(s.base, FINISHES, PNG(1600, 900), a.token);
    assert.equal(b.status, 429); assert.equal(runs.length, 2, 'no pass 1 when pass 2 would not fit');
  } finally { await s.close(); }
});

test('pass 1 fails -> no pass 2, error to client', async () => {
  const runs = []; const s = await boot(stubFal(runs, { failPass: 1 }));
  try {
    const g = await gen(s.base);
    assert.ok(g.status >= 500, String(g.status)); assert.equal(runs.length, 1);
  } finally { await s.close(); }
});

test('on by default, REMODEL_TWO_PASS=0 turns it off, and floor-only or no-floor requests stay single-call', async () => {
  const runs = []; const s = await boot(stubFal(runs), { REMODEL_TWO_PASS: '0' });
  try { assert.equal((await gen(s.base)).status, 200); assert.equal(runs.length, 1); } finally { await s.close(); }
  const { twoPassOn } = require('../remodelGenerate.cjs');
  for (const [v, want] of [[undefined, true], ['', true], ['1', true], ['0', false], ['false', false], ['OFF', false], ['no', false]]) {
    if (v === undefined) delete process.env.REMODEL_TWO_PASS; else process.env.REMODEL_TWO_PASS = v;
    assert.equal(twoPassOn(), want, String(v));
  }
  const { planCalls } = require('../remodelGenerate.cjs');
  process.env.REMODEL_TWO_PASS = '1';
  assert.equal(planCalls({ room: 'kitchen', prompt: 'p', finishes: { cabinets: 'white' } }).length, 1);
  const only = planCalls({ room: 'kitchen', prompt: 'p', finishes: { floor: 'light oak' } });
  assert.equal(only.length, 1); assert.equal(only[0].guidance_scale, 5);
  process.env.REMODEL_FLOOR_GUIDANCE = '7.5';
  assert.equal(planCalls({ room: 'kitchen', prompt: 'p', finishes: { floor: 'oak', walls: 'gray' } })[0].guidance_scale, 7.5);
  process.env.REMODEL_FLOOR_GUIDANCE = '50';
  assert.equal(planCalls({ room: 'kitchen', prompt: 'p', finishes: { floor: 'oak', walls: 'gray' } })[0].guidance_scale, 5);
  delete process.env.REMODEL_FLOOR_GUIDANCE;
});

test('inputs under 1024px on the long side log a warning (no upscaling)', () => {
  const { imageLongSide } = require('../remodelGenerate.cjs');
  assert.equal(imageLongSide(PNG(560, 315)), 560);
  assert.equal(imageLongSide(PNG(900, 1600)), 1600);
  const jpg = Buffer.from([0xff,0xd8, 0xff,0xe0,0,4,0,0, 0xff,0xc0,0,17,8, 0x01,0x3b, 0x02,0x30, 3]);
  assert.equal(imageLongSide('data:image/jpeg;base64,' + jpg.toString('base64')), 560);
  assert.equal(imageLongSide('data:image/jpeg;base64,AAAA'), null);
});

test('PUNCH P2: per-IP daily cap counts fal calls (two-pass = 2), checked before any call', async () => {
  const runs = []; const genCounter = require('../security.cjs').createDailyCounter();
  const s = await boot(stubFal(runs), { REMODEL_PER_IP_DAILY: '3', REMODEL_GLOBAL_DAILY: '100' }, { genCounter });
  try {
    assert.equal((await gen(s.base)).status, 200); assert.equal(runs.length, 2);
    assert.equal(genCounter.get('global'), 2);
    const b = await gen(s.base);
    assert.equal(b.status, 429, JSON.stringify(b.json)); assert.equal(runs.length, 2, 'no pass 1 when 2 slots do not fit');
    assert.equal(genCounter.get('global'), 2, 'a refused request reserves nothing');
    assert.equal((await gen(s.base, { cabinets: 'white shaker' })).status, 200, 'a 1-call generate still fits the last slot');
    assert.equal(runs.length, 3);
  } finally { await s.close(); }
});

test('PUNCH P2: global daily cap counts fal calls too', async () => {
  const runs = []; const genCounter = require('../security.cjs').createDailyCounter();
  const s = await boot(stubFal(runs), { REMODEL_PER_IP_DAILY: '100', REMODEL_GLOBAL_DAILY: '1' }, { genCounter });
  try {
    assert.equal((await gen(s.base)).status, 429); assert.equal(runs.length, 0); assert.equal(genCounter.get('global'), 0);
  } finally { await s.close(); }
});

test('PUNCH P3-1: REMODEL_FAL_MODEL=constructor/toString/__proto__ falls back to pro', () => {
  const g = require('../remodelGenerate.cjs');
  for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    process.env.REMODEL_FAL_MODEL = k; assert.equal(g.falModel().id, 'fal-ai/flux-pro/kontext', k); assert.equal(g.falModel().usd, 0.04);
  }
});

test('PUNCH P3-2: pass 2 throws -> pass 1 id still gets its retention and skip logs', async () => {
  const runs = []; const logs = []; const orig = console.info;
  console.info = (...a) => { logs.push(a.join(' ')); };
  const s = await boot(stubFal(runs, { failPass: 2 }));
  try {
    const g = await gen(s.base);
    assert.ok(g.status >= 500); assert.equal(runs.length, 2);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(logs.some((l) => l.startsWith('fal_run_retention') && l.includes('req-pass-1')), logs.join('\n'));
    assert.ok(logs.some((l) => l.startsWith('fal_payload_delete_skipped') && l.includes('req-pass-1')), logs.join('\n'));
    assert.ok(!logs.join('\n').includes('fal.media'), 'no URL in logs');
  } finally { console.info = orig; await s.close(); }
});

test('backsplash finish (free text) goes into pass 2 only', async () => {
  const runs = []; const s = await boot(stubFal(runs), { REMODEL_TWO_PASS: '' });
  try {
    const g = await gen(s.base, { floor: 'light oak', backsplash: 'white subway tile' });
    assert.equal(g.status, 200, JSON.stringify(g.json)); assert.equal(runs.length, 2);
    assert.ok(!/subway/.test(runs[0].body.prompt));
    assert.match(runs[1].body.prompt, /- Backsplash: white subway tile/);
  } finally { await s.close(); }
});

test('per-token allowance counts fal calls: a two-pass uses 2 of 3, the next two-pass is refused with no call', async () => {
  const runs = []; const s = await boot(stubFal(runs), { REMODEL_REQUESTS_PER_TOKEN: '3', REMODEL_PER_IP_DAILY: '100', REMODEL_GLOBAL_DAILY: '100' });
  try {
    const a = await gen(s.base); assert.equal(a.status, 200); assert.equal(runs.length, 2);
    const b = await gen(s.base, FINISHES, PNG(1600, 900), a.token);
    assert.equal(b.status, 401); assert.equal(runs.length, 2);
    const c = await gen(s.base, { cabinets: 'white shaker' }, PNG(1600, 900), a.token);
    assert.equal(c.status, 200, 'a 1-call generate still fits'); assert.equal(runs.length, 3);
  } finally { await s.close(); }
});

test('startup config line: resolved values, no secrets or URLs', () => {
  Object.assign(process.env, { FAL_KEY: 'sk-SECRET-fal', REMODEL_TOKEN_SECRET: 'Tq7vR2mZp9Lk4Wx8Bn3Hc6Jd1Fs5Gy0Ae', PUBLIC_API_ORIGIN: 'https://api.example.test', REMODEL_FAL_MODEL: 'max', REMODEL_GUIDANCE: '4', REMODEL_FLOOR_GUIDANCE: '6' });
  delete process.env.REMODEL_TWO_PASS; delete process.env.FAL_STORE_IO; delete process.env.FAL_MEDIA_EXPIRATION_SEC;
  const { resolvedConfig } = require('../remodelGenerate.cjs');
  const c = resolvedConfig();
  assert.deepEqual(c, { twoPass: true, model: 'fal-ai/flux-pro/kontext/max', guidance: 4, floorGuidance: 6, storeIo: '0', mediaTtlSec: 3600, publicApiOriginSet: true });
  const line = JSON.stringify(c);
  for (const bad of ['SECRET', 'Tq7vR2', 'example.test', 'Key ']) assert.ok(!line.includes(bad), bad);
  process.env.REMODEL_TWO_PASS = '0'; delete process.env.PUBLIC_API_ORIGIN; process.env.FAL_MEDIA_EXPIRATION_SEC = '0';
  assert.deepEqual([resolvedConfig().twoPass, resolvedConfig().publicApiOriginSet, resolvedConfig().mediaTtlSec], [false, false, null]);
  assert.match(require('node:fs').readFileSync(require.resolve('../remodelApi.cjs'), 'utf8'), /console\.log\('remodel_config', JSON\.stringify\(resolvedConfig\(\)\)\)/, 'logged once at startup');
  for (const k of ['PUBLIC_API_ORIGIN', 'REMODEL_GUIDANCE', 'REMODEL_FLOOR_GUIDANCE', 'FAL_MEDIA_EXPIRATION_SEC']) delete process.env[k];
});
