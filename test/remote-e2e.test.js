const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createService } = require('../main/remote-service');
const { createServer } = require('../main/remote-server');
const { createAuth, createLimiter } = require('../main/remote-auth');
const { createRemote } = require('../main/remote');

const project = path.resolve(__dirname, '..');

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function request(port, method, route, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers = data === undefined ? {} :
      { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request({ hostname: '127.0.0.1', port, method, path: route, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let value;
        try { value = JSON.parse(raw.toString('utf8')); } catch { value = raw; }
        resolve({ status: res.statusCode, body: value, headers: res.headers });
      });
    });
    req.setTimeout(2000, () => req.destroy(new Error(`request timed out: ${route}`)));
    req.once('error', reject);
    req.end(data);
  });
}

function openEvents(port, token) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/events',
      headers: { Authorization: `Bearer ${token}` } }, (res) => {
      const stream = { req, res, events: [], emitter: new EventEmitter(), rest: '' };
      res.on('data', (chunk) => {
        stream.rest += chunk.toString('utf8');
        let boundary;
        while ((boundary = stream.rest.indexOf('\n\n')) !== -1) {
          const frame = stream.rest.slice(0, boundary);
          stream.rest = stream.rest.slice(boundary + 2);
          const type = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (!type || !data) continue;
          const event = { type, data: JSON.parse(data) };
          stream.events.push(event);
          stream.emitter.emit('event', event);
        }
      });
      resolve(stream);
    });
    req.once('error', reject);
  });
}

function untilEvent(stream, type, predicate = () => true) {
  const found = stream.events.find((event) => event.type === type && predicate(event.data));
  if (found) return Promise.resolve(found.data);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`missing SSE event: ${type}`)); }, 1500);
    const onEvent = (event) => {
      if (event.type !== type || !predicate(event.data)) return;
      cleanup(); resolve(event.data);
    };
    function cleanup() { clearTimeout(timer); stream.emitter.off('event', onEvent); }
    stream.emitter.on('event', onEvent);
  });
}

function untilEnd(stream) {
  if (stream.res.readableEnded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('revoked SSE stayed open')); }, 1500);
    const done = () => { cleanup(); resolve(); };
    function cleanup() { clearTimeout(timer); stream.res.off('end', done); }
    stream.res.once('end', done);
  });
}

async function fixture(t, { saved = [], ntfy = false, notifyOnlyWhenAway = false } = {}) {
  let port;
  try { port = await freeLoopbackPort(); }
  catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    t.skip(`loopback bind unavailable: ${error.code}`);
    return null;
  }
  let devices = [];
  const secrets = new Map();
  const notifications = [];
  const sessions = new Map();
  const remote = createRemote({ send() {}, loadChat: () => null });
  const config = { remote: { enabled: true, mode: 'serve', port, hosts: [],
    ntfy: { enabled: ntfy, server: 'https://ntfy.sh' }, notifyOnlyWhenAway },
  openProjects: [project] };
  const savedById = new Map(saved.map((chat) => [chat.id, chat]));
  const service = createService({ createServer, createAuth, createLimiter, remote, sessions,
    getConfig: () => config, getDevices: () => devices, saveDevices: (value) => { devices = value; },
    getSecret: (key) => secrets.get(key) || '', setSecret: (key, value) => secrets.set(key, value),
    loadChat: (_project, id) => savedById.get(id) || null,
    listChats: () => saved.map((chat) => ({ id: chat.id, title: chat.title, updatedAt: chat.updatedAt })),
    staticDir: path.join(project, 'renderer', 'mobile'), send() {},
    execFile: (_file, args, _settings, callback) => callback(null, args[0] === 'status' ?
      JSON.stringify({ Self: { DNSName: 'mac.tailnet.ts.net.' } }) : '{}'),
    fetch: async (url, options) => { notifications.push({ url, body: options.body }); return { ok: true, status: 200 }; },
    logger: { warn() {} } });
  t.after(() => service.stop());
  const state = await service.sync();
  if (state.error === 'EPERM' || state.error === 'EACCES') {
    t.skip(`loopback bind unavailable: ${state.error}`);
    return null;
  }
  assert.equal(state.error, null);
  assert.equal(state.listening, true);
  assert.equal(state.host, '127.0.0.1');
  assert.equal(state.port, port);
  const paired = await service.pair();
  assert.equal(paired.url, 'https://mac.tailnet.ts.net');
  assert.equal(new URL(paired.payload).hash, `#pair=${paired.code}`);
  const code = new URLSearchParams(new URL(paired.payload).hash.slice(1)).get('pair');
  const response = await request(port, 'POST', '/pair', { code, label: 'Test phone' });
  assert.equal(response.status, 200);
  const token = response.body.token;
  function call(method, route, body, presented = token) { return request(port, method, route, body, presented); }
  function session(chatId = 'chat', engine = 'claude') {
    const value = new EventEmitter();
    value.cwd = project;
    value.permissionMode = 'default';
    value.sent = [];
    value.responded = [];
    value.controls = [];
    value.stopped = 0;
    value.user = (text) => value.sent.push(text);
    value.respond = (id, payload) => value.responded.push({ id, payload });
    value.control = async (req) => { value.controls.push(req); return { ok: true }; };
    value.stop = () => { value.stopped++; value.emit('exit'); };
    sessions.set(chatId, value);
    remote.attach(value, chatId, { project, engine });
    return value;
  }
  function prompt(value, id, toolName = 'Bash', input = { command: 'ls' }) {
    value.emit('message', { type: 'control_request', request_id: id,
      request: { subtype: 'can_use_tool', tool_name: toolName, input } });
  }
  async function events() {
    const stream = await openEvents(port, token);
    assert.equal(stream.res.statusCode, 200);
    t.after(() => stream.req.destroy());
    return stream;
  }
  return { service, config, remote, sessions, notifications, port, token, paired, call, session, prompt, events };
}

