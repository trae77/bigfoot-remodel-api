// Durable caps: 120/month, 25/day global, per-IP daily. Fail closed. Fake fetch only: fal is never called.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const caps = require('../capStore.cjs');

const ORIGIN = 'https://bigfoot-preview.ttawebdev.com';
const SECRET = 'Tq7vR2mZp9Lk4Wx8Bn3Hc6Jd1Fs5Gy0Ae';
const PNG = 'data:image/png;base64,' + Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,13,73,72,68,82]).toString('base64');
const GEN = { projectId: 1, imageUrl: PNG };
const hdrs = (o) => ({ get: (k) => o[k.toLowerCase()] ?? null });
let runs = [];
const fakeFetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('https://v3.fal.media/')) return { ok: true, status: 200, headers: hdrs({ 'content-type': 'image/jpeg' }), arrayBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]) };
  if (u.startsWith('https://api.fal.ai/')) return { ok: true, status: 200, json: async () => ({}) };
  runs.push({ url: u, headers: init.headers });
  return { ok: true, status: 200, headers: hdrs({}), text: async () => JSON.stringify({ images: [{ url: 'https://v3.fal.media/files/x.jpg' }], seed: 1 }) };
};

async function start(capStore, env = {}) {
  for (const k of ['REMODEL_GLOBAL_MONTHLY', 'REMODEL_SERVICE_TOKEN', 'CORS_ORIGINS', 'FAL_STORE_IO', 'FAL_MEDIA_EXPIRATION_SEC', 'REMODEL_TWO_PASS']) delete process.env[k];
  Object.assign(process.env, { FAL_KEY: 'fake-fal', REMODEL_TOKEN_SECRET: SECRET, REMODEL_PER_IP_DAILY: '1000', REMODEL_GLOBAL_DAILY: '1000', REMODEL_TOKENS_PER_IP_DAILY: '100000', REMODEL_REQUESTS_PER_TOKEN: '1000', ...env });
  for (const m of ['../remodelGenerate.cjs', '../remodelApi.cjs', '../security.cjs']) delete require.cache[require.resolve(m)];
  require('../remodelGenerate.cjs').sessionSpend.clear();
  const server = http.createServer(require('../remodelApi.cjs').createApp({ fetchImpl: fakeFetch, capStore }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
async function gen(base, ip, body = GEN) {
  const h = { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-Forwarded-For': ip };
  const t = await (await fetch(base + '/api/remodel/token', { method: 'POST', headers: h, body: '{}' })).json();
  const r = await fetch(base + '/api/remodel/generate', { method: 'POST', headers: { ...h, Authorization: `Bearer ${t.token}` }, body: JSON.stringify(body) });
  return r.status;
}
const month = () => caps.periodKeys().month;

test('default monthly cap is 120 and env-configurable (server env only)', () => {
  delete process.env.REMODEL_GLOBAL_MONTHLY; delete require.cache[require.resolve('../security.cjs')];
  assert.equal(require('../security.cjs').getConfig().globalMonthly, 120);
  process.env.REMODEL_GLOBAL_MONTHLY = '7'; assert.equal(require('../security.cjs').getConfig().globalMonthly, 7);
  delete process.env.REMODEL_GLOBAL_MONTHLY;
});

test('120th call allowed, 121st rejected (429) with no fal call; client cannot override', async () => {
  const store = caps.createMemoryCapStore(new Map([[`m:${month()}:global`, 119]]));
  const s = await start(store);
  try {
    runs = [];
    assert.equal(await gen(s.base, '9.0.0.1'), 200);
    assert.equal(store.peek(`m:${month()}:global`), 120);
    const n = runs.length;
    assert.equal(await gen(s.base, '9.0.0.2', { ...GEN, globalMonthly: 9999, cap: 9999 }), 429);
    assert.equal(runs.length, n);
  } finally { await s.close(); }
});

test('25/day global: 25th allowed, 26th rejected; per-IP daily cap enforced', async () => {
  const s = await start(caps.createMemoryCapStore(), { REMODEL_GLOBAL_DAILY: '25', REMODEL_PER_IP_DAILY: '5' });
  try {
    for (let i = 0; i < 5; i++) assert.equal(await gen(s.base, '7.0.0.1'), 200);
    assert.equal(await gen(s.base, '7.0.0.1'), 429, '6th from one IP');
    for (let i = 0; i < 20; i++) assert.equal(await gen(s.base, `7.0.1.${i}`), 200);
    assert.equal(await gen(s.base, '7.0.2.1'), 429, '26th global');
  } finally { await s.close(); }
});

test('restart does not reset counts (new process, same store)', async () => {
  const backing = new Map();
  let s = await start(caps.createMemoryCapStore(backing), { REMODEL_GLOBAL_DAILY: '2' });
  try { assert.equal(await gen(s.base, '6.0.0.1'), 200); assert.equal(await gen(s.base, '6.0.0.2'), 200); } finally { await s.close(); }
  s = await start(caps.createMemoryCapStore(backing), { REMODEL_GLOBAL_DAILY: '2' });
  try { runs = []; assert.equal(await gen(s.base, '6.0.0.3'), 429); assert.equal(runs.length, 0); } finally { await s.close(); }
});

test('D1 store: restart (new store object, same DB) keeps counts', async () => {
  const db = new Map();
  const d1 = d1Fake(db);
  const mk = () => caps.createD1CapStore({ accountId: 'a'.repeat(32), databaseId: '11111111-2222-3333-4444-555555555555', token: 'x'.repeat(40), fetchImpl: d1 });
  assert.equal(await mk().reserve('k', 1, 2), true);
  assert.equal(await mk().reserve('k', 1, 2), true);
  assert.equal(await mk().reserve('k', 1, 2), false);
});

test('month and day rollover reset (UTC)', async () => {
  assert.deepEqual(caps.periodKeys(Date.parse('2026-10-31T23:59:59Z')), { day: '2026-10-31', month: '2026-10' });
  assert.deepEqual(caps.periodKeys(Date.parse('2026-11-01T00:00:00Z')), { day: '2026-11-01', month: '2026-11' });
  const store = caps.createMemoryCapStore(new Map([['m:2000-01:global', 120], ['d:2000-01-01:global', 25]]));
  const s = await start(store);
  try { assert.equal(await gen(s.base, '5.0.0.1'), 200, 'old-period counts do not apply'); } finally { await s.close(); }
});

test('store down / timeout / garbage / unconfigured -> 503, no fal call', async () => {
  const cfg = { accountId: 'a'.repeat(32), databaseId: '11111111-2222-3333-4444-555555555555', token: 'x'.repeat(40) };
  const stores = [
    caps.createD1CapStore({ ...cfg, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }),
    caps.createD1CapStore({ ...cfg, timeoutMs: 50, fetchImpl: (_u, i) => new Promise((_r, rej) => i.signal.addEventListener('abort', () => rej(new Error('aborted')))) }),
    caps.createD1CapStore({ ...cfg, fetchImpl: async () => ({ ok: true, json: async () => ({ success: true, result: [{ success: true, results: [{ n: 'lots' }] }] }) }) }),
    caps.createD1CapStore({ ...cfg, fetchImpl: async () => ({ ok: true, json: async () => '<html>' }) }),
    caps.createD1CapStore({ ...cfg, fetchImpl: async () => ({ ok: false, json: async () => ({ success: false }) }) }),
    caps.createD1CapStore({ fetchImpl: fakeFetch }),
    caps.capStoreFromEnv({}),
  ];
  for (const st of stores) {
    const s = await start(st);
    try { runs = []; assert.equal(await gen(s.base, '4.0.0.1'), 503); assert.equal(runs.length, 0); } finally { await s.close(); }
  }
});

test('partial failure releases earlier reservations (all-or-nothing)', async () => {
  const store = caps.createMemoryCapStore();
  const r = await caps.reserveAll(store, [['a', 10, 'month'], ['b', 0, 'day']], 1);
  assert.deepEqual(r, { ok: false, which: 'day' });
  assert.equal(store.peek('a'), 0);
});

test('concurrency: 60 parallel requests never overshoot 25/day (D1 atomic SQL)', async () => {
  const d1 = d1Fake(new Map(), true);
  const store = caps.createD1CapStore({ accountId: 'a'.repeat(32), databaseId: '11111111-2222-3333-4444-555555555555', token: 'x'.repeat(40), fetchImpl: d1 });
  const s = await start(store, { REMODEL_GLOBAL_DAILY: '25' });
  try {
    runs = [];
    const st = await Promise.all(Array.from({ length: 60 }, (_, i) => gen(s.base, `3.0.${i >> 4}.${i}`)));
    assert.equal(st.filter((x) => x === 200).length, 25);
    assert.equal(runs.length, 25);
  } finally { await s.close(); }
});

test('EVERY fal call sends X-Fal-Store-IO: 0 and media expiry 3600 (single and two-pass)', async () => {
  for (const tp of ['0', '1']) {
    const s = await start(caps.createMemoryCapStore(), { REMODEL_TWO_PASS: tp });
    try {
      runs = [];
      assert.equal(await gen(s.base, '2.0.0.1', { ...GEN, finishes: { floor: 'light oak', cabinets: 'white shaker', counters: 'white quartz' } }), 200);
      assert.ok(runs.length >= 1);
      for (const r of runs) {
        assert.ok(r.url.startsWith('https://fal.run/'));
        assert.equal(r.headers['X-Fal-Store-IO'], '0');
        assert.deepEqual(JSON.parse(r.headers['X-Fal-Object-Lifecycle-Preference']), { expiration_duration_seconds: 3600 });
      }
      if (tp === '1') assert.equal(runs.length, 2, 'two-pass makes 2 calls, both checked');
    } finally { await s.close(); }
  }
});

/** Emulates D1's REST /query for RESERVE_SQL/RELEASE_SQL with SQLite's atomic single-statement semantics. */
function d1Fake(db, jitter = false) {
  return async (url, init) => {
    assert.match(url, /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[a-f0-9]{32}\/d1\/database\/[0-9a-f-]{36}\/query$/);
    assert.match(init.headers.Authorization, /^Bearer /);
    const { sql, params } = JSON.parse(init.body);
    if (jitter) await new Promise((r) => setTimeout(r, Math.random() * 5));
    let results = [];
    if (sql === caps.RESERVE_SQL) {
      const [k, n, lim] = params; const cur = db.get(k);
      if (cur === undefined ? n <= lim : cur + n <= lim) { db.set(k, (cur || 0) + n); results = [{ n: db.get(k) }]; }
    } else if (sql.startsWith('UPDATE remodel_caps')) {
      const [k, n] = params; db.set(k, Math.max((db.get(k) || 0) - n, 0));
    }
    return { ok: true, json: async () => ({ success: true, result: [{ success: true, results }] }) };
  };
}

test('RESERVE_SQL is atomic-correct on real SQLite (D1 engine): fills to limit, rejects over, never inserts over', (t) => {
  let DatabaseSync; try { ({ DatabaseSync } = require('node:sqlite')); } catch { return t.skip('node:sqlite unavailable'); }
  const d = new DatabaseSync(':memory:'); d.exec(caps.SCHEMA_SQL);
  const r = (k, n, l) => d.prepare(caps.RESERVE_SQL).all(k, n, l).map((x) => x.n);
  assert.deepEqual(r('k', 1, 2), [1]); assert.deepEqual(r('k', 1, 2), [2]); assert.deepEqual(r('k', 1, 2), []);
  assert.deepEqual(r('z', 3, 2), []); assert.equal(d.prepare('SELECT COUNT(*) c FROM remodel_caps WHERE k = ?').get('z').c, 0);
});
