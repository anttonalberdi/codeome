const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const source = path.join(__dirname, '..', 'kit', 'bin', 'codeome-agent');
const host = 'jpl786@mjolnirgate.unicph.domain';
const socket = '/tmp/codeome-remote-socket';

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-remote-'));
  const agentDir = path.join(root, '.codeome', 'bin');
  const fakeBin = path.join(root, 'fake-bin');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(fakeBin);
  fs.copyFileSync(source, path.join(agentDir, 'codeome-agent'));
  const ssh = path.join(fakeBin, 'ssh');
  fs.writeFileSync(ssh, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.CODEOME_TEST_SSH_ARGS, JSON.stringify(process.argv.slice(2)) + '\\n');",
    "const mode = fs.existsSync(process.env.CODEOME_TEST_SSH_MODE) ? fs.readFileSync(process.env.CODEOME_TEST_SSH_MODE, 'utf8') : '';",
    "if (process.argv.includes('-O')) { if (mode === 'dead') process.exit(255); process.stderr.write('Master running\\n'); return; }",
    "const countFile = process.env.CODEOME_TEST_SSH_COUNT;",
    "const count = (fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0) + 1;",
    "fs.writeFileSync(countFile, String(count));",
    "if (mode === 'fail' || (mode === 'drain-fail' && count > 2)) { process.stderr.write('secret remote diagnostic'); process.exit(255); }",
    "if (mode === 'overflow') { process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 120)); return; }",
    'const command = process.argv.at(-1);',
    "let hit = /^stat -c '%F\\|%s' -- (.+)$/.exec(command);",
    'if (hit) {',
    "  if (mode === 'drain-missing' && count > 2) process.exit(1);",
    "  if (['fifo', 'device', 'directory'].includes(mode)) { process.stdout.write(({ fifo: 'fifo', device: 'character special file', directory: 'directory' })[mode] + '|0\\n'); return; }",
    '  try { process.stdout.write("regular file|" + fs.statSync(hit[1]).size + "\\n"); }',
    '  catch (e) { process.exit(1); }',
    '  return;',
    '}',
    'hit = /^tail -c \\+(\\d+) -- (.+) \\| head -c 1048576$/.exec(command);',
    'if (!hit) process.exit(2);',
    'try { process.stdout.write(fs.readFileSync(hit[2]).subarray(Number(hit[1]) - 1, Number(hit[1]) - 1 + 1048576)); }',
    'catch (e) { process.exit(1); }'
  ].join('\n') + '\n');
  fs.chmodSync(ssh, 0o755);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    log: path.join(root, 'remote.log'),
    env: {
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      CODEOME_HPC_HOST: host,
      CODEOME_HPC_SOCKET: socket,
      CODEOME_WATCH_TEST: '1',
      CODEOME_WATCH_REMOTE_POLL: '0.05',
      CODEOME_WATCH_WAIT: '0.2',
      CODEOME_TEST_SSH_ARGS: path.join(root, 'ssh-args.jsonl'),
      CODEOME_TEST_SSH_COUNT: path.join(root, 'ssh-count'),
      CODEOME_TEST_SSH_MODE: path.join(root, 'ssh-mode')
    }
  };
}

function args(p, key, parser, extra = []) {
  return ['watch', '--remote-log', p.log, '--parser', parser, '--label', 'Remote run', '--task', key, ...extra];
}

function run(p, argv, env = {}) {
  return spawnSync('python3', ['-B', path.join(p.root, '.codeome', 'bin', 'codeome-agent'), ...argv], {
    cwd: p.root, encoding: 'utf8', timeout: 10000, env: { ...process.env, ...p.env, ...env }
  });
}

