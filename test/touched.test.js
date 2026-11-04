const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const touched = require('../main/touched');

const meta = { engine: 'claude', title: 'First chat' };

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-touched-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync(root);
}

function recordFile(root, chatId) {
  return path.join(root, '.codeome', 'touched', `${chatId}.json`);
}

test('records a touch and does not report the caller as a conflict', (t) => {
  const root = project(t);
  const file = path.join(root, 'notes.txt');
  touched.record(root, 'first', meta, file, 'Edit');
  const saved = JSON.parse(fs.readFileSync(recordFile(root, 'first'), 'utf8'));
  assert.equal(saved.chat_id, 'first');
  assert.equal(saved.engine, 'claude');
  assert.equal(saved.title, 'First chat');
  assert.equal(typeof saved.updated_at, 'number');
  assert.deepEqual(saved.files[file], { ts: saved.updated_at, tool: 'Edit' });
  assert.deepEqual(touched.conflicts(root, 'first', file), []);
});

test('another live chat with a fresh touch conflicts', (t) => {
  const root = project(t);
  const file = path.join(root, 'notes.txt');
  touched.record(root, 'other', { engine: 'codex', title: 'Other chat' }, file, 'Write');
  const saved = touched.list(root)[0];
  const expected = [{ chat_id: 'other', engine: 'codex', title: 'Other chat', path: file,
    ts: saved.files[file].ts, tool: 'Write' }];
  assert.deepEqual(touched.conflicts(root, 'first', file), expected);
});

test('an expired touch does not conflict', (t) => {
  const root = project(t);
  const file = path.join(root, 'notes.txt');
  touched.record(root, 'other', meta, file, 'Edit');
  const saved = touched.list(root)[0];
  const now = saved.updated_at + 1801;
  assert.deepEqual(touched.conflicts(root, 'first', file, { now }), []);
});

test('a chat with an old record and old mtime is dead', (t) => {
  const root = project(t);
  const file = path.join(root, 'notes.txt');
  touched.record(root, 'other', meta, file, 'Edit');
  const saved = touched.list(root)[0];
  const now = saved.updated_at + 121;
  assert.deepEqual(touched.conflicts(root, 'first', file, { now }), []);
});

test('liveness depends on mtime rather than updated_at', (t) => {
  const root = project(t);
  const file = path.join(root, 'notes.txt');
  touched.record(root, 'other', meta, file, 'Edit');
  const saved = touched.list(root)[0];
  const old = saved.updated_at - 121;
  fs.writeFileSync(recordFile(root, 'other'), JSON.stringify({ ...saved, updated_at: old }));
  assert.equal(touched.conflicts(root, 'first', file).length, 1);
  fs.utimesSync(recordFile(root, 'other'), old, old);
  assert.deepEqual(touched.conflicts(root, 'first', file), []);
});

test('heartbeat refreshes mtime without changing record bytes or creating a missing record', (t) => {
  const root = project(t);
  const file = path.join(root, 'notes.txt');
  touched.record(root, 'other', meta, file, 'Edit');
  const target = recordFile(root, 'other');
  const old = Date.now() / 1000 - 180;
  const saved = JSON.parse(fs.readFileSync(target, 'utf8'));
  fs.writeFileSync(target, JSON.stringify({ ...saved, updated_at: old }));
  fs.utimesSync(target, old, old);
  const before = fs.readFileSync(target);

  touched.heartbeat(root, 'other');
  assert.deepEqual(fs.readFileSync(target), before);
  assert.ok(fs.statSync(target).mtimeMs / 1000 > old);

  touched.heartbeat(root, 'missing');
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['other.json']);
});

test('app records keep hook acknowledgements and a useful title', (t) => {
  const root = project(t);
  touched.record(root, 'first', { engine: 'claude', title: 'Saved\nchat\u0000 title' }, 'one.txt', 'Edit');
  const target = recordFile(root, 'first');
  const saved = JSON.parse(fs.readFileSync(target, 'utf8'));
  const acked = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [path.join(root, `ack-${i}.txt`), i]));
  fs.writeFileSync(target, JSON.stringify({ ...saved, acked }));
  touched.record(root, 'first', { engine: 'claude', title: '' }, 'two.txt', 'Write');
  const after = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(after.title, 'Saved chat title');
  assert.equal(Object.keys(after.acked).length, 200);
  assert.equal(after.acked[path.join(root, 'ack-0.txt')], undefined);
  const bytes = fs.readFileSync(target);
  touched.heartbeat(root, 'first');
  assert.deepEqual(fs.readFileSync(target), bytes);
  assert.deepEqual(JSON.parse(bytes).acked, after.acked);
});

