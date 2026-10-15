const test = require('node:test');
const assert = require('node:assert');
const s = require('../main/suggest');

const Q = 'Next step (2) is template import. Want me to continue, or would you first like to run npm run dev and look at the shell?';

test('a message ending in a bare question wants suggestions', () => {
  assert.ok(s.wanted(Q));
  assert.ok(s.wanted('Shall I go ahead?**'));
  assert.ok(!s.wanted('Done. The tests pass.'));
  assert.ok(!s.wanted('Is this right? I changed the file.'));
});

test('a question that lists its own options is left alone', () => {
  assert.ok(!s.wanted('Which way?\n\n1. Keep both\n2. Drop the old one\n\nWhich do you prefer?'));
  assert.ok(!s.wanted('Pick one:\n- fast\n- safe\n\nWhat do you think?'));
  assert.ok(!s.wanted('Options:\nA) one\nB) two\nWhich?'));
});

test('the model output is cleaned to a short unique list', () => {
  assert.deepStrictEqual(s.parse('Sure: ["Continue", "continue", " Run dev first ", 5, ""]'), ['Continue', 'Run dev first']);
  assert.deepStrictEqual(s.parse('nope'), []);
  assert.deepStrictEqual(s.parse('[]'), []);
  assert.strictEqual(s.parse(JSON.stringify(['a', 'b', 'c', 'd', 'e'])).length, 4);
});

test('suggest asks Haiku about the last message only, and skips what needs no call', async () => {
  let calls = 0, seen;
  const run = async (engine, o) => { calls++; seen = { engine, ...o }; return { text: '["Continue", "Run dev first"]' }; };
  assert.deepStrictEqual(await s.suggest({ text: Q, run }), ['Continue', 'Run dev first']);
  assert.strictEqual(seen.model, 'haiku');
  assert.deepStrictEqual(await s.suggest({ text: 'All done.', run }), []);
  assert.deepStrictEqual(await s.suggest({ text: 'A?\n- x\n- y\nB?', run }), []);
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(await s.suggest({ text: Q, run: async () => { throw new Error('x'); } }), []);
  assert.deepStrictEqual(await s.suggest({ text: Q, run: async () => ({ text: '["only one"]' }) }), []);
});
