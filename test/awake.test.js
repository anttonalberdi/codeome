const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAwake } = require('../main/awake');

function setup(enabled = () => true) {
  const calls = [];
  const blocker = { start: (t) => { calls.push(['start', t]); return 7; }, stop: (id) => calls.push(['stop', id]) };
  const awake = createAwake({ blocker, enabled });
  const session = (id) => { const s = new EventEmitter(); s.user = () => {}; awake.track(id, s); return s; };
  return { awake, calls, session };
}

test('holds the lock from a user message until the turn result', () => {
  const { awake, calls, session } = setup();
  const s = session('a');
  assert.equal(awake.held(), false);
  s.user('hi');
  assert.deepEqual(calls, [['start', 'prevent-app-suspension']]);
  s.emit('message', { type: 'assistant' });
  assert.equal(awake.held(), true);
  s.emit('message', { type: 'result' });
  assert.deepEqual(calls.at(-1), ['stop', 7]);
  assert.equal(awake.held(), false);
});

test('stays held until every session is idle, and exit releases', () => {
  const { awake, calls, session } = setup();
  const a = session('a'), b = session('b');
  a.user('x'); b.user('y');
  a.emit('message', { type: 'result' });
  assert.equal(awake.held(), true);
  b.emit('exit');
  assert.equal(awake.held(), false);
  assert.equal(calls.filter((c) => c[0] === 'start').length, 1);
});

test('does nothing when disabled', () => {
  const { awake, calls, session } = setup(() => false);
  session('a').user('x');
  assert.equal(awake.held(), false);
  assert.deepEqual(calls, []);
});
