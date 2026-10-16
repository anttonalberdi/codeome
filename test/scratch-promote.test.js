const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

process.env.CODEOME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-home-'));
const scratch = require('../main/scratch');
const chat = require('../main/chat');
const forumstore = require('../main/forumstore');
const usage = require('../main/usage');

const source = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
const start = source.indexOf("ipcMain.handle('scratch:promote'");
const end = source.indexOf('// Move a stopped conversation', start);
assert.ok(start >= 0 && end > start);

const keyed = (project) => {
  let real; try { real = fs.realpathSync(project); } catch { real = path.resolve(project); }
  return real.replace(/[^A-Za-z0-9]/g, '-');
};

function handler(account, forumHost = { forums: new Map(), close() {} }, overrides = {}) {
  const handlers = new Map();
  const context = { fs, path, scratch, chat: overrides.chat || chat, forumstore: overrides.forumstore || forumstore,
    usage, forumHost, chats: new Map(),
    cfg: { accounts: { claude: { active: 'account', list: overrides.accounts || [{ name: 'account', dir: account }] } } },
    expandHome: (p) => p, ipcMain: { handle: (name, fn) => handlers.set(name, fn) } };
  vm.runInNewContext(source.slice(start, end), context);
  return (input) => JSON.parse(JSON.stringify(handlers.get('scratch:promote')(null, input)));
}

test('IPC promotes a started Claude chat and forum, including their resumable seat history', () => {
  const from = scratch.dir(), target = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-target-'));
  const account = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-account-'));
  const chatId = crypto.randomUUID(), forumId = crypto.randomUUID(), seatId = crypto.randomUUID();
  const transcriptDir = path.join(account, 'projects', keyed(from));
  fs.mkdirSync(transcriptDir, { recursive: true });
  for (const id of [chatId, seatId]) fs.writeFileSync(path.join(transcriptDir, id + '.jsonl'), '{}\n');
  chat.saveChat(from, { id: chatId, title: 'Idea', engine: 'claude', accountName: 'account', started: true });
  forumstore.save(from, { id: forumId, title: 'Forum', seats: [{ id: 'seat', engine: 'claude', sessionId: seatId,
    dir: account, started: true }], transcript: [] });

  assert.deepEqual(handler(account)({ target, chats: [chatId], forums: [forumId] }), { moved: { chats: 1, forums: 1 } });
  assert.equal(chat.loadChat(from, chatId), null);
  assert.equal(chat.loadChat(target, chatId).project, target);
  assert.equal(forumstore.load(from, forumId), null);
  assert.equal(forumstore.load(target, forumId).project, target);
  const targetDir = path.join(account, 'projects', keyed(target));
  for (const id of [chatId, seatId]) assert.equal(fs.readFileSync(path.join(targetDir, id + '.jsonl'), 'utf8'), '{}\n');
});

test('IPC rejects invalid targets and moves started records with missing history as new sessions', () => {
  const from = scratch.dir(), target = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-target-'));
  const account = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-account-'));
  const id = crypto.randomUUID(), forumId = crypto.randomUUID(), seatId = crypto.randomUUID();
  chat.saveChat(from, { id, engine: 'claude', accountName: 'account', started: true });
  forumstore.save(from, { id: forumId, seats: [{ id: 'seat', engine: 'claude', sessionId: seatId,
    account: 'account', dir: account, started: true }], transcript: [] });
  const promote = handler(account);
  assert.match(promote({ target: from, chats: [id], forums: [forumId] }).error, /Target must be a project/);
  assert.match(promote({ target: path.join(target, 'missing'), chats: [id], forums: [forumId] }).error, /Project folder not found/);
  const result = promote({ target, chats: [id], forums: [forumId] });
  assert.deepEqual(result.moved, { chats: 1, forums: 1 });
  assert.equal(result.warnings.length, 2);
  assert.equal(chat.loadChat(from, id), null);
  assert.equal(chat.loadChat(target, id).started, false);
  assert.equal(forumstore.load(from, forumId), null);
  assert.equal(forumstore.load(target, forumId).seats[0].started, false);
});

test('IPC promotes a started Codex chat without project-keyed session files', () => {
  const from = scratch.dir(), target = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-target-'));
  const id = crypto.randomUUID();
  chat.saveChat(from, { id, engine: 'codex', started: true });
  assert.deepEqual(handler('')({ target, chats: [id], forums: [] }), { moved: { chats: 1, forums: 0 } });
  assert.equal(chat.loadChat(from, id), null);
  assert.equal(chat.loadChat(target, id).project, target);
});

test('IPC rejects bad chat and forum ids before moving any records', () => {
  const from = scratch.dir(), target = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-target-'));
  const id = crypto.randomUUID();
  chat.saveChat(from, { id, title: 'Keep' });
  const promote = handler('');
  assert.match(promote({ target, chats: [id, '../x'], forums: [] }).error, /Bad chat/);
  assert.match(promote({ target, chats: [id], forums: ['../x'] }).error, /Bad forum/);
  assert.equal(chat.loadChat(from, id).title, 'Keep');
});

