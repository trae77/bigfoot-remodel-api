const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
process.env.REMODEL_TOKEN_SECRET = 'Tq7vR2mZp9Lk4Wx8Bn3Hc6Jd1Fs5Gy0Ae';
process.env.FAL_KEY = 'fake-fal';
const { createApp } = require('../remodelApi.cjs');
const fs = require('node:fs');

async function withServer(fn) {
  const server = http.createServer(createApp({ fetchImpl: async () => { throw new Error('no fal in tests'); } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

test('security headers on health', () => withServer(async (b) => {
  const r = await fetch(b + '/api/health');
  assert.match(r.headers.get('strict-transport-security'), /max-age=31536000/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
}));

test('unknown route returns JSON 404 with headers', () => withServer(async (b) => {
  const r = await fetch(b + '/nope/xyz');
  assert.equal(r.status, 404);
  assert.match(r.headers.get('content-type'), /application\/json/);
  assert.equal((await r.json()).error, 'Not found');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
}));

test('no price wording or cost fields in source responses', () => {
  for (const f of ['remodelGenerate.cjs', 'remodelApi.cjs']) {
    const s = fs.readFileSync(require.resolve('../' + f), 'utf8');
    assert.ok(!/estimatedCostUsd/.test(s), f + ' has estimatedCostUsd');
    assert.ok(!/['"`][^'"`]*\$\d/.test(s), f + ' has $ price wording in a string');
  }
});