test('service sync, fragment pairing, token and state complete the phone entry flow', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  assert.match(f.paired.payload, /^https:\/\/mac\.tailnet\.ts\.net\/#pair=[0-9a-f]+$/);
  assert.equal((await f.call('GET', '/api/state', undefined, null)).status, 401);
  const state = await f.call('GET', '/api/state');
  assert.equal(state.status, 200);
  assert.deepEqual(state.body.pending, []);
  assert.ok(Array.isArray(state.body.projects));
});

test('phone sees a safe Bash request and phone/desktop decisions respond exactly once', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const session = f.session();
  const stream = await f.events();
  const decided = [];
  f.remote.registry.on('decided', (event) => decided.push(event));
  f.prompt(session, 'safe', 'Bash', { command: 'ls' });
  const added = await untilEvent(stream, 'added', (data) => data.requestId === 'safe');
  assert.equal(added.needsDesktop, false);
  assert.deepEqual(added.input, { command: 'ls' });
  assert.equal((await f.call('POST', '/api/decide', { chatId: 'chat', requestId: 'safe', decision: 'allow' })).status, 200);
  assert.deepEqual(session.responded, [{ id: 'safe', payload: { behavior: 'allow', updatedInput: { command: 'ls' } } }]);
  assert.deepEqual(await untilEvent(stream, 'decided', (data) => data.requestId === 'safe'),
    { chatId: 'chat', requestId: 'safe', source: 'phone', decision: 'allow' });
  assert.deepEqual(f.remote.respond('chat', 'safe', { behavior: 'deny' }), { ok: true, already: true });
  f.prompt(session, 'race');
  const phone = f.call('POST', '/api/decide', { chatId: 'chat', requestId: 'race', decision: 'allow' });
  const desktop = f.remote.respond('chat', 'race', { behavior: 'deny', message: 'Desktop' });
  assert.deepEqual(desktop, { ok: true });
  assert.equal((await phone).status, 409);
  assert.equal(session.responded.filter((entry) => entry.id === 'race').length, 1);
  assert.equal(decided.filter((event) => event.requestId === 'race').length, 1);
  assert.equal((await f.call('GET', '/api/state')).body.pending.length, 0);
});

