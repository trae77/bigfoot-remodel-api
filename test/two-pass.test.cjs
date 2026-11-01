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
async function boot(fetchImpl, env = {}) {
  Object.assign(process.env, { REMODEL_TOKEN_SECRET: 'Tq7vR2mZp9Lk4Wx8Bn3Hc6Jd1Fs5Gy0Ae', FAL_KEY: 'fake-fal', FAL_STORE_IO: '0', REMODEL_TWO_PASS: '1' }, env);
  delete process.env.CORS_ORIGINS; delete process.env.REMODEL_FLOOR_GUIDANCE;
  if (!('REMODEL_FAL_MODEL' in env)) delete process.env.REMODEL_FAL_MODEL;
  for (const m of ['../remodelGenerate.cjs', '../remodelApi.cjs']) delete require.cache[require.resolve(m)];
  require('../remodelGenerate.cjs').sessionSpend.clear();
  const server = http.createServer(require('../remodelApi.cjs').createApp({ fetchImpl }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
async function gen(base, finishes = FINISHES, img = PNG(1600, 900), token) {
  const t = token || (await (await fetch(base + '/api/remodel/token', { method: 'POST', headers: { Origin: ORIGIN } })).json()).token;
  const r = await fetch(base + '/api/remodel/generate', { method: 'POST', headers: { Origin: ORIGIN, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 1, room: 'kitchen', image_url: img, finishes }) });
  return { status: r.status, json: await r.json(), token: t };
}
test.afterEach(() => { delete process.env.REMODEL_TWO_PASS; delete process.env.REMODEL_FAL_MODEL; });

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
  const runs = []; const s = await boot(stubFal(runs), { REMODEL_FAL_MODEL: 'max' });
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

test('off by default, and floor-only or no-floor requests stay single-call', async () => {
  const runs = []; const s = await boot(stubFal(runs), { REMODEL_TWO_PASS: '' });
  try { assert.equal((await gen(s.base)).status, 200); assert.equal(runs.length, 1); } finally { await s.close(); }
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
