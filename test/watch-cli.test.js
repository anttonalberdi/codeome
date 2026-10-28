const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const source = path.join(__dirname, '..', 'kit', 'bin', 'codeome-agent');
const fixtures = path.join(__dirname, 'fixtures', 'watch');
const snakemakeFixtures = path.join(__dirname, 'fixtures', 'snakemake');

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-watch-'));
  const bin = path.join(root, '.codeome', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(source, path.join(bin, 'codeome-agent'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function paths(root, key = 'task-1') {
  const dir = path.join(root, '.codeome', 'jobs', '.tasks', key);
  return { dir, file: path.join(dir, 'progress.json') };
}

function progress(root, key) {
  return JSON.parse(fs.readFileSync(paths(root, key).file, 'utf8'));
}

function stage(root, key) {
  return progress(root, key).stages[0];
}

function run(root, args, env = {}, timeout) {
  return spawnSync('python3', ['-B', path.join(root, '.codeome', 'bin', 'codeome-agent'), ...args], {
    cwd: root, encoding: 'utf8', timeout,
    env: { ...process.env, CODEOME_WATCH_TEST: '1', CODEOME_WATCH_POLL: '0.03', CODEOME_WATCH_WAIT: '0.1', ...env }
  });
}

function launch(t, root, args, env = {}) {
  const child = spawn('python3', ['-B', path.join(root, '.codeome', 'bin', 'codeome-agent'), 'watch', ...args], {
    cwd: root, env: { ...process.env, CODEOME_WATCH_TEST: '1', CODEOME_WATCH_POLL: '0.03', CODEOME_WATCH_WAIT: '0.1', ...env }
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  return { child, result };
}

async function until(check, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (check()) return; } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('timed out waiting for watcher progress');
}

function fixture(name) {
  return fs.readFileSync(path.join(fixtures, name), 'utf8');
}

function snakemakeFixture(name) {
  return fs.readFileSync(path.join(snakemakeFixtures, name), 'utf8');
}

test('watch timeout defaults and production timing floors', () => {
  const probe = [
    'import json, runpy, sys',
    'w = runpy.run_path(sys.argv[1])',
    "print(json.dumps([w['watch_default_timeout']('vitest', None), w['watch_default_timeout']('slurm', None),",
    "  w['watch_default_timeout']('snakemake', '/remote.log'),",
    "  w['watch_interval']('CODEOME_WATCH_SLURM_POLL', 30, 15),",
    "  w['watch_interval']('CODEOME_WATCH_REMOTE_POLL', 5, 2),",
    "  w['watch_interval']('CODEOME_WATCH_SSH_TIMEOUT', 15, 5)]))"
  ].join('\n');
  const runProbe = (env) => spawnSync('python3', ['-B', '-c', probe, source], {
    encoding: 'utf8', env: { ...process.env, ...env }
  });
  const overrides = { CODEOME_WATCH_SLURM_POLL: '0.1', CODEOME_WATCH_REMOTE_POLL: '0.1', CODEOME_WATCH_SSH_TIMEOUT: '0.1' };
  let r = runProbe({ ...overrides, CODEOME_WATCH_TEST: '0' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [21600, 259200, 259200, 15, 2, 5]);
  r = runProbe({ ...overrides, CODEOME_WATCH_TEST: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [21600, 259200, 259200, 0.1, 0.1, 0.1]);
  r = runProbe({ ...overrides, CODEOME_WATCH_SLURM_POLL: 'bad', CODEOME_WATCH_REMOTE_POLL: 'bad',
    CODEOME_WATCH_SSH_TIMEOUT: 'bad', CODEOME_WATCH_TEST: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), [21600, 259200, 259200, 30, 5, 15]);
});

test('vitest tails a growing log and counts unique files', async (t) => {
  const root = project(t);
  const log = path.join(root, 'vitest.log');
  fs.writeFileSync(log, '');
  const jobs = path.join(root, '.codeome', 'jobs');
  fs.mkdirSync(jobs, { recursive: true });
  fs.writeFileSync(path.join(jobs, '.progress-history.json'), JSON.stringify({ unit: [2, 4] }));
  const watch = launch(t, root, ['--log', log, '--parser', 'vitest', '--total', '2', '--label', 'Unit tests', '--task', 'vitest', '--stage', 'unit']);
  await until(() => fs.existsSync(paths(root, 'vitest').file));
  const lines = fixture('vitest.txt').split('\n');
  fs.appendFileSync(log, `\x1b[32m${lines[0]}\x1b[0m\n${lines[1]}\n`);
  await until(() => stage(root, 'vitest').done === 1);
  assert.equal(stage(root, 'vitest').state, 'running');
  fs.appendFileSync(log, `${lines[2]}\n${lines[3]}\n`);
  const result = await watch.result;
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /watch vitest: done/);
  assert.equal(result.stderr, '');
  assert.equal(progress(root, 'vitest').v, 1);
  assert.deepEqual({ id: stage(root, 'vitest').id, label: stage(root, 'vitest').label,
    done: stage(root, 'vitest').done, total: stage(root, 'vitest').total, unit: stage(root, 'vitest').unit,
    state: stage(root, 'vitest').state },
  { id: 'unit', label: 'Unit tests', done: 2, total: 2, unit: 'files', state: 'done' });
  assert.match(stage(root, 'vitest').startedAt, /\.\d{6}Z$/);
  assert.match(stage(root, 'vitest').endedAt, /\.\d{6}Z$/);
  assert.equal(stage(root, 'vitest').baselineSeconds, 3);
});

test('vitest failure marker makes a complete count fail', (t) => {
  const root = project(t);
  const log = path.join(root, 'fail.log');
  fs.writeFileSync(log, '   ✗ src/lib/foo.test.ts  (1 test)\n Test Files  1 failed (1)\n');
  const r = run(root, ['watch', '--log', log, '--parser', 'vitest', '--total', '1', '--label', 'Tests', '--task', 'fail']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stage(root, 'fail').state, 'failed');
  assert.equal(stage(root, 'fail').done, 1);
});

test('vitest ignores passing names containing failed, but recognises failure summaries', (t) => {
  const root = project(t);
  const log = path.join(root, 'names.log');
  fs.writeFileSync(log, ' ✓ src/a.test.ts > handles failed login\n Test Files  1 passed (1)\n Tests  1 passed (1)\n');
  let r = run(root, ['watch', '--log', log, '--parser', 'vitest', '--total', '1', '--label', 'Tests', '--task', 'names']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stage(root, 'names').state, 'done');
  fs.writeFileSync(log, ' ✓ src/a.test.ts > handles failed login\n Tests  1 failed (1)\n Test Files  1 passed (1)\n');
  r = run(root, ['watch', '--log', log, '--parser', 'vitest', '--total', '1', '--label', 'Tests', '--task', 'summary-fail']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stage(root, 'summary-fail').state, 'failed');
  fs.writeFileSync(log, ' ✓ src/a.test.ts > handles failed login\n FAIL src/a.test.ts\n Test Files  1 passed (1)\n');
  r = run(root, ['watch', '--log', log, '--parser', 'vitest', '--total', '1', '--label', 'Tests', '--task', 'fail-line']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stage(root, 'fail-line').state, 'failed');
});

test('pytest reads percent markers and summary failures', (t) => {
  const root = project(t);
  const log = path.join(root, 'pytest.log');
  fs.writeFileSync(log, fixture('pytest.txt'));
  let r = run(root, ['watch', '--log', log, '--parser', 'pytest', '--label', 'Pytest', '--task', 'py', '--quiet']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.deepEqual([stage(root, 'py').done, stage(root, 'py').total, stage(root, 'py').unit, stage(root, 'py').state], [100, 100, '%', 'done']);
  fs.writeFileSync(log, '[100%]\n==== 1 failed in 0.13s ====\n');
  r = run(root, ['watch', '--log', log, '--parser', 'pytest', '--label', 'Pytest', '--task', 'py-fail']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stage(root, 'py-fail').state, 'failed');
});

test('snakemake tails a growing log and gets its total from Job stats', async (t) => {
  const root = project(t);
  const log = path.join(root, 'snakemake.log');
  fs.writeFileSync(log, '');
  const watch = launch(t, root, ['--log', log, '--parser', 'snakemake', '--label', 'Workflow', '--task', 'snake']);
  await until(() => fs.existsSync(paths(root, 'snake').file));
  const lines = snakemakeFixture('normal.txt').split('\n');
  fs.appendFileSync(log, `${lines.slice(0, 8).join('\n')}\n`);
  await until(() => stage(root, 'snake').total === 3);
  assert.deepEqual([stage(root, 'snake').done, stage(root, 'snake').state], [0, 'running']);
  fs.appendFileSync(log, `${lines.slice(8, 10).join('\n')}\n`);
  await until(() => stage(root, 'snake').done === 1);
  assert.deepEqual([stage(root, 'snake').total, stage(root, 'snake').state], [3, 'running']);
  fs.appendFileSync(log, `${lines.slice(10).join('\n')}`);
  const result = await watch.result;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual([stage(root, 'snake').id, stage(root, 'snake').label, stage(root, 'snake').done,
    stage(root, 'snake').total, stage(root, 'snake').unit, stage(root, 'snake').state],
  ['snakemake', 'Workflow', 3, 3, 'steps', 'done']);
});

test('snakemake retry does not lower progress for the same total', (t) => {
  const root = project(t);
  const log = path.join(root, 'retry.log');
  const lines = snakemakeFixture('retry.txt').split('\n');
  const restart = lines.indexOf('0 of 2 steps (0%) done');
  fs.writeFileSync(log, `${lines.slice(0, restart + 1).join('\n')}\n`);
  const first = run(root, ['watch', '--log', log, '--parser', 'snakemake', '--label', 'Workflow', '--task', 'retry', '--pid', '99999999']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(stage(root, 'retry').done, 1);
  fs.appendFileSync(log, `${lines.slice(restart + 1).join('\n')}`);
  const result = run(root, ['watch', '--log', log, '--parser', 'snakemake', '--label', 'Workflow', '--task', 'retry']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual([stage(root, 'retry').done, stage(root, 'retry').total, stage(root, 'retry').state], [2, 2, 'done']);
});

test('snakemake handles failures, retries, summaries, and name text', (t) => {
  const root = project(t);
  const scenarios = [
    ['keep-going.txt', 2, 3, 'failed'],
    ['missing-retry.txt', 1, 1, 'done'],
    ['missing-fail.txt', 0, 1, 'failed'],
    ['dry-run.txt', 3, 3, 'done'],
    ['nothing.txt', 1, 1, 'done'],
    ['lock.txt', 0, 0, 'failed'],
    ['second-run.txt', 1, 3, 'failed'],
    ['ansi.txt', 1, 1, 'done'],
    ['names.txt', 2, 2, 'done'],
    ['finished-fallback.txt', 2, 2, 'done'],
    ['real-local-success.txt', 66, 66, 'done'],
    ['real-local-keepgoing-fail.txt', 19, 66, 'failed'],
    ['real-slurm-retry.txt', 3, 3, 'done'],
    ['real-slurm-large-fractional.txt', 1306, 1306, 'done']
  ];
  for (const [name, done, total, state] of scenarios) {
    const key = name.replace(/\.txt$/, '');
    const log = path.join(root, `${key}.log`);
    let contents = snakemakeFixture(name);
    if (name === 'ansi.txt') contents = contents.replace('1 of 1 steps (100%) done', '\x1b[32m1 of 1 steps (100%) done\x1b[0m');
    fs.writeFileSync(log, contents);
    const r = run(root, ['watch', '--log', log, '--parser', 'snakemake', '--label', 'Workflow', '--task', key]);
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.equal(r.stderr, '', name);
    assert.deepEqual([stage(root, key).done, stage(root, key).total, stage(root, key).state], [done, total, state], name);
  }
});

test('snakemake reads fractional progress before a large Slurm run finishes', async (t) => {
  const root = project(t);
  const log = path.join(root, 'large.log');
  const contents = snakemakeFixture('real-slurm-large-fractional.txt');
  const marker = '2 of 1306 steps (0.2%) done\n';
  const split = contents.indexOf(marker) + marker.length;
  fs.writeFileSync(log, contents.slice(0, split));
  const watch = launch(t, root, ['--log', log, '--parser', 'snakemake', '--label', 'Workflow', '--task', 'large']);
  await until(() => stage(root, 'large').done === 2);
  assert.deepEqual([stage(root, 'large').total, stage(root, 'large').state], [1306, 'running']);
  fs.appendFileSync(log, contents.slice(split));
  const result = await watch.result;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual([stage(root, 'large').done, stage(root, 'large').total, stage(root, 'large').state], [1306, 1306, 'done']);
});

test('snakemake keeps an unretried rule error even after full progress', (t) => {
  const root = project(t);
  const log = path.join(root, 'unresolved.log');
  fs.writeFileSync(log, snakemakeFixture('real-slurm-retry.txt').replace('Trying to restart job 1.\n', ''));
  const result = run(root, ['watch', '--log', log, '--parser', 'snakemake', '--label', 'Workflow', '--task', 'unresolved']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual([stage(root, 'unresolved').done, stage(root, 'unresolved').total,
    stage(root, 'unresolved').state], [3, 3, 'failed']);
});

test('snakemake resets an appended run with the same total', (t) => {
  const root = project(t);
  const log = path.join(root, 'same-total.log');
  fs.writeFileSync(log, [
    'Job stats:', 'job count', 'total 2', '', 'Error in rule old:', '2 of 2 steps (100%) done',
    'Complete log: first.log', 'Job stats:', 'job count', 'total 2', '',
    '1 of 2 steps (50%) done', '2 of 2 steps (100%) done', 'Complete log: second.log', ''
  ].join('\n'));
  const r = run(root, ['watch', '--log', log, '--parser', 'snakemake', '--label', 'Workflow', '--task', 'same-total']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([stage(root, 'same-total').done, stage(root, 'same-total').total, stage(root, 'same-total').state], [2, 2, 'done']);
});

test('snakemake keeps an explicit total and drops a retried error without jobid', (t) => {
  const root = project(t);
  const log = path.join(root, 'explicit-total.log');
  fs.writeFileSync(log, [
    'Job stats:', 'job count', 'total 2', '', 'Error in rule trial:', 'Trying to restart job 1.',
    '1 of 2 steps (50%) done', '2 of 2 steps (100%) done', 'Complete log: run.log', ''
  ].join('\n'));
  const r = run(root, ['watch', '--log', log, '--parser', 'snakemake', '--total', '3', '--label', 'Workflow', '--task', 'explicit-total']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([stage(root, 'explicit-total').done, stage(root, 'explicit-total').total, stage(root, 'explicit-total').state], [2, 3, 'failed']);
  const retried = run(root, ['watch', '--log', log, '--parser', 'snakemake', '--label', 'Workflow', '--task', 'retried-no-jobid']);
  assert.equal(retried.status, 0, retried.stderr);
  assert.deepEqual([stage(root, 'retried-no-jobid').done, stage(root, 'retried-no-jobid').state], [2, 'done']);
});

test('snakemake waits for WorkflowError after Complete log(s)', async (t) => {
  const root = project(t);
  const log = path.join(root, 'trailing-error.log');
  fs.writeFileSync(log, snakemakeFixture('real-local-success.txt'));
  const watch = launch(t, root, ['--log', log, '--parser', 'snakemake', '--label', 'Workflow', '--task', 'trailing-error'],
    { CODEOME_WATCH_POLL: '0.1' });
  await until(() => stage(root, 'trailing-error').done === 66 && stage(root, 'trailing-error').state === 'running');
  fs.appendFileSync(log, 'WorkflowError:\nAt least one job did not complete successfully.\n');
  const result = await watch.result;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual([stage(root, 'trailing-error').done, stage(root, 'trailing-error').total,
    stage(root, 'trailing-error').state], [66, 66, 'failed']);
});

test('tsc parses count and unique project forms, and errors fail', (t) => {
  const root = project(t);
  const log = path.join(root, 'tsc.log');
  fs.writeFileSync(log, fixture('tsc.txt'));
  let r = run(root, ['watch', '--log', log, '--parser', 'tsc', '--label', 'Build', '--task', 'counts']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([stage(root, 'counts').done, stage(root, 'counts').total, stage(root, 'counts').state], [7, 7, 'done']);
  fs.writeFileSync(log, fixture('tsc-projects.txt'));
  r = run(root, ['watch', '--log', log, '--parser', 'tsc', '--total', '2', '--label', 'Build', '--task', 'projects']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([stage(root, 'projects').done, stage(root, 'projects').total, stage(root, 'projects').unit], [2, 2, 'projects']);
  r = run(root, ['watch', '--log', log, '--parser', 'tsc', '--label', 'Build', '--task', 'projects-no-total']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /tsc project lines require --total/);
  assert.equal(stage(root, 'projects-no-total').state, 'failed');
  fs.writeFileSync(log, "Building project 'a'\nerror TS1234: bad\nBuilding project 'b'\n");
  r = run(root, ['watch', '--log', log, '--parser', 'tsc', '--total', '2', '--label', 'Build', '--task', 'ts-error']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stage(root, 'ts-error').state, 'failed');
});

test('regex parses named groups and has a bounded child process', (t) => {
  const root = project(t);
  const log = path.join(root, 'regex.log');
  fs.writeFileSync(log, 'work 1/2\nwork 2/2\n');
  let r = run(root, ['watch', '--log', log, '--parser', 'regex', '--regex', 'work (?P<done>\\d+)/(?P<total>\\d+)', '--label', 'Work', '--task', 'regex']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([stage(root, 'regex').done, stage(root, 'regex').total, stage(root, 'regex').state], [2, 2, 'done']);
  r = run(root, ['watch', '--log', log, '--parser', 'regex', '--regex', '(a+)+$(?P<done>\\d+)', '--total', '1', '--label', 'Work', '--task', 'nested']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /nested quantifiers/);
  assert.equal(fs.existsSync(paths(root, 'nested').file), false);
  fs.writeFileSync(log, `${'a'.repeat(200)}!\n`);
  r = run(root, ['watch', '--log', log, '--parser', 'regex', '--regex', '(?P<done>(a|aa)+)$', '--total', '1', '--label', 'Work', '--task', 'slow', '--timeout', '5'], {}, 15000);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /regex parser timed out/);
  assert.equal(stage(root, 'slow').state, 'failed');
});

test('regex accepts an unmatched optional done group', (t) => {
  const root = project(t);
  const log = path.join(root, 'optional.log');
  fs.writeFileSync(log, 'nothing to count\n');
  const r = run(root, ['watch', '--log', log, '--parser', 'regex', '--regex', '(?P<done>\\d+)?', '--total', '1', '--label', 'Work', '--task', 'optional', '--timeout', '0.1'], {}, 10000);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stage(root, 'optional').state, 'failed');
  assert.doesNotMatch(r.stderr, /TypeError/);
});

test('a catastrophic regex worker exits after its watcher is killed', async (t) => {
  const root = project(t);
  const log = path.join(root, 'catastrophic.log');
  fs.writeFileSync(log, `${'a'.repeat(200)}!\n`);
  const workerFile = path.join(root, 'worker.pid');
  fs.writeFileSync(path.join(root, 'sitecustomize.py'), [
    'import multiprocessing.process, os',
    '_start = multiprocessing.process.BaseProcess.start',
    'def start(self):',
    '    _start(self)',
    '    with open(os.environ["CODEOME_TEST_WORKER_PID_FILE"], "w") as file:',
    '        file.write(str(self.pid))',
    'multiprocessing.process.BaseProcess.start = start'
  ].join('\n'));
  const watch = launch(t, root, ['--log', log, '--parser', 'regex', '--regex', '(?P<done>(a|aa)+)$', '--total', '1', '--label', 'Work', '--task', 'orphan', '--timeout', '10'],
    { PYTHONPATH: root, CODEOME_TEST_WORKER_PID_FILE: workerFile });
  await until(() => (fs.existsSync(workerFile) && Number(fs.readFileSync(workerFile, 'utf8')) > 1) || watch.child.exitCode !== null);
  if (!fs.existsSync(workerFile)) assert.fail((await watch.result).stderr);
  const workerPid = Number(fs.readFileSync(workerFile, 'utf8'));
  assert.ok(workerPid > 1);
  watch.child.kill('SIGKILL');
  await watch.result;
  await until(() => { try { process.kill(workerPid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } }, 10000);
});

test('final read drains more than one mebibyte and 20000 lines', (t) => {
  const root = project(t);
  const log = path.join(root, 'backlog.log');
  fs.writeFileSync(log, `1 of 2\n${'x'.repeat(50)}\n`.repeat(25000) + '2 of 2\n');
  const r = run(root, ['watch', '--log', log, '--parser', 'tsc', '--label', 'Build', '--task', 'backlog', '--pid', '99999999']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stage(root, 'backlog').done, 2);
  assert.equal(stage(root, 'backlog').state, 'done');
});

test('unexpected watcher errors still save a failed terminal stage', (t) => {
  const root = project(t);
  const agent = path.join(root, '.codeome', 'bin', 'codeome-agent');
  const original = fs.readFileSync(agent, 'utf8');
  assert.match(original, /size = os\.fstat\(fd\)\.st_size/);
  fs.writeFileSync(agent, original.replace('size = os.fstat(fd).st_size', 'raise RuntimeError("injected read failure")'));
  const log = path.join(root, 'error.log');
  fs.writeFileSync(log, '');
  const r = run(root, ['watch', '--log', log, '--parser', 'tsc', '--label', 'Build', '--task', 'exception']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /injected read failure/);
  assert.equal(stage(root, 'exception').state, 'failed');
  assert.ok(stage(root, 'exception').endedAt);
});

test('truncation restarts at byte zero', async (t) => {
  const root = project(t);
  const log = path.join(root, 'truncated.log');
  fs.writeFileSync(log, `${'x'.repeat(100)}\n3 of 7\n`);
  const watch = launch(t, root, ['--log', log, '--parser', 'tsc', '--label', 'Build', '--task', 'truncate']);
  await until(() => stage(root, 'truncate').done === 3);
  fs.writeFileSync(log, '7 of 7\n');
  const result = await watch.result;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(stage(root, 'truncate').done, 7);
  assert.equal(stage(root, 'truncate').state, 'done');
});

test('pid exit finishes a final read without signalling the process', async (t) => {
  const root = project(t);
  const log = path.join(root, 'pid.log');
  fs.writeFileSync(log, '');
  const sleeper = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'],
    { stdio: ['pipe', 'ignore', 'ignore'] });
  t.after(() => { if (sleeper.exitCode === null && sleeper.signalCode === null) sleeper.kill('SIGTERM'); });
  const watch = launch(t, root, ['--log', log, '--parser', 'tsc', '--label', 'Build', '--task', 'pid', '--pid', String(sleeper.pid)]);
  await until(() => fs.existsSync(paths(root, 'pid').file));
  fs.appendFileSync(log, '1 of 1\n');
  const exited = new Promise((resolve, reject) => {
    sleeper.once('error', reject);
    sleeper.once('close', resolve);
  });
  sleeper.stdin.end();
  assert.equal(await exited, 0);
  const result = await watch.result;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(stage(root, 'pid').state, 'done');
  assert.equal(sleeper.signalCode, null);
});

test('a changed pid start time is treated as process exit', async (t) => {
  const root = project(t);
  const log = path.join(root, 'pid-reuse.log');
  fs.writeFileSync(log, '1 of 2\n');
  const stateFile = path.join(root, 'ps-state');
  fs.writeFileSync(stateFile, 'first start\n');
  const fakeBin = path.join(root, 'fake-bin');
  fs.mkdirSync(fakeBin);
  const ps = path.join(fakeBin, 'ps');
  fs.writeFileSync(ps, `#!/bin/sh\ncat '${stateFile}'\n`);
  fs.chmodSync(ps, 0o755);
  const watch = launch(t, root, ['--log', log, '--parser', 'tsc', '--label', 'Build', '--task', 'reuse', '--pid', String(process.pid)],
    { PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` });
  await until(() => stage(root, 'reuse').done === 1);
  fs.writeFileSync(stateFile, 'second start\n');
  const result = await watch.result;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(stage(root, 'reuse').state, 'failed');
});

test('unsafe logs and missing logs write failed cards', (t) => {
  const root = project(t);
  const log = path.join(root, 'safe.log');
  fs.writeFileSync(log, '');
  const symlink = path.join(root, 'link.log');
  fs.symlinkSync(log, symlink);
  for (const [key, file] of [['link', symlink], ['missing', path.join(root, 'missing.log')]]) {
    const r = run(root, ['watch', '--log', file, '--parser', 'vitest', '--total', '1', '--label', 'Test', '--task', key]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(stage(root, key).state, 'failed');
    assert.ok(stage(root, key).endedAt);
    assert.match(r.stderr, /warning: watch:/);
  }
  const fifo = path.join(root, 'fifo.log');
  if (spawnSync('mkfifo', [fifo]).status === 0) {
    const r = run(root, ['watch', '--log', fifo, '--parser', 'vitest', '--total', '1', '--label', 'Test', '--task', 'fifo']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(stage(root, 'fifo').state, 'failed');
  }
});

test('bad arguments exit zero with one warning and do not create task cards', (t) => {
  const root = project(t);
  const log = path.join(root, 'log');
  fs.writeFileSync(log, '');
  for (const extra of [
    ['--task', '../escape'], ['--task', 'a..b'], ['--task', '_bad'], ['--task', 'x'.repeat(65)],
    ['--task', 'okay', '--pid', '1'], ['--task', 'okay', '--pid', '2147483648'], ['--task', 'okay', '--total', '-2'],
    ['--task', 'okay', '--unknown'], ['--task', 'okay', '--regex', 'x']
  ]) {
    const r = run(root, ['watch', '--log', log, '--parser', 'vitest', '--total', '2', '--label', 'Test', ...extra]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^codeome-agent: warning: watch: [^\n]+\n$/);
    assert.equal(r.stdout, '');
  }
  assert.equal(fs.existsSync(paths(root, 'okay').file), false);
  const r = run(root, ['watch', '--parser', 'vitest']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /^codeome-agent: warning: watch: [^\n]+\n$/);
});

test('task directory symlinks are refused and pruning leaves foreign entries', (t) => {
  const root = project(t);
  const log = path.join(root, 'log');
  fs.writeFileSync(log, 'Test Files  0 passed\n');
  const taskRoot = path.join(root, '.codeome', 'jobs', '.tasks');
  fs.mkdirSync(taskRoot, { recursive: true });
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(taskRoot, 'linked'));
  let r = run(root, ['watch', '--log', log, '--parser', 'vitest', '--total', '1', '--label', 'Test', '--task', 'linked']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /real directory/);
  const old = new Date(Date.now() - 8 * 86400 * 1000);
  for (const key of ['old', 'foreign']) {
    const dir = path.join(taskRoot, key);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, key === 'old' ? 'progress.json' : 'notes.txt'), 'x');
    fs.utimesSync(dir, old, old);
  }
  r = run(root, ['watch', '--log', log, '--parser', 'vitest', '--total', '1', '--label', 'Test', '--task', 'new']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(taskRoot, 'old')), false);
  assert.equal(fs.existsSync(path.join(taskRoot, 'foreign', 'notes.txt')), true);
  assert.equal(fs.lstatSync(path.join(taskRoot, 'linked')).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(taskRoot, 'new', 'progress.json')), true);
});

test('pruning keeps the newest 50 valid task directories', (t) => {
  const root = project(t);
  const log = path.join(root, 'log');
  fs.writeFileSync(log, 'Test Files  0 passed\n');
  const taskRoot = path.join(root, '.codeome', 'jobs', '.tasks');
  fs.mkdirSync(taskRoot, { recursive: true });
  for (let i = 0; i < 51; i++) {
    const dir = path.join(taskRoot, `task-${i}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'progress.json'), '{}');
    const stamp = new Date(Date.now() - i * 1000);
    fs.utimesSync(dir, stamp, stamp);
  }
  const r = run(root, ['watch', '--log', log, '--parser', 'vitest', '--total', '1', '--label', 'Test', '--task', 'new']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(taskRoot, 'task-49')), false);
  assert.equal(fs.existsSync(path.join(taskRoot, 'task-50')), false);
  assert.equal(fs.existsSync(path.join(taskRoot, 'task-48')), true);
});

test('SIGTERM writes a stopped state', async (t) => {
  const root = project(t);
  const log = path.join(root, 'log');
  fs.writeFileSync(log, '');
  const watch = launch(t, root, ['--log', log, '--parser', 'vitest', '--total', '1', '--label', 'Test', '--task', 'stop']);
  await until(() => fs.existsSync(paths(root, 'stop').file));
  watch.child.kill('SIGTERM');
  const result = await watch.result;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(stage(root, 'stop').state, 'failed');
  assert.ok(stage(root, 'stop').endedAt);
});