test('phone answers AskUserQuestion multi-select with joined values and original input', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const session = f.session();
  const input = { questions: [{ question: 'Which tags?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }], metadata: 'kept' };
  f.prompt(session, 'ask', 'AskUserQuestion', input);
  const response = await f.call('POST', '/api/decide', { chatId: 'chat', requestId: 'ask',
    decision: 'allow', answers: { 'Which tags?': ['A', 'B'] } });
  assert.equal(response.status, 200);
  assert.deepEqual(session.responded, [{ id: 'ask', payload: { behavior: 'allow',
    updatedInput: { ...input, answers: { 'Which tags?': 'A, B' } } } }]);
});

test('risky, outside-project and >8 KB inputs require desktop while Deny remains available', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const session = f.session();
  for (const [id, toolName, input] of [
    ['sudo', 'Bash', { command: 'sudo ls' }],
    ['curl', 'Bash', { command: 'bash -c "$(curl x)"' }],
    ['remove', 'Bash', { command: 'rm -rf x' }],
    ['outside', 'Write', { file_path: '../outside.txt', content: 'hello' }],
    ['large', 'Bash', { command: 'ls', description: 'x'.repeat(8193) }]
  ]) {
    f.prompt(session, id, toolName, input);
    const pending = (await f.call('GET', '/api/state')).body.pending.find((item) => item.requestId === id);
    assert.equal(pending.needsDesktop, true, id);
    assert.equal((await f.call('POST', '/api/decide', { chatId: 'chat', requestId: id, decision: 'allow' })).status, 403, id);
    assert.equal(session.responded.length, 0, id);
    assert.equal((await f.call('POST', '/api/decide', { chatId: 'chat', requestId: id, decision: 'deny' })).status, 200, id);
    assert.equal(session.responded.at(-1).payload.behavior, 'deny', id);
    session.responded.length = 0;
  }
});

test('send uses default mode and records phone source; bypass modes reject; interrupt reaches session', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const session = f.session();
  assert.equal((await f.call('POST', '/api/send', { chatId: 'chat', text: 'hello from phone' })).status, 200);
  assert.deepEqual(session.sent, ['hello from phone']);
  assert.deepEqual(f.remote.buffers.get('chat').tail(1).items[0],
    { t: 'user', text: 'hello from phone', source: 'phone', i: 0, id: 'remote-0' });
  for (const mode of ['auto', 'acceptEdits', 'bypassPermissions']) {
    session.permissionMode = mode;
    assert.equal((await f.call('POST', '/api/send', { chatId: 'chat', text: 'blocked' })).status, 403, mode);
  }
  assert.deepEqual(session.sent, ['hello from phone']);
  assert.equal((await f.call('POST', '/api/interrupt', { chatId: 'chat' })).status, 200);
  assert.deepEqual(session.controls, [{ subtype: 'interrupt' }]);
});

test('BUG: session exit clears pending decisions and later phone decide returns 404/410', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const session = f.session();
  const stream = await f.events();
  f.prompt(session, 'exiting');
  assert.equal((await f.call('GET', '/api/state')).body.pending.length, 1);
  session.stop();
  assert.deepEqual(await untilEvent(stream, 'chat-exit', (data) => data.chatId === 'chat'), { chatId: 'chat' });
  assert.deepEqual((await f.call('GET', '/api/state')).body.pending, []);
  assert.equal(f.remote.buffers.get('chat').tail(1).items[0].state, 'cancelled');
  const later = await f.call('POST', '/api/decide', { chatId: 'chat', requestId: 'exiting', decision: 'allow' });
  assert.ok([404, 410].includes(later.status));
  assert.deepEqual(session.responded, []);
});

test('desktop revoke closes SSE promptly and invalidates the token', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const stream = await f.events();
  const deviceId = f.service.status().devices[0].id;
  assert.equal(f.service.status().devices[0].connected, true);
  assert.equal(f.service.revoke(deviceId), true);
  await untilEnd(stream);
  assert.equal((await f.call('GET', '/api/state')).status, 401);
});

test('same Codex request id in two sessions is decided independently', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const a = f.session('codex-a', 'codex');
  const b = f.session('codex-b', 'codex');
  f.prompt(a, 'codex-0');
  f.prompt(b, 'codex-0');
  assert.equal((await f.call('GET', '/api/state')).body.pending.length, 2);
  assert.equal((await f.call('POST', '/api/decide', { chatId: 'codex-a', requestId: 'codex-0', decision: 'allow' })).status, 200);
  assert.equal((await f.call('POST', '/api/decide', { chatId: 'codex-b', requestId: 'codex-0', decision: 'deny' })).status, 200);
  assert.deepEqual(a.responded.map((entry) => entry.payload.behavior), ['allow']);
  assert.deepEqual(b.responded.map((entry) => entry.payload.behavior), ['deny']);
});

