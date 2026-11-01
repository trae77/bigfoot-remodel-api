const test = require('node:test');
const assert = require('node:assert/strict');
const { deleteFalPayload } = require('../imageStore.cjs');
const RID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const resp = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('200 with all files deleted -> ok', async () => {
  const r = await deleteFalPayload(RID, 'k', resp(200, { cdn_delete_results: [{ link: 'x', exception: null }] }));
  assert.deepEqual(r, { ok: true, status: 200, failed: 0, total: 1 });
});
test('200 with a per-file exception -> not ok, counted', async () => {
  const r = await deleteFalPayload(RID, 'k', resp(200, { cdn_delete_results: [{ link: 'a', exception: null }, { link: 'b', exception: 'denied' }] }));
  assert.equal(r.ok, false); assert.equal(r.failed, 1); assert.equal(r.total, 2);
});
test('200 without cdn_delete_results -> not ok', async () => {
  const r = await deleteFalPayload(RID, 'k', resp(200, {}));
  assert.equal(r.ok, false); assert.equal(r.reason, 'no-results');
});
test('403 (key lacks models:requests:write/assets:write) -> not ok', async () => {
  const r = await deleteFalPayload(RID, 'k', resp(403, { error: { type: 'authorization_error' } }));
  assert.deepEqual(r, { ok: false, status: 403 });
});
test('network error -> not ok, reason network', async () => {
  const r = await deleteFalPayload(RID, 'k', async () => { throw new Error('ECONNRESET'); });
  assert.deepEqual(r, { ok: false, reason: 'network' });
});
test('missing / malformed request id -> no call, not ok', async () => {
  let called = false; const f = async () => { called = true; };
  assert.deepEqual(await deleteFalPayload(null, 'k', f), { ok: false, reason: 'no-request-id' });
  assert.deepEqual(await deleteFalPayload('../x', 'k', f), { ok: false, reason: 'no-request-id' });
  assert.equal(called, false);
});
test('calls documented endpoint with DELETE + Idempotency-Key', async () => {
  let seen; await deleteFalPayload(RID, 'k', async (u, i) => { seen = { u, i }; return { ok: true, status: 200, json: async () => ({ cdn_delete_results: [] }) }; });
  assert.equal(seen.u, `https://api.fal.ai/v1/models/requests/${RID}/payloads`);
  assert.equal(seen.i.method, 'DELETE'); assert.equal(seen.i.headers['Idempotency-Key'], RID);
});
