const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const platform = require('../main/platform');

test('platform checks use the host by default and accept an injected platform', () => {
  assert.equal(platform.isWin, process.platform === 'win32');
  assert.equal(platform.isMac, process.platform === 'darwin');
  assert.equal(platform.isWinPlatform('win32'), true);
  assert.equal(platform.isWinPlatform('darwin'), false);
  assert.equal(platform.isMacPlatform('darwin'), true);
  assert.equal(platform.isMacPlatform('linux'), false);
});

test('findBash checks the override, installed Git locations, then PATH', () => {
  const env = {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
    PATH: 'C:\\Windows\\System32;C:\\Other\\bin'
  };
  const candidates = [
    'D:\\custom\\bash.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe',
    'C:\\Other\\bin\\bash.exe'
  ];
  const checked = [];
  const exists = (p) => { checked.push(p); return p === candidates[4]; };
  assert.equal(platform.findBash({ platform: 'win32', env, exists, override: candidates[0] }), candidates[4]);
  assert.deepEqual(checked, candidates);
  assert.equal(platform.findBash({ platform: 'win32', env, exists: () => false }), null);
  assert.equal(platform.findBash({ platform: 'darwin', env, exists: () => true, override: candidates[0] }), null);
});

test('findBash stops at the first existing candidate', () => {
  const env = { ProgramFiles: 'C:\\Program Files', PATH: 'C:\\Tools' };
  const checked = [];
  const override = 'D:\\custom\\bash.exe';
  assert.equal(platform.findBash({ platform: 'win32', env, override, exists: (p) => { checked.push(p); return true; } }), override);
  assert.deepEqual(checked, [override]);
  assert.equal(platform.findBash({ platform: 'win32', env, exists: () => true }), 'C:\\Program Files\\Git\\bin\\bash.exe');
});

test('loginShell preserves the macOS shell choice and finds Git Bash on Windows', () => {
  assert.equal(platform.loginShell({ platform: 'darwin', env: { SHELL: '/bin/fish' } }), '/bin/fish');
  assert.equal(platform.loginShell({ platform: 'linux', env: {} }), '/bin/zsh');
  assert.equal(platform.loginShell({ platform: 'win32', env: {} }), null);
});

test('shellEnv adds Git Bash settings only on Windows', () => {
  assert.deepEqual(platform.shellEnv({}, 'win32'), { CHERE_INVOKING: '1', MSYS_NO_PATHCONV: '1' });
  assert.deepEqual(platform.shellEnv({}, 'darwin'), {});
  assert.deepEqual(platform.shellEnv({}, 'linux'), {});
});

test('toPosixForShell converts drive and UNC paths', () => {
  assert.equal(platform.toPosixForShell('C:\\a b\\c'), '/c/a b/c');
  assert.equal(platform.toPosixForShell('D:/x'), '/d/x');
  assert.equal(platform.toPosixForShell('\\\\host\\share\\x'), '//host/share/x');
  assert.equal(platform.toPosixForShell('/already/posix'), '/already/posix');
  assert.equal(platform.toPosixForShell(''), '');
  assert.equal(platform.toPosixForShell(undefined), undefined);
});

test('PATH list helpers use the target platform separator', () => {
  assert.deepEqual(platform.pathListSplit('C:\\Git;D:\\Tools', 'win32'), ['C:\\Git', 'D:\\Tools']);
  assert.equal(platform.pathListJoin(['C:\\Git', 'D:\\Tools'], 'win32'), 'C:\\Git;D:\\Tools');
  assert.deepEqual(platform.pathListSplit('/usr/bin:/bin', 'darwin'), ['/usr/bin', '/bin']);
  assert.equal(platform.pathListJoin(['/usr/bin', '/bin'], 'linux'), '/usr/bin:/bin');
});

