const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const main = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '../main/preload.js'), 'utf8');
const core = fs.readFileSync(path.join(__dirname, '../renderer/js/core.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');

test('main process records crashes, heartbeat, exits, and offers the previous report', () => {
  assert.match(main, /require\('\.\/crashlog'\)/);
  assert.match(main, /crashReporter\.start\(\{ uploadToServer: false, compress: true \}\)/);
  const previous = main.indexOf('crashlog.previousRun(logDir)');
  assert.ok(previous >= 0 && previous < main.indexOf('crashlog.init('));
  assert.match(main, /process\.platform === 'darwin' \? path\.join\(os\.homedir\(\), 'Library', 'Logs', 'Codeome'\) : path\.join\(app\.getPath\('userData'\), 'logs'\)/);
  assert.match(main, /crashlog\.init\(\{ dir: logDir, version: app\.getVersion\(\) \}\)/);
  for (const event of ['uncaughtException', 'unhandledRejection', 'render-process-gone', 'child-process-gone', 'unresponsive', 'responsive', 'did-fail-load', 'console-message']) {
    assert.match(main, new RegExp(`['"]${event}['"]`));
  }
  assert.match(main, /crashlog\.heartbeat\(\{ mem \}\)/);
  assert.match(main, /catch \(err\) \{ crashlog\.logError\('heartbeat', err\); \}/);
  assert.match(main, /heartbeatTimer\.unref\(\)/);
  assert.match(main, /crashlog\.markClean\(\)/);
  assert.match(main, /Codeome closed unexpectedly last time/);
  assert.match(main, /buttons: \['Open log', 'Copy report', 'OK'\]/);
  assert.match(main, /label: 'Reveal Logs'/);
  assert.match(main, /'pty exit'/);
  assert.match(main, /'chat exit'/);
  assert.match(main, /String\(r\.stderr\)\.trimStart\(\)\.split\(\/\\r\?\\n\/, 1\)\[0\]\.slice\(0, 200\)/);
  assert.match(main, /if \(quitting \|\| !win \|\| win\.isDestroyed\(\) \|\| wc !== win\.webContents\) return/);
  assert.match(main, /exceptionDialogOpen \|\| Date\.now\(\) - lastExceptionDialogAt < 10000/);
});

test('renderer errors cross the preload bridge and IPC validates and truncates them', () => {
  assert.match(preload, /logError: \(error\) => ipcRenderer\.send\('log:renderer', error\)/);
  assert.ok(index.indexOf('js/core.js') >= 0 && index.indexOf('js/core.js') < index.indexOf('js/app.js'));
  const listeners = {};
  const forwarded = [];
  const renderer = core.slice(0, core.indexOf('window.App ='));
  vm.runInNewContext(renderer, { window: { addEventListener: (name, cb) => { listeners[name] = cb; } }, codeome: { logError: (value) => forwarded.push(value) } });
  listeners.error({ message: 'broken', error: { stack: 'trace' } });
  listeners.unhandledrejection({ reason: { message: 'rejected', stack: 'rejection trace' } });
  assert.deepEqual(JSON.parse(JSON.stringify(forwarded)), [
    { message: 'broken', stack: 'trace' }, { message: 'rejected', stack: 'rejection trace' }
  ]);

  let handler;
  const logged = [];
  const webContents = {};
  const start = main.indexOf("ipcMain.on('log:renderer'");
  const end = main.indexOf('\n});', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(main.slice(start, end + 4), {
    ipcMain: { on: (_name, cb) => { handler = cb; } },
    win: { isDestroyed: () => false, webContents },
    logRendererLine: (...args) => logged.push(args)
  });
  handler({ sender: {} }, 'ignored');
  handler({ sender: webContents }, null);
  handler({ sender: webContents }, ['bad']);
  handler({ sender: webContents }, { extra: 'ignored' });
  assert.equal(logged.length, 0);
  handler({ sender: webContents }, { message: 'broken', stack: 'trace' });
  assert.deepEqual(logged[0], ['broken\ntrace', 'renderer']);
  handler({ sender: webContents }, 'x'.repeat(3000));
  assert.equal(logged[1][0].length, 2000);
});

test('renderer error lines share a 20 per 10 second limiter and duplicate messages are counted', () => {
  const logged = [];
  let timer;
  let now = 1000;
  const start = main.indexOf('let rendererLogTimer =');
  const end = main.indexOf('\nfunction send(', start);
  assert.ok(start >= 0 && end > start);
  const { logRendererLine } = vm.runInNewContext(main.slice(start, end) + '\n({ logRendererLine })', {
    crashlog: { log: (...args) => logged.push(args) },
    Date: { now: () => now },
    setTimeout: (cb) => { timer = cb; return { unref() {} }; },
    clearTimeout: () => {}
  });
  logRendererLine('same\nstack', 'renderer');
  logRendererLine('same', 'renderer console');
  for (let i = 0; i < 31; i++) logRendererLine(`message ${i}`, 'renderer');
  assert.equal(logged.length, 20);
  timer();
  assert.deepEqual(logged[20], ['warn', '13 renderer log lines suppressed']);
  now += 10000;
  logRendererLine('same', 'renderer');
  assert.deepEqual(logged[21], ['error', 'renderer: same']);
  logRendererLine('intervening', 'renderer');
  logRendererLine('same', 'renderer console');
  assert.equal(logged.length, 23);
  timer();
  assert.deepEqual(logged[23], ['warn', '1 renderer log lines suppressed']);
  now += 10000;
  logRendererLine('same\nfirst stack', 'renderer');
  logRendererLine('same\nsecond stack', 'renderer');
  assert.equal(logged.length, 26);

  let consoleHandler;
  const consoleStart = main.indexOf("win.webContents.on('console-message'");
  const consoleEnd = main.indexOf('\n  });', consoleStart);
  assert.ok(consoleStart >= 0 && consoleEnd > consoleStart);
  const received = [];
  vm.runInNewContext(main.slice(consoleStart, consoleEnd + 5), {
    win: { webContents: { on: (_name, cb) => { consoleHandler = cb; } } },
    logRendererLine: (...args) => received.push(args)
  });
  consoleHandler({ details: { level: 'warning', message: 'skip' } });
  consoleHandler({ details: { level: 'error', message: 'log me' } });
  assert.deepEqual(received, [['log me', 'renderer console']]);
});
