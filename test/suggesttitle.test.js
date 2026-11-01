const test = require('node:test');
const assert = require('node:assert');
const s = require('../main/suggesttitle');

test('the model output is cleaned to two short unique names', () => {
  assert.deepStrictEqual(s.parse('["Tab renaming", "**HPC login fix.**", "x y z w"]'), ['Tab renaming', 'HPC login fix']);
  assert.deepStrictEqual(s.parse('["Phone page", "phone PAGE", "Chat tabs"]'), ['Phone page', 'Chat tabs']);
  assert.deepStrictEqual(s.parse('nope'), []);
  assert.deepStrictEqual(s.parse('[]'), []);
});

test('suggestTitle sends only the user messages to Haiku and survives failures', async () => {
  let seen;
  const run = async (engine, o) => { seen = { engine, ...o }; return { text: '["Tab names", "Chat tabs"]' }; };
  assert.deepStrictEqual(await s.suggestTitle({ messages: ['rename tabs', 'shorter'], run }), ['Tab names', 'Chat tabs']);
  assert.strictEqual(seen.model, 'haiku');
  assert.ok(seen.prompt.includes('- rename tabs'));
  assert.deepStrictEqual(await s.suggestTitle({ messages: [], run }), []);
  assert.deepStrictEqual(await s.suggestTitle({ messages: ['x'], run: async () => { throw new Error('no'); } }), []);
});