test('live and saved logs paginate beyond 100 items; image bytes require a buffer image id', async (t) => {
  const saved = [{ id: 'saved', title: 'Saved', project, updatedAt: 1,
    items: Array.from({ length: 105 }, (_, i) => ({ t: 'user', text: `saved ${i}` })) }];
  const f = await fixture(t, { saved });
  if (!f) return;
  f.session();
  const buffer = f.remote.buffers.get('chat');
  for (let i = 0; i < 125; i++) buffer.addUser(`live ${i}`);
  const last = await f.call('GET', '/api/chats/chat/log?limit=100');
  assert.equal(last.status, 200);
  assert.equal(last.body.total, 125);
  assert.deepEqual([last.body.items[0].i, last.body.items.at(-1).i], [25, 124]);
  const earlier = await f.call('GET', '/api/chats/chat/log?before=25&limit=100');
  assert.deepEqual([earlier.body.items[0].i, earlier.body.items.at(-1).i], [0, 24]);
  const savedLast = await f.call('GET', '/api/chats/saved/log?limit=100');
  assert.equal(savedLast.body.total, 105);
  assert.deepEqual([savedLast.body.items[0].text, savedLast.body.items.at(-1).text], ['saved 5', 'saved 104']);
  const savedEarlier = await f.call('GET', '/api/chats/saved/log?before=5&limit=100');
  assert.equal(savedEarlier.body.items.length, 5);
  assert.equal((await f.call('GET', '/api/chats/chat/log?limit=101')).status, 400);
  assert.equal((await f.call('GET', '/api/chats/missing/log')).status, 404);
  buffer.addUser('image', { images: [{ source: { media_type: 'image/png', data: Buffer.from('image bytes').toString('base64') } }] });
  const imageId = buffer.tail(1).items[0].images[0].itemId;
  const image = await f.call('GET', `/api/chats/chat/image/${encodeURIComponent(imageId)}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.equal(image.body.toString(), 'image bytes');
  assert.equal((await f.call('GET', '/api/chats/chat/image/remote-125')).status, 404);
  assert.equal((await f.call('GET', `/api/chats/saved/image/${encodeURIComponent(imageId)}`)).status, 404);
});

test('ntfy sends one generic pending notice and suppresses it while the phone is active', async (t) => {
  // createNotifier captures setTimeout when service.sync() starts it.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t, { ntfy: true, notifyOnlyWhenAway: false });
  if (!f) return;
  const session = f.session();
  f.prompt(session, 'notice', 'Bash', { command: 'sudo secret-input' });
  assert.deepEqual(f.notifications, []);
  t.mock.timers.tick(5000);
  assert.deepEqual(f.notifications.map((entry) => entry.body), ['codeome needs a decision']);
  assert.equal(JSON.stringify(f.notifications).includes('secret-input'), false);
  f.config.remote.notifyOnlyWhenAway = true;
  const stream = await f.events();
  assert.equal(f.service.status().devices[0].connected, true);
  f.prompt(session, 'quiet', 'Bash', { command: 'sudo more-secret-input' });
  t.mock.timers.tick(5000);
  assert.equal(f.notifications.length, 1);
  stream.req.destroy();
});

test('disabled config never creates a server or listens', async () => {
  const config = { remote: { enabled: false, mode: 'serve', port: 47821 } };
  const remote = createRemote({ send() {}, loadChat: () => null });
  let created = 0;
  let devices = [];
  const service = createService({ createServer: (args) => { created++; return createServer(args); },
    createAuth, createLimiter, remote, sessions: new Map(), getConfig: () => config,
    getDevices: () => devices, saveDevices: (value) => { devices = value; },
    getSecret: () => '', setSecret() {}, loadChat: () => null, listChats: () => [],
    staticDir: path.join(project, 'renderer', 'mobile'), send() {},
    execFile: (_file, _args, _settings, callback) => callback(new Error('not installed')),
    fetch: async () => { throw new Error('unexpected fetch'); } });
  const state = await service.sync();
  assert.equal(state.listening, false);
  assert.equal(created, 0);
  await service.stop();
});
