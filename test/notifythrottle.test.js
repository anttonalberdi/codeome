const test = require('node:test');
const assert = require('node:assert/strict');
const { createNotifyThrottle } = require('../main/notifythrottle');

function fixture() {
  let time = 0, next = 1;
  const timers = new Map(), calls = [];
  const throttle = createNotifyThrottle({
    notify: (chatId, payload, merged) => calls.push({ chatId, payload, merged, time }),
    now: () => time,
    setTimer: (fn, delay) => { const id = next++; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimer: (id) => timers.delete(id)
  });
  function advance(ms) {
    const end = time + ms;
    while (true) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      time = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }
    time = end;
  }
  return { throttle, calls, timers, advance, setTime: (value) => { time = value; } };
}

test('first event passes and a burst makes one trailing generic notification', () => {
  const f = fixture();
  f.throttle.push('a', 5, { kind: 'ask' });
  assert.deepEqual(f.calls.map((call) => [call.chatId, call.payload.kind, call.merged]), [['a', 'ask', false]]);
  f.advance(1000);
  f.throttle.push('a', 5, { kind: 'approval' });
  f.throttle.push('a', 5, { kind: 'incoming' });
  f.advance(3999);
  assert.equal(f.calls.length, 1);
  f.advance(1);
  assert.deepEqual(f.calls.map((call) => [call.chatId, call.payload.kind, call.merged]),
    [['a', 'ask', false], ['a', 'incoming', true]]);
  assert.equal(f.timers.size, 0);
});

test('chats are independent and interval is respected after time advances', () => {
  const f = fixture();
  f.throttle.push('a', 5, { kind: 'ask' });
  f.throttle.push('b', 5, { kind: 'finished' });
  f.advance(5000);
  f.throttle.push('a', 5, { kind: 'incoming' });
  assert.deepEqual(f.calls.map((call) => [call.chatId, call.merged]),
    [['a', false], ['b', false], ['a', false]]);
});

test('close clears pending timers and stops later calls', () => {
  const f = fixture();
  f.throttle.push('a', 5, { kind: 'ask' });
  f.throttle.push('a', 5, { kind: 'approval' });
  assert.equal(f.timers.size, 1);
  f.throttle.close();
  assert.equal(f.timers.size, 0);
  f.advance(6000);
  f.throttle.push('a', 5, { kind: 'incoming' });
  assert.equal(f.calls.length, 1);
});

test('a backward clock jump begins a fresh window', () => {
  const f = fixture();
  f.setTime(10000);
  f.throttle.push('a', 5, { kind: 'ask' });
  f.setTime(1000);
  f.throttle.push('a', 5, { kind: 'incoming' });
  assert.deepEqual(f.calls.map((call) => [call.payload.kind, call.merged]), [['ask', false], ['incoming', false]]);
  assert.equal(f.timers.size, 0);
});

test('forget cancels one chat timer and permits a fresh window for that id', () => {
  const f = fixture();
  f.throttle.push('a', 5, { kind: 'ask' });
  f.throttle.push('a', 5, { kind: 'approval' });
  f.throttle.push('b', 5, { kind: 'incoming' });
  assert.equal(f.timers.size, 1);
  f.throttle.forget('a');
  assert.equal(f.timers.size, 0);
  f.advance(1000);
  f.throttle.push('a', 5, { kind: 'finished' });
  assert.deepEqual(f.calls.map((call) => [call.chatId, call.payload.kind]),
    [['a', 'ask'], ['b', 'incoming'], ['a', 'finished']]);
});
