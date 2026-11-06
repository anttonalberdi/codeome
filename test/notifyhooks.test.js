const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const NotifySettings = require('../main/notifysettings');

const source = fs.readFileSync(path.join(__dirname, '../renderer/js/chat.js'), 'utf8');

function fixture(cfg = {}, options = {}) {
  let onEvent, onOpen;
  const calls = [];
  const App = { h() {}, chatXmsg: { receipt: () => false }, chatCollisions: {}, project: '/project',
    cfg: { chatTabs: {}, accounts: {}, ...cfg },
    views: { agents: { jobs: [] } }, basename: (project) => project.split('/').pop(),
    toast() {}, emit() {}, saveConfig() {} };
  const codeome = {
    chat: { onEvent: (fn) => { onEvent = fn; }, onExit() {},
      control: async () => ({}),
      pending: async () => options.pendingRequests || [],
      load: async (_project, id) => options.saved?.[id] || null,
      save: async () => ({}) },
    inbox: { pending: async () => options.pendingOutbox || [] }
  };
  if (!options.noNotifyApi) codeome.notify = {
    show: (payload) => { calls.push(payload); return Promise.resolve(); },
    onOpen: (fn) => { onOpen = fn; return () => {}; }
  };
  vm.runInNewContext(source, { App, codeome, NotifySettings, document: { hidden: true },
    requestAnimationFrame: () => 1, setTimeout: () => 1, clearTimeout() {} });
  const C = App.views.chat;
  const chat = { id: 'chat', project: '/project', title: 'Chat', started: true, engine: 'claude',
    items: [], requests: {}, collisions: [], stream: {}, busy: true, running: true };
  C.byId.chat = chat;
  C.byProject['/project'] = { tabs: [chat], active: chat };
  return { App, C, chat, calls,
    event: (msg) => onEvent({ id: 'chat', msg }),
    open: (payload) => onOpen(payload) };
}

function expectOne(calls, kind, chatId = 'chat') {
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { chatId, kind });
  assert.deepEqual(Object.keys(calls[0]).sort(), ['chatId', 'kind']);
}

const outgoing = (id = 'out-1') => ({ type: 'outgoing', id, kind: 'message', text: 'Private approval text' });
const incoming = (id = 'in-1', changes = {}) => ({ type: 'inbox', id, kind: 'message',
  status: 'unread', text: 'Private message text', ...changes });
const request = (id, tool = 'Bash') => ({ type: 'control_request', request_id: id,
  request: { subtype: 'can_use_tool', tool_name: tool, input: {} } });

test('a live successful or failed turn sends one generic OS notification', () => {
  const finished = fixture();
  finished.event({ type: 'result', subtype: 'success' });
  expectOne(finished.calls, 'finished');
  finished.event({ type: 'result', subtype: 'success' });
  expectOne(finished.calls, 'finished'); // an old result has no live turn to finish

  const failed = fixture();
  failed.event({ type: 'result', subtype: 'error', result: 'Private error text' });
  expectOne(failed.calls, 'error');
});

test('user Stop suppresses its result notification and a later real error still notifies', async () => {
  const f = fixture();
  await f.C.stop();
  assert.equal(f.chat.stopping, true);
  f.event({ type: 'result', subtype: 'error', result: 'Interrupted' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.chat.stopping, false);
  f.chat.busy = true;
  f.event({ type: 'result', subtype: 'error', result: 'Actual failure' });
  expectOne(f.calls, 'error');
});

test('live permission and question requests notify, while reconciliation stays quiet', async () => {
  const perm = fixture();
  perm.event(request('perm-1'));
  expectOne(perm.calls, 'ask');
  perm.event(request('perm-1'));
  expectOne(perm.calls, 'ask');

  const ask = fixture();
  ask.event(request('ask-1', 'AskUserQuestion'));
  expectOne(ask.calls, 'ask');

  const replay = fixture({}, { pendingRequests: [{ chatId: 'chat', requestId: 'old',
    toolName: 'Bash', input: {} }] });
  await replay.C.open('chat');
  assert.equal(replay.chat.items.some((item) => item.requestId === 'old'), true);
  assert.equal(replay.calls.length, 0);
});

test('new live approval and incoming cards notify once, but updates and excluded events do not', () => {
  const approval = fixture();
  approval.event(outgoing());
  expectOne(approval.calls, 'approval');
  approval.event(outgoing());
  approval.event({ type: 'receipt', id: 'out-1', status: 'delivered' });
  expectOne(approval.calls, 'approval');

  const message = fixture();
  message.event(incoming());
  expectOne(message.calls, 'incoming');
  message.event(incoming());
  message.event(incoming('conflict-1', { kind: 'conflict' }));
  message.event(incoming('dismissed-1', { status: 'dismissed', awaiting: false }));
  message.event(incoming('expired-1', { status: 'expired', awaiting: false }));
  message.event(incoming('inactive-handoff', { kind: 'handoff', status: 'awaiting_accept', awaiting: false }));
  expectOne(message.calls, 'incoming');
});

test('saved and refreshed cards never produce OS notifications', async () => {
  const saved = { id: 'restored', project: '/project', title: 'Old', started: true,
    items: [{ t: 'outbox', id: 'saved-out', kind: 'message', status: 'pending' },
      { t: 'xmsg', id: 'saved-in', kind: 'message', status: 'unread' }] };
  const restored = fixture({}, { saved: { restored: saved }, pendingOutbox: [outgoing('pending-out')] });
  await restored.C.open('restored');
  assert.equal(restored.C.byId.restored.items.some((item) => item.id === 'pending-out'), true);
  assert.equal(restored.calls.length, 0);

  const refreshed = fixture({}, { pendingOutbox: [outgoing()] });
  refreshed.event(outgoing());
  refreshed.calls.length = 0;
  await refreshed.C.open('chat');
  assert.equal(refreshed.chat.items.filter((item) => item.t === 'outbox').length, 1);
  assert.equal(refreshed.calls.length, 0);
});

test('master, event, and project switches suppress notifications in the renderer', () => {
  const master = fixture({ notifications: { enabled: false } });
  master.event({ type: 'result', subtype: 'success' });
  assert.equal(master.calls.length, 0);

  const event = fixture({ notifications: { events: { ask: false } } });
  event.event(request('perm-1'));
  assert.equal(event.calls.length, 0);

  const project = fixture({ projectNotify: { '/project': { events: { finished: false } } } });
  project.event({ type: 'result', subtype: 'error' });
  assert.equal(project.calls.length, 0); // error shares the finished switch
});

test('notification clicks reveal only known chat ids', () => {
  const f = fixture();
  const revealed = [];
  f.C.reveal = (chat) => revealed.push(chat);
  f.open({ chatId: 'chat' });
  f.open({ chatId: 'missing' });
  f.open({ chatId: 123 });
  f.open(null);
  assert.deepEqual(revealed, [f.chat]);
});

test('missing notification bridge is harmless', () => {
  const f = fixture({}, { noNotifyApi: true });
  f.event(request('perm-1'));
  assert.equal(f.calls.length, 0);
});
