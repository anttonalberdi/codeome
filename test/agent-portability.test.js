const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('./helpers/portable-process');

const source = path.join(__dirname, '..', 'kit', 'bin', 'codeome-agent');

function project(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-portable-')));
  const agent = path.join(root, '.codeome', 'bin', 'codeome-agent');
  fs.mkdirSync(path.dirname(agent), { recursive: true });
  fs.copyFileSync(source, agent);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, agent };
}

test('regular file readers and message writes work without POSIX file APIs', (t) => {
  const { root, agent } = project(t);
  const file = path.join(root, 'record.json');
  fs.writeFileSync(file, '{"text":"hé😀"}\r\n');
  const script = `import json, os, runpy, sys
os.__dict__.pop('O_NONBLOCK', None)
os.__dict__.pop('fchmod', None)
f = runpy.run_path(sys.argv[1])
file = sys.argv[2]
assert f['progress_text'](file) == open(file, encoding='utf-8', newline='').read()
assert json.loads(f['touched_file'](file)[0])['text'] == sys.stdin.read()
f['message_write'](os.path.dirname(file), '123-abcdef12', {'text': 'hé😀'})
assert f['pid_alive'](os.getpid())
assert f['pid_alive'](int(sys.argv[3]))
assert not f['pid_alive'](2147483647)
print('ok')
`;
  const result = spawnSync('python3', ['-B', '-c', script, agent, file, String(process.pid)], {
    input: 'hé😀', encoding: 'utf8', env: { ...process.env,
      ...(process.platform === 'win32' ? { PYTHONIOENCODING: 'cp1252' } : {}) }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ok\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '123-abcdef12.json'), 'utf8')), { text: 'hé😀' });
});

test('local watch completes without O_NONBLOCK and reads CRLF log bytes', (t) => {
  const { root, agent } = project(t);
  const log = path.join(root, 'watch.log');
  fs.writeFileSync(log, ' ✓ src/example.test.ts\r\n Test Files  1 passed (1)\r\n');
  const script = "import os, runpy, sys; os.__dict__.pop('O_NONBLOCK', None); sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name='__main__')";
  const result = spawnSync('python3', ['-B', '-c', script, agent, 'watch', '--parser', 'vitest',
    '--log', log, '--total', '1', '--label', 'Portable', '--task', 'portable'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const progress = JSON.parse(fs.readFileSync(path.join(root, '.codeome', 'jobs', '.tasks', 'portable', 'progress.json'), 'utf8'));
  assert.deepEqual([progress.stages[0].done, progress.stages[0].total, progress.stages[0].state], [1, 1, 'done']);
});

test('Windows CLI cancellation kills the tree and records cancellation', (t) => {
  const { agent } = project(t);
  const script = `import os, runpy, sys, types
f = runpy.run_path(sys.argv[1])
job = {'id': 'test', 'engine': 'codex', 'status': 'running', 'pid': 123}
saved, calls = [], []
g = f['cmd_cancel'].__globals__
g['find_job'] = lambda _: job
g['save_job'] = lambda value: saved.append(dict(value))
g['subprocess'] = types.SimpleNamespace(DEVNULL=-3, PIPE=-1, run=lambda argv, **kwargs: calls.append(argv) or types.SimpleNamespace(returncode=0))
g['os'] = types.SimpleNamespace(name='nt')
f['cmd_cancel'](types.SimpleNamespace(id='test'))
assert calls == [['taskkill', '/PID', '123', '/T', '/F']]
assert saved[0]['status'] == 'cancelled' and saved[0]['exitCode'] == 130
assert saved[0]['endedAt']
job['pid'] = '../bad'
try:
    f['cmd_cancel'](types.SimpleNamespace(id='test'))
    raise AssertionError('invalid PID accepted')
except SystemExit:
    pass
assert len(calls) == 1
`;
  const result = spawnSync('python3', ['-B', '-c', script, agent], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Cancelling test\n');
});
