'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../regionTargeting.cjs');
const G = require('../remodelGenerate.cjs');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const KEYS = ['REMODEL_REGIONS', 'REMODEL_ROOM_PRESETS', 'REMODEL_REGION_MODE'];
function withEnv(env, fn) { const old = {}; for (const k of KEYS) { old[k] = process.env[k]; delete process.env[k]; } Object.assign(process.env, env); try { return fn(); } finally { for (const k of KEYS) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } } }
function plan(env, body) { return withEnv(env, () => { const v = G.validateGenerateBody({ projectId: 1, imageUrl: PNG, ...body }); assert.ok(!v.error, v.error); return G.planCalls(v); }); }
const ON = { REMODEL_REGIONS: '1', REMODEL_ROOM_PRESETS: '1' };

test('presets flag default OFF; needs regions ON', () => {
  withEnv({}, () => assert.equal(G.presetsOn(), false));
  withEnv({ REMODEL_ROOM_PRESETS: '1' }, () => assert.equal(G.presetsOn(), false));
  withEnv(ON, () => assert.equal(G.presetsOn(), true));
});
test('no exterior/siding preset', () => {
  assert.deepEqual(R.PRESET_ROOMS.sort(), ['bathroom', 'bedroom', 'living']);
  assert.ok(!/siding|exterior/i.test(JSON.stringify(R.ROOM_PRESETS)));
});
test('bathroom: vanity, tile floor, surround + wall tile folded into the last call = 3 calls', () => {
  const c = plan(ON, { room: 'bathroom', tiers: { flooring: 'flooring.better', vanity: 'vanity.better', tub_shower: 'tub_shower.good' }, finishes: { walls: 'white subway wall tile' } });
  assert.deepEqual(c.map((x) => x.region), ['vanity', 'floor', 'tub_shower']);
  for (const x of c) { assert.match(x.prompt, /Keep all appliances and objects not in the target regions unchanged/); assert.match(x.prompt, /toilet/); assert.ok(R.heuristicMask(x.region, 64, 48).startsWith('data:image/png;base64,')); }
  assert.match(c[0].prompt, /vanity/); assert.match(c[2].prompt, /shower and tub surround/); assert.match(c[2].prompt, /Also change the wall tile/);
  assert.ok(!/Also change/.test(c[0].prompt + c[1].prompt), 'wall tile only on the last call');
});
test('living: floor, walls, built-ins; sofas kept', () => {
  const c = plan(ON, { room: 'living', finishes: { floor: 'light oak planks', walls: 'warm white', builtins: 'painted navy shelving' } });
  assert.deepEqual(c.map((x) => x.region), ['floor', 'walls', 'builtins']);
  for (const x of c) assert.match(x.prompt, /Do not change any sofa/);
  assert.match(c[0].prompt, /one uniform material/);
});
test('bedroom: floor, walls, closet doors; bed kept', () => {
  const c = plan(ON, { room: 'bedroom', finishes: { floor: 'carpet', walls: 'sage green', closet_doors: 'white shaker sliding doors' } });
  assert.deepEqual(c.map((x) => x.region), ['floor', 'walls', 'closet_doors']);
  for (const x of c) assert.match(x.prompt, /Do not change the bed/);
});
test('only chosen regions are called', () => {
  assert.equal(plan(ON, { room: 'bedroom', finishes: { walls: 'sage green' } }).length, 1);
});
test('kitchen stays default region plan with presets ON; flag OFF = old plan for bathroom', () => {
  const k = plan(ON, { room: 'kitchen', finishes: { floor: 'oak', cabinets: 'white shaker', counters: 'quartz' } });
  assert.deepEqual(k.map((x) => x.region), ['floor', 'cabinets', 'counters']);
  const off = plan({ REMODEL_REGIONS: '1' }, { room: 'bathroom', tiers: { vanity: 'vanity.better' }, finishes: { floor: 'tile' } });
  assert.ok(!off.some((x) => x.region === 'vanity'));
});

test('bathroom: wall tile alone is one call', () => {
  const c = plan(ON, { room: 'bathroom', finishes: { walls: 'white subway wall tile' } });
  assert.deepEqual(c.map((x) => x.region), ['walls']); assert.ok(!/Also change/.test(c[0].prompt));
});
test('every preset full render is at most 3 calls', () => {
  assert.equal(plan(ON, { room: 'bathroom', tiers: { flooring: 'flooring.better', vanity: 'vanity.better', tub_shower: 'tub_shower.good' }, finishes: { walls: 'tile' } }).length, 3);
});
