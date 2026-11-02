/**
 * Engine interface for remodel edits. An engine is:
 *   { id, usdPerCall, usesMask, run({ prompt, negative, mask_url?, guidance_scale? }, imageUrl, { fetchImpl }) -> fal-shaped { images:[{url}] } }
 * The handler only sees this shape, so AI Bot's A/B or a Gemini engine plugs in by adding an entry here.
 * Every run() is one billable call and is counted by the durable D1 caps (planCalls length) before it goes out.
 */
const ENGINES = {};
function register(id, engine) { ENGINES[id] = { id, ...engine }; }
/** REMODEL_REGION_ENGINE (default 'kontext'). Unknown ids fail safe to kontext (no new spend path). */
function engineId() {
  const k = (process.env.REMODEL_REGION_ENGINE || '').trim().toLowerCase();
  return Object.hasOwn(ENGINES, k) && ENGINES[k].available() ? k : 'kontext';
}
function getEngine(id = engineId()) { return ENGINES[id] || ENGINES.kontext; }
module.exports = { ENGINES, register, engineId, getEngine };
