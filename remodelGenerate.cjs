/**
 * Live fal FLUX.1 Kontext [pro] generate path for Big Foot remodelizer.
 * Contract: docs/fal-kontext-contract-2026-10-24.md (mirror: offline-ai/docs/bigfoot-remodel-fal-contract-2026-10-24.md)
 * Authorized William t1097u — preview only. Never log FAL_KEY.
 */

// Model and $/image from fal's model pages (fal.ai/models/fal-ai/flux-pro/kontext[/max]/llms.txt, 2026-10-31).
const FAL_MODELS = { pro: { id: 'fal-ai/flux-pro/kontext', usd: 0.04 }, max: { id: 'fal-ai/flux-pro/kontext/max', usd: 0.08 } };
/** REMODEL_FAL_MODEL=pro|max (default pro). Anything else falls back to pro. */
function falModel() {
  const k = (process.env.REMODEL_FAL_MODEL || '').trim().toLowerCase();
  return Object.hasOwn(FAL_MODELS, k) ? FAL_MODELS[k] : FAL_MODELS.pro;
}
/** REMODEL_GUIDANCE: fal range 1-20, default 3.5. Out of range or not a number falls back to 3.5. */
function falGuidance() {
  const raw = (process.env.REMODEL_GUIDANCE || '').trim(); const g = Number(raw);
  return raw !== '' && Number.isFinite(g) && g >= 1 && g <= 20 ? g : 3.5;
}
/**
 * Floor-first two-call edit (R59 option A). On for unset/''/1/true/on/yes; off for 0/false/off/no.
 * Any other value fails closed (OFF, fewer fal calls) with one warn log per distinct value.
 */