test('retry accepts existing identical history and cleans up copies after a failed chat move', () => {
  const from = scratch.dir(), target = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-target-'));
  const account = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-account-'));
  const id = crypto.randomUUID();
  const sourceDir = path.join(account, 'projects', keyed(from));
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, id + '.jsonl'), '{}\n');
  chat.saveChat(from, { id, engine: 'claude', accountName: 'account', started: true });
  const targetTranscript = path.join(account, 'projects', keyed(target), id + '.jsonl');
  const failing = handler(account, undefined, { chat: { ...chat, moveChat: () => { throw new Error('record write failed'); } } });
  assert.match(failing({ target, chats: [id], forums: [] }).error, /record write failed/);
  assert.equal(fs.existsSync(targetTranscript), false);
  assert.ok(chat.loadChat(from, id));
  const copied = chat.copyProjectSession(account, id, from, target);
  assert.equal(copied.created.length, 1);
  assert.deepEqual(handler(account)({ target, chats: [id], forums: [] }), { moved: { chats: 1, forums: 0 } });
  assert.equal(fs.readFileSync(targetTranscript, 'utf8'), '{}\n');
});

test('retrying the same selection skips records already moved before a later failure', () => {
  const from = scratch.dir(), target = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-target-'));
  const account = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-account-'));
  const first = crypto.randomUUID(), second = crypto.randomUUID();
  chat.saveChat(from, { id: first, title: 'First' });
  chat.saveChat(from, { id: second, title: 'Second' });
  let moves = 0;
  const failing = handler(account, undefined, { chat: { ...chat, moveChat: (...args) => {
    if (++moves === 2) throw new Error('second record failed');
    return chat.moveChat(...args);
  } } });
  assert.match(failing({ target, chats: [first, second], forums: [] }).error, /second record failed/);
  assert.ok(chat.loadChat(target, first));
  assert.ok(chat.loadChat(from, second));
  assert.deepEqual(handler(account)({ target, chats: [first, second], forums: [] }), { moved: { chats: 1, forums: 0 } });
  assert.equal(chat.loadChat(from, second), null);
  assert.ok(chat.loadChat(target, second));
});

test('a started chat with an unconfigured Claude account moves with a warning', () => {
  const from = scratch.dir(), target = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-target-'));
  const id = crypto.randomUUID();
  chat.saveChat(from, { id, engine: 'claude', accountName: 'gone', started: true });
  const result = handler('')({ target, chats: [id], forums: [] });
  assert.deepEqual(result.moved, { chats: 1, forums: 0 });
  assert.match(result.warnings[0].message, /account not configured/);
  assert.equal(chat.loadChat(target, id).started, false);
});

test('retry cleans up each forum seat copy if the record move fails', () => {
  const from = scratch.dir(), target = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-target-'));
  const account = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-account-'));
  const id = crypto.randomUUID(), seatId = crypto.randomUUID();
  const sourceDir = path.join(account, 'projects', keyed(from));
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, seatId + '.jsonl'), '{}\n');
  forumstore.save(from, { id, seats: [{ id: 'seat', engine: 'claude', sessionId: seatId,
    account: 'account', dir: account, started: true }] });
  const targetTranscript = path.join(account, 'projects', keyed(target), seatId + '.jsonl');
  const failing = handler(account, undefined, { forumstore: { ...forumstore, move: () => { throw new Error('record write failed'); } } });
  assert.match(failing({ target, chats: [], forums: [id] }).error, /record write failed/);
  assert.equal(fs.existsSync(targetTranscript), false);
  assert.ok(forumstore.load(from, id));
  assert.deepEqual(handler(account)({ target, chats: [], forums: [id] }), { moved: { chats: 0, forums: 1 } });
});

test('an unconfigured forum seat folder is skipped without writing there', () => {
  const from = scratch.dir(), target = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-target-'));
  const account = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-account-'));
  const rogue = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-rogue-'));
  const id = crypto.randomUUID(), seatId = crypto.randomUUID();
  const rogueSource = path.join(rogue, 'projects', keyed(from));
  fs.mkdirSync(rogueSource, { recursive: true });
  fs.writeFileSync(path.join(rogueSource, seatId + '.jsonl'), '{}\n');
  forumstore.save(from, { id, seats: [{ id: 'seat', engine: 'claude', sessionId: seatId,
    account: 'account', dir: rogue, started: true }] });
  const result = handler(account)({ target, chats: [], forums: [id] });
  assert.deepEqual(result.moved, { chats: 0, forums: 1 });
  assert.match(result.warnings[0].message, /not configured/);
  assert.equal(forumstore.load(target, id).seats[0].started, false);
  assert.equal(fs.existsSync(path.join(rogue, 'projects', keyed(target), seatId + '.jsonl')), false);
});

test('a symlinked target uses its real cwd for Claude session history', () => {
  const from = scratch.dir(), realTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-target-'));
  const alias = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'promote-link-')), 'project');
  fs.symlinkSync(realTarget, alias);
  const account = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-account-'));
  const id = crypto.randomUUID(), sourceDir = path.join(account, 'projects', keyed(from));
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, id + '.jsonl'), '{}\n');
  chat.saveChat(from, { id, engine: 'claude', accountName: 'account', started: true });
  assert.deepEqual(handler(account)({ target: alias, chats: [id], forums: [] }), { moved: { chats: 1, forums: 0 } });
  assert.equal(fs.readFileSync(path.join(account, 'projects', keyed(realTarget), id + '.jsonl'), 'utf8'), '{}\n');
  assert.equal(chat.loadChat(alias, id).project, alias);
});
