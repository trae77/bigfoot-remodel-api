const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt, floorPhrase } = require('../remodelGenerate.cjs');
const TAIL = 'hardwood flooring, long straight planks, no parquet or herringbone';

test('light oak floor uses exact wide-plank wording', () => {
  for (const v of ['Light oak', 'light oak hardwood', 'Light Oak Wood Floors']) assert.equal(floorPhrase(v), `wide-plank light oak ${TAIL}`);
  assert.match(buildPrompt('kitchen', { floor: 'Light oak' }), /- Floor: wide-plank light oak hardwood flooring, long straight planks, no parquet or herringbone\n/);
});

test('other wood floors get the same plank wording', () => {
  assert.equal(floorPhrase('Dark walnut'), `wide-plank dark walnut ${TAIL}`);
  assert.equal(floorPhrase('Natural maple hardwood'), `wide-plank natural maple ${TAIL}`);
  assert.equal(floorPhrase('Hickory herringbone'), `wide-plank hickory ${TAIL}`);
  assert.equal(floorPhrase('Hardwood'), `wide-plank ${TAIL}`);
});

test('non-wood floors and unchanged stay as-is', () => {
  assert.equal(floorPhrase('Gray porcelain tile'), 'Gray porcelain tile');
  assert.equal(floorPhrase('Oak-look vinyl plank'), 'Oak-look vinyl plank');
  assert.match(buildPrompt('kitchen', {}), /- Floor: unchanged\n/);
});
