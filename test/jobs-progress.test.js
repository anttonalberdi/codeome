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
  assert.deepEqual((await jobs.list(root))[0], { ...job, estimate: null });
});

test('missing or invalid progress is ignored silently', async (t) => {
  const root = project(t);
  const job = { id: 'active', engine: 'claude', status: 'running', startedAt: new Date().toISOString() };
  const dir = writeJob(root, job);
  const file = path.join(dir, 'progress.json');
  for (const content of [null, '', '{broken', 'null', '[]', '{"v":2,"stages":[]}', '{"v":1,"stages":{}}']) {
    if (content !== null) fs.writeFileSync(file, content);
    assert.deepEqual((await jobs.list(root))[0], { ...job, estimate: null });
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
  assert.deepEqual((await jobs.list(root))[0], { ...job, estimate: null });
  fs.unlinkSync(file);
  fs.writeFileSync(file, ' '.repeat(256 * 1024 + 1));
  assert.deepEqual((await jobs.list(root))[0], { ...job, estimate: null });
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.deepEqual((await jobs.list(root))[0], { ...job, estimate: null });
  fs.rmdirSync(file);
  const fifo = spawnSync('mkfifo', [file]);
  if (fifo.status === 0) assert.deepEqual((await jobs.list(root))[0], { ...job, estimate: null });
});

test('running jobs include a capped and sanitised progress summary', async (t) => {
  const root = project(t);
  const dir = writeJob(root, { id: 'active', engine: 'claude', status: 'running', startedAt: new Date().toISOString() });
  const stages = Array.from({ length: 52 }, (_, i) => ({ id: `stage-${i}`, label: `Stage ${i}`, state: 'waiting' }));
  stages[0] = { id: 'i'.repeat(70), label: 'l'.repeat(130), state: 'running', kind: 'determinate',
    done: true, total: 10, unit: 'u'.repeat(30), startedAt: null, endedAt: null,
    updatedAt: 't'.repeat(80), baselineSeconds: 2.5, baselineSource: 'history', baselineRuns: 5,
    baselineLo: 1, baselineHi: 4, extra: 'discard' };
  stages[1].state = 'unknown';
  fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify({ v: 1, updatedAt: 't'.repeat(80), stages, extra: 'discard' }));
  const summary = (await jobs.list(root))[0].progress;
  assert.equal(summary.updatedAt, 't'.repeat(64));
  assert.equal(summary.stages.length, 49);
  assert.deepEqual(summary.stages[0], { id: 'i'.repeat(64), label: 'l'.repeat(120), state: 'running',
    kind: 'determinate', total: 10, unit: 'u'.repeat(20), startedAt: null, endedAt: null,
    updatedAt: 't'.repeat(64), baselineSeconds: 2.5, baselineSource: 'history', baselineRuns: 5,
    baselineLo: 1, baselineHi: 4 });
  assert.equal(summary.stages.at(-1).id, 'stage-49');
  fs.writeFileSync(path.join(dir, 'progress.json'), '{"v":1,"updatedAt":"now","stages":[{"id":"x","state":"running","done":1e999}]}');
  assert.deepEqual((await jobs.list(root))[0].progress.stages, [{ id: 'x', state: 'running' }]);
  fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify({ v: 1, stages: [
    { id: 'bad', state: 'waiting', baselineSeconds: -1, baselineSource: 'guess', baselineRuns: -2,
      baselineLo: '42', baselineHi: 'Infinity' },
    { id: 'good', state: 'waiting', baselineSeconds: 0, baselineSource: 'agent', baselineRuns: 0,
      baselineLo: null, baselineHi: 120 }
  ] }));
  assert.deepEqual((await jobs.list(root))[0].progress.stages, [
    { id: 'bad', state: 'waiting' },
    { id: 'good', state: 'waiting', baselineSeconds: 0, baselineSource: 'agent', baselineRuns: 0,
      baselineLo: null, baselineHi: 120 }
  ]);
});

test('job estimates match the CLI for the same role and engine', async (t) => {
  const root = project(t);
  const bin = path.join(root, '.codeome', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'kit', 'bin', 'codeome-agent'), path.join(bin, 'codeome-agent'));
  const now = Date.now();
  const durations = [300, 360, 480, 540, 10000];
  durations.forEach((seconds, i) => {
    const start = now - (i + 1) * 1000 - 20000;
    writeJob(root, { id: `job-${i}`, role: 'implementer', engine: 'codex', status: 'done',
      startedAt: new Date(start).toISOString(), endedAt: new Date(start + seconds * 1000).toISOString() });
  });
  writeJob(root, { id: 'failed', role: 'implementer', engine: 'codex', status: 'failed',
    startedAt: new Date(now - 1000).toISOString(), endedAt: new Date(now).toISOString() });
  writeJob(root, { id: 'claude', role: 'implementer', engine: 'claude', status: 'done',
    startedAt: new Date(now - 2000).toISOString(), endedAt: new Date(now - 1000).toISOString() });
  writeJob(root, { id: 'short', role: 'implementer', engine: 'codex', status: 'done',
    startedAt: new Date(now - 3000).toISOString(), endedAt: new Date(now - 2500).toISOString() });
  writeJob(root, { id: 'future', role: 'implementer', engine: 'codex', status: 'done',
    startedAt: new Date(now + 10000).toISOString(), endedAt: new Date(now + 20000).toISOString() });
  writeJob(root, { id: 'long', role: 'implementer', engine: 'codex', status: 'done',
    startedAt: new Date(now - 4000).toISOString(), endedAt: new Date(now + 10000001 * 1000).toISOString() });
  const linked = path.join(root, '.codeome', 'jobs', 'linked');
  fs.mkdirSync(linked);
  fs.symlinkSync(path.join(root, '.codeome', 'jobs', 'job-0', 'job.json'), path.join(linked, 'job.json'));
  const huge = path.join(root, '.codeome', 'jobs', 'huge');
  fs.mkdirSync(huge);
  fs.writeFileSync(path.join(huge, 'job.json'), ' '.repeat(1024 * 1024 + 1));
  const listed = await jobs.list(root);
  const estimate = listed.find((job) => job.id === 'job-0').estimate;
  const cli = spawnSync('python3', ['-B', path.join(bin, 'codeome-agent'), 'estimate', '--role', 'implementer', '--engine', 'codex', '--json'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, CODEOME_HOME: path.join(root, 'home') } });
  assert.equal(cli.status, 0, cli.stderr);
  const result = JSON.parse(cli.stdout);
  assert.deepEqual(estimate, { seconds: result.seconds, lo: result.lo, hi: result.hi, runs: result.runs });
  assert.deepEqual(estimate, { seconds: 420, lo: 330, hi: 510, runs: 4 });
  assert.deepEqual(listed.find((job) => job.id === 'failed').estimate, estimate);
  assert.deepEqual(listed.find((job) => job.id === 'claude').estimate, { seconds: 1, lo: null, hi: null, runs: 1 });
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