function launch(t, p, argv, env = {}) {
  const child = spawn('python3', ['-B', path.join(p.root, '.codeome', 'bin', 'codeome-agent'), ...argv], {
    cwd: p.root, env: { ...process.env, ...p.env, ...env }
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const result = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  return { child, result };
}

function stage(p, key) {
  return JSON.parse(fs.readFileSync(path.join(p.root, '.codeome', 'jobs', '.tasks', key, 'progress.json'), 'utf8')).stages[0];
}

function calls(p) {
  if (!fs.existsSync(p.env.CODEOME_TEST_SSH_ARGS)) return [];
  return fs.readFileSync(p.env.CODEOME_TEST_SSH_ARGS, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

async function until(check, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if (check()) return; } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('timed out waiting for remote watcher');
}

test('remote vitest follows split lines and finishes after counts rise', async (t) => {
  const p = project(t);
  fs.writeFileSync(p.log, '');
  const watch = launch(t, p, args(p, 'vitest', 'vitest', ['--total', '2']));
  await until(() => calls(p).length >= 2);
  fs.appendFileSync(p.log, '   \x1b[32m✓ src/lib/foo.test');
  await until(() => calls(p).length >= 4);
  fs.appendFileSync(p.log, '.ts\x1b[0m  (1 test)\n');
  await until(() => stage(p, 'vitest').done === 1);
  assert.equal(stage(p, 'vitest').state, 'running');
  fs.appendFileSync(p.log, '   ✓ src/lib/bar.spec.ts  (1 test)\n Test Files  2 passed (2)\n');
  const result = await watch.result;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual([stage(p, 'vitest').done, stage(p, 'vitest').total, stage(p, 'vitest').state], [2, 2, 'done']);
});

test('remote snakemake counts steps and waits for its summary', async (t) => {
  const p = project(t);
  fs.writeFileSync(p.log, '');
  const watch = launch(t, p, args(p, 'snake', 'snakemake'));
  fs.appendFileSync(p.log, 'Job stats:\njob count\ntotal 2\n\n0 of 2 steps (0%) done\n');
  await until(() => stage(p, 'snake').total === 2);
  fs.appendFileSync(p.log, '1 of 2 steps (50%) done\n');
  await until(() => stage(p, 'snake').done === 1);
  assert.equal(stage(p, 'snake').state, 'running');
  fs.appendFileSync(p.log, '2 of 2 steps (100%) done\nComplete log: .snakemake/log/run.log\n');
  const result = await watch.result;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual([stage(p, 'snake').done, stage(p, 'snake').total, stage(p, 'snake').state], [2, 2, 'done']);
});

test('remote vitest failure summary ends failed with completed count', (t) => {
  const p = project(t);
  fs.writeFileSync(p.log, '   ✗ src/lib/foo.test.ts\n Test Files  1 failed (1)\n');
  const r = run(p, args(p, 'failed', 'vitest', ['--total', '1']));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([stage(p, 'failed').done, stage(p, 'failed').state], [1, 'failed']);
});

test('truncation restarts the offset and discards an old partial line', async (t) => {
  const p = project(t);
  fs.writeFileSync(p.log, 'x'.repeat(200));
  const watch = launch(t, p, args(p, 'rotated', 'vitest', ['--total', '1']));
  await until(() => calls(p).filter((call) => call.at(-1).startsWith('stat ')).length >= 2);
  fs.writeFileSync(p.log, '   ✓ src/lib/new.test.ts\n Test Files  1 passed (1)\n');
  await until(() => calls(p).filter((call) => /^tail -c \+1 -- /.test(call.at(-1))).length >= 2);
  const result = await watch.result;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual([stage(p, 'rotated').done, stage(p, 'rotated').state], [1, 'done']);
  const tails = calls(p).filter((call) => call.at(-1).startsWith('tail '));
  assert.match(tails[0].at(-1), /^tail -c \+1 -- /);
  assert.ok(tails.slice(1).some((call) => /^tail -c \+1 -- /.test(call.at(-1))));
});

test('SSH argv contains both exact remote commands and the next byte offset', async (t) => {
  const p = project(t);
  fs.writeFileSync(p.log, '   ✓ src/lib/foo.test.ts\n');
  const initialSize = fs.statSync(p.log).size;
  const watch = launch(t, p, args(p, 'argv', 'vitest', ['--total', '2']));
  await until(() => stage(p, 'argv').done === 1);
  fs.appendFileSync(p.log, '   ✓ src/lib/bar.spec.ts\n Test Files  2 passed (2)\n');
  const result = await watch.result;
  assert.equal(result.code, 0, result.stderr);
  const expected = ['-o', `ControlPath=${socket}`, '-o', 'ControlMaster=no', '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10', host];
  const commands = calls(p);
  assert.ok(commands.length >= 4);
  assert.deepEqual(commands[0], ['-o', `ControlPath=${socket}`, '-O', 'check', host]);
  assert.deepEqual(commands[1], [...expected, `stat -c '%F|%s' -- ${p.log}`]);
  assert.deepEqual(commands[2], [...expected, `tail -c +1 -- ${p.log} | head -c 1048576`]);
  assert.deepEqual(commands[3], [...expected, `stat -c '%F|%s' -- ${p.log}`]);
  assert.deepEqual(commands[4], [...expected, `tail -c +${initialSize + 1} -- ${p.log} | head -c 1048576`]);
  const progress = fs.readFileSync(path.join(p.root, '.codeome', 'jobs', '.tasks', 'argv', 'progress.json'), 'utf8');
  assert.doesNotMatch(progress, /mjolnirgate|codeome-remote-socket/);
});

test('bad remote paths fail without any SSH call', (t) => {
  const p = project(t);
  const bad = ['/a/../b', 'relative', '/a b', '/a;b', '/a$(x)', '/a\nb', '-x', '/' + 'a'.repeat(1024), '/a//b'];
  for (const [i, remote] of bad.entries()) {
    const argv = args(p, `bad-${i}`, 'vitest', ['--total', '1']);
    if (remote === '-x') argv.splice(1, 2, `--remote-log=${remote}`);
    else argv[2] = remote;
    const r = run(p, argv);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, 'codeome-agent: warning: watch: invalid remote log path\n');
    assert.equal(stage(p, `bad-${i}`).state, 'failed');
  }
  assert.deepEqual(calls(p), []);
});

test('conflicting options and missing HPC environment fail before SSH', (t) => {
  const p = project(t);
  fs.writeFileSync(p.log, '');
  const cases = [
    ['pid', ['--pid', '123'], {}, /--pid/],
    ['both', ['--log', p.log], {}, /mutually exclusive/],
    ['host', [], { CODEOME_HPC_HOST: '' }, /HPC connection unavailable/],
    ['socket', [], { CODEOME_HPC_SOCKET: '' }, /HPC connection unavailable/]
  ];
  for (const [key, extra, env, warning] of cases) {
    const r = run(p, args(p, key, 'vitest', ['--total', '1', ...extra]), env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, warning);
    assert.equal(stage(p, key).state, 'failed');
  }
  assert.deepEqual(calls(p), []);
});

test('a missing remote file waits and then fails', (t) => {
  const p = project(t);
  const r = run(p, args(p, 'missing', 'vitest', ['--total', '1']));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, 'codeome-agent: warning: watch: log file did not appear\n');
  assert.equal(stage(p, 'missing').state, 'failed');
  assert.ok(calls(p).length >= 2);
});

test('three SSH failures fail with a short reason', (t) => {
  const p = project(t);
  fs.writeFileSync(p.env.CODEOME_TEST_SSH_MODE, 'fail');
  const r = run(p, args(p, 'disconnect', 'vitest', ['--total', '1']));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, 'codeome-agent: warning: watch: lost connection to HPC\n');
  assert.equal(stage(p, 'disconnect').state, 'failed');
  assert.equal(calls(p).filter((call) => call.at(-1).startsWith('stat ')).length, 3);
});

