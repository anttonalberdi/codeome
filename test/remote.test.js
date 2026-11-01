const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRemote, validateTabsPayload } = require('../main/remote');

function setup(loadChat = () => null, options = {}) {
  const events = [], calls = [];
  const session = new EventEmitter();
  session.respond = (requestId, response) => calls.push({ requestId, response });
  const remote = createRemote({ send: (channel, payload) => events.push({ channel, payload }), loadChat, ...options });
  const request = (requestId) => ({ type: 'control_request', request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'pwd' } } });
  return { events, calls, session, remote, request };
}

test('tab summaries validate every field and clear on window close', () => {
  let time = 100;
  const { remote } = setup(undefined, { now: () => time });
  const tab = { id: 'chat', title: 'Chat', state: 'ready', label: 'Reply ready', jobs: 2,
    engine: 'claude', role: '', active: true, updatedAt: 50 };
  const valid = { project: '/known', tabs: [tab] };
  assert.equal(validateTabsPayload(valid, new Set(['/known'])), true);
  for (const payload of [
    { ...valid, project: '/unknown' }, { ...valid, tabs: Array(51).fill(tab) },
    { ...valid, tabs: [{ ...tab, title: 'x'.repeat(201) }] },
    { ...valid, tabs: [{ ...tab, label: 'x'.repeat(101) }] },
    { ...valid, tabs: [{ ...tab, state: 'done' }] },
    { ...valid, tabs: [{ ...tab, jobs: Infinity }] },
    { ...valid, tabs: [{ ...tab, updatedAt: NaN }] },
    { ...valid, tabs: [{ ...tab, updatedAt: 1.5 }] },
    { ...valid, tabs: [{ ...tab, updatedAt: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...valid, tabs: [{ ...tab, active: 'true' }] },
    { ...valid, tabs: [{ ...tab, engine: 'other' }] },
    { ...valid, tabs: [{ ...tab, extra: 'ignored' }] }
  ]) assert.equal(validateTabsPayload(payload, new Set(['/known'])), false);
  const clamped = { project: '/known/', tabs: [{ ...tab, updatedAt: Number.MAX_SAFE_INTEGER }] };
  assert.equal(validateTabsPayload(clamped, new Set(['/known']), 100), true);
  assert.equal(clamped.tabs[0].updatedAt, 86400100);
  clamped.tabs[0].updatedAt = -10;
  assert.equal(validateTabsPayload(clamped, new Set(['/known']), 100), true);
  assert.equal(clamped.tabs[0].updatedAt, 0);
  const changed = [];
  remote.events.on('tabs', (project) => changed.push(project));
  assert.equal(remote.setTabs('/known', [tab]), true);
  assert.equal(remote.setTabs('/known/', [tab]), true);
  assert.equal(remote.tabs.size, 1);
  assert.equal(remote.tabs.get('/known').receivedAt, 100);
  time = 200;
  remote.clearTabs();
  assert.equal(remote.tabs.size, 0);
  assert.deepEqual(changed, ['/known', '/known', '/known']);
});

test('live fallback tracks busy, error and last activity from turns', () => {
  let time = 10;
  const { remote, session } = setup(undefined, { now: () => time });
  remote.attach(session, 'chat', { project: '/project' });
  assert.equal(remote.sessions.get('chat').busy, false);
  time = 20; remote.recordUser('chat', 'hello');
  assert.equal(remote.sessions.get('chat').busy, true);
  time = 30; session.emit('message', { type: 'result', is_error: true, result: 'failed' });
  assert.equal(remote.sessions.get('chat').busy, false);
  assert.equal(remote.sessions.get('chat').lastOutcome, 'error');
  assert.equal(remote.sessions.get('chat').lastActivityAt, 30);
});

test('attach feeds items and registry; user messages enter the live buffer', () => {
  const { session, remote, request } = setup();
  remote.attach(session, 'chat', { project: '/project' });
  remote.recordUser('chat', 'hello');
  session.emit('message', { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
  session.emit('message', request('r1'));
  assert.deepEqual(remote.buffers.get('chat').tail(3).items.map((item) => item.t), ['user', 'text', 'perm']);
  assert.equal(remote.buffers.get('chat').tail(3).items[0].source, 'desktop');
  assert.deepEqual(remote.registry.list('chat').map((item) => item.requestId), ['r1']);
});

test('desktop and phone answers race through one respond call and one decided event', () => {
  const { session, remote, request, calls, events } = setup();
  remote.attach(session, 'chat');
  session.emit('message', request('r1'));
  const raw = { behavior: 'allow', updatedInput: { command: 'changed' } };
  assert.deepEqual(remote.respond('chat', 'r1', raw, 'desktop'), { ok: true });
  assert.deepEqual(remote.registry.answer('chat', 'r1', { deny: true }, 'phone'), { ok: false, reason: 'already-decided' });
  assert.deepEqual(remote.respond('chat', 'r1', raw, 'desktop'), { ok: true, already: true });
  assert.deepEqual(calls, [{ requestId: 'r1', response: raw }]);
  assert.deepEqual(events, [{ channel: 'chat:decided', payload: { id: 'chat', requestId: 'r1', decision: 'allow', source: 'desktop' } }]);
  assert.equal(remote.buffers.get('chat').tail(1).items[0].state, 'decided');
  session.emit('message', request('r2'));
  assert.equal(remote.registry.answer('chat', 'r2', { allow: true }, 'phone').ok, true);
  assert.deepEqual(remote.respond('chat', 'r2', raw, 'desktop'), { ok: true, already: true });
  assert.equal(calls.length, 2);
  assert.equal(events.length, 2);
  assert.equal(events[1].payload.source, 'phone');
});

test('cancel and exit clear pending requests, while unregistered responses use the session', () => {
  const { session, remote, request, calls } = setup();
  remote.attach(session, 'chat');
  session.emit('message', request('cancelled'));
  session.emit('message', { type: 'control_cancel_request', request_id: 'cancelled' });
  assert.deepEqual(remote.registry.list(), []);
  assert.equal(remote.buffers.get('chat').tail(1).items[0].state, 'cancelled');
  assert.deepEqual(remote.respond('chat', 'cancelled', { behavior: 'deny' }), { error: 'The session is not running.' });
  assert.deepEqual(remote.respond('chat', 'unregistered', { behavior: 'deny' }), { ok: true });
  assert.equal(calls.length, 1);
  session.emit('message', request('pending'));
  session.emit('exit', {});
  assert.deepEqual(remote.registry.list(), []);
  assert.equal(remote.buffers.get('chat').tail(1).items[0].state, 'cancelled');
  assert.deepEqual(remote.respond('chat', 'pending', { behavior: 'deny' }), { error: 'The session is not running.' });
  assert.deepEqual(remote.respond('chat', 'later', { behavior: 'deny' }), { error: 'The session is not running.' });
  remote.detach('chat');
  assert.equal(remote.buffers.has('chat'), false);
  assert.equal(remote.registry.knows('chat', 'pending'), false);
});

test('same request id across chats responds to the matching session only', () => {
  const { remote, session: a, request, calls: aCalls } = setup();
  const b = new EventEmitter(), bCalls = [];
  b.respond = (...args) => bCalls.push(args);
  remote.attach(a, 'a'); remote.attach(b, 'b');
  a.emit('message', request('codex-0')); b.emit('message', request('codex-0'));
  assert.equal(remote.registry.list().length, 2);
  assert.deepEqual(remote.respond('c', 'codex-0', { behavior: 'deny' }), { error: 'The request belongs to another chat.' });
  assert.deepEqual(remote.respond('a', 'codex-0', { behavior: 'allow' }), { ok: true });
  assert.deepEqual(remote.respond('b', 'codex-0', { behavior: 'deny' }), { ok: true });
  assert.deepEqual(aCalls, [{ requestId: 'codex-0', response: { behavior: 'allow' } }]);
  assert.deepEqual(bCalls, [['codex-0', { behavior: 'deny' }]]);
});

test('a failed session response reports an error and leaves the request pending', () => {
  const { remote, session, request } = setup();
  remote.attach(session, 'chat');
  session.emit('message', request('r1'));
  session.respond = () => { throw new Error('closed'); };
  assert.deepEqual(remote.respond('chat', 'r1', { behavior: 'allow' }), { error: 'Could not answer the request.' });
  assert.equal(remote.registry.list('chat').length, 1);
  assert.deepEqual(remote.respond('chat', 'unregistered', { behavior: 'allow' }), { error: 'Could not answer the request.' });
});

test('resume seeds a buffer from the saved chat', () => {
  const { session, remote } = setup((project, id) => {
    assert.deepEqual([project, id], ['/project', 'chat']);
    return { items: [{ t: 'user', text: 'earlier' }] };
  });
  remote.attach(session, 'chat', { project: '/project', seed: true });
  remote.recordUser('chat', 'later');
  assert.deepEqual(remote.buffers.get('chat').tail(2).items.map((item) => [item.text, item.i]), [['earlier', 0], ['later', 1]]);
});

test('reattach reuses the live buffer and continues item indices', () => {
  const { remote, session } = setup(() => { throw new Error('saved chat should not reload'); });
  remote.attach(session, 'chat');
  remote.recordUser('chat', 'first');
  const replacement = new EventEmitter(); replacement.respond = () => {};
  remote.attach(replacement, 'chat', { seed: true });
  remote.recordUser('chat', 'second');
  assert.deepEqual(remote.buffers.get('chat').tail(2).items.map((item) => [item.text, item.i]), [['first', 0], ['second', 1]]);
});

test('exited chats keep their buffer during grace, then release listeners and use saved chat', () => {
  const timers = new Map();
  let nextTimer = 0;
  const saved = { items: [{ t: 'user', text: 'saved reply' }] };
  const { remote, session } = setup(() => saved, {
    exitGraceMs: 600000,
    setTimer: (fn, ms) => { assert.equal(ms, 600000); timers.set(++nextTimer, fn); return nextTimer; },
    clearTimer: (id) => timers.delete(id)
  });
  remote.attach(session, 'chat', { project: '/project' });
  remote.recordUser('chat', 'live reply');
  session.emit('exit');
  assert.equal(remote.buffers.get('chat').tail(1).items[0].text, 'live reply');
  assert.equal(remote.sessions.get('chat').exited, true);
  assert.equal(timers.size, 1);
  for (const timer of timers.values()) timer();
  assert.equal(remote.sessions.has('chat'), false);
  assert.equal(remote.buffers.has('chat'), false);
  assert.equal(session.listenerCount('message'), 0);
  assert.equal(session.listenerCount('exit'), 0);
  assert.equal(saved.items[0].text, 'saved reply');
});

test('reattaching an exited chat cancels its cleanup timer', () => {
  const timers = new Map();
  let nextTimer = 0;
  const { remote, session } = setup(() => null, {
    setTimer: (fn) => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimer: (id) => timers.delete(id)
  });
  remote.attach(session, 'chat');
  session.emit('exit');
  assert.equal(timers.size, 1);
  const replacement = new EventEmitter();
  remote.attach(replacement, 'chat');
  assert.equal(timers.size, 0);
  assert.equal(remote.sessions.get('chat').session, replacement);
  assert.equal(remote.buffers.has('chat'), true);
  remote.detach('chat');
});

test('question answers travel through the decided IPC and stored card', () => {
  const { remote, session, events } = setup();
  remote.attach(session, 'chat');
  session.emit('message', { type: 'control_request', request_id: 'r1', request: {
    subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which?' }] }
  } });
  assert.equal(remote.registry.answer('chat', 'r1', { answers: { 'Which?': 'A' } }, 'phone').ok, true);
  assert.deepEqual(events[0].payload.answers, { 'Which?': 'A' });
  assert.deepEqual(remote.buffers.get('chat').tail(1).items[0].answers, { 'Which?': 'A' });
});

test('approval preview is slim but registry retains the full input', () => {
  const { remote, session } = setup();
  remote.attach(session, 'chat');
  const input = { command: 'x'.repeat(700), hidden: 'check this too' };
  session.emit('message', { type: 'control_request', request_id: 'r1', request: {
    subtype: 'can_use_tool', tool_name: 'Bash', input
  } });
  assert.equal(remote.buffers.get('chat').tail(1).items[0].truncated, true);
  assert.deepEqual(remote.registry.list('chat')[0].input, input);
});

test('renderer restores pending cards and resolves a phone decision once', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer/js/chat.js'), 'utf8');
  let onDecided;
  const App = { h() {}, project: '/project', views: {}, cfg: { chatTabs: {} }, emit() {}, saveConfig() {} };
  const codeome = { chat: { onEvent() {}, onExit() {}, onDecided: (callback) => { onDecided = callback; },
    pending: async () => [
      { chatId: 'chat', requestId: 'r1', toolName: 'Bash', input: { command: 'pwd' } },
      { chatId: 'chat', requestId: 'r2', toolName: 'Read', input: { file_path: '/project/file' } }
    ], save() {} } };
  vm.runInNewContext(source, { App, codeome, setTimeout: () => 0, clearTimeout() {} });
  const chat = { id: 'chat', project: '/project', started: true, running: false, busy: false,
    items: [{ t: 'perm', requestId: 'r1', tool: 'Bash', input: { command: 'pwd' }, expired: true }], requests: {} };
  App.views.chat.byId.chat = chat;
  App.views.chat.byProject['/project'] = { tabs: [chat], active: chat };
  await App.views.chat.open('chat');
  assert.equal(chat.requests.r1.item, chat.items[0]);
  assert.equal(chat.items.length, 2);
  assert.equal(chat.items[0].expired, false);
  assert.equal(chat.requests.r2.item, chat.items[1]);
  await App.views.chat.open('chat');
  assert.equal(chat.items.length, 2);
  assert.equal(chat.running, true);
  onDecided({ id: 'chat', requestId: 'r1', decision: 'allow', source: 'phone' });
  assert.equal(chat.requests.r1, undefined);
  assert.equal(chat.items[0].decided, 'allow');
  assert.equal(chat.items[0].source, 'phone');
  onDecided({ id: 'chat', requestId: 'r1', decision: 'deny', source: 'desktop' });
  assert.equal(chat.items[0].decided, 'allow');
  chat.items.push({ t: 'ask', requestId: 'r3', questions: [{ question: 'Which?' }] });
  onDecided({ id: 'chat', requestId: 'r3', decision: 'answered', source: 'phone', answers: { 'Which?': 'A, B' } });
  assert.deepEqual(chat.items.at(-1).answers, { 'Which?': 'A, B' });
  const racing = { t: 'perm', requestId: 'r4', responding: true };
  chat.items.push(racing);
  onDecided({ id: 'chat', requestId: 'r4', decision: 'deny', source: 'desktop' });
  assert.equal(racing.decided, 'deny');
});

test('renderer retries a tab summary when IPC resolves with an error', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer/js/chat.js'), 'utf8');
  const start = source.indexOf('  const tabActivity = new WeakMap();');
  const end = source.indexOf('  let dragTab = null;', start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  const context = { codeome: { remote: { tabs: async (payload) => {
    calls.push(payload);
    return calls.length === 1 ? { error: 'Invalid tab summary.' } : { ok: true };
  } } }, clearTimeout() {}, setTimeout() {} };
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.pushTabs = pushTabs;', context);
  const tabs = [{ id: 'chat' }];
  context.pushTabs('/project', tabs, true);
  await Promise.resolve();
  context.pushTabs('/project', tabs, true);
  await Promise.resolve();
  assert.equal(calls.length, 2);
});
