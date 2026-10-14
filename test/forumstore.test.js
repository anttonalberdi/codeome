const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.CODEOME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forumstore-home-'));
const store = require('../main/forumstore');
const chat = require('../main/chat');

test('forum snapshots are atomic, listed separately from chats, and keep creation time', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'forumstore-project-'));
  const id = crypto.randomUUID();
  const snapshot = { id, project, title: 'A forum', seats: [{ id: 'a', engine: 'claude' }],
    transcript: [{ kind: 'message', text: 'hello' }, { kind: 'note', text: 'pause' }, { kind: 'message', text: 'reply' }],
    doc: { kind: 'gdoc', path: '/p/file.gdoc', docId: 'abc' }, usage: { a: { turns: 1 } } };
  const first = store.save(project, snapshot);
  assert.equal(first.kind, 'forum');
  assert.ok(first.createdAt <= first.updatedAt);
  assert.equal(store.load(project, id).usage.a.turns, 1);
  assert.deepEqual(store.list(project), [{ id, title: 'A forum', seats: snapshot.seats, messages: 2,
    updatedAt: first.updatedAt, doc: snapshot.doc }]);
  assert.equal(chat.listChats(project).length, 0);
  assert.ok(store.folder(project).startsWith(path.join(process.env.CODEOME_HOME, 'forums')));
  assert.deepEqual(fs.readdirSync(store.folder(project)), [id + '.json']);
  const second = store.save(project, { ...snapshot, title: 'Renamed' });
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(store.list(project)[0].title, 'Renamed');
  assert.deepEqual(fs.readdirSync(store.folder(project)), [id + '.json']);
});

test('bad ids cannot be loaded, saved or deleted, and deletion removes the forum', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'forumstore-project-'));
  const id = crypto.randomUUID();
  store.save(project, { id, title: 'Delete me', transcript: [] });
  assert.equal(store.load(project, '../escape'), null);
  assert.throws(() => store.save(project, { id: '../escape' }), /Bad forum/);
  assert.throws(() => store.remove(project, '../escape'), /Bad forum/);
  assert.deepEqual(store.remove(project, id), { ok: true });
  assert.equal(store.load(project, id), null);
  assert.deepEqual(store.list(project), []);
});
