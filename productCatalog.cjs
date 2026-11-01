/**
 * Config-driven good/better/best product catalog (client-agnostic).
 * Loads REMODEL_PRODUCTS_FILE (default config/products.bigfoot.json). The client sends only product ids;
 * the prompt text always comes from this server-side file. The file holds no prices by design.
 */
const fs = require('node:fs');
const path = require('node:path');

const ID_RE = /^[a-z_]{1,40}\.[a-z_]{1,20}$/;
const PRICE_RE = /\$\s?\d|\b\d+(?:\.\d+)?\s?(?:usd|dollars?)\b/i;
let cached = null;

// A trailing model/SKU code: at least 5 characters of caps, digits and dashes, with both a letter and a digit
// (I96711LP3, KB36-UF, TSTB-TS404-LR-25X96). Short tokens such as '4K' or '36' are never touched.
const SKU_TAIL_RE = /\s+((?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)*)$/;
/** Public names never end in a SKU, and never carry case sizes in parentheses. If fewer than 2 words would remain, the original name is kept. */
function cleanDisplayName(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const orig = v.replace(/\s+/g, ' ').trim();
  let t = orig.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  for (let m = SKU_TAIL_RE.exec(t); m && m[1].replace(/-/g, '').length >= 5; m = SKU_TAIL_RE.exec(t)) t = t.slice(0, m.index).trim();
  return t.split(' ').filter(Boolean).length >= 2 ? t : orig;
}

function loadCatalog(file) {
  const f = file || process.env.REMODEL_PRODUCTS_FILE || path.join(__dirname, 'config', 'products.bigfoot.json');
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  const tiers = raw.tiers || ['good', 'better', 'best'];
  const categories = (raw.categories || []).map((c) => ({ id: c.id, label: c.label, promptSlot: c.promptSlot }));
  const catIds = new Set(categories.map((c) => c.id));
  const byId = new Map();
  for (const p of raw.products || []) {
    // A product counts only with a source URL, a category/tier we know, and a description with no price in it.
    if (!p || !ID_RE.test(p.id) || p.id !== `${p.category}.${p.tier}`) continue;
    if (!catIds.has(p.category) || !tiers.includes(p.tier)) continue;
    if (typeof p.source_url !== 'string' || !/^https:\/\//.test(p.source_url)) continue;
    if (typeof p.description !== 'string' || !p.description.trim() || PRICE_RE.test(p.description) || PRICE_RE.test(p.name || '')) continue;
    byId.set(p.id, { id: p.id, category: p.category, tier: p.tier, name: String(p.name || ''), description: p.description.trim(), tierLabel: typeof p.tierLabel === 'string' ? p.tierLabel : null, displayName: cleanDisplayName(p.displayName) });
  }
  const quoteOnly = (raw.quoteOnly || []).filter((q) => q && catIds.has(q.category)).map((q) => ({ category: q.category, tier: String(q.tier), label: String(q.label || 'Quote-only') }));
  return { tiers, categories, byId, quoteOnly };
}

function getCatalog() {
  if (!cached) cached = loadCatalog();
  return cached;
}
function resetCatalog() { cached = null; }

/** Public view: ids, labels and availability only. No prices, no URLs needed by the page. */
function publicCatalog(cat = getCatalog()) {
  return {
    tiers: cat.tiers,
    categories: cat.categories.map((c) => ({
      id: c.id,
      label: c.label,
      options: cat.tiers.map((t) => {
        const p = cat.byId.get(`${c.id}.${t}`);
        const label = (p && p.tierLabel) || t[0].toUpperCase() + t.slice(1);
        // Public name is the short display name only (no SKU or case size); without one, only the tier label shows.
        if (p) return { id: p.id, tier: t, label, available: true, ...(p.displayName ? { name: p.displayName } : {}) };
        const q = cat.quoteOnly.find((x) => x.category === c.id && x.tier === t);
        return { id: `${c.id}.${t}`, tier: t, label, available: false, note: q ? 'quote-only' : 'unavailable' };
      }).concat(cat.quoteOnly.filter((q) => q.category === c.id && !cat.tiers.includes(q.tier))
        .map((q) => ({ id: `${c.id}.${q.tier}`, tier: q.tier, label: q.label, available: false, note: 'quote-only' }))),
    })),
  };
}

/** Validate { category: productId } from the client. Returns { error } or { picks: { slot: description } }. */
function resolveTiers(input, cat = getCatalog()) {
  if (input == null) return { picks: {} };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'tiers must be an object' };
  const picks = {};
  for (const [k, v] of Object.entries(input)) {
    const c = cat.categories.find((x) => x.id === k);
    if (!c) return { error: 'Unknown tier category' };
    if (v == null || v === '') continue;
    if (typeof v !== 'string' || !ID_RE.test(v)) return { error: 'Unknown product' };
    const p = cat.byId.get(v);
    if (!p || p.category !== k) return { error: 'That product is unavailable' };
    picks[c.promptSlot] = p.description;
  }
  return { picks };
}

module.exports = { cleanDisplayName, loadCatalog, getCatalog, resetCatalog, publicCatalog, resolveTiers, PRICE_RE };
