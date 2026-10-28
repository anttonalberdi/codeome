const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { progressView, STALL_SECONDS } = require('../renderer/js/progress');

const start = '2026-10-22T08:00:00Z';
const now = Date.parse('2026-10-22T08:02:00Z');

test('no progress or stages yields no view', () => {
  assert.equal(progressView(null, now), null);
  assert.equal(progressView({}, now), null);
  assert.equal(progressView({ stages: [] }, now), null);
});

test('running stage reports elapsed time, extrapolated ETA, and overall progress', () => {
  const view = progressView({ stages: [
    { id: 'prepare', label: 'Prepare', state: 'done', kind: 'setup' },
    { id: 'work', label: 'Work', state: 'running', kind: 'count', done: 3, total: 12, unit: 'files', startedAt: start, updatedAt: '2026-10-22T08:01:30Z' },
    { id: 'finish', label: 'Finish', state: 'waiting' }
  ] }, now);
  assert.equal(view.current, 1);
  assert.equal(view.doneCount, 1);
  assert.equal(view.total, 3);
  assert.ok(Math.abs(view.overallPct - 100 * 1.25 / 3) < 1e-10);
  assert.equal(view.stages[1].pct, 25);
  assert.equal(view.stages[1].elapsedSeconds, 120);
  assert.equal(view.stages[1].etaSeconds, 360);
  assert.equal(view.stages[1].unit, 'files');
  assert.equal(view.stages[1].stalled, false);
  assert.equal(view.stalled, false);
});

test('stall threshold uses stage update and falls back to progress update', () => {
  assert.equal(STALL_SECONDS, 120);
  const at = Date.parse(start);
  const view = progressView({ updatedAt: start, stages: [
    { id: 'exact', state: 'running', updatedAt: start },
    { id: 'fallback', state: 'running' },
    { id: 'newer', state: 'running', updatedAt: new Date(at + 10_000).toISOString() },
    { id: 'done', state: 'done', updatedAt: start }
  ] }, at + STALL_SECONDS * 1000 + 1);
  assert.deepEqual(view.stages.map((stage) => stage.stalled), [true, true, false, false]);
  assert.equal(view.stalled, true);
  const boundary = progressView({ updatedAt: start, stages: [{ state: 'running' }] }, at + STALL_SECONDS * 1000);
  assert.equal(boundary.stalled, false);
});

test('baseline supplies ETA only when extrapolation is unavailable', () => {
  const view = progressView({ stages: [
    { state: 'running', done: 0, total: 10, baselineSeconds: 150, startedAt: start },
    { state: 'running', baselineSeconds: 50, startedAt: start },
    { state: 'running', startedAt: start },
    { state: 'waiting', baselineSeconds: 150, startedAt: start }
  ] }, now);
  assert.deepEqual(view.stages.map((stage) => stage.etaSeconds), [30, 0, null, null]);
});

test('percentages are clamped and finished stages use endedAt', () => {
  const view = progressView({ stages: [
    { state: 'running', done: 15, total: 10, startedAt: start },
    { state: 'done', done: -2, total: 10, startedAt: start, endedAt: '2026-10-22T08:01:00Z' }
  ] }, now);
  assert.equal(view.stages[0].pct, 100);
  assert.equal(view.stages[0].etaSeconds, 0);
  assert.equal(view.stages[1].pct, 0);
  assert.equal(view.stages[1].elapsedSeconds, 60);
  assert.equal(view.overallPct, 100);
});

test('bad counts and dates do not produce NaN values or invented ETA', () => {
  const view = progressView({ updatedAt: 'bad', stages: [
    { state: 'running', done: NaN, total: Infinity, startedAt: 'bad', updatedAt: 'bad', baselineSeconds: NaN },
    { state: 'running', done: 2, total: 0, startedAt: 'bad' }
  ] }, now);
  assert.equal(view.stages[0].pct, null);
  assert.equal(view.stages[0].elapsedSeconds, null);
  assert.equal(view.stages[0].etaSeconds, null);
  assert.equal(view.stages[0].stalled, false);
  assert.equal(view.stages[1].pct, null);
  assert.equal(view.stages[1].etaSeconds, null);
  assert.equal(view.overallPct, 0);
});

test('running stages on stopped jobs have no live state, ETA, or stall', () => {
  for (const status of ['done', 'failed', 'cancelled', 'lost', 'paused', 'stale', 'held']) {
    const view = progressView({ updatedAt: start, stages: [
      { id: 'x', state: 'running', done: 2, total: 10, startedAt: start, baselineSeconds: 600 }
    ] }, now, { status });
    assert.equal(view.current, -1, status);
    assert.equal(view.stages[0].state, 'stopped', status);
    assert.equal(view.stages[0].etaSeconds, null, status);
    assert.equal(view.stages[0].elapsedSeconds, null, status);
    assert.equal(view.stages[0].stalled, false, status);
    assert.equal(view.stalled, false, status);
  }
});

test('browser script attaches the helper to App', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/js/progress.js'), 'utf8');
  const App = {};
  vm.runInNewContext(source, { App });
  assert.equal(App.progress.STALL_SECONDS, 120);
  assert.equal(App.progress.progressView(null, now), null);
});
