const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createServer, validateRemoteConfig } = require('../main/remote-server');
const { createRemote } = require('../main/remote');
const { createAuth, createLimiter } = require('../main/remote-auth');

const RULES = [
  { tool: 'Bash', pattern: '\\bsudo\\b' },
  { tool: 'Write', outsideProject: true },
  { role: 'hpc-operator' }
];

async function fixture(t, options = {}) {
  let devices = [];
  const auth = createAuth({ store: { get: () => devices, set: (value) => { devices = value; } } });
  const limiter = options.limiter || createLimiter();
  const sessions = new Map();
  const remote = createRemote({ send() {}, loadChat: () => null, exitGraceMs: options.exitGraceMs, now: options.now });
  const config = { remote: { mode: 'serve', hosts: ['phone.example.test'], requireDesktopFor: RULES }, openProjects: options.projects || [process.cwd()],
    issues: { enabled: false }, projectIssues: {} };
  const saved = options.saved || [];
  let listCalls = 0;
  const server = createServer({ auth, limiter, remote, sessions,
    loadChat: (_project, id) => saved.find((chat) => chat.id === id) || null,
    listChats: (project) => { listCalls++; return saved.filter((chat) => !options.savedByProject || path.resolve(chat.project) === project)
      .map((chat) => ({ id: chat.id, title: chat.title, updatedAt: chat.updatedAt, engine: chat.engine || 'claude', role: chat.role || '' })); },
    getConfig: () => config, getIssues: options.getIssues, staticDir: path.join(__dirname, '..', 'renderer', 'mobile'), heartbeatMs: options.heartbeatMs,
    now: options.now, setTimer: options.setTimer, clearTimer: options.clearTimer });
  if (!options.noListen) try { await server.listen(0, '127.0.0.1'); }
  catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    await server.close();
    t.skip(`loopback bind unavailable: ${error.code}`);
    return null;
  }
  t.after(() => server.close());
  const port = server.address()?.port;
  const pair = auth.createPairingCode();
  const issued = auth.redeem(pair.code, 'Test phone');
  function session(chatId = 'chat', project = process.cwd(), role = '') {
    const value = new EventEmitter();
    value.cwd = project;
    value.responded = [];
    value.sent = [];
    value.controls = [];
    value.respond = (requestId, response) => value.responded.push({ requestId, response });
    value.user = (text) => value.sent.push(text);
    value.control = async (request) => { value.controls.push(request); return { ok: true }; };
    sessions.set(chatId, value);
    remote.attach(value, chatId, { project, role, engine: 'claude' });
    return value;
  }
  function prompt(value, requestId, toolName = 'Bash', input = { command: 'pwd' }, chatId = 'chat') {
    value.emit('message', { type: 'control_request', request_id: requestId, request: {
      subtype: 'can_use_tool', tool_name: toolName, input } });
  }
  const call = (method, url, body, headers = {}, token = issued.token) => request(port, method, url, body,
    { ...(token === null ? {} : { Authorization: `Bearer ${token}` }), ...headers });
  return { auth, limiter, remote, sessions, server, port, token: issued.token, deviceId: issued.deviceId, config,
    session, prompt, call, listCalls: () => listCalls };
}

function request(port, method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, method, path: url,
      headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let value;
        try { value = JSON.parse(raw.toString()); } catch { value = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: value });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

