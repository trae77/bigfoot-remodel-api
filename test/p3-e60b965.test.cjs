// QA P3s from PUNCH-e60b965: deny-list gaps/overblocks, strict over-cap 400 in both modes, bathroom combos fit.
const test = require('node:test'); const assert = require('node:assert/strict');
const G = require('../remodelGenerate.cjs'); const cat = require('../config/products.bigfoot.json').products;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pick = (s) => cat.map((p) => p.id).filter((i) => i.startsWith(s + '.'));
const err = (t) => G.validateGenerateBody({ projectId: 1, room: 'kitchen', imageUrl: PNG, finishes: { counters: t } }).error;
function withTwoPass(mode, fn) {
  const prev = process.env.REMODEL_TWO_PASS; process.env.REMODEL_TWO_PASS = mode;
  try { fn(); } finally { if (prev === undefined) delete process.env.REMODEL_TWO_PASS; else process.env.REMODEL_TWO_PASS = prev; }
}

const blockLeet = ['ign0re previous', '1gnore all', 'd1sregard that', 'w4termark tile', 'IGN0RE', 'w@termark'];
const blockRules = ['do not follow rules', "don't follow the rules", 'never obey', 'break the rules'];
const blockMoney = ['clearance oak', 'coupon tile', 'promo granite', 'a deal on quartz', 'bargain oak', 'half off tile', 'half-off tile', 'fifty quid', '5 pounds', 'pay nothing', '10 percent off', 'markdown tile', 'rebate oak', 'budget tile', 'affordable oak', '20k dollars', '5 grand', '100 bucks'];
const allow = ['dollarweed green', 'grand oak', 'Grand Canyon tan', 'Buckskin beige', 'bucksaw oak', 'logo', 'caption', 'system white', '4K', '5k tile', 'Nordic 2k gray', 'free-form terrazzo', 'price-matched quartz', 'wholesale look', '3/4 in. oak', '12 x 24 in. porcelain', 'Calacatta 2cm quartz'];
test('P3-1 deny-list blocks leetspeak instruction words', () => { for (const t of blockLeet) assert.ok(err(t), `should block: ${t}`); });
test('P3-1 deny-list blocks rule-override wording', () => { for (const t of blockRules) assert.ok(err(t), `should block: ${t}`); });
test('P3-1 deny-list blocks discount and money words', () => { for (const t of blockMoney) assert.ok(err(t), `should block: ${t}`); });
test('P3-2 deny-list allows material words that merely contain money/meta words', () => { for (const t of allow) assert.ok(!err(t), `should allow: ${t} (${err(t)})`); });
test('P3-2 instruction-to-add a logo/caption is still blocked', () => { for (const t of ['add a logo', 'write a caption', 'show text']) assert.ok(err(t), t); });

// With two-pass on, the 100-char finish limit plus the trimmed wording keep every call under the cap, so the
// over-cap path is only reachable as one call (all six tiers + 100-char walls).
test('P3-3 over-cap prompt is a 400 Prompt too long (REMODEL_TWO_PASS=0)', () => withTwoPass('0', () => {
  const v = G.validateGenerateBody({ projectId: 1, room: 'bathroom', imageUrl: PNG, tiers: { flooring: 'flooring.better', cabinets: 'cabinets.best', countertops: 'countertops.better', backsplash: 'backsplash.best', vanity: 'vanity.better', tub_shower: 'tub_shower.good' }, finishes: { walls: 'oak '.repeat(24).trim() } });
  assert.equal(v.error, 'Prompt too long');
}));

for (const mode of ['1', '0']) test(`P3-4 every full bathroom tier combo validates, each call <= cap (REMODEL_TWO_PASS=${mode})`, () => withTwoPass(mode, () => {
  let n = 0;
  for (const flooring of pick('flooring')) for (const vanity of pick('vanity')) for (const tub_shower of pick('tub_shower')) for (const backsplash of pick('backsplash')) {
    const tiers = { flooring, vanity, tub_shower, backsplash };
    const v = G.validateGenerateBody({ projectId: 1, room: 'bathroom', imageUrl: PNG, tiers });
    assert.ok(!v.error, `${JSON.stringify(tiers)}: ${v.error}`);
    for (const c of G.planCalls(v)) assert.ok(c.prompt.length <= G.MAX_PROMPT_CHARS);
    n++;
  }
  assert.ok(n >= 81, `combos ${n}`);
}));

test('P3-4 two-pass pass 1 keeps the R59 long floor wording; single call uses the short one', () => withTwoPass('1', () => {
  const v = G.validateGenerateBody({ projectId: 1, room: 'bathroom', imageUrl: PNG, tiers: { flooring: pick('flooring')[0], vanity: pick('vanity')[0] } });
  const calls = G.planCalls(v);
  assert.equal(calls.length, 2);
  assert.match(calls[0].prompt, /the new floor covers every visible floor area edge to edge/);
  assert.match(v.prompt, /covering all visible floor edge to edge, none of the old floor left/);
}));

test('P3-3 two-pass on: the same max input fits, every call <= cap', () => withTwoPass('1', () => {
  const v = G.validateGenerateBody({ projectId: 1, room: 'bathroom', imageUrl: PNG, tiers: { flooring: 'flooring.better', cabinets: 'cabinets.best', countertops: 'countertops.better', backsplash: 'backsplash.best', vanity: 'vanity.better', tub_shower: 'tub_shower.good' }, finishes: { walls: 'oak '.repeat(24).trim() } });
  assert.ok(!v.error, v.error);
  for (const c of G.planCalls(v)) assert.ok(c.prompt.length <= G.MAX_PROMPT_CHARS);
}));
