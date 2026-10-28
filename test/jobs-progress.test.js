const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const jobs = require('../main/jobs');

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-jobs-progress-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeJob(root, job) {
  const dir = path.join(root, '.codeome', 'jobs', job.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job));
  return dir;
}

test('a job without progress keeps its original JSON', async (t) => {
  const root = project(t);
  const job = { id: 'recent', status: 'done', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), title: 'Original' };
  writeJob(root, job);
  assert.equal(JSON.stringify((await jobs.list(root))[0]), JSON.stringify(job));
});

test('missing or invalid progress is ignored silently', async (t) => {
  const root = project(t);
  const job = { id: 'active', engine: 'claude', status: 'running', startedAt: new Date().toISOString() };
  const dir = writeJob(root, job);
  const file = path.join(dir, 'progress.json');
  for (const content of [null, '', '{broken', 'null', '[]', '{"v":2,"stages":[]}', '{"v":1,"stages":{}}']) {
    if (content !== null) fs.writeFileSync(file, content);
    assert.deepEqual((await jobs.list(root))[0], job);
  }
});

test('symlink, oversized, directory and FIFO progress files are ignored', async (t) => {
  const root = project(t);
  const job = { id: 'active', engine: 'claude', status: 'running', startedAt: new Date().toISOString() };
  const dir = writeJob(root, job);
  const file = path.join(dir, 'progress.json');
  const target = path.join(root, 'target.json');
  fs.writeFileSync(target, JSON.stringify({ v: 1, stages: [{ id: 'x', state: 'running' }] }));
  fs.symlinkSync(target, file);
  assert.deepEqual((await jobs.list(root))[0], job);
  fs.unlinkSync(file);
  fs.writeFileSync(file, ' '.repeat(256 * 1024 + 1));
  assert.deepEqual((await jobs.list(root))[0], job);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.deepEqual((await jobs.list(root))[0], job);
  fs.rmdirSync(file);
  const fifo = spawnSync('mkfifo', [file]);
  if (fifo.status === 0) assert.deepEqual((await jobs.list(root))[0], job);
});

test('running jobs include a capped and sanitised progress summary', async (t) => {
  const root = project(t);
  const dir = writeJob(root, { id: 'active', engine: 'claude', status: 'running', startedAt: new Date().toISOString() });
  const stages = Array.from({ length: 52 }, (_, i) => ({ id: `stage-${i}`, label: `Stage ${i}`, state: 'waiting' }));
  stages[0] = { id: 'i'.repeat(50), label: 'l'.repeat(130), state: 'running', kind: 'determinate',
    done: true, total: 10, unit: 'u'.repeat(30), startedAt: null, endedAt: null,
    updatedAt: 't'.repeat(80), baselineSeconds: 2.5, extra: 'discard' };
  stages[1].state = 'unknown';
  fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify({ v: 1, updatedAt: 't'.repeat(80), stages, extra: 'discard' }));
  const summary = (await jobs.list(root))[0].progress;
  assert.equal(summary.updatedAt, 't'.repeat(64));
  assert.equal(summary.stages.length, 49);
  assert.deepEqual(summary.stages[0], { id: 'i'.repeat(40), label: 'l'.repeat(120), state: 'running',
    kind: 'determinate', total: 10, unit: 'u'.repeat(20), startedAt: null, endedAt: null,
    updatedAt: 't'.repeat(64), baselineSeconds: 2.5 });
  assert.equal(summary.stages.at(-1).id, 'stage-49');
  fs.writeFileSync(path.join(dir, 'progress.json'), '{"v":1,"updatedAt":"now","stages":[{"id":"x","state":"running","done":1e999}]}');
  assert.deepEqual((await jobs.list(root))[0].progress.stages, [{ id: 'x', state: 'running' }]);
});

test('old finished jobs omit progress and recent finished jobs include it', async (t) => {
  const root = project(t);
  const progress = { v: 1, updatedAt: new Date().toISOString(), stages: [] };
  const old = writeJob(root, { id: 'old', status: 'done', startedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(), endedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
  const recent = writeJob(root, { id: 'recent', status: 'failed', startedAt: new Date(Date.now() - 120000).toISOString(), endedAt: new Date(Date.now() - 60000).toISOString() });
  const pausing = writeJob(root, { id: 'pausing', engine: 'codex', status: 'pausing', pid: process.pid, startedAt: new Date().toISOString() });
  const paused = writeJob(root, { id: 'paused', status: 'paused', endedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
  const held = writeJob(root, { id: 'held', status: 'held', endedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
  const unknown = writeJob(root, { id: 'unknown', status: 'waiting', endedAt: 'bad' });
  for (const dir of [old, recent, pausing, paused, held, unknown]) fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify(progress));
  const listed = await jobs.list(root);
  assert.equal(Object.hasOwn(listed.find((job) => job.id === 'old'), 'progress'), false);
  assert.deepEqual(listed.find((job) => job.id === 'recent').progress, { updatedAt: progress.updatedAt, stages: [] });
  assert.deepEqual(listed.find((job) => job.id === 'pausing').progress, { updatedAt: progress.updatedAt, stages: [] });
  for (const id of ['paused', 'held', 'unknown']) {
    assert.deepEqual(listed.find((job) => job.id === id).progress, { updatedAt: progress.updatedAt, stages: [] });
  }
});
