'use strict';
/**
 * Hard-photo rule (recipe-spec §1c-1e). hard = hardPhoto === true OR busy_dark (edge >= HARD_EDGE_MIN AND
 * darkFrac >= HARD_DARK_MIN) OR panorama (aspect >= HARD_ASPECT_MAX) OR tall_narrow (aspect <= HARD_ASPECT_MIN).
 * Signals (§1b): downscale to 256 px wide, luma (PIL 'L': 299/587/114), darkFrac = share of luma < 50,
 * edgeDensity = share of |3x3 FIND_EDGES| > 40, aspect = w/h of the source. Computed with sharp before any paid call.
 * Low light alone is NOT a hard signal (§1a, w-bath-02-olivier).
 */
const DEFAULTS = { HARD_EDGE_MIN: 0.17, HARD_DARK_MIN: 0.14, HARD_ASPECT_MAX: 2.0, HARD_ASPECT_MIN: 0.70 };
const SIGNAL_WIDTH = 256;
const DARK_LUMA = 50;
const EDGE_ABS = 40;
// Render free (512 MB): refuse decode bombs (signals become null, only the client flag counts) and keep no libvips cache.
const MAX_INPUT_PIXELS = 40_000_000;
let sharpReady = false;

/** Thresholds from env; an unset, non-numeric or out-of-range value falls back to the spec default. */
function thresholds(env = process.env) {
  const t = {};
  for (const [k, d] of Object.entries(DEFAULTS)) {
    const raw = (env[k] || '').trim(); const n = Number(raw);
    t[k] = raw !== '' && Number.isFinite(n) && n > 0 && n <= 10 ? n : d;
  }
  return t;
}

const r4 = (x) => Math.round(x * 10000) / 10000;

/** Pure signal math on 8-bit RGB(A) pixels already at SIGNAL_WIDTH. */
function signalsFromPixels(data, width, height, channels, srcW, srcH) {
  const n = width * height; const L = new Uint8Array(n);
  let dark = 0;
  for (let i = 0, p = 0; i < n; i++, p += channels) {
    // PIL convert('L'): L = R*299/1000 + G*587/1000 + B*114/1000 (truncated)
    const l = channels >= 3 ? Math.floor((data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000) : data[p];
    L[i] = l; if (l < DARK_LUMA) dark++;
  }
  // PIL FIND_EDGES: kernel [-1,-1,-1,-1,8,-1,-1,-1,-1], output clipped to 0-255. PIL leaves the 1-px border
  // unfiltered (it keeps the luma value), and the spec's numbers include it, so the border counts the same way here.
  let edges = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const c = L[y * width + x];
    let s;
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1) s = c;
    else {
      s = 8 * c;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) s -= L[(y + dy) * width + x + dx];
    }
    if (Math.min(255, Math.max(0, s)) > EDGE_ABS) edges++;
  }
  return { w: srcW, h: srcH, aspect: r4(srcW / srcH), darkFrac: r4(dark / n), edgeDensity: r4(edges / n) };
}

/** Signals for a data:image URI, or null when the image can't be decoded (then only the client flag counts). */
async function computeSignals(dataUri, sharpImpl) {
  try {
    const m = /^data:image\/(?:jpeg|png|webp);base64,(.+)$/.exec(String(dataUri || ''));
    if (!m) return null;
    const sharp = sharpImpl || require('sharp');
    if (!sharpImpl && !sharpReady) { sharp.cache(false); sharp.concurrency(1); sharpReady = true; }
    const buf = Buffer.from(m[1], 'base64');
    const o = { limitInputPixels: MAX_INPUT_PIXELS };
    const meta = await sharp(buf, o).metadata();
    if (!meta.width || !meta.height) return null;
    const { data, info } = await sharp(buf, o).removeAlpha().resize({ width: SIGNAL_WIDTH, kernel: 'lanczos3' }).raw().toBuffer({ resolveWithObject: true });
    return signalsFromPixels(data, info.width, info.height, info.channels, meta.width, meta.height);
  } catch (_e) {
    return null;
  }
}

/** The rule itself. Returns { hard, hardReasons, warning }. */
function classify(signals, clientFlag, env = process.env) {
  const t = thresholds(env);
  const reasons = [];
  if (clientFlag === true) reasons.push('client_flag');
  if (signals) {
    if (signals.edgeDensity >= t.HARD_EDGE_MIN && signals.darkFrac >= t.HARD_DARK_MIN) reasons.push('busy_dark');
    if (signals.aspect >= t.HARD_ASPECT_MAX) reasons.push('panorama');
    if (signals.aspect <= t.HARD_ASPECT_MIN) reasons.push('tall_narrow');
  }
  return {
    hard: reasons.length > 0,
    hardReasons: reasons,
    warning: reasons.includes('panorama') ? 'Wide photos give weaker results; crop to one wall.' : null,
  };
}

module.exports = { DEFAULTS, SIGNAL_WIDTH, thresholds, signalsFromPixels, computeSignals, classify };
