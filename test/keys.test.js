const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../renderer/js/core.js'), 'utf8');
function load(platform) {
  const App = {};
  vm.runInNewContext(source.slice(source.indexOf('App.platform ='), source.indexOf('App.isIdeas =')), { App, window: { codeome: { platform } } });
  return App;
}
const event = (key, extra = {}) => ({ type: 'keydown', key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...extra });

test('command modifier follows preload platform, with a macOS fallback', () => {
  for (const platform of ['darwin', 'win32', 'linux', undefined]) {
    const App = load(platform);
    const mac = platform === 'darwin' || platform === undefined;
    assert.equal(App.isMod(event('x', { metaKey: true })), mac);
    assert.equal(App.isMod(event('x', { ctrlKey: true })), !mac);
    assert.equal(App.isMod(event('x')), false);
    assert.equal(App.isMod(event('x', { metaKey: true, ctrlKey: true })), true);
  }
});

test('macOS terminal decisions preserve existing key and selection rules', () => {
  const App = load('darwin');
  const action = (key, extra = {}, hasSelection = false) => App.terminalKeyAction(event(key, { metaKey: true, ...extra }), { hasSelection });
  assert.equal(action('k'), 'clear');
  assert.equal(action('f'), 'find');
  assert.equal(action('c', {}, true), 'copy');
  assert.equal(action('c'), null);
  assert.equal(action('v', { shiftKey: true }), null);
  assert.equal(action('K', { shiftKey: true }), null);
  assert.equal(action('k', { type: 'keyup' }), null);
  assert.equal(action('k', { metaKey: false, ctrlKey: true }), null);
});

test('Windows and Linux terminal decisions keep SIGINT and readline available', () => {
  for (const platform of ['win32', 'linux']) {
    const App = load(platform);
    const action = (key, extra = {}, hasSelection = false) => App.terminalKeyAction(event(key, { ctrlKey: true, ...extra }), { hasSelection });
    assert.equal(action('c'), null);
    assert.equal(action('c', {}, true), 'copy');
    assert.equal(action('C', { shiftKey: true }), 'copy');
    assert.equal(action('V', { shiftKey: true }), 'paste');
    assert.equal(action('v'), null);
    assert.equal(action('k'), null);
    assert.equal(action('K', { shiftKey: true }), 'clear');
    assert.equal(action('f'), 'find');
    assert.equal(action('c', { altKey: true }, true), null);
    assert.equal(action('f', { type: 'keyup' }), null);
    assert.equal(action('f', { ctrlKey: false, metaKey: true }), null);
  }
});
