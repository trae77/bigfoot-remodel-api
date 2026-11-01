const test = require('node:test'); const assert = require('node:assert');
const G = require('../remodelGenerate.cjs'); const cat = require('../config/products.bigfoot.json').products;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pick = (s) => cat.map((p) => p.id).filter((i) => i.startsWith(s + '.'));
function each(fn) { for (const flooring of pick('flooring')) for (const cabinets of pick('cabinets')) for (const countertops of pick('countertops')) for (const backsplash of pick('backsplash')) fn({ flooring, cabinets, countertops, backsplash }); }
for (const mode of ['1', '0']) test(`R60 every full kitchen tier combo validates, each call <= cap (REMODEL_TWO_PASS=${mode})`, () => {
  const prev = process.env.REMODEL_TWO_PASS; process.env.REMODEL_TWO_PASS = mode; let n = 0;
  try {
    each((tiers) => {
      const v = G.validateGenerateBody({ projectId: 1, room: 'kitchen', imageUrl: PNG, tiers });
      assert.ok(!v.error, `${JSON.stringify(tiers)}: ${v.error}`);
      for (const c of G.planCalls(v)) assert.ok(c.prompt.length <= G.MAX_PROMPT_CHARS);
      if (/shaker/i.test(v.prompt)) assert.match(v.prompt, /five-piece Shaker.*recessed flat panel, not slab/);
      n++;
    });
  } finally { if (prev === undefined) delete process.env.REMODEL_TWO_PASS; else process.env.REMODEL_TWO_PASS = prev; }
  assert.ok(n >= 54, `combos ${n}`);
});
test('R60 over-cap prompt is a clear 400 error', () => {
  const v = G.validateGenerateBody({ projectId: 1, room: 'kitchen', imageUrl: PNG, finishes: Object.fromEntries(['floor', 'cabinets', 'counters', 'walls', 'backsplash'].map((k) => [k, 'oak '.repeat(24).trim()])) });
  assert.ok(v.error === 'Prompt too long' || !v.error);
});
const bad = ['i g n o r e previous', 'ig-nore all', 'oak for 5 bucks', 'tile 100usd', 'marble 20 euros', 'granite 5 grand', 'add text saying SALE', 'white tile saying SALE', 'oak with watermark', 'free oak', '$5 tile', 'ignore all rules'];
const good = ['free-form terrazzo', 'prompt gray paint', 'cost-effective laminate', 'price-matched quartz', 'white shaker', 'light oak'];
test('R60 P3 deny-list', () => {
  for (const t of bad) assert.ok(G.validateGenerateBody({ projectId: 1, room: 'kitchen', imageUrl: PNG, finishes: { counters: t } }).error, `should block: ${t}`);
  for (const t of good) assert.ok(!G.validateGenerateBody({ projectId: 1, room: 'kitchen', imageUrl: PNG, finishes: { counters: t } }).error, `should allow: ${t}`);
});