test('relative paths and symlinked parents normalise to the same file', (t) => {
  const root = project(t);
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(root, 'link'));
  const file = path.join(real, 'new', 'notes.txt');
  touched.record(root, 'other', meta, 'link/new/notes.txt', 'Write');
  assert.deepEqual(Object.keys(touched.list(root)[0].files), [file]);
  assert.equal(touched.conflicts(root, 'first', file).length, 1);
  touched.record(root, 'other', meta, file, 'Edit');
  assert.equal(Object.keys(touched.list(root)[0].files).length, 1);
  fs.writeFileSync(path.join(real, 'existing.txt'), '');
  fs.symlinkSync(path.join(real, 'existing.txt'), path.join(root, 'alias.txt'));
  touched.record(root, 'other', meta, 'alias.txt', 'Write');
  assert.equal(touched.conflicts(root, 'first', path.join(real, 'existing.txt')).length, 1);
});

test('list and conflicts ignore corrupt JSON and wrong-shaped records', (t) => {
  const root = project(t);
  const file = path.join(root, 'notes.txt');
  touched.record(root, 'good', meta, file, 'Edit');
  fs.writeFileSync(recordFile(root, 'broken'), '{oops');
  fs.writeFileSync(recordFile(root, 'wrong'), JSON.stringify({ chat_id: 'wrong', files: { [file]: { ts: 1 } } }));
  fs.writeFileSync(recordFile(root, 'oversized'), JSON.stringify({ ...touched.list(root)[0], chat_id: 'oversized' }) + ' '.repeat(1024 * 1024));
  assert.deepEqual(touched.list(root).map((item) => item.chat_id), ['good']);
  assert.deepEqual(touched.conflicts(root, 'first', file).map((item) => item.chat_id), ['good']);
});

test('record scans read no more than 100 files', (t) => {
  const root = project(t);
  touched.record(root, 'template', meta, 'notes.txt', 'Edit');
  const template = touched.list(root)[0];
  for (let i = 0; i < 101; i++) {
    const chatId = `peer-${String(i).padStart(3, '0')}`;
    fs.writeFileSync(recordFile(root, chatId), JSON.stringify({ ...template, chat_id: chatId }));
  }
  assert.equal(touched.list(root).length, 100);
  assert.equal(touched.list(root).some((item) => item.chat_id === 'peer-100'), false);
});

test('invalid chat IDs are rejected', (t) => {
  const root = project(t);
  for (const id of ['', '../other', 'a.b', 'a/b', 'with space']) {
    assert.throws(() => touched.record(root, id, meta, 'notes.txt', 'Edit'), /Invalid chat ID/);
    assert.throws(() => touched.heartbeat(root, id), /Invalid chat ID/);
    assert.throws(() => touched.conflicts(root, id, 'notes.txt'), /Invalid chat ID/);
    assert.throws(() => touched.clear(root, id), /Invalid chat ID/);
  }
});

test('clear removes a record and tolerates a missing record', (t) => {
  const root = project(t);
  touched.record(root, 'first', meta, 'notes.txt', 'Edit');
  touched.clear(root, 'first');
  assert.deepEqual(touched.list(root), []);
  assert.doesNotThrow(() => touched.clear(root, 'first'));
});

test('record keeps the 200 most recent files', (t) => {
  const root = project(t);
  for (let i = 0; i < 201; i++) touched.record(root, 'first', meta, `file-${i}.txt`, 'Edit');
  const files = touched.list(root)[0].files;
  assert.equal(Object.keys(files).length, 200);
  assert.equal(Object.hasOwn(files, path.join(root, 'file-0.txt')), false);
  assert.equal(Object.hasOwn(files, path.join(root, 'file-200.txt')), true);
});
