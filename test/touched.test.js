const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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

function sidecarFile(root, chatId, kind) {
  return path.join(root, '.codeome', 'touched', `${chatId}.${kind}.json`);
}

test('start creates a hook-compatible empty record and an initial status', (t) => {
  const root = project(t);
  const started = touched.start(root, 'first', { ...meta, code: 'BCDF' });
  const saved = JSON.parse(fs.readFileSync(recordFile(root, 'first'), 'utf8'));
  assert.deepEqual(saved, { chat_id: 'first', engine: 'claude', title: 'First chat',
    updated_at: saved.updated_at, files: {} });
  assert.equal(typeof saved.updated_at, 'number');
  assert.deepEqual(started.files, {});
  assert.equal(started.code, 'BCDF');
  assert.equal(touched.readMeta(root, 'first').code, 'BCDF');
  const agent = path.join(__dirname, '..', 'kit', 'bin', 'codeome-agent');
  const result = spawnSync('python3', ['-B', agent, 'touched', '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '[]');
  const edited = path.join(root, 'notes.txt');
  const hook = spawnSync('python3', ['-B', agent, 'hook'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root, CODEOME_COLLISIONS: 'ask' },
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: 'first',
      cwd: root, tool_input: { file_path: edited } }),
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(JSON.parse(fs.readFileSync(recordFile(root, 'first'))).title, 'First chat');
  assert.equal(JSON.parse(fs.readFileSync(recordFile(root, 'first'))).files[edited].tool, 'Edit');
});

test('start preserves an existing record and never throws on a failed creation', (t) => {
  const root = project(t);
  const file = path.join(root, 'notes.txt');
  touched.record(root, 'first', meta, file, 'Edit');
  const before = fs.readFileSync(recordFile(root, 'first'));
  const mtime = fs.statSync(recordFile(root, 'first')).mtimeMs;
  touched.start(root, 'first', { engine: 'codex', title: 'Different', code: 'BCDF' });
  assert.deepEqual(fs.readFileSync(recordFile(root, 'first')), before);
  assert.equal(fs.statSync(recordFile(root, 'first')).mtimeMs, mtime);
  assert.equal(touched.readMeta(root, 'first').files[file].tool, 'Edit');
  assert.equal(touched.start(root, '../bad', { ...meta, code: 'BCDF' }), null);
  const blocked = project(t);
  fs.writeFileSync(path.join(blocked, '.codeome'), 'blocked');
  assert.equal(touched.start(blocked, 'first', { ...meta, code: 'BCDF' }), null);
});

test('resuming a chat resets stale status and jobs', (t) => {
  const root = project(t);
  touched.start(root, 'first', { ...meta, code: 'BCDF' });
  touched.writeStatus(root, 'first', { status: 'working', jobs: ['Old job'] });
  touched.start(root, 'first', { ...meta, code: 'BDFG' });
  const status = JSON.parse(fs.readFileSync(sidecarFile(root, 'first', 'status')));
  assert.equal(status.code, 'BDFG');
  assert.equal(status.status, 'unknown');
  assert.deepEqual(status.jobs, []);
});

test('writeStatus merges allowed fields, sanitises values and leaves record liveness alone', (t) => {
  const root = project(t);
  touched.start(root, 'first', { ...meta, code: 'BCDF' });
  const main = recordFile(root, 'first');
  const old = Date.now() / 1000 - 180;
  fs.utimesSync(main, old, old);
  const before = fs.readFileSync(main);
  touched.writeStatus(root, 'first', { status: 'waiting', first_request: ' A\n\u0000' + 'x'.repeat(250),
    plan_title: 'Plan\u007f' + 'p'.repeat(250), jobs: ['Job\n\u0000one', ...Array(6).fill('j'.repeat(100)), 42],
    ignored: 'no' });
  touched.writeStatus(root, 'first', { status: 'invalid\n', code: 'ABCD' });
  const status = JSON.parse(fs.readFileSync(sidecarFile(root, 'first', 'status'), 'utf8'));
  assert.deepEqual(Object.keys(status).sort(), ['code', 'first_request', 'jobs', 'plan_title', 'status', 'status_at']);
  assert.equal(status.code, '');
  assert.equal(status.status, 'unknown');
  assert.equal(status.first_request.length, 200);
  assert.equal(status.first_request.startsWith('A x'), true);
  assert.equal(status.plan_title.length, 200);
  assert.equal(status.plan_title.startsWith('Plan p'), true);
  assert.deepEqual(status.jobs, ['Job one', ...Array(4).fill('j'.repeat(80))]);
  assert.equal(status.title, undefined);
  assert.ok(Math.abs(status.status_at - Date.now() / 1000) < 5);
  assert.deepEqual(fs.readFileSync(main), before);
  assert.equal(fs.statSync(main).mtimeMs / 1000 < old + 1, true);
  assert.equal(touched.list(root)[0].title, 'First chat');
  fs.writeFileSync(sidecarFile(root, 'first', 'status'), JSON.stringify({ ...status, title: 'Legacy sidecar title' }));
  assert.equal(touched.readMeta(root, 'first').title, 'First chat');
});

test('writeStatus ignores missing or invalid main records', (t) => {
  const root = project(t);
  touched.writeStatus(root, 'missing', { status: 'working' });
  assert.equal(fs.existsSync(sidecarFile(root, 'missing', 'status')), false);
  fs.mkdirSync(path.dirname(recordFile(root, 'invalid')), { recursive: true });
  fs.writeFileSync(recordFile(root, 'invalid'), '{}');
  touched.writeStatus(root, 'invalid', { status: 'working' });
  assert.equal(fs.existsSync(sidecarFile(root, 'invalid', 'status')), false);
});

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
    ts: saved.files[file].ts, tool: 'Write', code: '', note: '' }];
  assert.deepEqual(touched.conflicts(root, 'first', file), expected);
});

