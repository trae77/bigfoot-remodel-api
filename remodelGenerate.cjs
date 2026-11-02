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
/** { w, h } from the same header parse, or null. Used to size heuristic masks. */
function imageSize(dataUri) {
  try {
    const m = /^data:image\/(jpeg|png|webp);base64,(.*)$/.exec(dataUri); if (!m) return null;
    const b = Buffer.from(m[2].slice(0, 200000), 'base64');
    if (m[1] === 'png' && b.length >= 24) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (m[1] === 'webp' && b.length >= 30 && b.toString('latin1', 12, 16) === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (m[1] === 'jpeg') {
      for (let i = 2; i + 9 < b.length;) {
        if (b[i] !== 0xff) { i++; continue; }
        const mk = b[i + 1];
        if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
    return null;
  } catch { return null; }
}
/**
 * REMODEL_REGIONS: per-region passes (floor, cabinets, counters) with furniture exclusions and floor guards.
 * Default OFF so deploying this changes nothing until flipped. On for 1/true/on/yes; anything else OFF.
 */
/** REMODEL_DECLUTTER: 'empty the room' pre-pass (1 extra fal call). Default OFF; on for 1/true/on/yes. */
function declutterOn() { return ['1', 'true', 'on', 'yes'].includes((process.env.REMODEL_DECLUTTER || '').trim().toLowerCase()); }
/** REMODEL_FAILOVER: on a primary (kontext) error or timeout, retry that one call on Qwen-Image-Edit. Default OFF. */
function failoverFlag() { return ['1', 'true', 'on', 'yes'].includes((process.env.REMODEL_FAILOVER || '').trim().toLowerCase()); }
/** Per-call timeout for the primary engine before failover (ms). Default 60000, range 5000-120000. */
function engineTimeoutMs() { const n = Number((process.env.REMODEL_ENGINE_TIMEOUT_MS || '').trim()); return Number.isInteger(n) && n >= 5000 && n <= 120000 ? n : 60000; }
/** Per-render dollar ceiling: ONE setting, security.cjs renderMaxUsd (#14: default 0.50, clamped to 1.00). Read from req.remodelCfg when present. */
function renderMaxUsd(req) { return req && req.remodelCfg && Number.isFinite(req.remodelCfg.renderMaxUsd) ? req.remodelCfg.renderMaxUsd : require('./security.cjs').renderMaxUsd(process.env.REMODEL_RENDER_MAX_USD); }
/** Strict on/off flag: exactly '1' is on; '0' or unset is off; anything else is off with one warn log (fail closed). */
const warnedStrict = new Set();
function strictFlag(name) {
  const raw = (process.env[name] || '').trim();
  if (raw === '1') return true;
  if (raw !== '' && raw !== '0' && !warnedStrict.has(`${name}=${raw}`)) { warnedStrict.add(`${name}=${raw}`); console.warn('remodel_flag_invalid', JSON.stringify({ name, using: false })); }
  return false;
}
/**
 * Recipe-spec §1c.4: the hard-photo engine. REMODEL_HARD_ENGINE defaults to kontext-pro; only the exact value
 * 'kontext-max' selects max, and only when REMODEL_MAX_ON_HARD is exactly '1'. Anything else = pro (max OFF).
 */
function hardEngineId() { return (process.env.REMODEL_HARD_ENGINE || '').trim() === 'kontext-max' ? 'kontext-max' : 'kontext-pro'; }
function maxOnHardOn() { return strictFlag('REMODEL_MAX_ON_HARD') && hardEngineId() === 'kontext-max'; }
/** Recipe: Fill is dropped. Only REMODEL_FILL_ENABLE exactly '1' (plus a valid REMODEL_FILL_USD) brings it back. */
function fillEnabled() { return strictFlag('REMODEL_FILL_ENABLE'); }
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;
/** REMODEL_REGION_MODE=cabinets-only (regions ON only): edit just the cabinets; floor, counters, walls, backsplash untouched. */
function cabinetsOnly() { return regionsOn() && (process.env.REMODEL_REGION_MODE || '').trim().toLowerCase() === 'cabinets-only'; }
/** REMODEL_ROOM_PRESETS (regions ON only): bathroom, living, bedroom get their own region plans. Default OFF. */
function presetsOn() { return regionsOn() && ['1', 'true', 'on', 'yes'].includes((process.env.REMODEL_ROOM_PRESETS || '').trim().toLowerCase()); }
function regionsOn() { return ['1', 'true', 'on', 'yes'].includes((process.env.REMODEL_REGIONS || '').trim().toLowerCase()); }
const FAL_MODEL = FAL_MODELS.pro.id;
const FAL_RUN_URL = `https://fal.run/${FAL_MODEL}`;
const store = require('./imageStore.cjs');
const regions = require('./regionTargeting.cjs');
const engines = require('./engines.cjs');
const catalog = require('./productCatalog.cjs');
const hardPhoto = require('./hardPhoto.cjs');
const palette = require('./palette/match.cjs');
const MAX_COLOR_TEXT = 60;
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
const ROOMS = new Set(['kitchen', 'bathroom', 'basement', 'deck', 'whole', 'laundry', 'living', 'bedroom']);
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
const FINISH_KEYS = ['floor', 'cabinets', 'counters', 'walls', 'backsplash', 'builtins', 'closet_doors'];
// Plain finish words only: letters, digits, space and a few joiners. No newlines or prompt syntax.
const FINISH_RE = /^[A-Za-z0-9 ,.:'&/()+-]+$/;

const MAGIC = {
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};

/** Drop JPEG APP1..APP15 + COM segments (EXIF/XMP/GPS/comments) and PNG eXIf/tEXt/zTXt/iTXt chunks. Malformed input is returned unchanged. */
function stripImageMetadata(type, b) {
  try {
    if (type === 'image/jpeg') {
      const out = [b.subarray(0, 2)]; let i = 2;
      while (i + 4 <= b.length && b[i] === 0xff) {
        const m = b[i + 1];
        if (m === 0xda || m === 0xd9) { out.push(b.subarray(i)); return Buffer.concat(out); }
        const len = b.readUInt16BE(i + 2);
        if (len < 2 || i + 2 + len > b.length) return b;
        if (!((m >= 0xe1 && m <= 0xef) || m === 0xfe)) out.push(b.subarray(i, i + 2 + len));
        i += 2 + len;
      }
      return i >= b.length ? Buffer.concat(out) : b;
    }
    if (type === 'image/png') {
      const out = [b.subarray(0, 8)]; let i = 8;
      while (i + 12 <= b.length) {
        const len = b.readUInt32BE(i); const t = b.toString('latin1', i + 4, i + 8);
        if (i + 12 + len > b.length) return b;
        if (!['eXIf', 'tEXt', 'zTXt', 'iTXt'].includes(t)) out.push(b.subarray(i, i + 12 + len));
        i += 12 + len;
      }
      return i === b.length ? Buffer.concat(out) : b;
    }
  } catch (_e) { return b; }
  return b;
}

/** Accept only data:image/(jpeg|png|webp);base64 whose bytes match the declared type. URLs of any kind are refused. */
function validateImage(raw) {
  if (typeof raw !== 'string') return { error: 'imageUrl must be a data:image/jpeg, png or webp URI' };
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw.trim());
  if (!m) return { error: 'imageUrl must be a data:image/jpeg, png or webp URI' };
  if (m[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return { error: 'Image is too large', status: 413 };
  const bytes = Buffer.from(m[2], 'base64');
  if (!MAGIC[m[1]](bytes)) return { error: 'Image content does not match its type' };
  const clean = stripImageMetadata(m[1], bytes);
  return { image_url: clean === bytes ? `data:${m[1]};base64,${m[2]}` : `data:${m[1]};base64,${clean.toString('base64')}` };
}

/** Validate the whole body before anything is counted or sent. Returns { error, status } or the clean fields. */
function validateGenerateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'JSON object body required' };
  if (body.hasPeople || body.has_people) {
    return { error: 'Please use a room photo without people or faces for the AI preview.' };
  }
  const projectId = Number(body.projectId ?? body.project_id);
  if (!Number.isInteger(projectId) || projectId <= 0) return { error: 'projectId is required' };
  // Recipe-spec §1d: hardPhoto is a strict boolean, default false. It is OR'd with the server's own signals.
  const hp = body.hardPhoto ?? body.hard_photo;
  if (hp != null && typeof hp !== 'boolean') return { error: 'hardPhoto must be true or false' };
  const hardPhotoFlag = hp === true;
  // Recipe-spec §2b: colorHex (paintHex is the older name) wins over colorText. Both target the wall paint.
  const chIn = body.colorHex ?? body.color_hex ?? body.paintHex ?? body.paint_hex;
  if (chIn != null && (typeof chIn !== 'string' || !HEX_RE.test(chIn.trim()))) return { error: 'colorHex must be a #RRGGBB color' };
  const ctIn = body.colorText ?? body.color_text;
  if (ctIn != null && ctIn !== '') {
    if (typeof ctIn !== 'string') return { error: 'colorText must be a string' };
    const t = ctIn.trim();
    if (t.length > MAX_COLOR_TEXT || !FINISH_RE.test(t) || finishDenied(t)) return { error: 'colorText is not a valid color' };
  }
  const color = chIn != null ? resolveColor(chIn.trim(), null) : (ctIn ? resolveColor(null, ctIn.trim()) : null);
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
  if (color && color.phrase) {
    if (catalogSlots.has('walls')) return { error: 'Pick either a paint color or a product for walls' };
    finishes.walls = finishes.walls == null ? color.phrase : `${finishes.walls}, ${color.phrase}`;
  }
  const img = validateImage(body.imageUrl ?? body.image_url);
  if (img.error) return img;
  const longSide = imageLongSide(img.image_url);
  if (longSide != null && longSide < MIN_LONG_SIDE_PX) console.warn('remodel_input_small', JSON.stringify({ longSide, min: MIN_LONG_SIDE_PX }));
  const v = { projectId, room, finishes, catalogSlots, image_url: img.image_url, longSide, hardPhoto: hardPhotoFlag, color,
    ...hardPhoto.classify(null, hardPhotoFlag), signals: null };
  return composeOrFallback(v);
}

/** colorHex / colorText -> { colorMatch, colorId, colorHexUsed, phrase } (spec §2b). Never a brand name. */
function resolveColor(hex, text) {
  const m = palette.matchColor(hex != null ? hex : text);
  const words = m.id ? m.id.replace(/^css:/, '').replace(/-/g, ' ') : null;
  let phrase = null;
  if (m.hex) phrase = `repaint the walls ${words ? `${words} ` : ''}(${m.hex}), a muted matte paint`;
  else if (m.text) phrase = `repaint the walls ${m.text}, a muted matte paint`; // nomatch: keep the free text, never guess
  // Brand-only text with aliases OFF: every word was a brand term and got stripped. Tell the UI instead of silently ignoring.
  const brandDropped = hex == null && m.method === 'none' && !m.text && typeof text === 'string' && text.trim() !== '' && palette.brandStripped(text);
  return { colorMatch: brandDropped ? 'brand_dropped' : m.method, colorId: m.id, colorHexUsed: m.hex, phrase };
}

/**
 * The extended keep-list is a free prompt add-on: if it alone pushes a call over the cap, send the base prompt
 * instead of refusing (meta.hard still reports the decision). Any other error is returned as-is.
 */
function composeOrFallback(v) {
  v.hardPrompt = undefined; v.compactKeep = undefined;
  let err = composePrompt(v);
  if (err && err.error === 'Prompt too long' && v.hard) {
    v.hardPrompt = false; err = composePrompt(v);
    if (!err) console.warn('remodel_prompt_fallback', JSON.stringify({ dropped: 'hard_keep' }));
  }
  // Single-call mode (REMODEL_TWO_PASS=0) with long catalog text: the pre-spec keep line (still keeps rugs and mats).
  if (err && err.error === 'Prompt too long') {
    v.compactKeep = true; err = composePrompt(v);
    if (!err) console.warn('remodel_prompt_fallback', JSON.stringify({ dropped: 'base_keep' }));
  }
  return err || v;
}
function hardWording(v) { return v.hard === true && v.hardPrompt !== false; }

/** Builds v.prompt for v.hard and checks every planned fal call against MAX_PROMPT_CHARS. Returns an error or null. */
function composePrompt(v) {
  v.prompt = buildPrompt(v.room, v.finishes, { catalogSlots: v.catalogSlots, hard: hardWording(v), compactKeep: v.compactKeep === true });
  // The cap applies to what is actually sent: each fal call's prompt (two-pass splits the edit across 2 calls).
  const sent = planCalls(v);
  if (cabinetsOnly() && !sent.length) return { error: 'Pick a cabinet finish for the cabinet-only preview' };
  if (sent.some((c) => c.prompt.length > MAX_PROMPT_CHARS)) return { error: 'Prompt too long' };
  return null;
}

/**
 * Full validation: the sync checks, then the hard-photo signals (sharp, 256 px) computed BEFORE any cap or paid
 * call (spec §1d). If the signals make the photo hard, the prompt is rebuilt with the extended keep-list and rechecked.
 */
async function validateGenerateRequest(body, opts = {}) {
  const v = validateGenerateBody(body);
  if (v.error) return v;
  v.signals = await hardPhoto.computeSignals(v.image_url, opts.sharp);
  Object.assign(v, hardPhoto.classify(v.signals, v.hardPhoto));
  if (v.signals) console.info('remodel_hard_signals', JSON.stringify({ ...v.signals, hard: v.hard, reasons: v.hardReasons }));
  return composeOrFallback(v);
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
// Recipe-spec §1c.1: the base keep-list classes, on every request. Merged into the one keep sentence below so the
// single-call full-catalog prompt stays under MAX_PROMPT_CHARS ("exactly as they are" = "exactly as in the photo").
const BASE_KEEP = ['all appliances', 'counter items', 'shelf items', 'furniture', 'rugs', 'mats', 'towels', 'lighting', 'windows'];
// Recipe-spec §1c.3: the extended keep-list for hard photos.
const HARD_KEEP = 'Do not remove, tidy or restyle anything; same camera framing';
const TARGET_WORDS = { cabinets: 'cabinet faces', counters: 'countertops', walls: 'wall paint', backsplash: 'backsplash', vanity: 'vanity', tub_shower: 'tub/shower', floor: 'flooring' };
function targetList(f) {
  const t = Object.keys(TARGET_WORDS).filter((k) => !(f[k] == null || f[k] === '')).map((k) => TARGET_WORDS[k]);
  if (t.length < 2) return t[0] || 'listed finishes';
  return `${t.slice(0, -1).join(', ')} and ${t[t.length - 1]}`;
}
function keepList(f, hasFloor, room, compact = false) {
  const layout = room === 'bathroom' ? ['fixture layout'] : ['cabinet layout', 'appliance footprints', 'fixture layout'];
  const keep = compact
    ? [...(f.walls ? ['wall layout'] : ['walls']), 'windows', 'camera angle', 'lighting', ...layout, 'rugs and mats', 'room dimensions']
    : [...BASE_KEEP, ...(f.walls ? ['wall layout'] : ['walls']), 'camera angle', ...layout, 'room dimensions'];
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
  const hard = opts.hard === true;
  const others = [
    ['Cabinet faces', f.cabinets == null || f.cabinets === '' ? f.cabinets : cabinetPhrase(f.cabinets, fromCat.has('cabinets'))], ['Countertops', f.counters], ['Wall paint/tile', f.walls],
    ['Backsplash', f.backsplash], ['Vanity', f.vanity], ['Tub/shower', f.tub_shower],
  ].filter(([, v]) => !(v == null || v === ''));
  return [
    `Edit this photo of a ${room || 'kitchen'}.`,
    ...(hasFloor ? [`Main edit - Floor: ${floorInstruction(f.floor, fromCat.has('floor'), true)}.`] : []),
    ...(others.length ? [hard ? (hasFloor ? 'Also clearly change these finishes:' : 'Clearly change these finishes:') : (hasFloor ? 'Also change these finishes:' : 'Change these finishes:'),
      ...others.map(([k, v]) => `- ${k}: ${hard ? String(v).replace(/^repaint the walls\b/, 'clearly repaint the walls') : v}`)] : []),
    '',
    opts.compactKeep ? `Keep everything else exactly as in the photo: ${keepList(f, hasFloor, room, true)}.`
      : `Keep everything else exactly as in the photo: ${keepList(f, hasFloor, room)}; change only the ${targetList(f)}.`,
    ...(hard ? [`${HARD_KEEP}${hasFloor ? '' : '; same floor coverings'}.`] : []),
    'Do not add people, text overlays, or new furniture.',
    'Output one photoreal still.',
  ].join('\n');
}

/** PUBLIC_API_ORIGIN (e.g. https://bigfoot-remodel-api.onrender.com) makes afterImageUrl absolute; unset keeps the path. */
function absoluteImageUrl(path) {
  const o = (process.env.PUBLIC_API_ORIGIN || '').trim().replace(/\/+$/, '');
  return /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(o) ? o + path : path;
}

/** Pass 1 of the two-pass edit: the floor and nothing else, short and direct (BFL: one direct instruction, then what to keep). */
function floorOnlyPrompt(floor, fromCatalog, hard = false) {
  return [
    `Change only the floor. ${floorInstruction(floor, fromCatalog).replace(/^replace/, 'Replace')}.`,
    'Leave the cabinets, counters, walls, appliances, windows and camera angle unchanged. Keep all appliances, objects, rugs and mats not in the target regions unchanged.',
    ...(hard ? [`${HARD_KEEP}.`] : []),
  ].join('\n');
}

/** The fal calls one generate will make: [{ prompt, guidance_scale? }]. Two only when REMODEL_TWO_PASS=1, a floor change is asked for, and something else changes too. */
function planCalls(v) {
  const f = v.finishes || {};
  if (regionsOn()) {
    const fromCat = v.catalogSlots instanceof Set ? v.catalogSlots : new Set();
    const phrase = (r, x) => (r === 'floor' ? stripNegations(fromCat.has('floor') ? String(x).trim() : floorPhrase(x)) : r === 'cabinets' ? cabinetPhrase(x, fromCat.has('cabinets')) : String(x));
    if (presetsOn() && regions.ROOM_PRESETS[v.room]) {
      const pp = regions.planPreset(v.room, f, phrase);
      return pp.map((c) => ({ region: c.region, prompt: c.prompt, negative: c.negative, ...(c.region === 'floor' ? { guidance_scale: floorGuidance() } : {}) }));
    }
    const src = cabinetsOnly() ? { cabinets: f.cabinets } : f;
    if (cabinetsOnly() && (f.cabinets == null || f.cabinets === '')) return [];
    const plan = regions.planRegions(v.room, src, phrase);
    if (plan.length && declutterOn()) plan.unshift(regions.declutterCall(v.room));
    if (plan.length) return plan.map((c) => ({ region: c.region, prompt: c.prompt, negative: c.negative, ...(c.region === 'floor' ? { guidance_scale: floorGuidance() } : {}) }));
  }
  const hasFloor = !(f.floor == null || f.floor === '');
  const pre = declutterOn() && Object.values(f).some((x) => !(x == null || x === '')) ? [regions.declutterCall(v.room)] : [];
  return [...pre, ...legacyCalls(v, f, hasFloor)];
}
function legacyCalls(v, f, hasFloor) {
  if (!twoPassOn() || !hasFloor) return [{ prompt: v.prompt }];
  const fromCat = v.catalogSlots instanceof Set && v.catalogSlots.has('floor');
  const pass1 = { prompt: floorOnlyPrompt(f.floor, fromCat, hardWording(v)), guidance_scale: floorGuidance() };
  const rest = { ...f, floor: null };
  const others = Object.entries(rest).some(([, x]) => !(x == null || x === ''));
  if (!others) return [pass1];
  return [pass1, { prompt: buildPrompt(v.room, rest, { catalogSlots: v.catalogSlots, hard: hardWording(v), compactKeep: v.compactKeep === true }) }];
}

function sessionKeyFromReq(req) {
  // All bypass renders share ONE session budget (MAX_SESSION_SPEND_USD), whatever headers they send.
  if (req.remodelBypass) return 'test-bypass';
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
    regions: regionsOn(),
    roomPresets: presetsOn(),
    cabinetsOnly: cabinetsOnly(),
    declutter: declutterOn(),
    failover: Boolean(failoverEngine(engines.ENGINES.kontext)),
    engine: selectEngine() ? selectEngine().id : 'unavailable',
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
  const res = await fetchImpl(`https://fal.run/${opts.model || falModel().id}`, {
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

/** Kontext has no negative-prompt field, so negatives are appended as plain 'Avoid:' words. Mask ignored. */
function withNegatives(prompt, negative) {
  return Array.isArray(negative) && negative.length ? `${prompt}\nAvoid: ${negative.join(', ')}.` : prompt;
}
engines.register('kontext', {
  usesMask: false,
  available: () => true,
  model: () => falModel().id,
  usdPerCall: () => falModel().usd,
  run: (c, imageUrl, o) => callFalKontext({ prompt: withNegatives(c.prompt, c.negative), image_url: imageUrl, ...(c.guidance_scale ? { guidance_scale: c.guidance_scale } : {}) }, o),
});
// Recipe hard-photo route: Kontext max at its own fal page price (FAL_MODELS.max.usd, 0.08), so caps and the ceiling count 0.08/call.
engines.register('kontext-max', {
  id: 'kontext-max',
  usesMask: false,
  available: () => true,
  model: () => FAL_MODELS.max.id,
  usdPerCall: () => FAL_MODELS.max.usd,
  run: (c, imageUrl, o) => callFalKontext({ prompt: withNegatives(c.prompt, c.negative), image_url: imageUrl, ...(c.guidance_scale ? { guidance_scale: c.guidance_scale } : {}) }, { ...o, model: FAL_MODELS.max.id }),
});
// fal FLUX.1 [pro] Fill: prompt + mask inpaint. Price is NOT hard-coded (never invent prices): the engine is
// only available when REMODEL_FILL_USD is set to a positive number from fal's model page; otherwise kontext is used.
const FILL_MODEL = 'fal-ai/flux-pro/v1/fill';
// Hard ceiling (QA R64): any value above 0.16 USD per call, or not a number, disables fill (fail closed, 503).
const MAX_FILL_USD = 0.16;
function fillUsd() { const n = Number((process.env.REMODEL_FILL_USD || '').trim()); return Number.isFinite(n) && n > 0 && n <= MAX_FILL_USD ? n : null; }
engines.register('fill', {
  usesMask: true,
  available: () => fillEnabled() && fillUsd() != null,
  model: () => FILL_MODEL,
  usdPerCall: () => fillUsd(),
  run: (c, imageUrl, o) => {
    // Fill must never run without a mask (it would repaint the whole photo).
    if (typeof c.mask_url !== 'string' || !c.mask_url.startsWith('data:image/png;base64,')) { const e = new Error('fill without mask'); e.code = 'NO_MASK'; return Promise.reject(e); }
    return callFalJson(FILL_MODEL, { prompt: withNegatives(c.prompt, c.negative), image_url: imageUrl, mask_url: c.mask_url, num_images: 1, output_format: 'jpeg', safety_tolerance: '2' }, o);
  },
});
// Qwen-Image-Edit inpaint on fal (failover only). Price NOT hard-coded: REMODEL_QWEN_USD (0 < x <= 0.16) or failover stays off.
const QWEN_MODEL = 'fal-ai/qwen-image-edit/inpaint';
function qwenUsd() { const n = Number((process.env.REMODEL_QWEN_USD || '').trim()); return Number.isFinite(n) && n > 0 && n <= MAX_FILL_USD ? n : null; }
engines.register('qwen', {
  usesMask: true,
  available: () => qwenUsd() != null,
  model: () => QWEN_MODEL,
  usdPerCall: () => qwenUsd(),
  run: (c, imageUrl, o) => {
    if (typeof c.mask_url !== 'string' || !c.mask_url.startsWith('data:image/png;base64,')) { const e = new Error('qwen without mask'); e.code = 'NO_MASK'; return Promise.reject(e); }
    return callFalJson(QWEN_MODEL, { prompt: `${regions.STRUCTURE_GUARD}\n${c.prompt}`, negative_prompt: (c.negative || []).join(', '), image_url: imageUrl, mask_url: c.mask_url, num_images: 1, output_format: 'jpeg' }, o);
  },
});
/** Failover engine, or null when off: needs REMODEL_FAILOVER on, a valid REMODEL_QWEN_USD, and a kontext primary. */
function failoverEngine(primary) {
  if (!failoverFlag() || !primary || primary.id !== 'kontext' || qwenUsd() == null) return null;
  return engines.ENGINES.qwen;
}
function withTimeout(p, ms) {
  let t; const to = new Promise((_, rej) => { t = setTimeout(() => { const e = new Error('engine timeout'); e.code = 'FAL_TIMEOUT'; rej(e); }, ms); });
  return Promise.race([p, to]).finally(() => clearTimeout(t));
}

/**
 * The engine this request will use. Regions OFF: always kontext (engine + provider). Regions ON: the
 * REMODEL_REGION_ENGINE choice; 'fill' without a valid price (at most 0.16 USD) returns null = refuse (fail closed).
 */
function hardRoute(e, v) { return e && e.id === 'kontext' && v && v.hard === true && maxOnHardOn() ? engines.ENGINES['kontext-max'] : e; }
function selectEngine(v) {
  if (!regionsOn()) return hardRoute(engines.ENGINES.kontext, v);
  const want = (process.env.REMODEL_REGION_ENGINE || '').trim().toLowerCase();
  if (want === 'fill' && !fillEnabled()) return hardRoute(engines.ENGINES.kontext, v);
  if (want === 'fill' && fillUsd() == null) return null;
  const e = engines.getEngine();
  // kontext-max is never picked by env: only the per-request hard-photo route reaches it.
  return hardRoute(e.id === 'kontext-max' ? engines.ENGINES.kontext : e, v);
}

/** Generic fal.run POST with the same retention headers and error shape as callFalKontext. */
async function callFalJson(model, body, opts = {}) {
  const key = getFalKey();
  if (!key) { const err = new Error('FAL_KEY is not configured'); err.code = 'MISSING_KEY'; throw err; }
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const headers = falRunHeaders(key);
  const res = await fetchImpl(`https://fal.run/${model}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!res.ok) { const err = new Error(`fal upstream ${res.status}`); err.code = 'FAL_UPSTREAM'; err.falStatus = res.status; throw err; }
  const rid = res.headers && res.headers.get ? res.headers.get('x-fal-request-id') : null;
  console.info('fal_run_retention', JSON.stringify(falRetentionLog(headers, rid)));
  if (rid && data && typeof data === 'object') Object.defineProperty(data, '__falRequestId', { value: rid, enumerable: false });
  if (data && typeof data === 'object') Object.defineProperty(data, '__falStoreIo', { value: headers['X-Fal-Store-IO'] ?? null, enumerable: false });
  return data;
}

/** Response meta (spec §1d, §2b): hard-photo decision, signals, engine and color match. No brand names, no prices. */
function responseMeta(v, engine) {
  const c = v.color || null;
  return {
    hard: v.hard === true,
    hardReasons: v.hardReasons || [],
    signals: v.signals || null,
    engine: engine.id === 'kontext' ? 'kontext-pro' : engine.id,
    warning: v.warning || null,
    colorMatch: c ? c.colorMatch : null,
    colorId: c ? c.colorId : null,
    colorHexUsed: c ? c.colorHexUsed : null,
  };
}

/**
 * Express handler factory.
 * @param {{ getClientFromToken: Function, ownerTokens: Set, fetchImpl?: typeof fetch }} deps
 */
function createRemodelGenerateHandler(deps) {
  return async function remodelGenerate(req, res) {
    // Any response sent before the first fal call releases this request's cap reservations (QA R65).
    let started = false;
    let renderUsd = 0;
    const early = async (code, obj) => { if (!started && typeof req.remodelReleaseAll === 'function') { try { await req.remodelReleaseAll(); } catch (_e) { /* fail-safe: slots stay used */ } } return res.status(code).json(obj); };
    try {
      const client = await deps.getClientFromToken(req);
      const auth = (req.headers.authorization || '').toString();
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      const isOwner = Boolean(token && deps.ownerTokens && deps.ownerTokens.has(token));
      if (!client && !isOwner) {
        return early(401, { error: 'Unauthorized' });
      }

      if (!getFalKey()) {
        return early(503, {
          error: 'Remodel generate is not configured (missing FAL_KEY)',
          honesty: HONESTY,
        });
      }

      const v = req.remodelValid || await validateGenerateRequest(req.body);
      if (v.error) return early(v.status || 400, { error: v.error, honesty: HONESTY });
      const { projectId, image_url } = v;
      const calls = planCalls(v);

      const sessionKey = sessionKeyFromReq(req);
      const budget = getSessionBudget(sessionKey);
      const remaining = remainingGenerates(budget);
      // Every fal call this request will make must fit the session cap before the first one goes out.
      if (remaining < calls.length) {
        return early(429, {
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
      const engine = selectEngine(v);
      if (!engine) return early(503, { error: 'Previews are paused right now. Please try again later.', honesty: HONESTY });
      if (engine.usesMask && calls.some((c) => !c.region)) return early(503, { error: 'Previews are paused right now. Please try again later.', honesty: HONESTY });
      // The up-front per-render ceiling is #14's capGate check (400, before any reservation); the per-call check below reads the same setting.
      const ceiling = renderMaxUsd(req);
      const backup = failoverEngine(engine);
      const size = engine.usesMask || backup ? imageSize(image_url) : null;
      if ((engine.usesMask || backup) && !size) return early(400, { error: 'Could not read image size', honesty: HONESTY });
      try {
      for (const c of calls) {
        const call = { ...c, ...(size ? { mask_url: regions.heuristicMask(c.region || 'finishes', size.w, size.h) } : {}) };
        if (!engine.usesMask) delete call.mask_url;
        const charge = (eng) => { budget.count += 1; budget.spendUsd += eng.usdPerCall(); budget.updatedAt = Date.now(); sessionSpend.set(sessionKey, budget); renderUsd += eng.usdPerCall(); };
        if (renderUsd + engine.usdPerCall() > ceiling + 1e-9) { const e = new Error('render ceiling'); e.code = 'RENDER_CEILING'; throw e; }
        let d;
        started = true;
        try {
          d = await withTimeout(engine.run(call, input, { fetchImpl: deps.fetchImpl }), engineTimeoutMs());
          // fal has billed once it returns: charge the session now, even if a later step fails.
          charge(engine);
        } catch (e) {
          if (!backup || !['FAL_UPSTREAM', 'FAL_FETCH', 'FAL_TIMEOUT'].includes(e && e.code)) throw e;
          // The failed attempt may still have billed: charge it, then the retry must fit every cap before it goes out.
          charge(engine);
          if (remainingGenerates(budget) < 1 || renderUsd + backup.usdPerCall() > ceiling + 1e-9) throw e;
          const ok = typeof req.remodelReserveExtra === 'function' ? await req.remodelReserveExtra(backup.usdPerCall()) : false;
          if (!ok) throw e;
          console.info('remodel_failover', JSON.stringify({ region: c.region || null, from: engine.id, to: backup.id, reason: e.code }));
          d = await withTimeout(backup.run({ ...call, mask_url: regions.heuristicMask(c.region || 'finishes', size.w, size.h) }, input, { fetchImpl: deps.fetchImpl }), engineTimeoutMs());
          charge(backup);
        }
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
      if (calls.length > 1) console.info(calls[0].region ? 'remodel_region_passes' : 'remodel_two_pass', JSON.stringify({ ids: results.map((d) => d.__falRequestId || null), passes: results.length }));
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
        provider: engine.model(),
        seed: data.seed ?? null,
        projectId,
        meta: responseMeta(v, engine),
      });
    } catch (e) {
      // QA R66 P3: nothing reached fal (thrown before the first call, or a NO_MASK refusal before anything billed): release all.
      if ((!started || (e && e.code === 'NO_MASK' && renderUsd === 0)) && typeof req.remodelReleaseAll === 'function') { try { await req.remodelReleaseAll(); } catch (_x) { /* fail-safe */ } }
      if (e && e.code === 'RENDER_CEILING') return res.status(429).json({ error: 'Preview limit reached for this render. Try fewer changes.', honesty: HONESTY });
      if (e && e.code === 'FAL_TIMEOUT') return res.status(502).json({ error: 'Image service failed — try again later', honesty: HONESTY });
      if (e && e.code === 'NO_MASK') return res.status(503).json({ error: 'Previews are paused right now. Please try again later.', honesty: HONESTY });
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
  maxOnHardOn,
  hardEngineId,
  validateGenerateRequest,
  resolveColor,
  responseMeta,
  BASE_KEEP,
  HARD_KEEP,
  fillEnabled,
  HEX_RE,
  presetsOn,
  cabinetsOnly,
  declutterOn,
  failoverEngine,
  qwenUsd,
  renderMaxUsd,
  QWEN_MODEL,
  selectEngine,
  fillUsd,
  MAX_FILL_USD,
  regionsOn,
  imageSize,
  withNegatives,
  FILL_MODEL,
  stripImageMetadata,
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
