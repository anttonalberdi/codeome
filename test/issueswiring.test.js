const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { buildStartWorkPrompt } = require('../main/issueprompt');

test('issue IPC handlers and preload bridge expose the inbox channels', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../main/preload.js'), 'utf8');
  for (const channel of ['issues:list', 'issues:refresh', 'issues:assess', 'issues:startWork', 'issues:setStatus',
    'issues:comment', 'issues:markSeen',
    'issues:enable', 'issues:counts']) {
    assert.ok(main.includes(`ipcMain.handle('${channel}', wrap(`), channel + ' must use wrap');
    assert.ok(preload.includes(`'${channel}'`), channel + ' must be in the bridge');
  }
  assert.match(main, /send\('issues:changed', \{ project, counts:/);
  assert.match(preload, /onChanged: on\('issues:changed'\)/);
  assert.match(preload, /assess: \(project, number\) => ipcRenderer\.invoke\('issues:assess', \{ project, number \}\)/);
  assert.match(preload, /startWork: \(project, number, force\) => ipcRenderer\.invoke\('issues:startWork', \{ project, number, force \}\)/);
  assert.match(preload, /comment: \(project, number, body\) => ipcRenderer\.invoke\('issues:comment', \{ project, number, body \}\)/);
  assert.match(main, /triaging: triagingIssue\?\.project === project && triagingIssue\.number === item\.number/);
  assert.match(main, /win\.on\('focus',/);
  assert.match(main, /issuePoller\.start\(\)/);
  assert.match(main, /issuePoller\.stop\(\)/);
});

function workAndCommentWiring() {
  const main = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
  const source = 'const lastIssueComments = new Map();\n' +
    main.slice(main.indexOf("ipcMain.handle('issues:startWork'"), main.indexOf("ipcMain.handle('issues:markSeen'"));
  const handlers = new Map(), changes = [], statuses = [], comments = [];
  const items = [{ number: 4, title: 'Fix\n\u202esearch', body: 'Issue body', author: 'outsider', labels: [],
    triage: { action: 'fix', size: 'small', summary: 'Fix it', proposedPlan: 'Edit search' } }];
  let stale = false, failStatus = false, failChanged = false, now = 100000;
  let reply = { url: 'https://github.com/o/r/issues/4#issuecomment-1' };
  const wrap = (fn) => async (_event, payload) => {
    try { return { data: await fn(payload) }; } catch (error) { return { error: error.message }; }
  };
  const lastIssueComments = vm.runInNewContext(source + '\nlastIssueComments', {
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, wrap,
    issueRoot: (project) => { if (project !== '/repo') throw new Error('Choose an open project.'); return project; },
    issueStore: {
      list: () => items,
      needsTriage: () => stale,
      setStatus: (project, number, status, extra) => {
        if (failStatus) throw new Error('Status write failed.');
        statuses.push({ project, number, status, extra }); return { status, ...extra };
      }
    },
    buildStartWorkPrompt, crypto, Number, Date: { now: () => now },
    issueChanged: (project) => { if (failChanged) throw new Error('Change notification failed.'); changes.push(project); },
    commentOnIssue: async (args) => { comments.push(args); return reply; },
    accountStore: () => ({ accounts: [] }), config: { getSecret: () => null }, fetch: () => {}, run: () => {}
  });
  const call = (channel, payload) => handlers.get('issues:' + channel)(null, payload);
  return { call, items, comments, statuses, changes, lastIssueComments, setStale: (value) => { stale = value; },
    setFailStatus: (value) => { failStatus = value; }, setFailChanged: (value) => { failChanged = value; },
    advance: (ms) => { now += ms; }, setReply: (value) => { reply = value; } };
}

test('startWork validates input, assessment state, and creates a fresh gated prompt without changing status', async () => {
  const f = workAndCommentWiring();
  assert.match((await f.call('startWork', { project: '/other', number: 4 })).error, /open project/);
  for (const number of [0, -1, 1.5, '4', Number.MAX_SAFE_INTEGER + 1])
    assert.match((await f.call('startWork', { project: '/repo', number })).error, /positive integer/);
  assert.match((await f.call('startWork', { project: '/repo', number: 9 })).error, /not found/);
  f.setStale(true);
  assert.match((await f.call('startWork', { project: '/repo', number: 4 })).error, /Re-Assess/);
  f.setStale(false);
  for (const action of ['none', 'reply', 'unexpected']) {
    f.items[0].triage.action = action;
    assert.match((await f.call('startWork', { project: '/repo', number: 4 })).error, /does not call for starting work/);
  }
  delete f.items[0].triage;
  assert.match((await f.call('startWork', { project: '/repo', number: 4 })).error, /Assess this issue/);
  assert.match((await f.call('startWork', { project: '/repo', number: 4, force: 'true' })).error, /Assess this issue/);
  const first = (await f.call('startWork', { project: '/repo', number: 4, force: true })).data;
  const second = (await f.call('startWork', { project: '/repo', number: 4, force: true })).data;
  assert.equal(first.title, 'Issue #4: Fixsearch');
  assert.notEqual(first.prompt, second.prompt);
  assert.match(first.prompt, /stop at Gate 1/);
  assert.equal(f.statuses.length, 0);
});

test('setStatus validates chat IDs and passes an in-progress chat to the store', async () => {
  const f = workAndCommentWiring();
  for (const chat of ['', 'x'.repeat(65), 'a/b', 4])
    assert.match((await f.call('setStatus', { project: '/repo', number: 4, status: 'in-progress', chat })).error, /chat ID/);
  assert.match((await f.call('setStatus', { project: '/repo', number: 4, status: 'done', chat: 'chat-1' })).error, /chat ID/);
  assert.equal(f.statuses.length, 0);
  await f.call('setStatus', { project: '/repo', number: 4, status: 'in-progress', chat: 'chat_1-2' });
  assert.equal(f.statuses[0].extra.chat, 'chat_1-2');
  assert.deepEqual(f.changes, ['/repo']);
});

test('comment validates, rate limits, posts through the bound account, and marks done only on success', async () => {
  const f = workAndCommentWiring();
  assert.match((await f.call('comment', { project: '/other', number: 4, body: 'hi' })).error, /open project/);
  for (const number of [0, '4', 4.5])
    assert.match((await f.call('comment', { project: '/repo', number, body: 'hi' })).error, /positive integer/);
  for (const body of ['', ' \n ', 'x'.repeat(65001), null])
    assert.match((await f.call('comment', { project: '/repo', number: 4, body })).error, /Comment body/);
  assert.match((await f.call('comment', { project: '/repo', number: 9, body: 'hi' })).error, /not found/);
  assert.equal(f.comments.length, 0);
  const body = 'User-edited reply';
  const posted = await f.call('comment', { project: '/repo', number: 4, body });
  assert.equal(posted.data.url, 'https://github.com/o/r/issues/4#issuecomment-1');
  assert.equal(f.comments[0].root, '/repo');
  assert.equal(f.comments[0].number, 4);
  assert.equal(f.comments[0].body, body);
  assert.deepEqual(f.statuses.map((entry) => entry.status), ['done']);
  assert.deepEqual(f.changes, ['/repo']);
  assert.match((await f.call('comment', { project: '/repo', number: 4, body })).error, /Wait 10 seconds/);
  assert.equal(f.comments.length, 1);
  f.advance(10000);
  f.setReply({ error: { message: 'GitHub token lacks issue write access.' } });
  assert.match((await f.call('comment', { project: '/repo', number: 4, body })).error, /issue write access/);
  assert.equal(f.statuses.length, 1);
  f.advance(10000);
  f.setReply(null);
  assert.match((await f.call('comment', { project: '/repo', number: 4, body })).error, /GitHub account and remote/);
  assert.equal(f.statuses.length, 1);
});

test('a posted comment returns its URL even if local status or notification fails', async () => {
  const f = workAndCommentWiring();
  f.setFailStatus(true);
  const first = await f.call('comment', { project: '/repo', number: 4, body: 'First' });
  assert.equal(first.data.url, 'https://github.com/o/r/issues/4#issuecomment-1');
  assert.equal(first.error, undefined);
  f.advance(10000);
  f.setFailStatus(false);
  f.setFailChanged(true);
  const second = await f.call('comment', { project: '/repo', number: 4, body: 'Second' });
  assert.equal(second.data.url, first.data.url);
  assert.equal(second.error, undefined);
  assert.equal(f.comments.length, 2);
});

test('comment rate limit discards expired entries when adding a new one', async () => {
  const f = workAndCommentWiring();
  await f.call('comment', { project: '/repo', number: 4, body: 'First' });
  assert.equal(f.lastIssueComments.size, 1);
  f.advance(10000);
  f.items.push({ number: 5 });
  await f.call('comment', { project: '/repo', number: 5, body: 'Second' });
  assert.equal(f.lastIssueComments.size, 1);
  assert.equal(f.lastIssueComments.has('/repo:4'), false);
  assert.equal(f.lastIssueComments.has('/repo:5'), true);
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
  const source = main.slice(main.indexOf("ipcMain.handle('issues:assess'"), main.indexOf("ipcMain.handle('issues:startWork'"));
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
  const source = main.slice(main.indexOf("ipcMain.handle('issues:assess'"), main.indexOf("ipcMain.handle('issues:startWork'"));
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