function openEvents(port, token, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/events',
      headers: { Authorization: `Bearer ${token}`, ...headers } }, (res) => {
      const stream = { req, res, text: '' };
      res.on('data', (chunk) => { stream.text += chunk.toString(); });
      resolve(stream);
    });
    req.on('error', reject);
  });
}
async function waitFor(stream, pattern) {
  const deadline = Date.now() + 1500;
  while (!pattern.test(stream.text)) {
    if (Date.now() > deadline) throw new Error(`SSE missing ${pattern}: ${stream.text}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('project state derives live tabs, earlier chats, counts, sorting and retains summaries', async (t) => {
  let time = 1_000_000;
  const alpha = '/projects/alpha-phone-test', beta = '/projects/beta-phone-test';
  const saved = Array.from({ length: 34 }, (_, i) => ({ id: `old-${i}`, project: alpha,
    title: `Earlier ${i}`, updatedAt: 500 - i, engine: 'claude', role: 'reviewer' }));
  saved.push({ id: 'beta-old', project: beta, title: 'Beta', updatedAt: 700, engine: 'codex' });
  const f = await fixture(t, { noListen: true, projects: [alpha, beta], saved, savedByProject: true, now: () => time });
  const session = f.session('live-alpha', alpha);
  f.remote.recordUser('live-alpha', 'hello');
  let models = f.server.projectState();
  const a = models.find((project) => project.path === alpha);
  assert.equal(a.key, crypto.createHash('sha1').update(alpha).digest('hex').slice(0, 12));
  assert.equal(a.name, 'alpha-phone-test');
  assert.equal(a.tabs[0].state, 'working');
  assert.equal(a.earlier.length, 30);
  assert.deepEqual(a.earlier[0], { id: 'old-0', title: 'Earlier 0', updatedAt: 500, engine: 'claude', role: 'reviewer' });
  assert.deepEqual(a.counts, { waiting: 0, working: 1, ready: 0, error: 0, jobs: 0 });
  assert.ok(models.indexOf(a) < models.findIndex((project) => project.path === beta));

  const tab = { id: 'live-alpha', title: 'Live', state: 'ready', label: 'Reply ready', jobs: 3,
    engine: 'claude', role: '', active: true, updatedAt: time + 1 };
  f.remote.setTabs(alpha, [tab]);
  models = f.server.projectState();
  assert.deepEqual(models.find((project) => project.path === alpha).counts,
    { waiting: 0, working: 0, ready: 1, error: 0, jobs: 3 });
  f.prompt(session, 'need-input');
  const waiting = f.server.projectState().find((project) => project.path === alpha);
  assert.equal(waiting.tabs[0].state, 'waiting');
  assert.equal(waiting.counts.waiting, 1);
  assert.equal(waiting.counts.ready, 0);
  f.remote.setTabs(alpha, [{ ...tab, state: 'waiting', label: 'Waiting for you' }]);
  f.remote.respond('live-alpha', 'need-input', { behavior: 'deny' });
  const answered = f.server.projectState().find((project) => project.path === alpha);
  assert.equal(answered.tabs[0].state, 'working');
  assert.equal(answered.counts.waiting, 0);
  time += 5 * 60 * 1000 + 1;
  const stale = f.server.projectState().find((project) => project.path === alpha);
  assert.equal(stale.tabs[0].state, 'working');
  assert.equal(stale.counts.jobs, 3);
  session.emit('message', { type: 'result', is_error: true, result: 'failed' });
  assert.equal(f.server.projectState().find((project) => project.path === alpha).tabs[0].state, 'error');
});

test('main chat ownership defeats a forged tab in another project', async (t) => {
  const alpha = '/projects/alpha-ownership', beta = '/projects/beta-ownership';
  const f = await fixture(t, { noListen: true, projects: [alpha, beta], savedByProject: true,
    saved: [{ id: 'owned', project: beta, title: 'Owned chat', updatedAt: 50 }] });
  const session = f.session('owned', beta);
  f.remote.setTabs(alpha, [{ id: 'owned', title: 'Forged', state: 'ready', label: 'Reply ready',
    jobs: 4, engine: 'claude', role: '', active: true, updatedAt: 60 }]);
  f.prompt(session, 'need-input', 'Bash', { command: 'pwd' }, 'owned');
  const models = f.server.projectState();
  assert.equal(models.find((entry) => entry.path === alpha).tabs.length, 0);
  assert.equal(models.find((entry) => entry.path === alpha).counts.jobs, 0);
  assert.equal(models.find((entry) => entry.path === beta).tabs[0].state, 'waiting');
});

test('project paths normalize, ties sort by name then path, and state caps at 30', async (t) => {
  const projects = ['/b/shared/', '/a/shared', ...Array.from({ length: 32 }, (_, i) => `/projects/p${String(i).padStart(2, '0')}`)];
  const f = await fixture(t, { noListen: true, projects });
  const models = f.server.projectState();
  assert.equal(models.length, 30);
  assert.equal(models[0].path, '/projects/p00');
  f.remote.setTabs('/a/shared/', [{ id: 'tab', title: 'Tab', state: 'idle', label: 'Open',
    jobs: 0, engine: 'claude', role: '', active: true, updatedAt: 10 }]);
  assert.equal(f.server.projectState()[0].path, '/a/shared');
  assert.equal(f.server.projectState()[0].key, crypto.createHash('sha1').update('/a/shared').digest('hex').slice(0, 12));
  assert.equal(f.server.projectState().filter((entry) => entry.path === '/a/shared').length, 1);
  f.remote.clearTabs();
  f.config.openProjects = ['/b/shared', '/a/shared'];
  const ties = f.server.projectState().filter((entry) => entry.name === 'shared');
  assert.deepEqual(ties.map((entry) => entry.path), ['/a/shared', '/b/shared']);
  const session = f.session('aliased', '/a/shared/');
  f.prompt(session, 'aliased-decision', 'Bash', { command: 'pwd' }, 'aliased');
  assert.equal(f.server.projectState().find((entry) => entry.path === '/a/shared').counts.waiting, 1);
});

test('message events retain the chat cache while registry additions refresh it', async (t) => {
  const timers = new Map();
  let nextTimer = 0;
  const f = await fixture(t, { noListen: true, projects: ['/projects/cache'],
    setTimer: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimer: (id) => timers.delete(id) });
  const session = f.session('cached', '/projects/cache');
  f.server.projectState();
  const calls = f.listCalls();
  session.emit('message', { type: 'text_delta', text: 'hello' });
  f.server.projectState();
  for (const fn of [...timers.values()]) fn();
  assert.equal(f.listCalls(), calls);
  f.prompt(session, 'approval', 'Bash', { command: 'pwd' }, 'cached');
  f.server.projectState();
  assert.ok(f.listCalls() > calls);
});

test('tab timer builds only the changed project model', async (t) => {
  const timers = new Map();
  let nextTimer = 0;
  const f = await fixture(t, { noListen: true, projects: ['/projects/one', '/projects/two'],
    setTimer: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimer: (id) => timers.delete(id) });
  const tab = { id: 'one', title: 'One', state: 'idle', label: 'Open', jobs: 0,
    engine: 'claude', role: '', active: true, updatedAt: 1 };
  f.remote.setTabs('/projects/one', [tab]);
  f.remote.setTabs('/projects/two', [{ ...tab, id: 'two' }]);
  for (const fn of [...timers.values()]) fn();
  timers.clear();
  const gets = [];
  f.remote.tabs.get = function (key) { gets.push(key); return Map.prototype.get.call(this, key); };
  f.remote.events.emit('tabs', '/projects/one');
  for (const fn of [...timers.values()]) fn();
  assert.deepEqual(gets, ['/projects/one', '/projects/two', '/projects/one']);
});

test('closed empty project disappears after config change', async (t) => {
  const project = '/projects/closed-phone';
  const f = await fixture(t, { noListen: true, projects: [project] });
  assert.equal(f.server.projectState()[0].path, project);
  f.config.openProjects = [];
  f.remote.events.emit('config-changed');
  assert.equal(f.server.projectState().some((entry) => entry.path === project), false);
});

test('tab changes publish the same project shape over SSE', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const stream = await openEvents(f.port, f.token);
  t.after(() => stream.req.destroy());
  f.remote.setTabs(process.cwd(), [{ id: 'phone-tab', title: 'Phone tab', state: 'ready', label: 'Reply ready',
    jobs: 1, engine: 'claude', role: '', active: true, updatedAt: 123 }]);
  await waitFor(stream, /event: tabs[\s\S]*"title":"Phone tab"/);
  const event = stream.text.match(/event: tabs\ndata: ([^\n]+)/);
  const project = JSON.parse(event[1]);
  assert.deepEqual(project, (await f.call('GET', '/api/state')).body.projects.find((p) => p.path === process.cwd()));
});

test('phone state limits issue summaries to enabled open projects and safe fields', async (t) => {
  const project = process.cwd(), disabled = '/projects/disabled-issues', closed = '/projects/closed-issues';
  const hostile = '<script>alert(1)</script>\u0000\u001b\u202e' + 'x'.repeat(150);
  const issue = (number, status = 'new') => ({ number, title: number === 12 ? hostile : `Issue ${number}`,
    status, body: 'private body', author: 'private author', url: 'https://example.test/private',
    repo: 'private repo', triage: { action: 'fix', proposedPlan: 'private plan', draftReply: 'private draft' } });
  const f = await fixture(t, { noListen: true, projects: [project, disabled], getIssues: (root) =>
    root === project ? [issue(12), issue(99, 'in-progress'), ...Array.from({ length: 11 }, (_, i) => issue(11 - i)), issue(98, 'seen')] :
      root === disabled ? [issue(21)] : root === closed ? [issue(22)] : [] });
  f.config.issues.enabled = true;
  f.config.projectIssues[project] = { enabled: true };
  f.config.projectIssues[disabled] = { enabled: false };
  f.config.projectIssues[closed] = { enabled: true };
  const issues = f.server.issueState();
  assert.equal(issues.length, 1);
  assert.deepEqual(Object.keys(issues[0]).sort(), ['count', 'items', 'project']);
  assert.equal(issues[0].project, project);
  assert.equal(issues[0].count, 12);
  assert.equal(issues[0].items.length, 10);
  assert.deepEqual(Object.keys(issues[0].items[0]).sort(), ['action', 'number', 'status', 'title']);
  assert.deepEqual({ number: issues[0].items[0].number, action: issues[0].items[0].action,
    status: issues[0].items[0].status }, { number: 12, action: 'fix', status: 'new' });
  assert.deepEqual({ number: issues[0].items[1].number, status: issues[0].items[1].status },
    { number: 99, status: 'in-progress' });
  assert.equal(issues[0].items[0].title, '<script>alert(1)</script>' + 'x'.repeat(95));
  assert.equal(Array.from(issues[0].items[0].title).length, 120);
  assert.doesNotMatch(JSON.stringify(issues), /private body|private author|private plan|private draft|private repo|example\.test/);
  f.config.issues.enabled = false;
  assert.deepEqual(f.server.issueState(), []);
});

test('phone API state includes issue summaries', async (t) => {
  const project = process.cwd();
  const f = await fixture(t, { getIssues: () => [{ number: 7, title: 'A new issue', status: 'new' }] });
  if (!f) return;
  f.config.issues.enabled = true;
  f.config.projectIssues[project] = { enabled: true };
  assert.deepEqual((await f.call('GET', '/api/state')).body.issues,
    [{ project, count: 1, items: [{ number: 7, title: 'A new issue', action: null, status: 'new' }] }]);
});

test('issue changes refresh the phone without exposing issue data in SSE', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const stream = await openEvents(f.port, f.token);
  t.after(() => stream.req.destroy());
  f.server.issuesChanged();
  await waitFor(stream, /event: issues-changed\ndata: \{\}/);
});

test('phone API has no issue action routes', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  for (const route of ['/api/issues', '/api/issues/1', '/api/issues/1/assess',
    '/api/issues/1/startWork', '/api/issues/1/comment', '/api/issues/1/setStatus',
    '/api/issues/1/markSeen', '/api/issues/1/enable']) {
    assert.equal((await f.call('GET', route)).status, 404, route);
    assert.equal((await f.call('POST', route, { number: 1, action: 'fix' })).status, 404, route);
  }
});

test('pending state and added SSE use main project and saved title', async (t) => {
  const project = process.cwd();
  const f = await fixture(t, { savedByProject: true,
    saved: [{ id: 'owned', project, title: 'Saved title', updatedAt: 10 }] });
  if (!f) return;
  const stream = await openEvents(f.port, f.token);
  t.after(() => stream.req.destroy());
  const session = f.session('owned', project);
  f.prompt(session, 'decision', 'Bash', { command: 'pwd' }, 'owned');
  await waitFor(stream, /event: added[\s\S]*"requestId":"decision"/);
  const added = stream.text.split('\n').filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6))).find((item) => item.requestId === 'decision');
  const pending = (await f.call('GET', '/api/state')).body.pending[0];
  for (const item of [added, pending]) {
    assert.equal(item.project, project);
    assert.equal(item.projectName, path.basename(project));
    assert.equal(item.chatTitle, 'Saved title');
  }
});

test('config change publishes one removal for a closed empty project', async (t) => {
  const f = await fixture(t, { projects: [process.cwd()] });
  if (!f) return;
  const stream = await openEvents(f.port, f.token);
  t.after(() => stream.req.destroy());
  f.remote.events.emit('config-changed');
  await waitFor(stream, /event: tabs[\s\S]*"path":"[^"]+"/);
  f.config.openProjects = [];
  f.remote.events.emit('config-changed');
  await waitFor(stream, /event: tabs\ndata: \{"key":"[a-f0-9]{12}","removed":true\}/);
  const removals = stream.text.match(/"removed":true/g) || [];
  assert.equal(removals.length, 1);
  assert.equal((await f.call('GET', '/api/state')).body.projects.some((entry) => entry.path === process.cwd()), false);
});

test('authentication, Host/Origin, security headers and pairing single use', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  assert.equal((await f.call('GET', '/api/state', undefined, {}, null)).status, 401);
  assert.equal((await f.call('GET', '/api/state', undefined, {}, 'bad')).status, 401);
  assert.equal((await f.call('GET', '/api/state', undefined, { Host: 'evil.example' })).status, 403);
  assert.equal((await f.call('GET', '/api/state', undefined, { Origin: 'https://evil.example' })).status, 403);
  const ok = await f.call('GET', '/api/state', undefined, { Origin: 'https://phone.example.test' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  assert.equal(ok.headers['referrer-policy'], 'no-referrer');
  assert.match(ok.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(ok.headers['access-control-allow-origin'], undefined);
  const code = f.auth.createPairingCode().code;
  const paired = await f.call('POST', '/pair', { code, label: 'Other phone' }, {}, null);
  assert.equal(paired.status, 200);
  assert.ok(paired.body.token);
  assert.ok(paired.body.deviceId);
  assert.equal((await f.call('POST', '/pair', { code, label: 'Again' }, {}, null)).status, 410);
  assert.equal((await f.call('POST', '/pair', { code: 'bad', label: 'No code' }, {}, null)).status, 410);
  assert.equal((await f.call('GET', '/api/devices')).body.some((d) => 'hash' in d), false);
  assert.deepEqual((await f.call('GET', '/api/devices')).body, [{ id: f.deviceId, label: 'Test phone' }]);
});

test('mobile renderer scripts are served by the static allowlist', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  for (const asset of ['/render.js', '/md.js']) {
    const result = await f.call('GET', asset, undefined, {}, null);
    assert.equal(result.status, 200);
    assert.match(result.headers['content-type'], /text\/javascript/);
  }
});

test('decisions are single use and desktop races phone through one respond', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const s = f.session();
  f.prompt(s, 'r1');
  assert.equal((await f.call('POST', '/api/decide', { chatId: 'chat', requestId: 'r1', decision: 'allow' })).status, 200);
  assert.equal(s.responded.length, 1);
  assert.equal(s.responded[0].response.behavior, 'allow');
  assert.equal((await f.call('POST', '/api/decide', { chatId: 'chat', requestId: 'r1', decision: 'deny' })).status, 409);
  f.prompt(s, 'r2');
  f.remote.respond('chat', 'r2', { behavior: 'deny' });
  assert.equal((await f.call('POST', '/api/decide', { chatId: 'chat', requestId: 'r2', decision: 'allow' })).status, 409);
  assert.equal(s.responded.length, 2);
});

test('full high-risk input and outside-project paths require desktop; Deny remains available', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const s = f.session();
  for (const [id, tool, input] of [
    ['sudo', 'Bash', { command: 'sudo ls' }],
    ['long', 'Bash', { command: 'x'.repeat(601) }],
    ['outside', 'Write', { file_path: '../other/file', content: 'hi' }]
  ]) {
    f.prompt(s, id, tool, input);
    const state = (await f.call('GET', '/api/state')).body;
    assert.equal(state.pending.find((entry) => entry.requestId === id).needsDesktop, true);
    const allowed = await f.call('POST', '/api/decide', { chatId: 'chat', requestId: id, decision: 'allow' });
    assert.equal(allowed.status, 403);
    assert.equal(allowed.body.error, 'needs-desktop');
    assert.equal((await f.call('POST', '/api/decide', { chatId: 'chat', requestId: id, decision: 'deny' })).status, 200);
  }
  assert.equal(s.responded.length, 3);
});

test('SSE sends added events, replays Last-Event-ID and closes revoked streams', async (t) => {
  const f = await fixture(t, { heartbeatMs: 30 });
  if (!f) return;
  const s = f.session();
  const first = await openEvents(f.port, f.token);
  t.after(() => first.req.destroy());
  assert.equal(f.server.clients()[0].id, f.deviceId);
  f.prompt(s, 'r1');
  await waitFor(first, /event: added[\s\S]*"requestId":"r1"/);
  const id = Number(first.text.match(/id: (\d+)\nevent: added/)[1]);
  f.prompt(s, 'r2');
  first.req.destroy();
  const resumed = await openEvents(f.port, f.token, { 'Last-Event-ID': String(id) });
  t.after(() => resumed.req.destroy());
  await waitFor(resumed, /event: added[\s\S]*"requestId":"r2"/);
  assert.doesNotMatch(resumed.text, /"requestId":"r1"/);
  const ended = new Promise((resolve) => resumed.res.once('end', resolve));
  f.auth.revoke(f.deviceId);
  f.server.revokeDevice(f.deviceId);
  assert.equal((await f.call('GET', '/api/state')).status, 401);
  let timeout;
  try {
    await Promise.race([
      ended,
      new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('revoked SSE stayed open')), 1500); })
    ]);
  } finally { clearTimeout(timeout); }
  assert.equal(resumed.res.readableEnded, true);
  assert.equal(f.server.clients().length, 0);
});

test('SSE heartbeats arrive promptly and failed token verification closes the stream', async (t) => {
  const f = await fixture(t, { heartbeatMs: 30 });
  if (!f) return;
  const stream = await openEvents(f.port, f.token);
  t.after(() => stream.req.destroy());
  await waitFor(stream, /: heartbeat\n\n/);
  const ended = new Promise((resolve) => stream.res.once('end', resolve));
  f.auth.revoke(f.deviceId);
  let timeout;
  try {
    await Promise.race([ended, new Promise((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('invalid token SSE stayed open')), 500);
    })]);
  } finally { clearTimeout(timeout); }
  assert.equal(stream.res.readableEnded, true);
  assert.equal(f.server.clients().length, 0);
});

test('live and saved log pages, tool results, images, and path validation', async (t) => {
  const f = await fixture(t, { saved: [{ id: 'saved', title: 'Saved', project: '/project', updatedAt: 5,
    items: [{ t: 'user', text: 'old' }, { t: 'text', text: 'reply' }] }] });
  if (!f) return;
  const s = f.session();
  const buffer = f.remote.buffers.get('chat');
  for (let i = 0; i < 4; i++) buffer.addUser(`line ${i}`);
  const live = await f.call('GET', '/api/chats/chat/log?limit=2');
  assert.deepEqual(live.body.items.map((item) => item.i), [2, 3]);
  assert.equal(live.body.total, 4);
  assert.equal(live.body.hasMore, true);
  assert.deepEqual((await f.call('GET', '/api/chats/chat/log?before=2&limit=2')).body.items.map((item) => item.i), [0, 1]);
  assert.deepEqual((await f.call('GET', '/api/chats/saved/log?limit=1')).body.items.map((item) => item.text), ['reply']);
  assert.equal((await f.call('GET', '/api/chats/chat/log?limit=101')).status, 400);
  buffer.addUser('image', { images: [{ source: { media_type: 'image/png', data: Buffer.from('png').toString('base64') } }] });
  const imageId = buffer.tail(1).items[0].images[0].itemId;
  const image = await f.call('GET', `/api/chats/chat/image/${encodeURIComponent(imageId)}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.equal(image.body.toString(), 'png');
  assert.equal((await f.call('GET', '/api/chats/chat/image/unknown')).status, 404);
  assert.equal((await f.call('GET', '/api/chats/chat/image/..%2Fsecret')).status, 404);
  assert.equal((await f.call('GET', '/icons/..%2Fsecret')).status, 404);
  assert.equal((await f.call('GET', '/api/chats/chat/tool/unknown')).status, 404);
  s.emit('message', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Read', input: {} }] } });
  s.emit('message', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'result' }] } });
  assert.equal((await f.call('GET', '/api/chats/chat/tool/tool1')).body.result, 'result');
});