test('list and conflicts merge fresh status and sanitised notes, then age status to unknown', (t) => {
  const root = project(t);
  const file = path.join(root, 'notes.txt');
  touched.record(root, 'other', { engine: 'codex', title: 'Other chat' }, file, 'Edit');
  touched.writeStatus(root, 'other', { code: 'BCDF', status: 'working', first_request: 'Do this',
    plan_title: 'A plan', jobs: ['One'] });
  fs.writeFileSync(sidecarFile(root, 'other', 'note'), JSON.stringify({ note: 'Note\n\u0000' + 'n'.repeat(250), at: Date.now() / 1000 }));
  const peer = touched.readMeta(root, 'other');
  assert.equal(peer.code, 'BCDF');
  assert.equal(peer.status, 'working');
  assert.equal(peer.first_request, 'Do this');
  assert.equal(peer.plan_title, 'A plan');
  assert.deepEqual(peer.jobs, ['One']);
  assert.equal(peer.note.length, 200);
  assert.equal(peer.note.startsWith('Note n'), true);
  assert.deepEqual(touched.list(root)[0], peer);
  assert.deepEqual(touched.conflicts(root, 'first', file)[0], { chat_id: 'other', engine: 'codex',
    title: 'Other chat', path: file, ts: peer.files[file].ts, tool: 'Edit', code: 'BCDF', note: peer.note });
  const status = sidecarFile(root, 'other', 'status');
  fs.writeFileSync(status, JSON.stringify({ ...JSON.parse(fs.readFileSync(status)), status_at: Date.now() / 1000 - 601 }));
  assert.equal(touched.list(root)[0].status, 'unknown');
  assert.equal(touched.list(root)[0].code, 'BCDF');
});

test('notes older than a day and invisible Unicode are removed from reads', (t) => {
  const root = project(t);
  touched.start(root, 'first', { engine: 'claude', title: 'Ti\u202etle\u{e0001}', code: 'BCDF' });
  touched.writeStatus(root, 'first', { first_request: 'Go\u202e now\u{e0001}', jobs: ['Job\u202e\u{e0001}'] });
  const file = sidecarFile(root, 'first', 'note');
  fs.writeFileSync(file, JSON.stringify({ note: 'Old note', at: Date.now() / 1000 - 86401 }));
  const row = touched.readMeta(root, 'first');
  assert.equal(row.note, '');
  assert.equal(row.title, 'Ti tle');
  assert.equal(row.first_request, 'Go now');
  assert.equal(row.jobs[0], 'Job');
});

