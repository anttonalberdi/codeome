const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const source = path.join(__dirname, '..', 'kit', 'bin', 'codeome-agent');
const fixtures = path.join(__dirname, 'fixtures', 'sacct');
const host = 'jpl786@mjolnirgate.unicph.domain';
const socket = '/tmp/codeome-ssh-%C';

function fixture(name) {
  return fs.readFileSync(path.join(fixtures, name), 'utf8');
}

function project(t, replies = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-slurm-'));
  const agentDir = path.join(root, '.codeome', 'bin');
  const fakeBin = path.join(root, 'fake-bin');
  const repliesDir = path.join(root, 'replies');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(fakeBin);
  fs.mkdirSync(repliesDir);
  fs.copyFileSync(source, path.join(agentDir, 'codeome-agent'));
  const ssh = path.join(fakeBin, 'ssh');
  fs.writeFileSync(ssh, [
    '#!/bin/sh',
    'printf "%s\\n" "---" >> "$CODEOME_TEST_SSH_ARGS"',
    'printf "%s\\n" "$@" >> "$CODEOME_TEST_SSH_ARGS"',
    'case " $* " in',
    '  *" -O check "*)',
    '    if [ "${CODEOME_TEST_SSH_MASTER:-}" = dead ]; then exit 255; fi',
    '    if [ -n "${CODEOME_TEST_SSH_MASTER_SLEEP:-}" ]; then sleep "$CODEOME_TEST_SSH_MASTER_SLEEP"; fi',
    '    echo "Master running"',
    '    exit 0;;',
    'esac',
    'n=0',
    'if [ -f "$CODEOME_TEST_SSH_COUNT" ]; then n=$(cat "$CODEOME_TEST_SSH_COUNT"); fi',
    'n=$((n + 1))',
    'printf "%s\\n" "$n" > "$CODEOME_TEST_SSH_COUNT"',
    'reply="$CODEOME_TEST_SSH_REPLIES/$n"',
    'if [ ! -f "$reply.out" ]; then reply="$CODEOME_TEST_SSH_REPLIES/default"; fi',
    'if [ -f "$reply.sleep" ]; then sleep "$(cat "$reply.sleep")"; fi',
    'if [ -f "$reply.out" ]; then cat "$reply.out"; fi',
    'if [ -f "$reply.err" ]; then cat "$reply.err" >&2; fi',
    'if [ -f "$reply.exit" ]; then exit "$(cat "$reply.exit")"; fi'
  ].join('\n') + '\n');
  fs.chmodSync(ssh, 0o755);
  for (let i = 0; i < replies.length; i++) {
    const reply = replies[i];
    for (const [key, value] of Object.entries(reply)) fs.writeFileSync(path.join(repliesDir, `${i + 1}.${key}`), String(value));
  }
  const last = replies[replies.length - 1] || { out: '' };
  for (const [key, value] of Object.entries(last)) fs.writeFileSync(path.join(repliesDir, `default.${key}`), String(value));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    env: {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      CODEOME_HPC_HOST: host,
      CODEOME_HPC_SOCKET: socket,
      CODEOME_WATCH_TEST: '1',
      CODEOME_WATCH_SLURM_POLL: '0.03',
      CODEOME_TEST_SSH_ARGS: path.join(root, 'ssh-args'),
      CODEOME_TEST_SSH_COUNT: path.join(root, 'ssh-count'),
      CODEOME_TEST_SSH_REPLIES: repliesDir
    }
  };
}

function args(key, jobs, extra = []) {
  return ['watch', '--parser', 'slurm', '--label', 'HPC jobs', '--task', key, '--jobs', jobs, ...extra];
}

function run(p, argv, env = {}, timeout = 12000) {
  return spawnSync('python3', ['-B', path.join(p.root, '.codeome', 'bin', 'codeome-agent'), ...argv], {
    cwd: p.root, encoding: 'utf8', timeout, env: { ...process.env, ...p.env, ...env }
  });
}

