const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tasks, list } = require('../main/jobs');

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-tasks-progress-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function taskDir(root, key) {
  const dir = path.join(root, '.codeome', 'jobs', '.tasks', key);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('task progress returns only valid, sanitised files without changing jobs.list', async (t) => {
  const root = project(t);
  const dir = taskDir(root, 'task-1');
  fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify({ v: 1, updatedAt: 'u'.repeat(80), extra: true,
    stages: [{ id: 'i'.repeat(50), label: 'l'.repeat(130), state: 'running', kind: 'determinate',
      done: 2, total: 5, unit: 'x'.repeat(30), startedAt: null, extra: true },
    { id: 'bad', state: 'unknown' }] }));
  assert.deepEqual(tasks.progress(root, ['task-1', 'missing']), {
    'task-1': { updatedAt: 'u'.repeat(64), stages: [{ id: 'i'.repeat(40), label: 'l'.repeat(120),
      state: 'running', kind: 'determinate', done: 2, total: 5, unit: 'x'.repeat(20), startedAt: null }] }
  });
  assert.deepEqual(await list(root), []);
});

test('missing, corrupt, wrong-version, oversized and non-regular files are ignored', (t) => {
  const root = project(t);
  const dir = taskDir(root, 'task');
  const file = path.join(dir, 'progress.json');
  for (const content of [null, '{broken', '{"v":2,"stages":[]}', ' '.repeat(256 * 1024 + 1)]) {
    if (content !== null) fs.writeFileSync(file, content);
    assert.deepEqual(tasks.progress(root, ['task']), {});
  }
  fs.unlinkSync(file);
  const target = path.join(root, 'target.json');
  fs.writeFileSync(target, '{"v":1,"stages":[]}');
  fs.symlinkSync(target, file);
  assert.deepEqual(tasks.progress(root, ['task']), {});
  fs.unlinkSync(file);
  const fifo = spawnSync('mkfifo', [file]);
  if (fifo.status === 0) assert.deepEqual(tasks.progress(root, ['task']), {});
});

test('symlinked task directories are ignored', (t) => {
  const root = project(t);
  const tasksDir = path.join(root, '.codeome', 'jobs', '.tasks');
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  fs.mkdirSync(path.dirname(tasksDir), { recursive: true });
  fs.symlinkSync(real, tasksDir);
  const linkedKey = path.join(real, 'linked');
  fs.mkdirSync(linkedKey);
  fs.writeFileSync(path.join(linkedKey, 'progress.json'), '{"v":1,"stages":[]}');
  assert.deepEqual(tasks.progress(root, ['linked']), {});
  fs.unlinkSync(tasksDir);
  fs.mkdirSync(tasksDir);
  fs.symlinkSync(linkedKey, path.join(tasksDir, 'linked'));
  assert.deepEqual(tasks.progress(root, ['linked']), {});
});

test('symlinked .codeome and jobs directories are ignored', (t) => {
  for (const segment of ['.codeome', 'jobs']) {
    const root = project(t);
    const outside = path.join(root, 'outside');
    const realTask = path.join(outside, 'jobs', '.tasks', 'linked');
    fs.mkdirSync(realTask, { recursive: true });
    fs.writeFileSync(path.join(realTask, 'progress.json'), '{"v":1,"stages":[]}');
    if (segment === '.codeome') fs.symlinkSync(outside, path.join(root, '.codeome'));
    else {
      fs.mkdirSync(path.join(root, '.codeome'));
      fs.symlinkSync(path.join(outside, 'jobs'), path.join(root, '.codeome', 'jobs'));
    }
    assert.deepEqual(tasks.progress(root, ['linked']), {});
  }
});

test('invalid keys are skipped and requests are capped at 20 keys', (t) => {
  const root = project(t);
  for (const key of ['valid', 'last']) {
    fs.writeFileSync(path.join(taskDir(root, key), 'progress.json'), '{"v":1,"stages":[]}');
  }
  assert.deepEqual(tasks.progress(root, ['../x', 'a/b', '', 'a'.repeat(65), 7, 'a..b', 'valid']),
    { valid: { stages: [] } });
  assert.deepEqual(tasks.progress(root, [...Array(20).fill('missing'), 'last']), {});
  assert.deepEqual(tasks.progress(root, ['last']), { last: { stages: [] } });
  assert.deepEqual(tasks.progress(root, null), {});
});
