const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('issue IPC handlers and preload bridge expose the inbox channels', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../main/preload.js'), 'utf8');
  for (const channel of ['issues:list', 'issues:refresh', 'issues:assess', 'issues:setStatus', 'issues:markSeen',
    'issues:enable', 'issues:counts']) {
    assert.ok(main.includes(`ipcMain.handle('${channel}', wrap(`), channel + ' must use wrap');
    assert.ok(preload.includes(`'${channel}'`), channel + ' must be in the bridge');
  }
  assert.match(main, /send\('issues:changed', \{ project, counts:/);
  assert.match(preload, /onChanged: on\('issues:changed'\)/);
  assert.match(preload, /assess: \(project, number\) => ipcRenderer\.invoke\('issues:assess', \{ project, number \}\)/);
  assert.match(main, /triaging: triagingIssue\?\.project === project && triagingIssue\.number === item\.number/);
  assert.match(main, /win\.on\('focus',/);
  assert.match(main, /issuePoller\.start\(\)/);
  assert.match(main, /issuePoller\.stop\(\)/);
});

function triageWiring() {
  const main = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
  const source = main.slice(main.indexOf('async function assessIssue('), main.indexOf('function notifyNewIssues('));
  const items = [
    { number: 1, body: 'old', updatedAt: '2026-11-01T00:00:00Z' },
    { number: 2, body: 'new', updatedAt: '2026-11-03T00:00:00Z' },
    { number: 3, body: 'middle', updatedAt: '2026-11-02T00:00:00Z' }
  ];
  const stored = [], changed = [], assessed = [], done = new Set();
  let runs = 0;
  const context = {
    triagingIssue: null, triagingDone: Promise.resolve(),
    cfg: { issues: { enabled: true, triageCap: 2, dailyTriageCap: 30, model: 'sonnet', autoTriageOutsiders: true },
      accounts: { claude: { list: [{ name: 'account', dir: '' }] } } },
    issueStore: {
      list: () => items.map((item) => ({ ...item, labels: item.labels?.slice() }))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      needsTriage: (_project, number) => !done.has(number),
      setTriage: (_project, number, result) => { stored.push(number); done.add(number); items.find((item) => item.number === number).triage = result; return result; },
      markAutoTriaged: (_project, number) => { items.find((item) => item.number === number).autoTriaged = true; },
      triageRunCount: () => runs,
      recordTriageRun: (cap) => { if (runs >= cap) return false; runs++; return true; }
    },
    issueChanged: (project) => changed.push(project),
    launchOn: () => ({ info: { name: 'account' }, env: {}, unset: [] }),
    cliCmd: () => 'claude', process: { env: {} }, JSON, oneShot: async () => ({}),
    triageIssue: async ({ issue }) => { assessed.push(issue.number); return { action: 'none', size: 'trivial', summary: 'No work.' }; }
  };
  const functions = vm.runInNewContext(source + '\n({ assessIssue, triageNewIssues })', context);
  return { context, functions, stored, changed, assessed, done, items, runs: () => runs };
}

test('automatic assessment uses the cap, newest first, and never repeats a completed issue', async () => {
  const f = triageWiring();
  await f.functions.triageNewIssues('/repo', [1, 2, 3]);
  assert.deepEqual(f.assessed, [2, 3]);
  assert.deepEqual(f.stored, [2, 3]);
  await f.functions.triageNewIssues('/repo', [1, 2, 3]);
  assert.deepEqual(f.assessed, [2, 3, 1]);
  f.done.delete(3); // An edit makes its existing assessment stale.
  f.items[2].body = 'edited';
  await f.functions.triageNewIssues('/repo', [3]);
  assert.deepEqual(f.assessed, [2, 3, 1]);
  f.context.cfg.issues.triageCap = 0;
  await f.functions.triageNewIssues('/repo', [3]);
  assert.deepEqual(f.assessed, [2, 3, 1]);
});

test('failed automatic assessment is attempted only once; daily budget limits automatic and manual runs', async () => {
  const f = triageWiring();
  f.context.cfg.issues.dailyTriageCap = 1;
  f.context.triageIssue = async ({ issue }) => { f.assessed.push(issue.number); return { error: 'Could not assess this issue.' }; };
  await f.functions.triageNewIssues('/repo', [1, 2, 3]);
  assert.deepEqual(f.assessed, [2]);
  await f.functions.triageNewIssues('/repo', [2, 3]);
  assert.deepEqual(f.assessed, [2]);
  assert.equal(f.items[1].autoTriaged, true);
  await assert.rejects(f.functions.assessIssue('/repo', 1), /Daily triage limit reached/);
  assert.equal(f.runs(), 1);
});

test('manual assessment uses the shared daily budget before automatic assessment', async () => {
  const f = triageWiring();
  f.context.cfg.issues.dailyTriageCap = 1;
  await f.functions.assessIssue('/repo', 1);
  await f.functions.triageNewIssues('/repo', [2, 3]);
  assert.deepEqual(f.assessed, [1]);
  assert.equal(f.runs(), 1);
  assert.equal(f.items[1].autoTriaged, undefined);
});

test('outsider automatic assessment is optional and enabled by default', async () => {
  const f = triageWiring();
  f.items[1].authorAssociation = 'NONE';
  f.context.cfg.issues.autoTriageOutsiders = false;
  await f.functions.triageNewIssues('/repo', [1, 2]);
  assert.deepEqual(f.assessed, [1]);
});

test('only one assessment runs at a time and transient state is announced on start and finish', async () => {
  const f = triageWiring();
  let release;
  f.context.triageIssue = () => new Promise((resolve) => { release = resolve; });
  const first = f.functions.assessIssue('/repo', 1);
  assert.equal(f.context.triagingIssue.number, 1);
  await assert.rejects(f.functions.assessIssue('/repo', 1), /already being assessed/);
  await assert.rejects(f.functions.assessIssue('/repo', 2), /already being assessed/);
  assert.deepEqual(f.changed, ['/repo']);
  release({ action: 'none', size: 'trivial', summary: 'No work.' });
  await first;
  assert.equal(f.context.triagingIssue, null);
  assert.deepEqual(f.changed, ['/repo', '/repo']);
});

test('automatic assessment waits for a manual assessment and skips an issue completed while waiting', async () => {
  const f = triageWiring();
  let release;
  f.context.triageIssue = ({ issue }) => {
    f.assessed.push(issue.number);
    if (issue.number === 1) return new Promise((resolve) => { release = resolve; });
    return { action: 'none', size: 'trivial', summary: 'No work.' };
  };
  const manual = f.functions.assessIssue('/repo', 1);
  const automatic = f.functions.triageNewIssues('/repo', [1, 2]);
  assert.deepEqual(f.assessed, [1]);
  release({ action: 'none', size: 'trivial', summary: 'No work.' });
  await Promise.all([manual, automatic]);
  assert.deepEqual(f.assessed, [1, 2]);
  assert.deepEqual(f.stored, [1, 2]);
});

test('assessment result is discarded after title, labels, or body changes', async () => {
  for (const change of [
    (item) => { item.title = 'edited'; },
    (item) => { item.labels = ['edited']; },
    (item) => { item.body = 'edited'; }
  ]) {
    const f = triageWiring();
    let release;
    f.context.triageIssue = () => new Promise((resolve) => { release = resolve; });
    const pending = f.functions.assessIssue('/repo', 1);
    change(f.items[0]);
    release({ action: 'none', size: 'trivial', summary: 'No work.' });
    assert.equal((await pending).error, 'Issue changed during assessment.');
    assert.deepEqual(f.stored, []);
  }
});

test('assess IPC validates the project and a positive safe issue number', async () => {
  const main = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
  const source = main.slice(main.indexOf("ipcMain.handle('issues:assess'"), main.indexOf("ipcMain.handle('issues:setStatus'"));
  let handler, called = 0;
  vm.runInNewContext(source, {
    ipcMain: { handle: (_channel, fn) => { handler = fn; } }, wrap: (fn) => fn,
    issueRoot: (project) => { if (project !== '/repo') throw new Error('Choose an open project.'); return project; },
    assessIssue: async () => { called++; return { action: 'none' }; }, Number,
    cfg: { issues: { enabled: true }, projectIssues: { '/repo': { enabled: true } } }
  });
  assert.throws(() => handler({ project: '/other', number: 1 }), /Choose an open project/);
  for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'])
    assert.throws(() => handler({ project: '/repo', number }), /positive integer/);
  assert.equal(called, 0);
  assert.equal((await handler({ project: '/repo', number: 1 })).action, 'none');
  assert.equal(called, 1);
});

test('manual assessment refuses unchanged triage', async () => {
  const f = triageWiring();
  await f.functions.assessIssue('/repo', 1);
  await assert.rejects(f.functions.assessIssue('/repo', 1), /already been assessed/);
  assert.equal(f.runs(), 1);
});

test('assess IPC refuses globally or locally disabled projects', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
  const source = main.slice(main.indexOf("ipcMain.handle('issues:assess'"), main.indexOf("ipcMain.handle('issues:setStatus'"));
  let handler;
  const cfg = { issues: { enabled: false }, projectIssues: { '/repo': { enabled: true } } };
  vm.runInNewContext(source, { ipcMain: { handle: (_channel, fn) => { handler = fn; } }, wrap: (fn) => fn,
    issueRoot: (project) => project, assessIssue: () => { throw new Error('called'); }, Number, cfg });
  assert.throws(() => handler({ project: '/repo', number: 1 }), /disabled/);
  cfg.issues.enabled = true;
  cfg.projectIssues['/repo'].enabled = false;
  assert.throws(() => handler({ project: '/repo', number: 1 }), /disabled/);
});

test('issues:list exposes stale triage on edited issues', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
  const source = main.slice(main.indexOf("ipcMain.handle('issues:list'"), main.indexOf("ipcMain.handle('issues:refresh'"));
  let handler;
  const items = [{ number: 1, triage: { action: 'none' } }, { number: 2 }];
  vm.runInNewContext(source, { ipcMain: { handle: (_channel, fn) => { handler = fn; } }, wrap: (fn) => fn,
    issueRoot: (project) => project, issueStore: { list: () => items, needsTriage: (_project, number) => number === 1 },
    triagingIssue: null, cfg: { issues: {}, projectIssues: {} }, issuePoller: { lastError: () => null } });
  const result = handler({ project: '/repo' });
  assert.equal(result.items[0].triageStale, true);
  assert.equal(result.items[1].triageStale, false);
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