const warnedTwoPass = new Set();
function twoPassOn() {
  const raw = (process.env.REMODEL_TWO_PASS || '').trim().toLowerCase();
  if (['', '1', 'true', 'on', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  if (!warnedTwoPass.has(raw)) { warnedTwoPass.add(raw); console.warn('remodel_two_pass_invalid', JSON.stringify({ value: raw.slice(0, 20), using: false })); }
  return false;
}
/** REMODEL_FLOOR_GUIDANCE: guidance for the floor-only pass, fal range 1-20, default 5.0. */
function floorGuidance() {
  const raw = (process.env.REMODEL_FLOOR_GUIDANCE || '').trim(); const g = Number(raw);
  return raw !== '' && Number.isFinite(g) && g >= 1 && g <= 20 ? g : 5;
}
const MIN_LONG_SIDE_PX = 1024;
/** Long side in px from JPEG/PNG/WebP header bytes, or null. Used only for a log warning; we never upscale. */
function imageLongSide(dataUri) {
  try {
    const m = /^data:image\/(jpeg|png|webp);base64,(.*)$/.exec(dataUri); if (!m) return null;
    const b = Buffer.from(m[2].slice(0, 200000), 'base64');
    let w = null; let h = null;
    if (m[1] === 'png' && b.length >= 24) { w = b.readUInt32BE(16); h = b.readUInt32BE(20); }
    else if (m[1] === 'webp' && b.length >= 30 && b.toString('latin1', 12, 16) === 'VP8X') { w = 1 + b.readUIntLE(24, 3); h = 1 + b.readUIntLE(27, 3); }
    else if (m[1] === 'jpeg') {
      for (let i = 2; i + 9 < b.length;) {
        if (b[i] !== 0xff) { i++; continue; }
        const mk = b[i + 1];
        if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) { h = b.readUInt16BE(i + 5); w = b.readUInt16BE(i + 7); break; }
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
    return w && h ? Math.max(w, h) : null;
  } catch { return null; }
}
const FAL_MODEL = FAL_MODELS.pro.id;
const FAL_RUN_URL = `https://fal.run/${FAL_MODEL}`;
const store = require('./imageStore.cjs');
const catalog = require('./productCatalog.cjs');
const COST_PER_STILL_USD = 0.04; // pro; use falModel().usd for the live cost
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

// Our own limit; fal publishes none for Kontext. 1200 (R60): two-pass calls all fit under 800, but the
// single-call prompt for a full catalog kitchen (two-pass off) reaches ~1165. Over it is a clear 400.
const MAX_PROMPT_CHARS = 1200;
const MAX_FINISH_CHARS = 100;
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
// Must match ROOM_ORDER in the Big Foot page (src/remodelOptions.ts).
const ROOMS = new Set(['kitchen', 'bathroom', 'basement', 'deck', 'whole', 'laundry']);
/** Free-text finishes are material words only: no money talk and no instructions to the model. */
// Checked on the raw text (word boundaries, so 'free-form', 'cost-effective', 'price-matched', 'prompt gray' pass)
// and on a squashed copy with spaces/hyphens/dots removed (catches 'i g n o r e', 'ig-nore').
// QA P3 (PUNCH-e60b965): money words need whole-word or number context, so dollarweed, 'grand oak', Buckskin,
// bucksaw, logo, caption, 'system white' and 4K/5k/2k pass; leetspeak (ign0re, w4termark) is folded before the squashed check.
const MONEY_UNIT = '(?:dollars?|bucks?|usd|eur|euros?|quid|pounds?|grand|percent|k\\s*(?:dollars?|usd|bucks?))';
const FINISH_DENY_RE = new RegExp([
  '[$€£¥%]',
  '\\b(?:dollars?|bucks|usd|eur|euros?|quid|pounds? sterling|prices?|pricing|cheap(?:est)?|discount(?:ed)?|sale|clearance|markdowns?|bargains?|deals?|coupons?|promos?|promotions?|rebates?|budget|affordable|half[ -]?off|watermarks?|labels? saying)\\b',
  `\\b\\d[\\d,.]*\\s*${MONEY_UNIT}\\b`,
  '\\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|hundred|thousand)\\s+' + MONEY_UNIT + '\\b',
  '\\b\\d+\\s*(?:percent|pct)\\s*off\\b|\\bpay\\s+(?:nothing|less|only)\\b',
  '\\b(?:add|write|put|show|print|insert)\\b[^.]{0,20}\\b(?:text|words?|letters?|captions?|logos?|signs?|labels?)\\b',
  '\\bsaying\\b|\\b(?:ignore|disregard|forget)\\b|\\b(?:system prompt|instructions?)\\b',
  "\\b(?:do\\s+not|don'?t|never|stop)\\s+(?:follow|obey)\\b|\\b(?:follow|obey|break)\\s+(?:no|the|any|your|these)?\\s*rules\\b",
  '\\b(?:costs?|prices?)\\s*(?:is|are|of|:|\\d)',
].join('|'), 'i');
const FINISH_DENY_SQUASHED_RE = /ignore|disregard|forgetprevious|systemprompt|instruction|watermark|\d(?:dollars?|bucks|usd|euros?|quid)/i;
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', '!': 'i', '|': 'i' };
/** Leetspeak folded only for the instruction words (digits stay digits for the money check). */
function deLeet(t) { return t.replace(/[013457@!|]/g, (c) => LEET[c]); }
function finishDenied(t) {
  // Allowed compounds are removed first; any other free/cost/price word is still blocked.
  // QA P3-a (PUNCH-2e946c5): cabinet clearance terms, Euro-style, a singular weight ('2 pound') and
  // forget-me-not are finish words. Plural 'N pounds', bare 'clearance' and 'euros' stay blocked.
  const scrubbed = t
    .replace(/\b(?:free-form|freeform|cost-effective|price-matched|free-standing|freestanding)\b/gi, ' ')
    .replace(/\btoe[ -]?kick\s+clearance\b|\bclearance\s+(?:under|above|below|around|between|behind|for)\b/gi, ' ')
    .replace(/\beuro[ -]style\b/gi, ' ')
    .replace(/\bforget[ -]?me[ -]?not\b/gi, ' ')
    .replace(/\b\d+(?:\.\d+)?[ -]pound\b(?!\s*(?:sterling|off|each|per|discount|price|cost))/gi, ' ');
  if (FINISH_DENY_RE.test(scrubbed)) return true;
  if (/\b(?:free|costs?|prices?)\b|\b(?:system|prompts?)\s*[:=]|\bsystem\s+(?:message|role|override)\b|\b(?:the|your|this|my|show|reveal|print)\s+prompts?\b/i.test(scrubbed)) return true;
  const squashed = scrubbed.replace(/[\s\-_.'/]+/g, '');
  if (FINISH_DENY_SQUASHED_RE.test(squashed)) return true;
  return /ignore|disregard|forget|watermark|systemprompt|instruction/i.test(deLeet(squashed));
}
const FINISH_KEYS = ['floor', 'cabinets', 'counters', 'walls', 'backsplash'];
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
    if (finishDenied(t)) return { error: `finishes.${k} is not a valid finish` };
    finishes[k] = t;
  }
  // Good/better/best picks: ids only, resolved server-side to the verified product description.
  const t = catalog.resolveTiers(body.tiers);
  const catalogSlots = new Set();
  if (t.error) return { error: t.error };
  for (const [slot, desc] of Object.entries(t.picks)) {
    if (FINISH_KEYS.includes(slot) && finishes[slot] != null) return { error: `Pick either a finish or a product for ${slot}` };
    finishes[slot] = desc;
    catalogSlots.add(slot);
  }
  const img = validateImage(body.imageUrl ?? body.image_url);
  if (img.error) return img;
  const prompt = buildPrompt(room, finishes, { catalogSlots });
  // The cap applies to what is actually sent: each fal call's prompt (two-pass splits the edit across 2 calls).
  const sent = planCalls({ room, finishes, catalogSlots, prompt });
  if (sent.some((c) => c.prompt.length > MAX_PROMPT_CHARS)) return { error: 'Prompt too long' };
  const longSide = imageLongSide(img.image_url);
  if (longSide != null && longSide < MIN_LONG_SIDE_PX) console.warn('remodel_input_small', JSON.stringify({ longSide, min: MIN_LONG_SIDE_PX }));
  return { projectId, room, finishes, catalogSlots, image_url: img.image_url, prompt, longSide };
}

// Naming a pattern, even as "no parquet", pulls Kontext toward it, so unwanted patterns are never named.
const NEGATED_PATTERN_RE = /[,;]?\s*\b(?:no|not|without)\s+(?:parquet|herringbone|chevron|basket-?weave)(?:\s*(?:,|or|and)\s*(?:parquet|herringbone|chevron|basket-?weave))*\b/gi;
/** Remove negated pattern phrases and tidy the punctuation they leave ('not parquet, oak' -> 'oak'). */
function stripNegations(v) {
  return String(v).replace(NEGATED_PATTERN_RE, ' ')
    .replace(/\s+([,;])/g, (_, c) => c).replace(/([,;])(\s*[,;])+/g, (_, c) => c)
    .replace(/^[\s,;]+|[\s,;]+$/g, '').replace(/\s+/g, ' ').trim();
}
const PLANK_TAIL = 'hardwood flooring in long straight parallel planks';
const WOOD_RE = /\b(oak|walnut|maple|hickory|cherry|ash|birch|pine|teak|acacia|hardwood|wood)\b/i;
const NOT_WOOD_RE = /\b(tile|vinyl|lvp|laminate|carpet|concrete|stone|marble|porcelain|ceramic|epoxy)\b/i;
/** Wood floor choices become explicit wide-plank wording so the model doesn't drift to parquet or herringbone. */
function floorPhrase(v) {
  // Strip "no parquet", "without herringbone" etc. first, so a negated pattern is never read as the choice.
  const raw = stripNegations(v);
  if (!raw) return 'a new plain floor';
  if ((!WOOD_RE.test(raw) && !/\b(herringbone|parquet|basket-?weave)\b/i.test(raw)) || NOT_WOOD_RE.test(raw)) return raw;
  const pat = /\bherringbone\b/i.test(raw) ? 'herringbone' : /\b(parquet|basket-?weave)\b/i.test(raw) ? 'parquet' : null;
  if (pat) {
    // Explicit pattern choice is kept, with its wood type.
    const wood = raw.replace(/\b(hardwood|wood|floor(?:ing|s)?|planks?|herringbone|parquet|basket-?weave|pattern)\b/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    return `${wood ? wood + ' ' : ''}hardwood flooring in a ${pat} pattern`;
  }
  if (/\blight\b/i.test(raw) && /\boak\b/i.test(raw)) return `wide-plank light oak ${PLANK_TAIL}`;
  const desc = raw.replace(/\b(hardwood|wood|floor(?:ing|s)?|planks?|wide-plank|wide|parquet|herringbone)\b/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return `wide-plank ${desc ? desc + ' ' : ''}${PLANK_TAIL}`;
}

/**
 * Kontext keeps an existing floor unless told to replace it (CEO proof render kept the source parquet).
 * Every chosen floor, legacy option or catalog product, is phrased as an explicit full replacement.
 */
const PATTERN_RE = /\b(herringbone|parquet|basket-?weave|chevron)\b/i;
// Pass 1 (two-pass, R59-proven) keeps the long cover tail; the single-call prompt uses the short one so every
// full bathroom/kitchen tier set fits MAX_PROMPT_CHARS with REMODEL_TWO_PASS off (QA P3-4).
const FLOOR_COVER_LONG = 'the new floor covers every visible floor area edge to edge and none of the old floor pattern, color or grain remains';
const FLOOR_COVER_SHORT = 'covering all visible floor edge to edge, none of the old floor left';
function floorInstruction(v, fromCatalog, short = false) {
  const target = stripNegations(fromCatalog ? String(v).trim() : floorPhrase(v));
  const patterned = PATTERN_RE.test(target);
  const planks = !patterned && /\b(plank|planks|lvp|hardwood|vinyl|laminate|wood|oak|strips?)\b/i.test(target);
  const parts = [`replace the entire existing floor with ${target}`];
  if (planks && !/long straight (parallel )?planks/i.test(target)) parts.push('laid as long straight parallel planks');
  parts.push(short ? FLOOR_COVER_SHORT : FLOOR_COVER_LONG);
  return parts.join('; ');
}

/**
 * Kontext edits best with a direct instruction first and preservation stated after (BFL Kontext guide).
 * The floor is the edit it most often skips, so it leads, on its own line, ahead of the other finishes.
 */
/** What to keep, minus anything this prompt asks to change (a51aaa6 said "keep walls" while also changing wall paint). */
function keepList(f, hasFloor, room) {
  const layout = room === 'bathroom' ? ['fixture layout'] : ['cabinet layout', 'appliance footprints', 'fixture layout'];
  const keep = [...(f.walls ? ['wall layout'] : ['walls']), 'windows', 'camera angle', 'lighting', ...layout, 'room dimensions'];
  if (!hasFloor) keep.push('the floor');
  const last = keep.pop();
  return `${keep.join(', ')} and ${last}`;
}

// Kept short so every tier combo fits MAX_PROMPT_CHARS per fal call (R60). Meaning: five-piece Shaker, flat frame, recessed flat panel, not slab.
const SHAKER_DOORS = 'five-piece Shaker doors and drawers: flat square frame around a recessed flat panel, not slab';
const SHAKER_RE = /\bshaker\b/i;
/** QA P3: a bare 'white shaker' renders as flat slab doors. Spell the door out, in the chosen color. */
function cabinetPhrase(v, fromCatalog) {
  const raw = String(v).replace(/\s+/g, ' ').trim();
  if (!SHAKER_RE.test(raw)) return raw;
  if (fromCatalog) {
    // Color = the words before the first construction/style word ('Bright white painted Shaker, ...' -> 'Bright white').
    const color = raw.split(/\b(?:painted|stained|recessed|5-piece|five-piece|shaker|doors?|cabinets?)\b/i)[0].replace(/[\s,;-]+$/, '').trim();
    // R60: the full product text is dropped; color + door style is what the image needs.
    return `${color ? `${color} ` : ''}${SHAKER_DOORS}`;
  }
  const color = raw.replace(/\bshaker(?:[- ]style|[- ]type)?\b/gi, ' ').replace(/\b(?:cabinets?|doors?|style)\b/gi, ' ')
    .replace(/\s+([,;])/g, (_, c) => c).replace(/^[\s,;-]+|[\s,;-]+$/g, '').replace(/\s+/g, ' ').trim();
  return `${color ? `${color} ` : ''}${SHAKER_DOORS}`;
}

function buildPrompt(room, finishes, opts = {}) {
  const f = finishes && typeof finishes === 'object' ? finishes : {};
  const fromCat = opts.catalogSlots instanceof Set ? opts.catalogSlots : new Set();
  const hasFloor = !(f.floor == null || f.floor === '');
  const others = [
    ['Cabinet faces', f.cabinets == null || f.cabinets === '' ? f.cabinets : cabinetPhrase(f.cabinets, fromCat.has('cabinets'))], ['Countertops', f.counters], ['Wall paint/tile', f.walls],
    ['Backsplash', f.backsplash], ['Vanity', f.vanity], ['Tub/shower', f.tub_shower],
  ].filter(([, v]) => !(v == null || v === ''));
  return [
    `Edit this photo of a ${room || 'kitchen'}.`,
    ...(hasFloor ? [`Main edit - Floor: ${floorInstruction(f.floor, fromCat.has('floor'), true)}.`] : []),
    ...(others.length ? [hasFloor ? 'Also change these finishes:' : 'Change these finishes:', ...others.map(([k, v]) => `- ${k}: ${v}`)] : []),
    '',
    `Keep everything else exactly as in the photo: ${keepList(f, hasFloor, room)}. Do not add people, text overlays, or new furniture.`,
    'Output one photoreal still.',
  ].join('\n');
}

/** PUBLIC_API_ORIGIN (e.g. https://bigfoot-remodel-api.onrender.com) makes afterImageUrl absolute; unset keeps the path. */
function absoluteImageUrl(path) {
  const o = (process.env.PUBLIC_API_ORIGIN || '').trim().replace(/\/+$/, '');
  return /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(o) ? o + path : path;
}

/** Pass 1 of the two-pass edit: the floor and nothing else, short and direct (BFL: one direct instruction, then what to keep). */
function floorOnlyPrompt(floor, fromCatalog) {
  return [
    `Change only the floor. ${floorInstruction(floor, fromCatalog).replace(/^replace/, 'Replace')}.`,
    'Leave the cabinets, counters, walls, appliances, windows and camera angle unchanged.',
  ].join('\n');
}

/** The fal calls one generate will make: [{ prompt, guidance_scale? }]. Two only when REMODEL_TWO_PASS=1, a floor change is asked for, and something else changes too. */
function planCalls(v) {
  const f = v.finishes || {};
  const hasFloor = !(f.floor == null || f.floor === '');
  if (!twoPassOn() || !hasFloor) return [{ prompt: v.prompt }];
  const fromCat = v.catalogSlots instanceof Set && v.catalogSlots.has('floor');
  const pass1 = { prompt: floorOnlyPrompt(f.floor, fromCat), guidance_scale: floorGuidance() };
  const rest = { ...f, floor: null };
  const others = Object.entries(rest).some(([, x]) => !(x == null || x === ''));
  if (!others) return [pass1];
  return [pass1, { prompt: buildPrompt(v.room, rest, { catalogSlots: v.catalogSlots }) }];
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
  const bySpend = Math.floor((MAX_SESSION_SPEND_USD - row.spendUsd) / falModel().usd + 1e-9);
  return Math.max(0, Math.min(byCount, bySpend));
}

/**
 * Default: send X-Fal-Store-IO: 0 so fal does not keep the request/response JSON in request history.
 * Only an explicit FAL_STORE_IO=1 omits it. fal docs: that header does NOT cover CDN files (the output
 * image on fal.media); those follow X-Fal-Object-Lifecycle-Preference, set here to expire after
 * FAL_MEDIA_EXPIRATION_SEC (default 3600; 0 omits the header). We copy the image into our own store at once.
 */
function falRunHeaders(key) {
  const h = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };
  if ((process.env.FAL_STORE_IO || '').trim() !== '1') h['X-Fal-Store-IO'] = '0';
  const raw = (process.env.FAL_MEDIA_EXPIRATION_SEC ?? '').trim();
  const ttl = raw === '' ? 3600 : Number(raw);
  if (Number.isInteger(ttl) && ttl > 0) h['X-Fal-Object-Lifecycle-Preference'] = JSON.stringify({ expiration_duration_seconds: ttl });
  return h;
}

/** Resolved runtime config for the startup log. Booleans and numbers only: never a key, secret or URL. */
function resolvedConfig() {
  const h = falRunHeaders('x');
  return {
    twoPass: twoPassOn(),
    model: falModel().id,
    guidance: falGuidance(),
    floorGuidance: floorGuidance(),
    storeIo: h['X-Fal-Store-IO'] ?? 'omitted',
    mediaTtlSec: h['X-Fal-Object-Lifecycle-Preference'] ? JSON.parse(h['X-Fal-Object-Lifecycle-Preference']).expiration_duration_seconds : null,
    publicApiOriginSet: Boolean((process.env.PUBLIC_API_ORIGIN || '').trim()),
  };
}

/** Log line for what retention headers actually went out. No URL, no key. */
function falRetentionLog(headers, requestId) {
  return { id: requestId || null, storeIo: headers['X-Fal-Store-IO'] ?? 'omitted', mediaTtlSec: headers['X-Fal-Object-Lifecycle-Preference'] ? JSON.parse(headers['X-Fal-Object-Lifecycle-Preference']).expiration_duration_seconds : null };
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
    guidance_scale: typeof input.guidance_scale === 'number' ? input.guidance_scale : falGuidance(),
    num_images: 1,
    output_format: 'jpeg',
    safety_tolerance: '2',
  };
  const headers = falRunHeaders(key);
  const res = await fetchImpl(`https://fal.run/${falModel().id}`, {
    method: 'POST',
    headers,
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
  const rid = res.headers && res.headers.get ? res.headers.get('x-fal-request-id') : null;
  console.info('fal_run_retention', JSON.stringify(falRetentionLog(headers, rid)));
  if (rid && data && typeof data === 'object') Object.defineProperty(data, '__falRequestId', { value: rid, enumerable: false });
  if (data && typeof data === 'object') Object.defineProperty(data, '__falStoreIo', { value: headers['X-Fal-Store-IO'] ?? null, enumerable: false });
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
      const { projectId, image_url } = v;
      const calls = planCalls(v);

      const sessionKey = sessionKeyFromReq(req);
      const budget = getSessionBudget(sessionKey);
      const remaining = remainingGenerates(budget);
      // Every fal call this request will make must fit the session cap before the first one goes out.
      if (remaining < calls.length) {
        return res.status(429).json({
          error: 'Session preview limit reached. Start a new browser session or try later.',
          remainingSessionGenerates: 0,
          honesty: HONESTY,
        });
      }

      const fetchImpl = deps.fetchImpl || globalThis.fetch;
      const results = [];
      let input = image_url;
      let cleaned = false;
      const runCleanup = () => { if (!cleaned) { cleaned = true; cleanup(); } };
      try {
      for (const c of calls) {
        const d = await callFalKontext({ prompt: c.prompt, image_url: input, ...(c.guidance_scale ? { guidance_scale: c.guidance_scale } : {}) }, { fetchImpl: deps.fetchImpl });
        // fal has billed once it returns: charge the session now, even if a later step fails.
        budget.count += 1;
        budget.spendUsd += falModel().usd;
        budget.updatedAt = Date.now();
        sessionSpend.set(sessionKey, budget);
        results.push(d);
        const u = d?.images?.[0]?.url;
        if (!u) break;
        input = u;
      }
      } catch (e) {
        // A later pass threw: still log the skip/delete for every call fal already ran (pass 1's id stays in the audit log).
        runCleanup();
        throw e;
      }
      if (calls.length > 1) console.info('remodel_two_pass', JSON.stringify({ ids: results.map((d) => d.__falRequestId || null), passes: results.length }));
      const data = results[results.length - 1];
      const falUrl = results.length === calls.length ? data?.images?.[0]?.url : null;
      function cleanup() { setImmediate(() => {
        for (const d of results) {
          // Server-side only, for QA delete checks: fal request id and counts. No URL, no key. Never sent to the browser.
          const rid = d.__falRequestId; const id = rid || null; const key = getFalKey();
          // With X-Fal-Store-IO: 0 fal keeps no request payload, so there is nothing to delete (the delete call 403s).
          if (d.__falStoreIo === '0') { console.info('fal_payload_delete_skipped', JSON.stringify({ id, storeIo: '0' })); continue; }
          store.deleteFalPayload(rid, key, fetchImpl).then((del) => {
            if (del.ok) { console.info('fal_payload_delete_ok', JSON.stringify({ id, files: del.total ?? null })); return; }
            console.error('ALERT fal_payload_delete_failed', JSON.stringify({ id, status: del.status || null, reason: del.reason || null, failed: del.failed ?? null }));
            if (typeof deps.onFalDeleteFail === 'function') Promise.resolve().then(() => deps.onFalDeleteFail(del)).catch(() => {});
          }).catch(() => console.error('ALERT fal_payload_delete_failed', JSON.stringify({ id, reason: 'exception' })));
        }
      }); }
      if (!falUrl) {
        runCleanup();
        return res.status(502).json({ error: 'fal returned no image URL', honesty: HONESTY });
      }
      // Privacy: copy the render into private in-process storage, then delete it from fal.
      // The public fal URL is never sent to the client.
      let stored;
      try {
        stored = await store.fetchFalImage(falUrl, fetchImpl);
      } finally {
        // Never block the client on fal's delete: run it after the response is sent (capped at 3 s in imageStore).
        runCleanup();
      }
      const id = deps.imageStore.put(stored.buf, stored.type);
      const secret = (req.remodelCfg && req.remodelCfg.secret) || deps.secret;
      const afterImageUrl = absoluteImageUrl(store.signedImagePath(secret, id));

      return res.status(200).json({
        afterImageUrl,
        afterImageExpiresIn: store.URL_TTL_SEC_MAX,
        remainingSessionGenerates: remainingGenerates(budget),
        honesty: HONESTY,
        provider: falModel().id,
        seed: data.seed ?? null,
        projectId,
      });
    } catch (e) {
      if (e && e.code === 'MISSING_KEY') {
        return res.status(503).json({ error: 'Remodel generate is not configured (missing FAL_KEY)', honesty: HONESTY });
      }
      if (e && (e.code === 'FAL_UPSTREAM' || e.code === 'FAL_FETCH')) {
        return res.status(502).json({ error: 'Image service failed — try again later', honesty: HONESTY });
      }
      console.error('remodel/generate error', e && e.message ? e.message : e);
      return res.status(500).json({ error: 'Generate failed', honesty: HONESTY });
    }
  };
}

module.exports = {
  FAL_MODEL,
  FAL_MODELS,
  falModel,
  falGuidance,
  planCalls,
  FINISH_DENY_RE,
  cabinetPhrase,
  SHAKER_DOORS,
  resolvedConfig,
  twoPassOn,
  floorOnlyPrompt,
  imageLongSide,
  COST_PER_STILL_USD,
  MAX_GENERATES_PER_SESSION,
  MAX_SESSION_SPEND_USD,
  HONESTY,
  getFalKey,
  buildPrompt,
  floorPhrase,
  floorInstruction,
  absoluteImageUrl,
  falRunHeaders,
  falRetentionLog,
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
