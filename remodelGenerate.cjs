/**
 * Live fal FLUX.1 Kontext [pro] generate path for Big Foot remodelizer.
 * Contract: docs/fal-kontext-contract-2026-10-24.md (mirror: offline-ai/docs/bigfoot-remodel-fal-contract-2026-10-24.md)
 * Authorized William t1097u — preview only. Never log FAL_KEY.
 */

const FAL_MODEL = 'fal-ai/flux-pro/kontext';
const FAL_RUN_URL = `https://fal.run/${FAL_MODEL}`;
const COST_PER_STILL_USD = 0.04;
const MAX_GENERATES_PER_SESSION = 5;
const MAX_SESSION_SPEND_USD = 0.25;
const HONESTY = 'AI preview — not a final design · not a bid';

/** @type {Map<string, { count: number; spendUsd: number; updatedAt: number }>} */
const sessionSpend = new Map();

/** One env var, FAL_KEY, set as a Render secret. The old split/base64 variants are gone. */
function getFalKey() {
  const key = (process.env.FAL_KEY || '').trim();
  return key;
}

const MAX_PROMPT_CHARS = 1000;
const MAX_FINISH_CHARS = 100;
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
// Must match ROOM_ORDER in the Big Foot page (src/remodelOptions.ts).
const ROOMS = new Set(['kitchen', 'bathroom', 'basement', 'deck', 'whole', 'laundry']);
const FINISH_KEYS = ['floor', 'cabinets', 'counters', 'walls'];
// Plain finish words only: letters, digits, space and a few joiners. No newlines or prompt syntax.
const FINISH_RE = /^[A-Za-z0-9 ,.:'&/()+-]+$/;

const MAGIC = {
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};

/** Accept only data:image/(jpeg|png|webp);base64 whose bytes match the declared type. URLs of any kind are refused. */
function validateImage(raw) {
  if (typeof raw !== 'string') return { error: 'imageUrl must be a data:image/jpeg, png or webp URI' };
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw.trim());
  if (!m) return { error: 'imageUrl must be a data:image/jpeg, png or webp URI' };
  if (m[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return { error: 'Image is too large', status: 413 };
  const bytes = Buffer.from(m[2], 'base64');
  if (!MAGIC[m[1]](bytes)) return { error: 'Image content does not match its type' };
  return { image_url: `data:${m[1]};base64,${m[2]}` };
}

/** Validate the whole body before anything is counted or sent. Returns { error, status } or the clean fields. */
function validateGenerateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'JSON object body required' };
  if (body.hasPeople || body.has_people) {
    return { error: 'Please use a room photo without people or faces for the AI preview.' };
  }
  const projectId = Number(body.projectId ?? body.project_id);
  if (!Number.isInteger(projectId) || projectId <= 0) return { error: 'projectId is required' };
  const roomIn = body.room ?? body.roomType ?? 'kitchen';
  if (typeof roomIn !== 'string') return { error: 'room must be a string' };
  const room = roomIn.trim().toLowerCase();
  if (!ROOMS.has(room)) return { error: 'Unknown room type' };
  const fIn = body.finishes ?? {};
  if (!fIn || typeof fIn !== 'object' || Array.isArray(fIn)) return { error: 'finishes must be an object' };
  for (const k of Object.keys(fIn)) if (!FINISH_KEYS.includes(k)) return { error: 'Unknown finish field' };
  const finishes = {};
  for (const k of FINISH_KEYS) {
    const v = fIn[k];
    if (v == null || v === '') { finishes[k] = null; continue; }
    if (typeof v !== 'string') return { error: `finishes.${k} must be a string` };
    const t = v.trim();
    if (t.length > MAX_FINISH_CHARS || !FINISH_RE.test(t)) return { error: `finishes.${k} is not a valid finish` };
    finishes[k] = t;
  }
  const img = validateImage(body.imageUrl ?? body.image_url);
  if (img.error) return img;
  const prompt = buildPrompt(room, finishes);
  if (prompt.length > MAX_PROMPT_CHARS) return { error: 'Prompt too long' };
  return { projectId, room, finishes, image_url: img.image_url, prompt };
}

function buildPrompt(room, finishes) {
  const f = finishes && typeof finishes === 'object' ? finishes : {};
  const line = (v) => {
    if (v == null || v === '') return 'unchanged';
    return String(v);
  };
  return [
    'Photoreal remodel preview of this exact room. Keep walls, windows, camera angle, and fixture layout identical. Keep cabinet layout and appliance footprints. Do not add people, text overlays, or new furniture. Do not change room dimensions.',
    '',
    `Room type: ${room || 'kitchen'}.`,
    'Change only these finishes:',
    `- Floor: ${line(f.floor)}`,
    `- Cabinet faces: ${line(f.cabinets)}`,
    `- Countertops: ${line(f.counters)}`,
    `- Wall paint/tile: ${line(f.walls)}`,
    '',
    'Output a single photoreal still suitable as an AI preview.',
  ].join('\n');
}

