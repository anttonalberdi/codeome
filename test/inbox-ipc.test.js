const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const inbox = require('../main/inbox');
const touched = require('../main/touched');
const { createInboxWire } = require('../main/inboxwire');
const { createInboxIpc, createOutboxWatcher } = require('../main/inboxipc');

test('inbox IPC validates frame, chat, ids, hashes, edits and recipients', (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-inbox-ipc-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const chats = new Map([['owner', { cwd: project }]]);
  const calls = [];
  const inboxWire = { pendingFor: () => [], statusFor: (_id, cards) => cards.map((card) => ({ ...card, status: 'pending' })),
    approve: (...args) => { calls.push(args); return { ok: true }; }, decline: () => ({ ok: true }) };
  const frame = {}, contents = { mainFrame: frame }, win = { isDestroyed: () => false, webContents: contents };
  const handlers = createInboxIpc({ chats, inboxWire, getWindow: () => win,
    loadChat: (_project, id) => id === 'saved' ? { id } : null });
  const event = { sender: contents, senderFrame: frame };
  const good = { chatId: 'owner', id: '123-abcdef12', textHash: 'a'.repeat(64) };
  const refused = (payload, e = event) => assert.equal(handlers.approve(e, payload).ok, false);
  refused(good, { sender: {}, senderFrame: frame });
  refused({ ...good, chatId: 'other' });
  refused({ ...good, id: '../bad' });
  refused({ ...good, textHash: 'a'.repeat(63) });
  refused({ ...good, edited: 'x'.repeat(8001) });
  refused({ ...good, edited: { brief: 'x'.repeat(8201) } });
  refused({ ...good, recipients: Array(101).fill('peer') });
  refused({ ...good, recipients: ['../other'] });
  assert.equal(handlers.approve(event, { ...good, edited: { brief: 'Hi' }, recipients: ['peer'] }).ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(handlers.status(event, { chatId: 'other', project, cards: [] }), []);
  assert.deepEqual(handlers.status(event, { chatId: 'owner', project: '/foreign', cards: [] }), []);
  assert.deepEqual(handlers.status(event, { chatId: 'owner', project, cards: Array(51).fill({ id: good.id, box: 'outbox' }) }), []);
  assert.deepEqual(handlers.status(event, { chatId: 'owner', project, cards: [{ id: '../bad', box: 'outbox' }] }), []);
  assert.equal(handlers.status(event, { chatId: 'saved', project, cards: [{ id: good.id, box: 'outbox' }] }).length, 1);
});

test('two live chats can refresh one outbox without duplicate announcements; capability is private', (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-watch-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const events = [];
  const chats = new Map([['owner', { cwd: project, code: 'GHJK', getTitle: () => 'Owner', user() {} }],
    ['peer', { cwd: project, code: 'BCDF', getTitle: () => 'Peer', user() {} }]]);
  touched.start(project, 'owner', { engine: 'claude', code: 'GHJK', title: 'Owner' });
  touched.start(project, 'peer', { engine: 'claude', code: 'BCDF', title: 'Peer' });
  const id = '123-abcdef12';
  const dir = path.join(project, '.codeome', 'outbox', 'owner');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ v: 1, id, kind: 'message',
    from: { code: 'GHJK', chat_id: 'owner' }, to: { code: 'BCDF', chat_id: 'peer' },
    text: 'Hello', ts: Date.now() / 1000, hops: 0, status: 'pending' }));
  const wire = createInboxWire({ inbox, chats, touched, send: (chatId, msg) => events.push({ chatId, msg }) });
  const watcher = createOutboxWatcher({ inboxWire: wire, chats, appVersion: '0.9.4' });
  t.after(() => watcher.close());
  watcher.refresh(project);
  watcher.refresh(project);
  assert.equal(events.filter((event) => event.msg.type === 'outgoing').length, 1);
  const support = path.join(project, '.codeome', 'inbox-support.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(support)), { inbox: 1, app: '0.9.4' });
  assert.equal(fs.statSync(support).mode & 0o777, 0o600);
});
