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
const KEEP_OTHERS = 'Keep all appliances and objects not in the target regions unchanged';
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
    lines.push(`${KEEP_OTHERS}. ${EXCLUDE}. ${NO_ADD}.`);
    lines.push('Output one photoreal still.');
    return { region: p.region, prompt: lines.join('\n'), negative: spec ? spec.negative.slice() : [], extras: p.extras.map(([k]) => k) };
  });
}

// ---- Free heuristic mask provider (for mask-capable engines). White = edit, black = keep. ----
// Bands are fractions of image height for a typical eye-level kitchen photo. Crude by design: an
// engine that segments for itself (Kontext, Gemini) ignores masks. Tables sit mostly in the middle band,
// so the counters band is narrow and the floor band starts low.
const MASK_BANDS = { vanity: [0.4, 0.9], tub_shower: [0.05, 0.9], walls: [0, 0.75], builtins: [0.1, 0.85], closet_doors: [0.05, 0.9], declutter: [0.3, 1.0], floor: [0.72, 1.0], cabinets: [0.15, 0.85], counters: [0.5, 0.6], finishes: [0, 1] };

// ---- 'Empty the room' pre-pass (REMODEL_DECLUTTER). Removes loose items and free-standing furniture first,
// so the region passes never see a table they could turn into countertop. Structure is kept.
const DECLUTTER_NEGATIVE = ['walls moved', 'windows changed', 'cabinets removed', 'appliances removed', 'new objects added', 'floor pattern changed'];
function declutterCall(room) {
  return {
    region: 'declutter',
    prompt: [
      `Edit this photo of a ${room || 'kitchen'}.`,
      'Remove every loose item from the countertops and remove all free-standing furniture from the middle of the room, especially any dining table, chairs, stools, benches and rugs.',
      'Fill the cleared areas with the existing floor and countertop surfaces so they look naturally empty.',
      'Keep the walls, windows, doors, cabinets, built-in appliances, sink, lighting, room layout and camera angle exactly as in the photo.',
      'Do not change any colors or materials. Do not add people, text, logos or new objects.',
      'Output one photoreal still.',
    ].join('\n'),
    negative: DECLUTTER_NEGATIVE.slice(),
  };
}

// Prefix for the failover engine (Qwen): it drifts layout more than Kontext, so the structure is pinned first.
const STRUCTURE_GUARD = 'Keep the exact layout, camera angle, walls and windows of this photo. Edit only inside the masked area.';

// ---- Room presets (REMODEL_ROOM_PRESETS, default OFF; kitchen keeps the plan above). No exterior/siding (dropped). ----
const ROOM_PRESETS = {
  bathroom: {
    rideAlong: ['walls'],
    keepObjects: 'Do not change the toilet, mirror, faucets, towels, lights or decor: keep their exact shape, material and color',
    regions: {
      vanity: { label: 'the bathroom vanity cabinet and its top', keep: 'floor, shower or tub, wall tile, toilet, mirror, fixtures and camera angle', negative: ['toilet changed', 'mirror changed', 'layout changed'] },
      floor: { label: 'the bathroom floor tile', keep: 'vanity, shower or tub, wall tile, toilet, fixtures and camera angle', negative: ['stripes', 'banding', 'painted lines', 'toilet changed'], floorGuard: true },
      tub_shower: { label: 'the shower and tub surround tile and glass', keep: 'vanity, floor, toilet, mirror, fixtures and camera angle', negative: ['fixtures moved', 'toilet changed', 'window changed'] },
      walls: { label: 'the wall tile and wall finish outside the shower', keep: 'vanity, floor, shower or tub, toilet, mirror, fixtures and camera angle', negative: ['mirror changed', 'fixtures moved'] },
    },
  },
  living: {
    keepObjects: 'Do not change any sofa, couch, armchair, coffee table, TV, rug, lamp, shelves contents or decor: keep their exact shape, material and color',
    regions: {
      floor: { label: 'the floor', keep: 'walls, built-ins, windows, sofas, chairs, tables and camera angle', negative: ['stripes', 'banding', 'painted lines', 'sofa changed', 'rug changed'], floorGuard: true },
      walls: { label: 'the wall paint', keep: 'floor, built-ins, windows, sofas, chairs, tables, art and camera angle', negative: ['sofa changed', 'art changed', 'windows changed'] },
      builtins: { label: 'the built-in shelving, cabinetry and fireplace surround only', keep: 'floor, walls, windows, sofas, chairs, tables and the items on the shelves', negative: ['sofa changed', 'shelf items changed', 'new built-ins added'] },
    },
  },
  bedroom: {
    keepObjects: 'Do not change the bed, bedding, headboard, nightstands, dresser, chairs, lamps, rug or decor: keep their exact shape, material and color',
    regions: {
      floor: { label: 'the floor', keep: 'walls, closet doors, windows, the bed and all furniture and camera angle', negative: ['stripes', 'banding', 'painted lines', 'bed changed', 'rug changed'], floorGuard: true },
      walls: { label: 'the wall paint', keep: 'floor, closet doors, windows, the bed and all furniture, art and camera angle', negative: ['bed changed', 'art changed'] },
      closet_doors: { label: 'the closet doors only', keep: 'floor, walls, windows, the bed and all furniture and camera angle', negative: ['bed changed', 'closet moved', 'new doors added'] },
    },
  },
};
const PRESET_ROOMS = Object.keys(ROOM_PRESETS);
/** Region plan for a non-kitchen preset: one call per chosen region, in preset order. */
function planPreset(room, finishes, phrase = (_r, v) => String(v)) {
  const pre = ROOM_PRESETS[room]; if (!pre) return null;
  const f = finishes || {};
  const label = room === 'living' ? 'living room' : room;
  const ride = (pre.rideAlong || []).filter((r) => present(f[r]));
  let picked = Object.entries(pre.regions).filter(([r]) => present(f[r]) && !(pre.rideAlong || []).includes(r));
  // Ride-along regions (bathroom wall tile) join the last call, like kitchen walls, so a full render stays at 3 calls.
  let extra = ride;
  if (!picked.length && ride.length) { picked = [[ride[0], pre.regions[ride[0]]]]; extra = ride.slice(1); }
  return picked.map(([r, spec], i) => ({
    region: r,
    prompt: [
      `Edit this photo of a ${label}.`,
      `Change only ${spec.label}: make it ${phrase(r, f[r])}.`,
      ...(i === picked.length - 1 ? extra.map((k) => `Also change ${pre.regions[k].label}: make it ${phrase(k, f[k])}.`) : []),
      ...(spec.floorGuard ? [`The floor must be ${FLOOR_GUARD}.`] : []),
      `Keep ${spec.keep} exactly as in the photo.`,
      `${KEEP_OTHERS}. ${pre.keepObjects}. ${NO_ADD}.`,
      'Output one photoreal still.',
    ].join('\n'),
    negative: spec.negative.slice(),
  }));
}

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

module.exports = { ROOM_PRESETS, PRESET_ROOMS, planPreset, declutterCall, DECLUTTER_NEGATIVE, STRUCTURE_GUARD, KEEP_OTHERS, REGION_ORDER, RIDE_ALONG, REGION_SPEC, EXCLUDE, FLOOR_GUARD, MASK_BANDS, planRegions, bandMask, heuristicMask, crc32 };