function sessionKeyFromReq(req) {
  const hdr = (req.headers['x-remodel-session'] || '').toString().trim();
  if (hdr && hdr.length <= 128) return `hdr:${hdr}`;
  const auth = (req.headers.authorization || '').toString();
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token) {
      // Hash-ish truncation so we never store full bearer in logs elsewhere
      const crypto = require('crypto');
      return `tok:${crypto.createHash('sha256').update(token).digest('hex').slice(0, 32)}`;
    }
  }
  return `ip:${req.remodelIp || req.socket?.remoteAddress || 'anon'}`;
}

function getSessionBudget(key) {
  let row = sessionSpend.get(key);
  if (!row) {
    row = { count: 0, spendUsd: 0, updatedAt: Date.now() };
    sessionSpend.set(key, row);
  }
  return row;
}

function remainingGenerates(row) {
  const byCount = MAX_GENERATES_PER_SESSION - row.count;
  const bySpend = Math.floor((MAX_SESSION_SPEND_USD - row.spendUsd) / COST_PER_STILL_USD + 1e-9);
  return Math.max(0, Math.min(byCount, bySpend));
}

/**
 * Call fal.run with the contract input shape (same fields as fal.subscribe input).
 * @param {{ prompt: string, image_url: string }} input
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
async function callFalKontext(input, opts = {}) {
  const key = getFalKey();
  if (!key) {
    const err = new Error('FAL_KEY is not configured');
    err.code = 'MISSING_KEY';
    throw err;
  }
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    const err = new Error('fetch is not available');
    err.code = 'NO_FETCH';
    throw err;
  }
  const body = {
    prompt: input.prompt,
    image_url: input.image_url,
    guidance_scale: 3.5,
    num_images: 1,
    output_format: 'jpeg',
    safety_tolerance: '2',
  };
  const res = await fetchImpl(FAL_RUN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Key ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error((data && (data.detail || data.error || data.message)) || `fal upstream ${res.status}`);
    err.code = 'FAL_UPSTREAM';
    err.status = res.status >= 400 && res.status < 500 ? 502 : 502;
    err.falStatus = res.status;
    throw err;
  }
  return data;
}

/**
 * Express handler factory.
 * @param {{ getClientFromToken: Function, ownerTokens: Set, fetchImpl?: typeof fetch }} deps
 */
function createRemodelGenerateHandler(deps) {
  return async function remodelGenerate(req, res) {
    try {
      const client = await deps.getClientFromToken(req);
      const auth = (req.headers.authorization || '').toString();
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const isOwner = Boolean(token && deps.ownerTokens && deps.ownerTokens.has(token));
      if (!client && !isOwner) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (!getFalKey()) {
        return res.status(503).json({
          error: 'Remodel generate is not configured (missing FAL_KEY)',
          honesty: HONESTY,
        });
      }

      const v = req.remodelValid || validateGenerateBody(req.body);
      if (v.error) return res.status(v.status || 400).json({ error: v.error, honesty: HONESTY });
      const { projectId, prompt, image_url } = v;

      const sessionKey = sessionKeyFromReq(req);
      const budget = getSessionBudget(sessionKey);
      const remaining = remainingGenerates(budget);
      if (remaining <= 0) {
        return res.status(429).json({
          error: 'Session generate cap reached (max 5 stills or ~$0.25). Start a new browser session or try later.',
          remainingSessionGenerates: 0,
          estimatedCostUsd: COST_PER_STILL_USD,
          honesty: HONESTY,
        });
      }

      const data = await callFalKontext({ prompt, image_url }, { fetchImpl: deps.fetchImpl });
      const afterImageUrl = data?.images?.[0]?.url;
      if (!afterImageUrl) {
        return res.status(502).json({ error: 'fal returned no image URL', honesty: HONESTY });
      }

      budget.count += 1;
      budget.spendUsd += COST_PER_STILL_USD;
      budget.updatedAt = Date.now();
      sessionSpend.set(sessionKey, budget);

      return res.status(200).json({
        afterImageUrl,
        estimatedCostUsd: COST_PER_STILL_USD,
        remainingSessionGenerates: remainingGenerates(budget),
        honesty: HONESTY,
        provider: FAL_MODEL,
        seed: data.seed ?? null,
        projectId,
      });
    } catch (e) {
      if (e && e.code === 'MISSING_KEY') {
        return res.status(503).json({ error: 'Remodel generate is not configured (missing FAL_KEY)', honesty: HONESTY });
      }
      if (e && e.code === 'FAL_UPSTREAM') {
        return res.status(502).json({ error: 'Image service failed — try again later', honesty: HONESTY });
      }
      console.error('remodel/generate error', e && e.message ? e.message : e);
      return res.status(500).json({ error: 'Generate failed', honesty: HONESTY });
    }
  };
}

module.exports = {
  FAL_MODEL,
  COST_PER_STILL_USD,
  MAX_GENERATES_PER_SESSION,
  MAX_SESSION_SPEND_USD,
  HONESTY,
  getFalKey,
  buildPrompt,
  validateGenerateBody,
  validateImage,
  MAX_PROMPT_CHARS,
  callFalKontext,
  createRemodelGenerateHandler,
  sessionSpend,
  remainingGenerates,
  getSessionBudget,
  sessionKeyFromReq,
};
