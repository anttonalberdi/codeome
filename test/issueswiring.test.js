const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('issue IPC handlers and preload bridge expose the inbox channels', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../main/preload.js'), 'utf8');
  for (const channel of ['issues:list', 'issues:refresh', 'issues:setStatus', 'issues:markSeen',
    'issues:enable', 'issues:counts']) {
    assert.ok(main.includes(`ipcMain.handle('${channel}', wrap(`), channel + ' must use wrap');
    assert.ok(preload.includes(`'${channel}'`), channel + ' must be in the bridge');
  }
  assert.match(main, /send\('issues:changed', \{ project, counts:/);
  assert.match(preload, /onChanged: on\('issues:changed'\)/);
  assert.match(main, /win\.on\('focus',/);
  assert.match(main, /issuePoller\.start\(\)/);
  assert.match(main, /issuePoller\.stop\(\)/);
});

test('config updates preserve main-owned project issue settings and IPC rejects special project keys', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
  const configSet = main.slice(main.indexOf("ipcMain.handle('config:set'"), main.indexOf('if (typeof remote !==', main.indexOf("ipcMain.handle('config:set'")));
  assert.match(configSet, /config\.save\(\{ \.\.\.c,[\s\S]*projectIssues: cfg\.projectIssues/);
  const issueRoot = main.slice(main.indexOf('function issueRoot(project)'), main.indexOf('function issueCounts()'));
  for (const key of ['__proto__', 'constructor', 'hasOwnProperty']) {
    const validate = vm.runInNewContext(issueRoot + '\nissueRoot', {
      github: { inProject: () => true }, openRoots: () => [key], path
    });
    assert.throws(() => validate(key), /Choose an open project/);
  }
});

test('new issue notifications use the added count and expose the open event', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../main/preload.js'), 'utf8');
  const service = fs.readFileSync(path.join(__dirname, '../main/remote-service.js'), 'utf8');
  assert.match(main, /onChange: \(project, changes\) => \{ issueChanged\(project\); notifyNewIssues\(project, changes\); \}/);
  assert.match(main, /if \(!cfg\.issues\?\.notify \|\| !added\?\.length\) return/);
  assert.match(main, /remoteService\.notifyIssues\(project, added\.length\)/);
  assert.match(main, /win\.isFocused\(\) \|\| !Notification\.isSupported\(\)/);
  assert.match(main, /send\('issues:open', \{ project \}\)/);
  assert.match(preload, /onOpen: on\('issues:open'\)/);
  assert.match(service, /if \(listening && config\(\)\.ntfy\?\.enabled\) notifier\?\.notifyIssues\(\{ project, count \}\)/);
});
