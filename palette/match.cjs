'use strict';
/**
 * Paint text/hex -> our generic palette color (recipe-spec §2b; JS port of AI Bot's palette/match.py).
 * Order: raw hex -> alias exact -> longest alias contained -> fuzzy (Levenshtein <= 2 AND 1 - d/maxLen >= 0.8, the
 * difflib 0.8 cutoff from match.py; plain <= 2 mapped 'blue' to blush and 'tab' to beige) -> CSS named -> none.
 * Brand aliases (palette.json brandAliases) are OFF unless PALETTE_BRAND_ALIASES=1 exactly. When off, any brand
 * phrase in the text is dropped before matching, so a brand name never reaches the prompt or the response.
 */
const P = require('./palette.json');
const CSS = require('./css-named.json');

const STOP = new Set(['paint', 'color', 'colour', 'in', 'a', 'the', 'shade', 'tone', 'ish', 'satin', 'gloss', 'semi']);
const HEX_RE = /^#?[0-9a-fA-F]{6}$/;
function norm(s) {
  return String(s).toLowerCase().replace(/-/g, ' ').replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)).join(' ');
}
function brandAliasesOn(env = process.env) { return (env.PALETTE_BRAND_ALIASES || '').trim() === '1'; }

const BY_ID = new Map(P.colors.map((c) => [c.id, c]));
function table(brand) {
  const t = new Map();
  for (const c of P.colors) for (const a of [...c.aliases, c.id.replace(/-/g, ' ')]) t.set(norm(a), c);
  if (brand) for (const [id, list] of Object.entries(P.brandAliases || {})) for (const a of list) t.set(norm(a), BY_ID.get(id));
  return t;
}
const TABLES = { true: table(true), false: table(false) };
// Brand color names plus the maker names/codes users type with them ('SW 7008 Alabaster' -> 'sw' would otherwise remain).
const BRAND_MAKERS = ['sherwin williams', 'benjamin moore', 'behr', 'valspar', 'ppg', 'sw', 'bm'];
const BRAND_KEYS = [...Object.values(P.brandAliases || {}).flat().map(norm), ...BRAND_MAKERS].sort((a, b) => b.length - a.length);

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Returns { hex, id, method } with method in hex|alias|contains|fuzzy|css|none, plus text = brand-free normalized text. */
function matchColor(q, opts = {}) {
  const brand = opts.brandAliases ?? brandAliasesOn();
  const raw = String(q == null ? '' : q).trim();
  if (HEX_RE.test(raw)) return { hex: `#${raw.replace('#', '').toUpperCase()}`, id: null, method: 'hex', text: null };
  let n = norm(raw);
  if (!brand) for (const k of BRAND_KEYS) n = n.replace(new RegExp(`\\b${esc(k)}\\b`, 'g'), ' ').replace(/\s+/g, ' ').trim();
  const none = { hex: null, id: null, method: 'none', text: n || null };
  if (!n) return none;
  const AL = TABLES[brand];
  if (AL.has(n)) { const c = AL.get(n); return { hex: c.hex, id: c.id, method: 'alias', text: n }; }
  for (const k of [...AL.keys()].sort((a, b) => b.length - a.length)) {
    if (new RegExp(`\\b${esc(k)}\\b`).test(n)) { const c = AL.get(k); return { hex: c.hex, id: c.id, method: 'contains', text: n }; }
  }
  let best = null;
  for (const k of AL.keys()) { const d = lev(n, k); if (d <= 2 && 1 - d / Math.max(n.length, k.length) >= 0.8 && (!best || d < best.d)) best = { d, k }; }
  if (best) { const c = AL.get(best.k); return { hex: c.hex, id: c.id, method: 'fuzzy', text: n }; }
  const c = n.replace(/ /g, '');
  if (CSS[c]) return { hex: CSS[c], id: `css:${c}`, method: 'css', text: n };
  return none;
}

/** True when the brand strip (aliases OFF) actually removed a brand term from q. */
function brandStripped(q) {
  const n0 = norm(String(q || '')); let n = n0;
  for (const k of BRAND_KEYS) n = n.replace(new RegExp(`\\b${esc(k)}\\b`, 'g'), ' ').replace(/\s+/g, ' ').trim();
  return n !== n0.replace(/\s+/g, ' ').trim();
}
module.exports = { matchColor, brandStripped, brandAliasesOn, norm, lev, PALETTE: P };
