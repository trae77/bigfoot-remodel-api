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

function getFalKey() {
  // Split halves: some hosts redact full key-shaped secrets on inject.
  const a = (process.env.FAL_KEY_A || '').trim();
  const b = (process.env.FAL_KEY_B || '').trim();
  if (a && b) return a + b;
  if (process.env.FAL_KEY_B64) {
    try {
      const decoded = Buffer.from(String(process.env.FAL_KEY_B64).trim(), 'base64').toString('utf8').trim();
      if (decoded) return decoded;
    } catch (_) { /* fall through */ }
  }
  const key = process.env.FAL_KEY || process.env.FAL_API_KEY || process.env.REMODEL_AI_API_KEY;
  return key && String(key).trim() ? String(key).trim() : '';
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

function resolveImageUrl(imageUrl, req) {
  const raw = String(imageUrl || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw) || /^data:/i.test(raw)) return raw;
  if (raw.startsWith('/')) {
    const base = (process.env.CLIENT_URL || '').replace(/\/$/, '')
      || `${req.protocol}://${req.get('host')}`;
    return `${base}${raw}`;
  }
  return raw;
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
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'anon').toString().split(',')[0].trim();
  return `ip:${ip}`;
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

      const projectId = Number(req.body?.projectId ?? req.body?.project_id);
      const room = String(req.body?.room || req.body?.roomType || 'kitchen').toLowerCase();
      const finishes = req.body?.finishes || {};
      const imageUrlIn = req.body?.imageUrl || req.body?.image_url;
      const hasPeople = Boolean(req.body?.hasPeople || req.body?.has_people);

      if (hasPeople) {
        return res.status(400).json({
          error: 'Please use a room photo without people or faces for the AI preview.',
          honesty: HONESTY,
        });
      }

      if (!Number.isFinite(projectId) || projectId <= 0) {
        return res.status(400).json({ error: 'projectId is required', honesty: HONESTY });
      }

      const image_url = resolveImageUrl(imageUrlIn, req);
      if (!image_url) {
        return res.status(400).json({ error: 'imageUrl is required (https URL, data URI, or /uploads/… path)', honesty: HONESTY });
      }

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

      const prompt = buildPrompt(room, finishes);
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
  resolveImageUrl,
  callFalKontext,
  createRemodelGenerateHandler,
  sessionSpend,
  remainingGenerates,
  getSessionBudget,
  sessionKeyFromReq,
};