test('an exited chat falls back to its saved log after the grace period', async (t) => {
  const f = await fixture(t, { exitGraceMs: 30, saved: [{ id: 'chat', project: process.cwd(), title: 'Chat',
    items: [{ t: 'user', text: 'saved reply' }] }] });
  if (!f) return;
  const session = f.session();
  f.remote.recordUser('chat', 'live reply');
  assert.deepEqual((await f.call('GET', '/api/chats/chat/log')).body.items.map((item) => item.text), ['live reply']);
  session.emit('exit');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(f.remote.buffers.has('chat'), false);
  assert.deepEqual((await f.call('GET', '/api/chats/chat/log')).body.items.map((item) => item.text), ['saved reply']);
});

test('send, interrupt, body cap, wildcard bind refusal and shared failed-token limiter', async (t) => {
  const limiter = createLimiter({ maxFailures: 2 });
  const f = await fixture(t, { limiter });
  if (!f) return;
  const s = f.session();
  assert.equal((await f.call('POST', '/api/send', { chatId: 'chat', text: 'hello' })).status, 200);
  assert.deepEqual(s.sent, ['hello']);
  for (const mode of ['auto', 'acceptEdits', 'bypassPermissions']) {
    s.permissionMode = mode;
    const blocked = await f.call('POST', '/api/send', { chatId: 'chat', text: 'blocked' });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error, 'needs-desktop-mode');
  }
  s.permissionMode = 'default';
  assert.equal(f.remote.buffers.get('chat').tail(1).items[0].source, 'phone');
  assert.equal((await f.call('POST', '/api/interrupt', { chatId: 'chat' })).status, 200);
  assert.deepEqual(s.controls, [{ subtype: 'interrupt' }]);
  assert.equal((await f.call('POST', '/api/send', { chatId: 'missing', text: 'hello' })).status, 404);
  assert.equal((await f.call('POST', '/api/send', { chatId: 'chat', text: 'x'.repeat(65536) })).status, 413);
  await assert.rejects(f.server.listen(0, '0.0.0.0'), /Invalid bind host/);
  assert.equal((await f.call('GET', '/api/state', undefined, {}, 'bad-a')).status, 401);
  assert.equal((await f.call('GET', '/api/state', undefined, {}, 'bad-a')).status, 401);
  assert.equal((await f.call('GET', '/api/state', undefined, {}, 'bad-a')).status, 429);
  assert.equal((await f.call('GET', '/api/state', undefined, {}, 'bad-b')).status, 429);
  assert.equal((await f.call('GET', '/api/state')).status, 200);
});

