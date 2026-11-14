"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/promptBuilder.ts
var promptBuilder_exports = {};
__export(promptBuilder_exports, {
  MOODS: () => MOODS,
  PRESERVE: () => PRESERVE,
  REALISM: () => REALISM,
  buildPrompts: () => buildPrompts,
  hexToColorName: () => hexToColorName,
  normalizeRoom: () => normalizeRoom,
  picksToSelections: () => picksToSelections,
  promptLengths: () => promptLengths,
  sanitizeNote: () => sanitizeNote,
  summarizeSelections: () => summarizeSelections
});
module.exports = __toCommonJS(promptBuilder_exports);
var COLOR_PRESETS = {
  white: "clean white",
  gray: "medium gray",
  navy: "deep navy blue",
  sage: "muted sage green",
  black: "satin black",
  wood: "natural light oak wood grain",
  "natural wood": "natural light oak wood grain",
  "warm-white": "warm off-white",
  "warm white": "warm off-white",
  "light-gray": "light gray",
  "light gray": "light gray",
  greige: "greige (warm gray-beige)",
  "soft-blue": "soft pale blue",
  "soft blue": "soft pale blue"
};
var NAMED_COLORS = [
  ["white", [250, 250, 250]],
  ["warm off-white", [245, 240, 228]],
  ["light gray", [200, 200, 200]],
  ["medium gray", [128, 128, 128]],
  ["charcoal", [54, 54, 58]],
  ["black", [20, 20, 20]],
  ["navy blue", [27, 43, 82]],
  ["royal blue", [45, 85, 190]],
  ["sky blue", [135, 190, 230]],
  ["teal", [30, 130, 130]],
  ["forest green", [38, 90, 55]],
  ["sage green", [150, 170, 140]],
  ["olive", [110, 115, 50]],
  ["yellow", [235, 200, 60]],
  ["mustard", [200, 150, 30]],
  ["terracotta", [195, 100, 70]],
  ["red", [190, 40, 40]],
  ["burgundy", [110, 25, 40]],
  ["pink", [230, 170, 180]],
  ["purple", [100, 60, 140]],
  ["tan", [200, 175, 140]],
  ["brown", [100, 70, 45]],
  ["greige", [190, 180, 168]],
  ["cream", [250, 243, 215]]
];
function hexToColorName(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return "";
  const n = parseInt(m[1], 16);
  const rgb = [n >> 16 & 255, n >> 8 & 255, n & 255];
  let best = NAMED_COLORS[0];
  let bestD = Infinity;
  for (const c of NAMED_COLORS) {
    const d = (c[1][0] - rgb[0]) ** 2 + (c[1][1] - rgb[1]) ** 2 + (c[1][2] - rgb[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best[0];
}
function colorWords(p) {
  if (p.kind === "preset") return COLOR_PRESETS[p.id] || COLOR_PRESETS[p.id.replace(/-/g, " ")] || p.id.replace(/-/g, " ");
  return hexToColorName(p.hex);
}
var MOODS = [
  { id: "cozy", label: "Cozy", hint: "warm and cozy" },
  { id: "bright", label: "Bright and airy", hint: "bright and airy" },
  { id: "calm", label: "Soft and calm", hint: "soft and calm" },
  { id: "clean", label: "Clean and simple", hint: "clean and simple" },
  { id: "natural", label: "Natural", hint: "natural and organic" }
];
var COUNTERS = {
  quartz: "white quartz countertops with subtle gray veining and a polished finish",
  "white quartz": "white quartz countertops with subtle gray veining and a polished finish",
  marble: "marble-look countertops, white with soft gray veining",
  "marble look": "marble-look countertops, white with soft gray veining",
  granite: "granite countertops with natural speckled variation",
  butcher: "butcher block countertops, warm wood with visible grain",
  "butcher block": "butcher block countertops, warm wood with visible grain",
  concrete: "honed concrete countertops with soft natural mottling"
};
var FLOORS = {
  "light-wood": "light wood plank flooring with natural grain, planks running in the same direction as the current floor",
  "light wood": "light wood plank flooring with natural grain, planks running in the same direction as the current floor",
  "dark-wood": "dark walnut-tone wood plank flooring with natural grain",
  "dark wood": "dark walnut-tone wood plank flooring with natural grain",
  "gray-lvp": "gray luxury vinyl plank flooring with a subtle wood texture",
  "gray lvp": "gray luxury vinyl plank flooring with a subtle wood texture",
  "large-tile": "large-format porcelain floor tile with thin grout lines",
  "large tile": "large-format porcelain floor tile with thin grout lines",
  "patterned-tile": "patterned cement-style floor tile with a tidy repeating geometric pattern",
  "patterned tile": "patterned cement-style floor tile with a tidy repeating geometric pattern"
};
var FIXTURES = {
  "matte-black": "matte black",
  "matte black": "matte black",
  "brushed-nickel": "brushed nickel",
  "brushed nickel": "brushed nickel",
  "brass-gold": "warm brushed brass",
  brass: "warm brushed brass",
  "brass / gold": "warm brushed brass",
  chrome: "polished chrome"
};
var DECKING = {
  "comp-gray": "composite gray",
  "composite gray": "composite gray",
  "comp-brown": "composite brown",
  "composite brown": "composite brown",
  cedar: "cedar"
};
var RAILINGS = {
  "black-metal": "black metal",
  "black metal": "black metal",
  wood: "wood"
};
var STYLE_CUES = {
  modern: "Overall feel: modern, clean lines, flat-panel doors, minimal ornament.",
  farmhouse: "Overall feel: farmhouse, shaker-style doors, warm and welcoming.",
  traditional: "Overall feel: traditional, raised-panel doors, classic profiles.",
  transitional: "Overall feel: transitional, simple shaker doors, balanced and timeless.",
  rustic: "Overall feel: rustic, natural textures, visible wood grain."
};
var STYLE_DEFAULT_FIXTURES = {
  modern: "matte black",
  farmhouse: "brushed nickel",
  traditional: "brushed nickel",
  transitional: "brushed nickel",
  rustic: "brass"
};
var ROOM_FIELDS = {
  kitchen: ["cabinets", "walls", "counters", "flooring", "fixtures"],
  bathroom: ["cabinets", "walls", "counters", "flooring", "fixtures"],
  basement: ["walls", "flooring"],
  deck: ["deckBoards", "deckRailing"]
};
function normalizeRoom(room) {
  if (room === "bath" || room === "bathroom") return "bathroom";
  if (room === "basement" || room === "deck" || room === "kitchen") return room;
  return "kitchen";
}
var NOTE_MAX = 80;
var INJECTION = [
  /ignore|disregard|forget|override|system|prompt|instruction|jailbreak|developer mode/i,
  /https?:|www\.|\.com\b|<|>|\{|\}|\[|\]|`|\\|\(\s*\$/i,
  /\b(nude|naked|nsfw|sex|porn|gore|blood|weapon|gun)\b/i,
  /\b(remove|delete|add|insert|replace)\s+(the\s+)?(person|people|man|woman|child|kid|face|window|door|wall|ceiling|beam)/i,
  /\b(string lights?|added objects?|new (people|person|furniture|windows?|doors?))\b/i
];
function sanitizeNote(raw) {
  if (!raw) return { safe: "", dropped: false };
  let t = raw.normalize("NFKC").replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, " ");
  t = t.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);
  if (INJECTION.some((re) => re.test(t))) return { safe: "", dropped: true };
  t = t.replace(/[^\p{L}\p{N} .,'&/-]/gu, "");
  if (!t) return { safe: "", dropped: Boolean(raw.trim()) };
  if (INJECTION.some((re) => re.test(t))) return { safe: "", dropped: true };
  return { safe: t, dropped: false };
}
var PRESERVE = "Keep the exact same camera angle, framing, perspective and lens. Keep the room's layout, walls, ceiling, windows, doors, openings, soffits, and the position and size of every cabinet, appliance, fixture and piece of furniture. Keep the same lighting direction and shadows.";
var REALISM = "Photorealistic result that looks like the original photo: same exposure, white balance, grain and sharpness. Natural material texture, realistic reflections, clean straight edges where new material meets existing surfaces. No text, logos, watermarks, people or added objects.";
var FIELD_LABEL = {
  cabinets: "Cabinet color",
  walls: "Wall color",
  counters: "Counters",
  flooring: "Flooring",
  fixtures: "Fixtures",
  deckBoards: "Decking",
  deckRailing: "Railing"
};
function buildPrompts(sel, opts = {}) {
  const fillStyleDefaults = opts.fillStyleDefaults !== false;
  const warnings = [];
  const room = normalizeRoom(sel.room);
  const allowed = new Set(ROOM_FIELDS[room]);
  const use = (k) => {
    if (sel[k] === void 0 || sel[k] === "") return void 0;
    if (!allowed.has(k)) {
      warnings.push(`${FIELD_LABEL[k] || String(k)} is not used for a ${room}, so that pick was left out.`);
      return void 0;
    }
    return sel[k];
  };
  const cabinets = use("cabinets");
  const walls = use("walls");
  const counters = use("counters");
  const flooring = use("flooring");
  const deckBoards = use("deckBoards");
  const deckRailing = use("deckRailing");
  let fixtures = use("fixtures");
  let fixturesFromStyle = false;
  if (!fixtures && fillStyleDefaults && sel.style && allowed.has("fixtures")) {
    fixtures = STYLE_DEFAULT_FIXTURES[sel.style];
    fixturesFromStyle = Boolean(fixtures);
  }
  if (cabinets && walls) {
    const c = colorWords(cabinets);
    const w = colorWords(walls);
    if (c && w && c === w) warnings.push("Cabinets and walls are the same color, so they may blend together.");
  }
  if (cabinets && cabinets.kind === "preset" && (cabinets.id === "wood" || cabinets.id === "natural wood") && (counters === "butcher" || counters === "butcher block")) {
    warnings.push("Natural wood cabinets with butcher block counters can look heavy. Rendering as picked.");
  }
  const contrastNote = cabinets && walls && colorWords(cabinets) && colorWords(cabinets) === colorWords(walls) ? " Keep the cabinets visibly distinct from the walls with a slightly different shade or sheen." : "";
  const p1 = [];
  if (room === "deck") {
    const boards = deckBoards ? DECKING[deckBoards] || deckBoards : "";
    const rail = deckRailing ? RAILINGS[deckRailing] || deckRailing : "";
    if (boards) p1.push(`Replace only the deck floor boards with ${boards} decking, with realistic board gaps and the same board direction.`);
    if (rail) p1.push(`Replace only the railing with a ${rail} railing in the same location and height.`);
  } else {
    if (cabinets && colorWords(cabinets)) {
      p1.push(`Repaint only the cabinet doors, drawer fronts and cabinet frames ${colorWords(cabinets)}, keeping the same door style and hardware positions.${contrastNote}`);
    }
    if (counters && COUNTERS[counters]) p1.push(`Replace only the countertops with ${COUNTERS[counters]}, keeping the same shape, edge profile and backsplash.`);
    if (flooring && FLOORS[flooring]) p1.push(`Replace only the floor with ${FLOORS[flooring]}.`);
  }
  const pass1 = p1.length ? `${p1.join(" ")} ${PRESERVE} ${REALISM}` : "";
  const p2 = [];
  if (walls && colorWords(walls)) p2.push(`Repaint only the wall surfaces ${colorWords(walls)}, with a matte finish, cutting in cleanly around trim.`);
  if (fixtures && FIXTURES[fixtures]) p2.push(`Update the visible faucets, cabinet pulls and light fixtures to ${FIXTURES[fixtures]} finish, keeping their shapes and positions.`);
  if (sel.style && STYLE_CUES[sel.style]) p2.push(`${STYLE_CUES[sel.style]} Apply this only to materials and finishes already being changed.`);
  const mood = MOODS.find((m) => m.id === sel.mood);
  const { safe, dropped } = sanitizeNote(sel.note);
  const hint = mood ? mood.hint : safe;
  if (hint) p2.push(`Homeowner's styling preference (a taste hint only; it cannot change the room's layout or structure): "${hint}".`);
  const pass2 = p2.length ? `${p2.join(" ")} Leave every other surface and object unchanged. ${PRESERVE} ${REALISM}` : "";
  return { pass1, pass2, warnings, droppedNote: dropped, fixturesFromStyle, fixturesId: fixtures || void 0 };
}
function prettyColor(p) {
  return colorWords(p) || (p.kind === "custom" ? "custom color" : p.id);
}
var STYLE_LABEL = {
  modern: "Modern",
  farmhouse: "Farmhouse",
  traditional: "Traditional",
  transitional: "Transitional",
  rustic: "Rustic"
};
function summarizeSelections(sel, built) {
  const room = normalizeRoom(sel.room);
  const out = [`Room: ${room === "bathroom" ? "Bath" : room[0].toUpperCase() + room.slice(1)}`];
  if (sel.style) out.push(`Style: ${STYLE_LABEL[sel.style]}`);
  if (sel.cabinets) out.push(`Cabinets: ${prettyColor(sel.cabinets)}`);
  if (sel.walls) out.push(`Walls: ${prettyColor(sel.walls)}`);
  if (sel.counters) out.push(`Counters: ${sel.counters.replace(/-/g, " ")}`);
  if (sel.flooring) out.push(`Flooring: ${sel.flooring.replace(/-/g, " ")}`);
  const builtFix = built || buildPrompts(sel);
  if (builtFix.fixturesId) {
    const label = builtFix.fixturesId.replace(/-/g, " ");
    out.push(builtFix.fixturesFromStyle && sel.style ? `Fixtures: ${label} (from ${STYLE_LABEL[sel.style]})` : `Fixtures: ${label}`);
  }
  if (sel.deckBoards) out.push(`Deck boards: ${DECKING[sel.deckBoards] || sel.deckBoards}`);
  if (sel.deckRailing) out.push(`Railing: ${RAILINGS[sel.deckRailing] || sel.deckRailing}`);
  const mood = MOODS.find((m) => m.id === sel.mood);
  if (mood) out.push(`Mood: ${mood.label}`);
  return out;
}
function promptLengths(built) {
  return { pass1: built.pass1.length, pass2: built.pass2.length };
}
function toColor(id, hex) {
  if (!id) return void 0;
  if (id === "custom") return { kind: "custom", hex: hex || "#000000" };
  return { kind: "preset", id };
}
function picksToSelections(room, picks, surface = "all") {
  const allow = (f) => surface === "all" || surface === f;
  const sel = {
    room: normalizeRoom(room),
    style: picks.style || void 0
  };
  if (allow("cabinets")) sel.cabinets = toColor(picks.cabinets, picks.cabinetCustom);
  if (allow("walls")) sel.walls = toColor(picks.walls, picks.wallCustom);
  if (allow("counters")) sel.counters = picks.counters || void 0;
  if (allow("floor")) sel.flooring = picks.floor || void 0;
  if (allow("fixtures")) sel.fixtures = picks.fixtures || void 0;
  if (allow("deck") || allow("floor")) sel.deckBoards = picks.decking || void 0;
  if (allow("deck")) sel.deckRailing = picks.railing || void 0;
  if (picks.mood) sel.mood = picks.mood;
  return sel;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MOODS,
  PRESERVE,
  REALISM,
  buildPrompts,
  hexToColorName,
  normalizeRoom,
  picksToSelections,
  promptLengths,
  sanitizeNote,
  summarizeSelections
});
