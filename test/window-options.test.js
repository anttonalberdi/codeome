const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { windowOptions } = require('../main/window-options');

for (const dark of [false, true]) {
  const expected = {
    width: 1500, height: 940, minWidth: 720, minHeight: 600,
    title: 'Codeome',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: dark ? '#1b1c1f' : '#f6f5f2',
    webPreferences: {
      preload: path.join(__dirname, '..', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  };
  test(`darwin preserves all existing window options (dark=${dark})`, () => {
    assert.deepEqual(windowOptions({ platform: 'darwin', dark }), expected);
  });
  for (const platform of ['win32', 'linux']) {
    test(`${platform} uses a native frame with the same web preferences (dark=${dark})`, () => {
      const options = windowOptions({ platform, dark });
      const { trafficLightPosition, ...native } = expected;
      assert.deepEqual(options, { ...native, titleBarStyle: 'default' });
      assert.equal(Object.hasOwn(options, 'trafficLightPosition'), false);
    });
  }
}

test('renderer exposes the preload platform on html before styles load', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/js/platform.js'), 'utf8');
  for (const platform of ['darwin', 'win32', 'linux']) {
    const document = { documentElement: { dataset: {} } };
    vm.runInNewContext(source, { document, window: { codeome: { platform } } });
    assert.equal(document.documentElement.dataset.platform, platform);
  }
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  assert.ok(html.indexOf('src="js/platform.js"') < html.indexOf('rel="stylesheet"'));
});
