'use strict';
/**
 * Alternate image engine: Gemini "Nano Banana 2 Lite" (gemini-3.1-flash-lite-image), Gemini API generateContent (REST).
 * OFF by default: used only when REMODEL_ENGINE=gemini. fal stays primary. Unknown values fall back to fal with a warn log.
 * Key: env GEMINI_API_KEY only, sent in the x-goog-api-key header (never in the URL), never logged.
 * PAID TIER ONLY: the Gemini free tier may use inputs/outputs to improve Google products. The paid tier does not,
 * but Google keeps prompts/outputs ~55 days for abuse monitoring (no zero-retention on the developer API).
 * We strip EXIF/XMP/text metadata before sending and keep nothing beyond the existing short-TTL private image store.
 */

const GEMINI_MODEL = 'gemini-3.1-flash-lite-image';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_USD_PER_CALL = 0.0336; // per 1K image, Gemini API pricing page (2026-10-30). Used for the session budget only.
const TIMEOUT_MS = 60000;
const ENGINES = new Set(['fal', 'gemini']);

function engine(env = process.env) {
  const raw = (env.REMODEL_ENGINE || '').trim().toLowerCase();
  if (raw === '' ) return 'fal';
  if (ENGINES.has(raw)) return raw;
  console.warn('remodel_engine_unknown', JSON.stringify({ fallback: 'fal' }));
  return 'fal';
}

function getGeminiKey() { return (process.env.GEMINI_API_KEY || '').trim(); }

class GeminiError extends Error { constructor(code) { super('Image service failed'); this.code = code; } }

/** Remove EXIF/XMP/IPTC/comments. JPEG: drop APP1-APP15 + COM. PNG: drop eXIf/tEXt/iTXt/zTXt/tIME. WebP: drop EXIF/XMP chunks. */
function stripMetadata(buf, type) {
  if (type === 'image/jpeg') {
    if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new GeminiError('BAD_IMAGE');
    const out = [buf.subarray(0, 2)];
    let i = 2;
    while (i + 4 <= buf.length) {
      if (buf[i] !== 0xff) throw new GeminiError('BAD_IMAGE');
      const m = buf[i + 1];
      if (m === 0xda) { out.push(buf.subarray(i)); return Buffer.concat(out); } // start of scan: rest is image data
      const len = buf.readUInt16BE(i + 2);
      const seg = buf.subarray(i, i + 2 + len);
      if (!((m >= 0xe1 && m <= 0xef) || m === 0xfe)) out.push(seg);
      i += 2 + len;
    }
    return Buffer.concat(out);
  }
  if (type === 'image/png') {
    const out = [buf.subarray(0, 8)];
    let i = 8;
    while (i + 12 <= buf.length) {
      const len = buf.readUInt32BE(i);
      const t = buf.toString('latin1', i + 4, i + 8);
      const end = i + 12 + len;
      if (!['eXIf', 'tEXt', 'iTXt', 'zTXt', 'tIME'].includes(t)) out.push(buf.subarray(i, end));
      i = end;
    }
    return Buffer.concat(out);
  }
  if (type === 'image/webp') {
    if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') throw new GeminiError('BAD_IMAGE');
    const out = [];
    let i = 12;
    while (i + 8 <= buf.length) {
      const t = buf.toString('latin1', i, i + 4);
      const len = buf.readUInt32LE(i + 4);
      const end = i + 8 + len + (len & 1);
      if (t !== 'EXIF' && t !== 'XMP ') out.push(buf.subarray(i, end));
      i = end;
    }
    const body = Buffer.concat(out);
    const hdr = Buffer.alloc(12); hdr.write('RIFF', 0, 'latin1'); hdr.writeUInt32LE(body.length + 4, 4); hdr.write('WEBP', 8, 'latin1');
    // Clear VP8X EXIF/XMP flags if present.
    if (body.toString('latin1', 0, 4) === 'VP8X') body[8] &= ~0x0c;
    return Buffer.concat([hdr, body]);
  }
  throw new GeminiError('BAD_IMAGE');
}

function parseDataUri(uri) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.*)$/s.exec(uri || '');
  if (!m) throw new GeminiError('BAD_IMAGE');
  return { type: m[1], buf: Buffer.from(m[2], 'base64') };
}

/**
 * One Gemini edit. input: { prompt, image: {type, buf} }. Returns { type, buf } (metadata-free image bytes).
 * Throws GeminiError with code MISSING_KEY | GEMINI_UPSTREAM | GEMINI_BAD_REPLY | GEMINI_TIMEOUT | BAD_IMAGE. Messages never carry the key.
 */
async function callGemini({ prompt, image }, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const key = getGeminiKey();
  if (!key) throw new GeminiError('MISSING_KEY');
  const clean = stripMetadata(image.buf, image.type);
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  let res, data;
  try {
    res = await fetchImpl(GEMINI_URL, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: image.type, data: clean.toString('base64') } }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { imageSize: '1K' } },
      }),
      signal: ac.signal,
    });
    data = await res.json();
  } catch (_e) {
    throw new GeminiError(ac.signal.aborted ? 'GEMINI_TIMEOUT' : 'GEMINI_UPSTREAM');
  } finally {
    clearTimeout(t);
  }
  if (!res || !res.ok) {
    console.warn('gemini_upstream_error', JSON.stringify({ status: res ? res.status : null }));
    throw new GeminiError('GEMINI_UPSTREAM');
  }
  const parts = data && Array.isArray(data.candidates) && data.candidates[0] && data.candidates[0].content && Array.isArray(data.candidates[0].content.parts)
    ? data.candidates[0].content.parts : null;
  const img = parts && parts.map((p) => p && (p.inlineData || p.inline_data)).find((d) => d && typeof d.data === 'string');
  const mime = img && (img.mimeType || img.mime_type);
  if (!img || !/^image\/(jpeg|png|webp)$/.test(mime || '')) throw new GeminiError('GEMINI_BAD_REPLY');
  const buf = Buffer.from(img.data, 'base64');
  if (buf.length < 8 || buf.length > 15 * 1024 * 1024) throw new GeminiError('GEMINI_BAD_REPLY');
  let out;
  try { out = stripMetadata(buf, mime); } catch { throw new GeminiError('GEMINI_BAD_REPLY'); }
  return { type: mime, buf: out };
}

module.exports = { GEMINI_MODEL, GEMINI_URL, GEMINI_USD_PER_CALL, engine, getGeminiKey, stripMetadata, parseDataUri, callGemini, GeminiError };