function launch(t, p, argv, env = {}) {
  const child = spawn('python3', ['-B', path.join(p.root, '.codeome', 'bin', 'codeome-agent'), ...argv], {
    cwd: p.root, env: { ...process.env, ...p.env, ...env }
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

function progress(p, key) {
  return JSON.parse(fs.readFileSync(path.join(p.root, '.codeome', 'jobs', '.tasks', key, 'progress.json'), 'utf8'));
}

function stage(p, key) {
  return progress(p, key).stages[0];
}

function calls(p) {
  if (!fs.existsSync(p.env.CODEOME_TEST_SSH_ARGS)) return [];
  return fs.readFileSync(p.env.CODEOME_TEST_SSH_ARGS, 'utf8').split('---\n').slice(1)
    .filter(Boolean).map((call) => call.trimEnd().split('\n'))
    .filter((call) => call.at(-1).startsWith('sacct '));
}

function allCalls(p) {
  if (!fs.existsSync(p.env.CODEOME_TEST_SSH_ARGS)) return [];
  return fs.readFileSync(p.env.CODEOME_TEST_SSH_ARGS, 'utf8').split('---\n').slice(1)
    .filter(Boolean).map((call) => call.trimEnd().split('\n'));
}

async function until(check, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (check()) return; } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('timed out waiting for Slurm watcher');
}

test('array progress counts completed tasks poll by poll', async (t) => {
  const p = project(t, [
    { out: fixture('array-pending.txt') },
    ...Array(8).fill({ out: fixture('array-one.txt') }),
    ...Array(8).fill({ out: fixture('array-two.txt') }),
    { out: fixture('array-done.txt') }
  ]);
  const watch = launch(t, p, args('array', '45802073'), { CODEOME_WATCH_SLURM_POLL: '0.15' });
  await until(() => stage(p, 'array').done === 1);
  assert.deepEqual([stage(p, 'array').total, stage(p, 'array').state], [3, 'running']);
  await until(() => stage(p, 'array').done === 2);
  assert.equal(stage(p, 'array').state, 'running');
  const result = await watch.result;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual([stage(p, 'array').id, stage(p, 'array').label, stage(p, 'array').done,
    stage(p, 'array').total, stage(p, 'array').unit, stage(p, 'array').state],
  ['slurm', 'HPC jobs', 3, 3, 'tasks', 'done']);
});

test('each terminal Slurm failure ends failed with completed count', async (t) => {
  const states = ['FAILED', 'OUT_OF_MEMORY', 'TIMEOUT', 'NODE_FAIL', 'BOOT_FAIL',
    'DEADLINE', 'REVOKED', 'CANCELLED'];
  await Promise.all(states.map(async (state, i) => {
    const p = project(t, [{ out: `123_0|COMPLETED\n123_1|${state}\n` }]);
    const key = `failure-${i}`;
    const watch = launch(t, p, args(key, '123'));
    const result = await watch.result;
    assert.equal(result.code, 0, `${state}: ${result.stderr}`);
    assert.deepEqual([stage(p, key).done, stage(p, key).total, stage(p, key).state], [1, 2, 'failed'], state);
  }));
});

test('CANCELLED by uid and collapsed array rows count their tasks', (t) => {
  const p = project(t, [{ out: fixture('cancelled.txt') }]);
  const r = run(p, args('cancelled', '45804133'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([stage(p, 'cancelled').done, stage(p, 'cancelled').total, stage(p, 'cancelled').state], [1, 4, 'failed']);
});

test('collapsed rows count ranges, commas and throttle suffixes', (t) => {
  const p = project(t, [
    { out: fixture('collapsed.txt') },
    { out: '45804244_[0-2%1]|COMPLETED\n45870000_[0,2-4%2]|COMPLETED\n' }
  ]);
  const r = run(p, args('collapsed', '45804244,45870000'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([stage(p, 'collapsed').done, stage(p, 'collapsed').total, stage(p, 'collapsed').state], [7, 7, 'done']);
});

test('largest observed array total does not shrink', (t) => {
  const p = project(t, [
    { out: fixture('growing-small.txt') },
    { out: fixture('growing-large.txt') },
    { out: fixture('growing-small.txt') },
    { out: '45861893_[1-4]|COMPLETED\n' }
  ]);
  const r = run(p, args('growing', '45861893'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([stage(p, 'growing').done, stage(p, 'growing').total, stage(p, 'growing').state], [4, 4, 'done']);
});

test('plain job ignores step rows; explicit total takes precedence', async (t) => {
  const cases = [
    ['plain', [], [1, 1, 'done']],
    ['total', ['--total', '2'], [1, 2, 'failed']]
  ];
  await Promise.all(cases.map(async ([key, extra, expected]) => {
    const p = project(t, [{ out: '45772308|COMPLETED\n45772308.batch|FAILED\n45772308.extern|FAILED\n' }]);
    const watch = launch(t, p, args(key, '45772308', extra));
    const result = await watch.result;
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual([stage(p, key).done, stage(p, key).total, stage(p, key).state], expected);
  }));
});

test('a failure from an earlier poll does not stick after completion', (t) => {
  const p = project(t, [
    { out: '123_0|FAILED\n123_1|RUNNING\n' },
    { out: '123_0|COMPLETED\n123_1|COMPLETED\n' }
  ]);
  const r = run(p, args('persistent', '123'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([stage(p, 'persistent').done, stage(p, 'persistent').total, stage(p, 'persistent').state], [2, 2, 'done']);
});

test('preempted and special-exit tasks can complete after requeue', (t) => {
  for (const state of ['PREEMPTED', 'SPECIAL_EXIT']) {
    const p = project(t, [{ out: `123_0|${state}\n123_1|COMPLETED\n` },
      { out: '123_0|COMPLETED\n123_1|COMPLETED\n' }]);
    const r = run(p, args(state.toLowerCase(), '123'));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([stage(p, state.toLowerCase()).done, stage(p, state.toLowerCase()).state], [2, 'done']);
    assert.equal(calls(p).length, 2);
  }
});

test('other active states keep polling and a collapsed expansion is bounded', async (t) => {
  const active = ['CONFIGURING', 'COMPLETING', 'SUSPENDED', 'REQUEUED', 'RESIZING'];
  const p = project(t, [
    { out: active.map((state, i) => `123_${i}|${state}`).join('\n') + '\n' },
    { out: '123_[0-4]|COMPLETED\n' }
  ]);
  const watch = launch(t, p, args('active', '123'));
  const result = await watch.result;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(calls(p).length, 2);
  assert.deepEqual([stage(p, 'active').done, stage(p, 'active').total, stage(p, 'active').state], [5, 5, 'done']);

  const large = project(t, [{ out: '456_[0-9999999999]|COMPLETED\n' }]);
  const capped = launch(t, large, args('capped', '456'));
  assert.equal((await capped.result).code, 0);
  assert.deepEqual([stage(large, 'capped').done, stage(large, 'capped').total], [100000, 100000]);
});

test('bad ids are rejected before SSH starts', (t) => {
  const p = project(t);
  for (const [i, jobs] of ['1;rm', '12_[1-3]', 'abc', '', Array.from({ length: 51 }, (_, n) => String(n)).join(','), '-j'].entries()) {
    const argv = jobs === '-j' ? args(`bad-${i}`, '1').slice(0, -2).concat('--jobs=-j') : args(`bad-${i}`, jobs);
    const r = run(p, argv);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^codeome-agent: warning: watch: [^\n]+\n$/);
  }
  const missing = run(p, args('missing-jobs', '1').slice(0, -2));
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stderr, /^codeome-agent: warning: watch: [^\n]+\n$/);
  assert.deepEqual(calls(p), []);
});

test('missing connection and invalid host or socket write failed cards without SSH', (t) => {
  const p = project(t);
  const cases = [
    ['missing-host', { CODEOME_HPC_HOST: '' }],
    ['missing-socket', { CODEOME_HPC_SOCKET: '' }],
    ['host-option', { CODEOME_HPC_HOST: '-oProxyCommand=x' }],
    ['host-space', { CODEOME_HPC_HOST: 'a b' }],
    ['socket-newline', { CODEOME_HPC_SOCKET: 'bad\npath' }],
    ['socket-long', { CODEOME_HPC_SOCKET: 'x'.repeat(4097) }]
  ];
  for (const [key, env] of cases) {
    const r = run(p, args(key, '123'), env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^codeome-agent: warning: watch: [^\n]+\n$/);
    assert.equal(stage(p, key).state, 'failed');
    assert.ok(stage(p, key).endedAt);
    assert.doesNotMatch(r.stderr, /mjolnirgate|ProxyCommand|bad.path/);
  }
  assert.deepEqual(calls(p), []);
});

test('SSH argv uses the control connection and exact validated sacct command', (t) => {
  const p = project(t, [{ out: '123|COMPLETED\n456_7|COMPLETED\n' }]);
  const r = run(p, args('argv', '123,456_7'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls(p), [[
    '-o', `ControlPath=${socket}`, '-o', 'ControlMaster=no', '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10', host, 'sacct -X -n -P -j 123,456_7 -o JobID,State'
  ]]);
  assert.deepEqual(allCalls(p)[0], ['-o', `ControlPath=${socket}`, '-O', 'check', host]);
  assert.match(calls(p)[0].at(-1), /^sacct -X -n -P -j [0-9_,]+ -o JobID,State$/);
  const data = fs.readFileSync(path.join(p.root, '.codeome', 'jobs', '.tasks', 'argv', 'progress.json'), 'utf8');
  assert.doesNotMatch(data, /mjolnirgate|codeome-ssh/);
});

test('a dead master prevents data commands', (t) => {
  const p = project(t);
  const r = run(p, args('dead-master', '123'), { CODEOME_TEST_SSH_MASTER: 'dead' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /HPC connection not available/);
  assert.equal(stage(p, 'dead-master').state, 'failed');
  assert.equal(calls(p).length, 0);
  assert.equal(allCalls(p).length, 1);
});

test('a timed-out master check reports unavailable before data commands', (t) => {
  const p = project(t);
  const r = run(p, args('slow-master', '123'), {
    CODEOME_WATCH_SSH_TIMEOUT: '0.2', CODEOME_TEST_SSH_MASTER_SLEEP: '5'
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, 'codeome-agent: warning: watch: HPC connection not available\n');
  assert.equal(stage(p, 'slow-master').state, 'failed');
  assert.equal(calls(p).length, 0);
  assert.ok(allCalls(p).every((call) => call.includes('-O')));
});

test('three SSH failures and three empty results fail with short reasons', async (t) => {
  const cases = [
    ['disconnect', [{ out: '', err: 'sensitive host and socket', exit: '255' }], 'lost connection to HPC'],
    ['empty', [{ out: '' }], 'no job data']
  ];
  await Promise.all(cases.map(async ([key, replies, reason]) => {
    const p = project(t, replies);
    const watch = launch(t, p, args(key, '999'));
    const result = await watch.result;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, `codeome-agent: warning: watch: ${reason}\n`);
    assert.equal(stage(p, key).state, 'failed');
    assert.equal(calls(p).length, 3);
  }));
});

test('empty results must be consecutive', (t) => {
  const p = project(t, [
    { out: '' }, { out: '', exit: '255' }, { out: '' }, { out: '' }, { out: '' }
  ]);
  const r = run(p, args('interrupted-empty', '999'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no job data/);
  assert.equal(calls(p).length, 5);
});

test('SIGTERM settles a pending stage', async (t) => {
  const p = project(t, [{ out: '123|PENDING\n' }]);
  const watch = launch(t, p, args('stopped', '123'), { CODEOME_WATCH_SLURM_POLL: '5' });
  await until(() => calls(p).length >= 1);
  const started = Date.now();
  watch.child.kill('SIGTERM');
  const result = await watch.result;
  assert.equal(result.code, 0, result.stderr);
  assert.ok(Date.now() - started < 2000);
  assert.equal(stage(p, 'stopped').state, 'failed');
  assert.ok(stage(p, 'stopped').endedAt);
});

test('SIGTERM kills an in-flight SSH command promptly', async (t) => {
  const p = project(t, [{ out: '123|PENDING\n', sleep: '5' }]);
  const watch = launch(t, p, args('stopped-ssh', '123'), { CODEOME_WATCH_SLURM_POLL: '5' });
  await until(() => calls(p).length >= 1);
  const started = Date.now();
  watch.child.kill('SIGTERM');
  const result = await watch.result;
  assert.equal(result.code, 0, result.stderr);
  assert.ok(Date.now() - started < 2000);
  assert.equal(stage(p, 'stopped-ssh').state, 'failed');
});

test('--log with Slurm is a reported failed stage', (t) => {
  const p = project(t);
  const r = run(p, args('log-conflict', '123', ['--log', '/tmp/local.log']));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /--log is not used with --parser slurm/);
  assert.equal(stage(p, 'log-conflict').state, 'failed');
  assert.equal(allCalls(p).length, 0);
});

test('SSH timeout is bounded by the test override', (t) => {
  const p = project(t, [{ out: '123|COMPLETED\n', sleep: '10' }]);
  const r = run(p, args('ssh-timeout', '123'), { CODEOME_WATCH_SSH_TIMEOUT: '2' }, 20000);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /lost connection to HPC/);
  assert.equal(stage(p, 'ssh-timeout').state, 'failed');
  assert.equal(calls(p).length, 3);
  assert.equal(allCalls(p).filter((call) => call.includes('-O')).length, 4);
});
