const test = require('node:test');
const assert = require('node:assert/strict');
const { describePhone } = require('../renderer/js/phone');

test('phone indicator is hidden when the companion is disabled', () => {
  assert.deepEqual(describePhone({ enabled: false, listening: true, devices: [{ label: 'Phone', connected: true }] }),
    { hidden: true, tone: 'neutral', label: '', title: '', labels: [] });
});

test('phone indicator shows a neutral listening state without connected devices', () => {
  assert.deepEqual(describePhone({ enabled: true, listening: true, devices: [{ label: 'Paired phone', connected: false }] }),
    { hidden: false, tone: 'neutral', label: 'Phone: listening', title: 'Waiting for a phone to connect.', labels: [] });
});

test('phone indicator shows connected labels and a count for multiple phones', () => {
  const one = describePhone({ enabled: true, listening: true, devices: [{ label: 'iPhone', connected: true }] });
  assert.equal(one.label, 'Phone connected');
  assert.equal(one.title, 'Connected phone: iPhone');
  const markup = '<img src=x onerror=alert(1)>';
  const two = describePhone({ enabled: true, listening: true, devices: [
    { label: markup, connected: true }, { label: 'Pixel', connected: true }, { label: 'Offline', connected: false }
  ] });
  assert.equal(two.tone, 'connected');
  assert.equal(two.label, 'Phone connected (2)');
  assert.equal(two.title, `Connected phones: ${markup}, Pixel`);
  assert.deepEqual(two.labels, [markup, 'Pixel']);
});

test('phone indicator shows service errors when enabled but not listening', () => {
  assert.deepEqual(describePhone({ enabled: true, listening: false, error: 'no-tailnet-address' }),
    { hidden: false, tone: 'error', label: 'Phone: error', title: 'no-tailnet-address', labels: [] });
});

test('phone indicator handles missing status fields and labels', () => {
  assert.equal(describePhone().hidden, true);
  assert.deepEqual(describePhone({ enabled: true }),
    { hidden: false, tone: 'neutral', label: 'Phone: starting', title: 'Phone companion is starting.', labels: [] });
  assert.equal(describePhone({ enabled: true, listening: true }).label, 'Phone: listening');
  const connected = describePhone({ enabled: true, listening: true, devices: [{ connected: true }] });
  assert.deepEqual(connected.labels, ['Unnamed phone']);
  assert.equal(connected.title, 'Connected phone: Unnamed phone');
});
