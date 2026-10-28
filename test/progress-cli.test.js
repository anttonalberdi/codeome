const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const source = path.join(__dirname, '..', 'kit', 'bin', 'codeome-agent');

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-progress-'));
  const bin = path.join(root, '.codeome', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(source, path.join(bin, 'codeome-agent'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function job(root, id = 'job-1') {
  const dir = path.join(root, '.codeome', 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id }));
  return dir;
}

function run(root, args, input, env = {}) {
  return spawnSync('python3', ['-B', path.join(root, '.codeome', 'bin', 'codeome-agent'), ...args], {
    cwd: root, input, encoding: 'utf8', env: { ...process.env, CODEOME_HOME: path.join(root, 'home'), ...env }
  });
}

const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const progress = (dir) => json(path.join(dir, 'progress.json'));
const epochMicros = (stamp) => {
  const [seconds, fraction = ''] = stamp.slice(0, -1).split('.');
  return Date.parse(`${seconds}Z`) * 1000 + Number(fraction.padEnd(6, '0'));
};

test('codeome-agent help lists progress and watch', () => {
  const r = spawnSync('python3', ['-B', source, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^    progress\s+record progress for a job stage$/m);
  assert.match(r.stdout, /^    watch\s+follow a log and record task progress$/m);
});

test('progress writes and merges stages in first-seen order', (t) => {
  const root = project(t);
  const dir = job(root);
  let r = run(root, ['progress', '--job', 'job-1', '--stage', 'build', '--label', 'Build files', '--state', 'running', '--done', '2', '--total', '10', '--unit', 'files']);
  assert.equal(r.status, 0, r.stderr);
  const first = progress(dir);
  assert.equal(first.v, 1);
  assert.match(first.updatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  assert.deepEqual(first.stages[0], {
    id: 'build', label: 'Build files', state: 'running', kind: 'determinate', done: 2, total: 10,
    unit: 'files', startedAt: first.stages[0].updatedAt, endedAt: null,
    updatedAt: first.stages[0].updatedAt, baselineSeconds: null
  });
  r = run(root, ['progress', '--job', 'job-1', '--stage', 'test', '--state', 'waiting']);
  assert.equal(r.status, 0, r.stderr);
  r = run(root, ['progress', '--job', 'job-1', '--stage', 'build', '--done', '6']);
  assert.equal(r.status, 0, r.stderr);
  const next = progress(dir);
  assert.deepEqual(next.stages.map((s) => s.id), ['build', 'test']);
  assert.equal(next.stages[0].done, 6);
  assert.equal(next.stages[0].startedAt, first.stages[0].startedAt);
  assert.equal(next.stages[1].state, 'waiting');
});

test('plan declares waiting stages without replacing existing stages', (t) => {
  const root = project(t);
  const dir = job(root);
  assert.equal(run(root, ['progress', '--job', 'job-1', '--plan', 'design:Design,build:Build']).status, 0);
  let stages = progress(dir).stages;
  assert.deepEqual(stages.map((s) => [s.id, s.label, s.state]), [['design', 'Design', 'waiting'], ['build', 'Build', 'waiting']]);
  assert.equal(stages[0].kind, 'indeterminate');
  assert.equal(run(root, ['progress', '--job', 'job-1', '--stage', 'design', '--state', 'done', '--plan', 'design:Changed,test:Test']).status, 0);
  stages = progress(dir).stages;
  assert.deepEqual(stages.map((s) => s.id), ['design', 'build', 'test']);
  assert.equal(stages[0].label, 'Design');
  assert.equal(stages[0].state, 'done');
  assert.ok(stages[0].endedAt);
  assert.equal(stages[0].startedAt, null);
});

test('progress clamps counts and caps stage and string lengths', (t) => {
  const root = project(t);
  const dir = job(root);
  const args = ['progress', '--job', 'job-1', '--stage', 's'.repeat(50), '--label', 'l'.repeat(130), '--unit', 'u'.repeat(30), '--done', '20', '--total', '10', '--baseline', '2.5'];
  assert.equal(run(root, args).status, 0);
  let stage = progress(dir).stages[0];
  assert.equal(stage.id.length, 40);
  assert.equal(stage.label.length, 120);
  assert.equal(stage.unit.length, 20);
  assert.equal(stage.done, 10);
  assert.equal(stage.baselineSeconds, 2.5);
  assert.equal(run(root, ['progress', '--job', 'job-1', '--stage', stage.id, '--done', '-3']).status, 0);
  assert.equal(progress(dir).stages[0].done, 0);
  const plan = Array.from({ length: 55 }, (_, i) => `stage${i}:Stage ${i}`).join(',');
  assert.equal(run(root, ['progress', '--job', 'job-1', '--plan', plan]).status, 0);
  assert.equal(progress(dir).stages.length, 50);
});

test('invalid inputs warn without writing a progress record', (t) => {
  const root = project(t);
  const dir = job(root);
  for (const extra of [['--stage', 'x', '--total', '-1'], ['--stage', 'x', '--done', 'no'], ['--plan', 'bad'], ['--baseline', 'NaN', '--stage', 'x']]) {
    const r = run(root, ['progress', '--job', 'job-1', ...extra]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^codeome-agent: warning: progress: .+\n$/);
    assert.equal(fs.existsSync(path.join(dir, 'progress.json')), false);
  }
});

test('progress parse errors and missing stage warn with success status', (t) => {
  const root = project(t);
  const dir = job(root);
  for (const extra of [['--stage', 'x', '--state', 'bad'], ['--stage', 'x', '--unknown'],
    ['--stage', 'x', '--label', '-negative'], []]) {
    const r = run(root, ['progress', '--job', 'job-1', ...extra]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^codeome-agent: warning: progress: [^\n]+\n$/);
    assert.equal(fs.existsSync(path.join(dir, 'progress.json')), false);
  }
  assert.equal(run(root, ['list', '--unknown']).status, 2);
});

test('missing or invalid job ids exit successfully with one warning', (t) => {
  const root = project(t);
  job(root);
  job(root, 'a..b');
  job(root, '_bad');
  for (const args of [['progress', '--stage', 'x'], ['progress', '--job', '', '--stage', 'x'], ['progress', '--job', '../escape', '--stage', 'x'], ['progress', '--job', 'a..b', '--stage', 'x'], ['progress', '--job', '_bad', '--stage', 'x'], ['progress', '--job', 'missing', '--stage', 'x']]) {
    const r = run(root, args, undefined, { CODEOME_JOB_ID: args.includes('') ? 'job-1' : '' });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /^codeome-agent: warning: missing or invalid progress job id\n$/);
    assert.equal(r.stdout, '');
  }
});

test('progress ignores unsafe existing files and oversized history', (t) => {
  const root = project(t);
  const dir = job(root);
  const file = path.join(dir, 'progress.json');
  const other = path.join(root, 'other.json');
  fs.writeFileSync(other, JSON.stringify({ v: 1, stages: [{ id: 'old', state: 'done' }] }));
  for (const setup of [
    () => fs.symlinkSync(other, file),
    () => fs.writeFileSync(file, ' '.repeat(256 * 1024 + 1)),
    () => fs.mkdirSync(file)
  ]) {
    setup();
    const r = run(root, ['progress', '--job', 'job-1', '--stage', 'new']);
    assert.equal(r.status, 0, r.stderr);
    if (fs.lstatSync(file).isDirectory()) fs.rmdirSync(file);
    else {
      assert.deepEqual(progress(dir).stages.map((s) => s.id), ['new']);
      fs.unlinkSync(file);
    }
  }
  if (spawnSync('mkfifo', [file]).status === 0) {
    assert.equal(run(root, ['progress', '--job', 'job-1', '--stage', 'new']).status, 0);
    assert.deepEqual(progress(dir).stages.map((s) => s.id), ['new']);
    fs.unlinkSync(file);
  }
  const historyPath = path.join(root, '.codeome', 'jobs', '.progress-history.json');
  for (const setup of [
    () => fs.symlinkSync(other, historyPath),
    () => fs.writeFileSync(historyPath, ' '.repeat(256 * 1024 + 1)),
    () => fs.mkdirSync(historyPath)
  ]) {
    setup();
    const r = run(root, ['progress', '--job', 'job-1', '--stage', 'new']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(progress(dir).stages[0].baselineSeconds, null);
    if (fs.lstatSync(historyPath).isDirectory()) fs.rmdirSync(historyPath);
    else fs.unlinkSync(historyPath);
  }
});

test('stage transitions reset timestamps and history uses elapsed time', (t) => {
  const root = project(t);
  const dir = job(root);
  const file = path.join(dir, 'progress.json');
  const old = '2020-01-01T00:00:00Z';
  fs.writeFileSync(file, JSON.stringify({ v: 1, stages: [{ id: 'x', state: 'done', startedAt: old, endedAt: old }] }));
  assert.equal(run(root, ['progress', '--job', 'job-1', '--stage', 'x', '--state', 'running']).status, 0);
  const running = progress(dir).stages[0];
  assert.notEqual(running.startedAt, old);
  assert.equal(running.endedAt, null);
  assert.equal(run(root, ['progress', '--job', 'job-1', '--stage', 'x', '--state', 'done']).status, 0);
  const done = progress(dir).stages[0];
  assert.equal(done.endedAt, done.updatedAt);
  const elapsedMicros = epochMicros(done.endedAt) - epochMicros(running.startedAt);
  assert.equal(fs.existsSync(path.join(root, '.codeome', 'jobs', '.progress-history.json')), elapsedMicros >= 1000000);
  fs.writeFileSync(file, JSON.stringify({ v: 1, stages: [{ ...done, endedAt: old }] }));
  assert.equal(run(root, ['progress', '--job', 'job-1', '--stage', 'x', '--state', 'done']).status, 0);
  assert.equal(progress(dir).stages[0].endedAt, progress(dir).stages[0].updatedAt);
});

test('history evicts the oldest key after 500 stages', (t) => {
  const root = project(t);
  const dir = job(root);
  const historyPath = path.join(root, '.codeome', 'jobs', '.progress-history.json');
  fs.writeFileSync(historyPath, JSON.stringify(Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`old${i}`, [2]]))));
  fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify({ v: 1, stages: [{ id: 'fresh', state: 'running', startedAt: '2020-01-01T00:00:00Z' }] }));
  assert.equal(run(root, ['progress', '--job', 'job-1', '--stage', 'fresh', '--state', 'done']).status, 0);
  const history = json(historyPath);
  assert.equal(Object.keys(history).length, 500);
  assert.equal(Object.hasOwn(history, 'old0'), false);
  assert.ok(history.fresh[0] > 1);
});

