/**
 * Private render storage at $0: in-process memory on the Render free instance (no disk, no third-party bucket).
 * - Images never leave this process except through a short-lived HMAC-signed URL (default 15 min).
 * - Retention: entries are deleted at their TTL (default 15 min, hard max 7 days) by a sweep, and are
 *   also lost whenever the free instance sleeps or restarts (fail-safe: nothing persists).
 * - Bounded: max entries and max total bytes; oldest evicted first.
 * The signed URL carries only a random id, an expiry and a signature. No IP, email, project or prompt.
 */
const crypto = require('node:crypto');

const MAX_RETENTION_MS = 7 * 24 * 3600 * 1000;
const URL_TTL_SEC_MAX = 15 * 60;

function createImageStore({ retentionMs = 15 * 60 * 1000, maxEntries = 50, maxBytes = 60 * 1024 * 1024, now = () => Date.now() } = {}) {
  const ttl = Math.min(Math.max(1000, retentionMs), MAX_RETENTION_MS);
  const map = new Map(); // id -> { buf, type, expiresAt }
  let total = 0;
  function del(id) { const e = map.get(id); if (e) { total -= e.buf.length; map.delete(id); } }
  function sweep() { const t = now(); for (const [id, e] of map) if (e.expiresAt <= t) del(id); }
  function put(buf, type) {
    sweep();
    const id = crypto.randomBytes(18).toString('base64url');
    while (map.size >= maxEntries || (map.size && total + buf.length > maxBytes)) del(map.keys().next().value);
    map.set(id, { buf, type, expiresAt: now() + ttl });
    total += buf.length;
    return id;
  }
  function get(id) { sweep(); return map.get(id) || null; }
  return { put, get, delete: del, sweep, size: () => map.size, retentionMs: ttl };
}

function signImage(secret, id, exp) {
  return crypto.createHmac('sha256', secret).update('img:' + id + ':' + exp).digest('base64url');
}

function signedImagePath(secret, id, { ttlSec = URL_TTL_SEC_MAX, now = Date.now() } = {}) {
  const exp = Math.floor(now / 1000) + Math.min(ttlSec, URL_TTL_SEC_MAX);
  return `/api/remodel/image/${id}?exp=${exp}&sig=${signImage(secret, id, exp)}`;
}

function verifyImageSig(secret, id, exp, sig, now = Date.now()) {
  const e = Number(exp);
  if (!secret || !/^[A-Za-z0-9_-]{16,64}$/.test(String(id)) || !Number.isInteger(e) || typeof sig !== 'string') return false;
  if (e * 1000 <= now || e * 1000 > now + URL_TTL_SEC_MAX * 1000 + 5000) return false;
  const a = Buffer.from(signImage(secret, id, e)); const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const FAL_HOST_RE = /^(?:[a-z0-9-]+\.)*fal\.media$/;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const MAGIC = {
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};
function magicMatches(type, buf) { return Boolean(MAGIC[type] && MAGIC[type](buf)); }

/** Read a fetch body as a stream, aborting as soon as it passes max bytes. */
async function readCapped(r, max) {
  const tooBig = () => Object.assign(new Error('fal image size not allowed'), { code: 'FAL_FETCH' });
  if (r.body && typeof r.body.getReader === 'function') {
    const reader = r.body.getReader(); const chunks = []; let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > max) { try { await reader.cancel(); } catch {} throw tooBig(); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, n);
  }
  const buf = Buffer.from(await r.arrayBuffer()); // fallback for non-stream mocks
  if (buf.length > max) throw tooBig();
  return buf;
}

/** Download fal output bytes server-side. Only https fal.media hosts; bounded size; image types only. */
async function fetchFalImage(url, fetchImpl) {
  let u; try { u = new URL(url); } catch { throw Object.assign(new Error('bad fal url'), { code: 'FAL_FETCH' }); }
  if (u.protocol !== 'https:' || !FAL_HOST_RE.test(u.hostname)) throw Object.assign(new Error('fal url host not allowed'), { code: 'FAL_FETCH' });
  const r = await fetchImpl(u.toString(), { method: 'GET', redirect: 'error' });
  if (!r.ok) throw Object.assign(new Error('fal image fetch failed'), { code: 'FAL_FETCH' });
  const type = String((r.headers && r.headers.get && r.headers.get('content-type')) || '').split(';')[0].trim();
  if (!TYPES.has(type)) throw Object.assign(new Error('fal image type not allowed'), { code: 'FAL_FETCH' });
  const len = Number(r.headers && r.headers.get && r.headers.get('content-length'));
  if (Number.isFinite(len) && len > MAX_IMAGE_BYTES) throw Object.assign(new Error('fal image size not allowed'), { code: 'FAL_FETCH' });
  const buf = await readCapped(r, MAX_IMAGE_BYTES);
  if (!buf.length) throw Object.assign(new Error('fal image size not allowed'), { code: 'FAL_FETCH' });
  if (!magicMatches(type, buf)) throw Object.assign(new Error('fal image bytes do not match type'), { code: 'FAL_FETCH' });
  return { buf, type };
}

/** Best-effort delete of fal's stored payload + output CDN files. Needs a fal key with models:requests:write + assets:write. */
async function deleteFalPayload(requestId, key, fetchImpl) {
  if (!requestId || !/^[0-9a-f-]{36}$/i.test(requestId)) return { ok: false, reason: 'no-request-id' };
  try {
    const r = await fetchImpl(`https://api.fal.ai/v1/models/requests/${requestId}/payloads`, {
      method: 'DELETE', headers: { Authorization: `Key ${key}`, 'Idempotency-Key': requestId },
    });
    return { ok: r.ok, status: r.status };
  } catch { return { ok: false, reason: 'network' }; }
}

module.exports = { magicMatches, readCapped, MAX_IMAGE_BYTES, createImageStore, signedImagePath, verifyImageSig, fetchFalImage, deleteFalPayload, URL_TTL_SEC_MAX, MAX_RETENTION_MS, FAL_HOST_RE };
