const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt, floorPhrase } = require('../remodelGenerate.cjs');
const TAIL = 'hardwood flooring in long straight parallel planks';

test('light oak floor uses exact wide-plank wording', () => {
  for (const v of ['Light oak', 'light oak hardwood', 'Light Oak Wood Floors']) assert.equal(floorPhrase(v), `wide-plank light oak ${TAIL}`);
  assert.match(buildPrompt('kitchen', { floor: 'Light oak' }), /\nMain edit - Floor: replace the entire existing floor with wide-plank light oak hardwood flooring in long straight parallel planks; the new floor covers every visible floor area edge to edge and none of the old floor pattern, color or grain remains\.\n/);
});

test('other wood floors get the same plank wording', () => {
  assert.equal(floorPhrase('Dark walnut'), `wide-plank dark walnut ${TAIL}`);
  assert.equal(floorPhrase('Natural maple hardwood'), `wide-plank natural maple ${TAIL}`);
  assert.equal(floorPhrase('Hardwood'), `wide-plank ${TAIL}`);
});

test('non-wood floors and unchanged stay as-is', () => {
  assert.equal(floorPhrase('Gray porcelain tile'), 'Gray porcelain tile');
  assert.equal(floorPhrase('Oak-look vinyl plank'), 'Oak-look vinyl plank');
  const none = buildPrompt('kitchen', {});
  assert.ok(!/Floor:/.test(none)); assert.match(none, /room dimensions and the floor\./);
});

test('explicit herringbone/parquet keeps the pattern and wood type', () => {
  assert.equal(floorPhrase('White oak herringbone'), 'white oak hardwood flooring in a herringbone pattern');
  assert.equal(floorPhrase('Walnut parquet floors'), 'walnut hardwood flooring in a parquet pattern');
  assert.equal(floorPhrase('Herringbone'), 'hardwood flooring in a herringbone pattern');
  assert.ok(!/no parquet or herringbone/.test(floorPhrase('Hickory herringbone')));
});

test('CEO light oak prompt: floor leads, nothing names parquet or herringbone, preservation comes after', () => {
  const pr = buildPrompt('kitchen', { floor: 'light oak', cabinets: 'white shaker', counters: 'white quartz', walls: 'soft gray' });
  const lines = pr.split('\n');
  assert.equal(lines[0], 'Edit this photo of a kitchen.');
  assert.match(lines[1], /^Main edit - Floor: replace the entire existing floor with wide-plank light oak/);
  assert.ok(!/parquet|herringbone|chevron/i.test(pr), pr);
  assert.ok(pr.indexOf('Keep everything else') > pr.indexOf('- Wall paint/tile: soft gray'));
  assert.ok(!/unchanged/.test(pr));
});

test('catalog text that says "no parquet or herringbone" is cleaned before it reaches the prompt', () => {
  const pr = buildPrompt('kitchen', { floor: 'Oak strips, no parquet or herringbone, matte' }, { catalogSlots: new Set(['floor']) });
  assert.ok(!/parquet|herringbone/i.test(pr), pr);
  assert.match(pr, /Oak strips, matte; laid as long straight parallel planks/);
});

test('keep list never contradicts an edit: changing wall paint drops "walls" from what to keep', () => {
  const pr = buildPrompt('kitchen', { floor: 'light oak', cabinets: 'white shaker', counters: 'white quartz', walls: 'soft gray' });
  const keep = pr.split('\n').find((l) => l.startsWith('Keep everything else'));
  assert.ok(!/\bwalls\b/.test(keep), keep); assert.match(keep, /wall layout/);
  assert.ok(!/the floor/.test(keep));
  assert.match(buildPrompt('kitchen', { cabinets: 'x' }), /Keep everything else exactly as in the photo: walls, /);
});

test('floorPhrase strips "no ..." negations before it looks for a pattern word', () => {
  assert.equal(floorPhrase('no parquet please oak'), `wide-plank please oak ${TAIL}`);
  assert.ok(!/pattern|parquet/.test(floorPhrase('no parquet please oak')));
  assert.equal(floorPhrase('Oak without herringbone'), `wide-plank oak ${TAIL}`);
  assert.equal(floorPhrase('Walnut, no parquet or herringbone'), `wide-plank walnut ${TAIL}`);
  assert.equal(floorPhrase('White oak herringbone'), 'white oak hardwood flooring in a herringbone pattern');
  assert.equal(floorPhrase('no parquet'), 'a new plain floor');
  assert.ok(!/parquet|herringbone/i.test(buildPrompt('kitchen', { floor: 'no parquet please oak' })));
});

test('QA #5 P3: a removed negation leaves no stray comma', () => {
  assert.equal(floorPhrase('not parquet, oak'), `wide-plank oak ${TAIL}`);
  assert.equal(floorPhrase('Oak, no parquet, matte'), `wide-plank oak, matte ${TAIL}`);
  const pr = buildPrompt('kitchen', { floor: 'not parquet, oak' }, { catalogSlots: new Set(['floor']) });
  assert.match(pr, /replace the entire existing floor with oak; /);
  assert.ok(!/with [,;]|,\s*,|,\s*;/.test(pr), pr);
});