test('safe phone policy rejects shell bypasses, unknown tools and altered input without a socket', async (t) => {
  const f = await fixture(t, { noListen: true });
  const session = f.session();
  const risk = (toolName, input, chatId = 'chat') => f.server.risk({ chatId, toolName, input });
  for (const command of ["r''m -rf", '"rm" -rf', 'rm -r -f', 'rm -Rf', 'rm -rfv',
    'rm \\\n -rf', "s'u'do", 'git -C x push', 'bash -c "$(curl x)"', 'bash <(curl x)',
    'python3 -c', 'eval', 'scp', 'nc', 'osascript', 'launchctl', 'ls; rm x', 'cat a | sh'])
    assert.equal(risk('Bash', { command }), 'needs-desktop', command);
  for (const command of ['ls -la', 'git status', 'npm test']) assert.equal(risk('Bash', { command }), null, command);
  assert.equal(risk('Bash', { command: 'find . -exec sh {} +' }), 'needs-desktop');
  assert.equal(risk('Bash', { command: 'rg --pre sh x' }), 'needs-desktop');
  assert.equal(risk('Bash', { command: 'git branch -D main' }), 'needs-desktop');
  assert.equal(risk('McpTool', {}), 'needs-desktop');
  assert.equal(risk('Read', { file_path: '/tmp/outside' }), 'needs-desktop');
  assert.equal(risk('Edit', { file_path: '../outside' }), 'needs-desktop');
  assert.equal(risk('MultiEdit', { edits: [{ file_path: '/tmp/outside' }] }), 'needs-desktop');
  assert.equal(risk('Read', { file_path: 'main/remote-server.js' }), null);
  assert.equal(risk('Read', { file_path: 7 }), 'needs-desktop');
  assert.equal(risk('Write', { content: 'hello' }), 'needs-desktop');
  assert.equal(risk('Read', {}), 'needs-desktop');
  assert.equal(risk('AskUserQuestion', { questions: [], path: '/tmp/outside' }), 'needs-desktop');
  assert.equal(risk('Read', { file_path: '~/private' }), 'needs-desktop');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-phone-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.symlinkSync(os.tmpdir(), path.join(root, 'escape'));
  f.session('link-chat', root);
  assert.equal(risk('Read', { file_path: 'escape/outside' }, 'link-chat'), 'needs-desktop');
  f.session('no-project', null);
  assert.equal(risk('Glob', { pattern: '*' }, 'no-project'), 'needs-desktop');
  assert.equal(risk('Bash', { command: 'cat /tmp/outside' }), 'needs-desktop');
  assert.equal(risk('Read', { file_path: 'main/remote-server.js', token: 'abc' }), 'redacted');
  assert.equal(risk('AskUserQuestion', { questions: [] }), null);
  assert.equal(risk('Read', { file_path: 'main/remote-server.js', content: 'x'.repeat(8192) }), 'needs-desktop');
  f.config.remote.requireDesktopFor = [{ tool: 'Bash', pattern: '[' }];
  assert.equal(risk('Bash', { command: 'ls' }), 'needs-desktop');
  assert.match(validateRemoteConfig(f.config.remote), /Invalid remote rule pattern/);
  f.config.remote.requireDesktopFor = [{ tool: 7 }];
  assert.equal(risk('Bash', { command: 'ls' }), 'needs-desktop');
  f.config.remote.requireDesktopFor = [null];
  assert.equal(risk('Bash', { command: 'ls' }), 'needs-desktop');
  session.emit('exit');
});