test('parallel stage updates both survive', async (t) => {
  const root = project(t);
  const dir = job(root);
  const launch = (stage) => new Promise((resolve, reject) => {
    const child = spawn('python3', ['-B', path.join(root, '.codeome', 'bin', 'codeome-agent'), 'progress', '--job', 'job-1', '--stage', stage],
      { cwd: root, env: { ...process.env, CODEOME_HOME: path.join(root, 'home') }, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });
  assert.deepEqual(await Promise.all([launch('one'), launch('two')]), [0, 0]);
  assert.deepEqual(progress(dir).stages.map((s) => s.id).sort(), ['one', 'two']);
});

test('CODEOME_JOB_ID selects the job and corrupt progress is replaced', (t) => {
  const root = project(t);
  const dir = job(root);
  fs.writeFileSync(path.join(dir, 'progress.json'), '{broken');
  const r = run(root, ['progress', '--stage', 'restore'], undefined, { CODEOME_JOB_ID: 'job-1' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(progress(dir).stages.map((s) => s.id), ['restore']);
});

test('history keeps five durations, records only a transition to done, and fills median baseline', (t) => {
  const root = project(t);
  const dir = job(root);
  const historyPath = path.join(root, '.codeome', 'jobs', '.progress-history.json');
  fs.writeFileSync(historyPath, JSON.stringify({ build: [1, 2, 3, 4, 5] }));
  const startedAt = new Date(Date.now() - 7000).toISOString();
  fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify({ v: 1, stages: [{ id: 'build', state: 'running', startedAt }] }));
  assert.equal(run(root, ['progress', '--job', 'job-1', '--stage', 'build', '--state', 'done']).status, 0);
  const durations = json(historyPath).build;
  assert.equal(durations.length, 5);
  assert.deepEqual(durations.slice(0, 4), [2, 3, 4, 5]);
  assert.ok(durations[4] >= 7);
  assert.ok(Math.abs(durations[4] - (Date.parse(progress(dir).stages[0].endedAt) - Date.parse(startedAt)) / 1000) < 0.002);
  assert.equal(progress(dir).stages[0].baselineSeconds, 3);
  assert.equal(run(root, ['progress', '--job', 'job-1', '--stage', 'build', '--state', 'done']).status, 0);
  assert.deepEqual(json(historyPath).build, durations);
  const other = job(root, 'job-2');
  assert.equal(run(root, ['progress', '--job', 'job-2', '--stage', 'build']).status, 0);
  assert.equal(progress(other).stages[0].baselineSeconds, 4);
});

test('corrupt history is ignored', (t) => {
  const root = project(t);
  const dir = job(root);
  fs.writeFileSync(path.join(root, '.codeome', 'jobs', '.progress-history.json'), '{bad');
  const r = run(root, ['progress', '--job', 'job-1', '--stage', 'x']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(progress(dir).stages[0].baselineSeconds, null);
});

test('SubagentStart returns the job id in additionalContext; other hooks stay silent', (t) => {
  const root = project(t);
  const pre = run(root, ['hook'], JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 't1', tool_input: { subagent_type: 'planner' } }));
  assert.equal(pre.status, 0, pre.stderr);
  assert.equal(pre.stdout, '');
  const start = run(root, ['hook'], JSON.stringify({ hook_event_name: 'SubagentStart', agent_type: 'planner', agent_id: 'a1', cwd: root }));
  assert.equal(start.status, 0, start.stderr);
  const out = JSON.parse(start.stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, 'SubagentStart');
  const jobId = fs.readFileSync(path.join(root, '.codeome', 'jobs', '.agents', 'a1'), 'utf8');
  assert.match(out.additionalContext, new RegExp(`Your Codeome job id is ${jobId}\\.`));
  assert.ok(out.additionalContext.includes(`progress --job ${jobId} --stage <id>`));
  assert.equal(json(path.join(root, '.codeome', 'jobs', jobId, 'job.json')).id, jobId);
  const stop = run(root, ['hook'], JSON.stringify({ hook_event_name: 'SubagentStop', agent_type: 'planner', agent_id: 'a1' }));
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(stop.stdout, '');
  assert.equal(run(root, ['hook'], '{bad').stdout, '');
});
