const test = require('node:test');
const assert = require('node:assert/strict');
const { localPtySpec } = require('../main/spawn-spec');
const { cliSpawnSpec, fromPosixForShell, killTree } = require('../main/platform');

const bashPath = 'C:\\Program Files\\Git\\bin\\bash.exe';
const cwd = 'C:\\Users\\me\\project';

test('Darwin local pty specs retain the original shell and command strings', () => {
  const options = { platform: 'darwin', env: { SHELL: '/bin/zsh' }, cwd: '/Users/me/project' };
  for (const [kind, args] of [
    ['shell', ['-l']],
    ['task', ['-l', '-c', 'echo hi; echo; echo "[process exited with $?]"; exec /bin/zsh -l']],
    ['agent-local', ['-l', '-c', 'echo hi; exec /bin/zsh -l']],
    ['console', ['-l', '-c', 'echo hi']]
  ]) assert.deepEqual(localPtySpec({ kind, command: 'echo hi' }, options), { file: '/bin/zsh', args, cwd: options.cwd });
});

test('Windows pty uses Git bash and quotes its POSIX path, leaving cwd native', () => {
  assert.deepEqual(localPtySpec({ kind: 'task', command: 'echo hi' }, { platform: 'win32', env: {}, bashPath, cwd }), {
    file: bashPath, args: ['-l', '-c', 'echo hi; echo; echo "[process exited with $?]"; exec \'/c/Program Files/Git/bin/bash.exe\' -l'], cwd
  });
});

test('chat launch preserves Darwin argv and converts the Windows binary operand', () => {
  assert.deepEqual(cliSpawnSpec('/Users/me/bin/claude', ['-p'], { platform: 'darwin', env: { SHELL: '/bin/zsh' } }), {
    file: '/bin/zsh', args: ['-l', '-c', 'exec "$0" "$@"', '/Users/me/bin/claude', '-p']
  });
  assert.deepEqual(cliSpawnSpec('C:\\Users\\me\\bin\\claude.cmd', ['-p'], { platform: 'win32', env: {}, bashPath }), {
    file: bashPath, args: ['-l', '-c', 'exec "$0" "$@"', 'C:/Users/me/bin/claude.cmd', '-p']
  });
});

test('missing Git bash reports the installation requirement', () => {
  const options = { platform: 'win32', env: {}, bashPath: null, cwd };
  assert.throws(() => localPtySpec({ kind: 'shell' }, options), /Git for Windows is required/);
  assert.throws(() => cliSpawnSpec('claude', [], options), /Git for Windows is required/);
});

test('bash lookup paths become native for filesystem consumers', () => {
  assert.equal(fromPosixForShell('/c/Users/me/bin/inkscape.exe', 'win32'), 'C:\\Users\\me\\bin\\inkscape.exe');
  assert.equal(fromPosixForShell('/usr/bin/inkscape', 'darwin'), '/usr/bin/inkscape');
});

test('non-Windows cancellation keeps the child signal behavior', () => {
  const signals = [];
  killTree({ kill: signal => signals.push(signal) }, 'SIGTERM', { platform: 'darwin' });
  assert.deepEqual(signals, ['SIGTERM']);
});

test('Windows cancellation uses hidden taskkill for the entire process tree', () => {
  const childProcess = require('child_process');
  const original = childProcess.spawn;
  let actual;
  childProcess.spawn = (...args) => { actual = args; return { on() {} }; };
  try {
    killTree({ pid: 123 }, 'SIGKILL', { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } });
    assert.deepEqual(actual, ['C:\\Windows\\System32\\taskkill.exe', ['/pid', '123', '/T', '/F'], { windowsHide: true }]);
  } finally { childProcess.spawn = original; }
});