test('darwin toolDirs matches augmentedEnv paths in util.js', () => {
  const home = os.homedir();
  assert.deepEqual(platform.toolDirs({ platform: 'darwin', env: { HOME: home } }), [
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin',
    path.join(home, '.local/bin'), path.join(home, 'bin'),
    path.join(home, 'miniforge3/bin'), path.join(home, 'miniconda3/bin'), path.join(home, 'anaconda3/bin'),
    path.join(home, '.npm-global/bin'), path.join(home, '.cargo/bin'),
    '/Applications/quarto/bin', '/Library/Frameworks/R.framework/Resources/bin',
    '/usr/bin', '/bin', '/usr/sbin', '/sbin'
  ]);
  assert.deepEqual(platform.toolDirs({ platform: 'linux', env: {} }), []);
});

test('Windows toolDirs uses only configured environment locations', () => {
  assert.deepEqual(platform.toolDirs({ platform: 'win32', env: {} }), []);
  assert.deepEqual(platform.toolDirs({ platform: 'win32', env: {
    ProgramFiles: 'C:\\Program Files', APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', NVM_SYMLINK: 'C:\\Node'
  } }), [
    'C:\\Program Files\\Git\\usr\\bin', 'C:\\Program Files\\Git\\cmd',
    'C:\\Users\\me\\AppData\\Roaming\\npm',
    'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\usr\\bin',
    'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd',
    'C:\\Users\\me\\AppData\\Local\\Programs\\nodejs',
    'C:\\Users\\me\\AppData\\Local\\Volta\\bin', 'C:\\Node'
  ]);
});

test('Windows executable lookup skips cwd, relative and empty PATH entries', () => {
  const checked = [];
  const env = { Path: ';.;relative;C:relative;C:\\Tools', PATHEXT: '.EXE;.CMD' };
  assert.equal(platform.resolveExecutable('git', { platform: 'win32', env, exists: p => { checked.push(p); return p.endsWith('.CMD'); } }), 'C:\\Tools\\git.CMD');
  assert.deepEqual(checked, ['C:\\Tools\\git.EXE', 'C:\\Tools\\git.CMD']);
  assert.equal(platform.resolveExecutable('git', { platform: 'darwin', env, exists: () => { throw Error('unexpected'); } }), 'git');
});

test('findBash ignores relative PATH entries and Windows stubs', () => {
  const checked = [];
  assert.equal(platform.findBash({ platform: 'win32', env: { PATH: '.;relative;C:relative;C:\\Windows\\System32;C:\\Users\\me\\WindowsApps;C:\\Git\\bin' }, exists: p => { checked.push(p); return true; } }), 'C:\\Git\\bin\\bash.exe');
  assert.deepEqual(checked, ['C:\\Git\\bin\\bash.exe']);
});

test('Git virtual paths use cygpath while drive paths convert directly', () => {
  for (const p of ['/mingw64/bin/git', '/usr/bin/x']) assert.equal(platform.fromPosixForShell(p, 'win32', value => 'native:' + value), 'native:' + p);
  assert.equal(platform.fromPosixForShell('/c/a/b', 'win32'), 'C:\\a\\b');
  assert.equal(platform.fromPosixForShell('/usr/bin/x', 'darwin'), '/usr/bin/x');
});

test('absolute project keys preserve POSIX and accept Windows drive and UNC roots', () => {
  for (const p of ['/a', 'C:\\a', '\\\\server\\share']) assert.equal(platform.isAbsoluteProject(p, 'win32'), true);
  assert.equal(platform.isAbsoluteProject('C:\\a', 'darwin'), false);
  assert.equal(platform.isAbsoluteProject('/a', 'darwin'), true);
});

test('Windows tree termination validates pid and tries graceful taskkill before force', async () => {
  const { EventEmitter } = require('events');
  const calls = [];
  const spawn = (file, args) => { calls.push({ file, args }); const child = new EventEmitter(); process.nextTick(() => child.emit('close', 0)); return child; };
  for (const pid of [0, 4, -1, '123', 1.5]) await platform.killTree({ pid }, 'SIGTERM', { platform: 'win32', spawn });
  assert.equal(calls.length, 0);
  await platform.killTree({ pid: 123 }, 'SIGTERM', { platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, spawn });
  assert.equal(calls[0].file, 'C:\\Windows\\System32\\taskkill.exe');
  assert.deepEqual(calls.map(c => c.args), [['/pid', '123', '/T'], ['/pid', '123', '/T', '/F']]);
});
