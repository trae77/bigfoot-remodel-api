/**
 * Region targeting (CEO render score 5.5/10, 2026-11-01): renders turned the dining table into countertop,
 * barely changed counters, and striped the floor. Fix: one edit per region (floor, cabinets, counters),
 * each prompt scoped to that region only, with explicit exclusions for non-kitchen furniture and guards
 * against floor-pattern artifacts. Engine-agnostic: a plan is a list of { region, prompt, negative, mask? }
 * and any engine that implements run(call, imageUrl) can execute it (Kontext today; fal fill, Gemini, A/B later).
 *
 * Free by design: Kontext needs no mask (prompt-scoped). The optional mask provider is a pure-JS heuristic
 * (no model, no network, no cost). No new dependency.
 */
const zlib = require('zlib');

const REGION_ORDER = ['floor', 'cabinets', 'counters'];
// Finishes with no region of their own ride on the last region pass (fewest fal calls).
const RIDE_ALONG = ['walls', 'backsplash'];

// Things the model must never restyle. The dining table top was being turned into countertop.
const EXCLUDE = 'Do not change any table, dining table, table top, chairs, stools, benches, rugs, decor or other furniture: keep their exact shape, material and color';
const NO_ADD = 'Do not add people, text, logos, new furniture or new objects';
// Floor stripes in render 3: plain, uniform, no painted-on lines.
const FLOOR_GUARD = 'one uniform material across the whole floor, no stripes, no painted lines, no banding, no repeating light-dark bars, no rug, seams only where planks or tiles meet';

const REGION_SPEC = {
  floor: {
    label: 'the floor',
    keep: 'cabinets, countertops, walls, appliances, windows, table, chairs and camera angle',
    negative: ['stripes', 'banding', 'painted lines', 'pattern change on furniture', 'table or chairs changed'],
  },
  cabinets: {
    label: 'the cabinet doors, drawer fronts and cabinet boxes',
    keep: 'floor, countertops, walls, appliances, windows, table, chairs and camera angle',
    negative: ['table or chairs changed', 'new cabinets added', 'cabinet layout changed'],
  },
  counters: {
    label: 'the kitchen countertops that sit on top of the base cabinets and the island top only',
    keep: 'floor, cabinets, walls, appliances, windows, table, chairs and camera angle',
    negative: ['dining table top turned into countertop', 'table or chairs changed', 'counter shape changed'],
  },
};

function present(v) { return !(v == null || v === ''); }

/**
 * Build the region plan. phrase(region, value) turns a finish into model words (caller passes the existing
 * floor/cabinet phrasing so tier products and wood-plank rules stay identical).
 * @returns {{ region: string, prompt: string, negative: string[], extras: string[] }[]}
 */
function planRegions(room, finishes, phrase = (_r, v) => String(v)) {
  const f = finishes || {};
  const regions = REGION_ORDER.filter((r) => present(f[r]));
  const extras = RIDE_ALONG.filter((k) => present(f[k]));
  if (!regions.length && !extras.length) return [];
  const plan = regions.map((r) => ({ region: r, value: phrase(r, f[r]), extras: [] }));
  if (!plan.length) plan.push({ region: 'finishes', value: null, extras: [] });
  plan[plan.length - 1].extras = extras.map((k) => [k, f[k]]);
  return plan.map((p) => {
    const spec = REGION_SPEC[p.region];
    const lines = [`Edit this photo of a ${room || 'kitchen'}.`];
    if (spec) lines.push(`Change only ${spec.label}: make it ${p.value}.`);
    if (p.region === 'floor') lines.push(`The floor must be ${FLOOR_GUARD}.`);
    if (p.region === 'counters') lines.push('A table in the room is not a countertop: leave its top exactly as it is.');
    for (const [k, v] of p.extras) lines.push(`Also change ${k === 'walls' ? 'the wall paint' : 'the backsplash'} to ${v}.`);
    lines.push(`Keep ${spec ? spec.keep : 'floor, cabinets, countertops, appliances, windows, table, chairs and camera angle'} exactly as in the photo.`);
    lines.push(`${EXCLUDE}. ${NO_ADD}.`);
    lines.push('Output one photoreal still.');
    return { region: p.region, prompt: lines.join('\n'), negative: spec ? spec.negative.slice() : [], extras: p.extras.map(([k]) => k) };
  });
}

// ---- Free heuristic mask provider (for mask-capable engines). White = edit, black = keep. ----
// Bands are fractions of image height for a typical eye-level kitchen photo. Crude by design: an
// engine that segments for itself (Kontext, Gemini) ignores masks. Tables sit mostly in the middle band,
// so the counters band is narrow and the floor band starts low.
const MASK_BANDS = { floor: [0.72, 1.0], cabinets: [0.15, 0.85], counters: [0.5, 0.6], finishes: [0, 1] };

function crc32(buf) {
  let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** Grayscale PNG data URI, w x h, white rows inside [top, bottom) fraction band. */
function bandMask(w, h, [top, bottom]) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 8192 || h > 8192) throw new Error('bad mask size');
  const y0 = Math.floor(top * h); const y1 = Math.ceil(bottom * h);
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; if (y >= y0 && y < y1) raw.fill(255, y * (w + 1) + 1, (y + 1) * (w + 1)); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}
function heuristicMask(region, w, h) { return bandMask(w, h, MASK_BANDS[region] || MASK_BANDS.finishes); }

module.exports = { REGION_ORDER, RIDE_ALONG, REGION_SPEC, EXCLUDE, FLOOR_GUARD, MASK_BANDS, planRegions, bandMask, heuristicMask, crc32 };