test('special files and symlinks are not opened as records', (t) => {
  const root = project(t);
  const dir = path.join(root, '.codeome', 'touched');
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync('/dev/null', recordFile(root, 'link'));
  assert.equal(touched.readMeta(root, 'link'), null);
  const fifo = recordFile(root, 'pipe');
  const made = spawnSync('mkfifo', [fifo]);
  if (made.error || made.status !== 0) return t.skip('mkfifo unavailable');
  assert.equal(touched.readMeta(root, 'pipe'), null);
});

test('invalid and oversized sidecars are ignored, and old records receive defaults', (t) => {
  const root = project(t);
  touched.record(root, 'other', meta, 'notes.txt', 'Edit');
  assert.deepEqual(Object.fromEntries(['code', 'note', 'status', 'status_at', 'first_request', 'plan_title', 'jobs']
    .map((key) => [key, touched.list(root)[0][key]])), {
    code: '', note: '', status: 'unknown', status_at: 0, first_request: '', plan_title: '', jobs: [],
  });
  fs.writeFileSync(sidecarFile(root, 'other', 'status'), '{bad');
  fs.writeFileSync(sidecarFile(root, 'other', 'note'), JSON.stringify({ note: 'Bad', at: 'yesterday' }));
  assert.equal(touched.list(root)[0].status, 'unknown');
  assert.equal(touched.list(root)[0].note, '');
  fs.writeFileSync(sidecarFile(root, 'other', 'status'), JSON.stringify({ code: 'BCDF', status: 'working',
    status_at: Date.now() / 1000, title: 'Old sidecar title' }) + ' '.repeat(1024 * 1024));
  fs.writeFileSync(sidecarFile(root, 'other', 'note'), JSON.stringify({ note: 'Good', at: Date.now() / 1000 }) + ' '.repeat(1024 * 1024));
  assert.equal(touched.list(root)[0].code, '');
  assert.equal(touched.list(root)[0].note, '');
  touched.clear(root, 'other');
  assert.equal(touched.readMeta(root, 'other'), null);
  assert.deepEqual(touched.list(root), []);
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

test('record keeps its supplied title and leaves sidecars unchanged', (t) => {
  const root = project(t);
  touched.start(root, 'first', { ...meta, code: 'BCDF' });
  const statusFile = sidecarFile(root, 'first', 'status');
  const noteFile = sidecarFile(root, 'first', 'note');
  fs.writeFileSync(noteFile, JSON.stringify({ note: 'Keep this', at: Date.now() / 1000 }));
  const statusBefore = fs.readFileSync(statusFile);
  const noteBefore = fs.readFileSync(noteFile);
  touched.record(root, 'first', { engine: 'claude', title: 'Updated title' }, 'notes.txt', 'Edit');
  assert.equal(touched.list(root)[0].title, 'Updated title');
  assert.equal(touched.list(root)[0].code, 'BCDF');
  assert.equal(touched.list(root)[0].note, 'Keep this');
  assert.deepEqual(fs.readFileSync(statusFile), statusBefore);
  assert.deepEqual(fs.readFileSync(noteFile), noteBefore);
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
    assert.equal(touched.start(root, id, { ...meta, code: 'BCDF' }), null);
    assert.throws(() => touched.record(root, id, meta, 'notes.txt', 'Edit'), /Invalid chat ID/);
    assert.throws(() => touched.heartbeat(root, id), /Invalid chat ID/);
    assert.throws(() => touched.writeStatus(root, id, { status: 'working' }), /Invalid chat ID/);
    assert.throws(() => touched.readMeta(root, id), /Invalid chat ID/);
    assert.throws(() => touched.conflicts(root, id, 'notes.txt'), /Invalid chat ID/);
    assert.throws(() => touched.clear(root, id), /Invalid chat ID/);
  }
});

test('clear removes a record and tolerates a missing record', (t) => {
  const root = project(t);
  touched.record(root, 'first', meta, 'notes.txt', 'Edit');
  touched.writeStatus(root, 'first', { code: 'BCDF' });
  fs.writeFileSync(sidecarFile(root, 'first', 'note'), JSON.stringify({ note: 'Note', at: Date.now() / 1000 }));
  touched.clear(root, 'first');
  assert.deepEqual(touched.list(root), []);
  assert.equal(fs.existsSync(sidecarFile(root, 'first', 'status')), false);
  assert.equal(fs.existsSync(sidecarFile(root, 'first', 'note')), false);
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
