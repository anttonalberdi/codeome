const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const setup = require('../main/setup');
const source = fs.readFileSync(require.resolve('../renderer/js/core.js'), 'utf8');
function load(platform) {
  const App = {};
  vm.runInNewContext(source.slice(source.indexOf('App.platform ='), source.indexOf('App.isIdeas =')), { App, window: { codeome: { platform } } });
  return App;
}

test('keyboard hints preserve macOS and name Windows/Linux modifiers', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const App = load(platform);
    for (const [mac, other] of [['⌘1', 'Ctrl+1'], ['⇧⌘T', 'Ctrl+Shift+T'], ['⌥⌘R', 'Ctrl+Alt+R'], ['⌘↩', 'Ctrl+Enter']]) {
      assert.equal(App.keyLabel(mac), platform === 'darwin' ? mac : other);
    }
    const text = 'This Mac · macOS Keychain · ⌘1';
    assert.equal(App.uiText(text), platform === 'darwin' ? text : 'This computer · system credential store · Ctrl+1');
  }
});

test('Windows prerequisites detect bash and require a working Python 3 version', async () => {
  const calls = [];
  const list = await setup.prerequisites({ platform: 'win32', findBash: () => 'git/bash.exe', runCommand: async (...args) => {
    calls.push(args);
    return args[1][2].startsWith('python3 ') ? { code: 1, stdout: 'Python 3.12' } : { code: 0, stdout: 'Python 3.13.1' };
  } });
  assert.deepEqual(list.map((t) => [t.label, t.ok]), [['Git for Windows', true], ['python3', true]]);
  assert.equal(list[0].url, 'https://git-scm.com/download/win');
  assert.equal(list[1].path, 'python');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([shell, args]) => shell === 'git/bash.exe' && args[2].endsWith(' --version')));
  assert.doesNotMatch(JSON.stringify(list), /brew/i);
  const missing = await setup.prerequisites({ platform: 'win32', findBash: () => null, runCommand: () => assert.fail('no bash') });
  assert.ok(missing.every((t) => !t.ok));
  const launcher = await setup.prerequisites({ platform: 'win32', findBash: () => 'bash', runCommand: async (_, args) => ({ code: args[2] === 'py -3 --version' ? 0 : 1, stdout: 'Python 3.12' }) });
  assert.equal(launcher[1].path, 'py -3');
});

test('macOS recipe list and install plans match HEAD behaviour', async () => {
  const head = execFileSync('git', ['show', 'HEAD:main/setup.js'], { encoding: 'utf8' });
  const module = { exports: {} };
  vm.runInNewContext(head, { require: (id) => require(require.resolve(id, { paths: [require('node:path').dirname(require.resolve('../main/setup'))] })), module, process });
  assert.equal(JSON.stringify(setup.RECIPES), JSON.stringify(module.exports.RECIPES));
  assert.equal(setup.BREW_INSTALL, module.exports.BREW_INSTALL);
  assert.equal(JSON.stringify(setup.installCommand(Object.keys(setup.RECIPES))), JSON.stringify(module.exports.installCommand(Object.keys(module.exports.RECIPES))));
  assert.deepEqual(await setup.prerequisites({ platform: 'darwin', findBash: () => assert.fail('macOS list unchanged') }), []);
});


test('Windows install requests cannot offer a Homebrew recipe', () => {
  const filename = require.resolve('../main/setup');
  const nativeRequire = require('node:module').createRequire(filename);
  const module = { exports: {} };
  const requireStub = (id) => id === './platform' ? { ...nativeRequire(id), isWin: true } : nativeRequire(id);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: requireStub, module, process });
  assert.equal(module.exports.installCommand(['python3', 'git', 'openconnect']), null);
});