test('SSH output beyond one mebibyte is capped and does not hang', (t) => {
  const p = project(t);
  fs.writeFileSync(p.env.CODEOME_TEST_SSH_MODE, 'overflow');
  const r = run(p, args(p, 'overflow', 'vitest', ['--total', '1']));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /lost connection to HPC/);
  assert.equal(stage(p, 'overflow').state, 'failed');
  assert.equal(calls(p).filter((call) => call.at(-1).startsWith('stat ')).length, 3);
});

test('dead control socket prevents remote data reads', (t) => {
  const p = project(t);
  fs.writeFileSync(p.env.CODEOME_TEST_SSH_MODE, 'dead');
  const r = run(p, args(p, 'dead', 'vitest', ['--total', '1']));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /HPC connection not available/);
  assert.equal(stage(p, 'dead').state, 'failed');
  assert.equal(calls(p).length, 1);
  assert.ok(calls(p)[0].includes('-O'));
});

test('remote non-regular files fail before tail', (t) => {
  for (const mode of ['fifo', 'device', 'directory']) {
    const p = project(t);
    fs.writeFileSync(p.env.CODEOME_TEST_SSH_MODE, mode);
    const r = run(p, args(p, mode, 'vitest', ['--total', '1']));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /remote log is not a regular file/);
    assert.equal(stage(p, mode).state, 'failed');
    assert.ok(calls(p).every((call) => !call.at(-1).startsWith('tail ')));
  }
});

test('drain uses normal SSH and missing-file limits', (t) => {
  for (const [mode, expected] of [['drain-fail', 'lost connection to HPC'], ['drain-missing', 'log file did not appear']]) {
    const p = project(t);
    fs.writeFileSync(p.log, '   ✓ src/lib/foo.test.ts\n Test Files  1 passed (1)\n');
    fs.writeFileSync(p.env.CODEOME_TEST_SSH_MODE, mode);
    const r = run(p, args(p, mode, 'vitest', ['--total', '1']));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(expected));
    assert.equal(stage(p, mode).state, 'failed');
    assert.ok(Number(fs.readFileSync(p.env.CODEOME_TEST_SSH_COUNT, 'utf8')) < 12);
  }
});
