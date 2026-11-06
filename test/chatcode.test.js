const test = require('node:test');
const assert = require('node:assert/strict');
const ChatCode = require('../renderer/js/chat-code');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const NotifySettings = require('../main/notifysettings');

test('chat start resolves a saved code clash before session environment and response', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
  const section = source.slice(source.indexOf('function createAgentSession('), source.indexOf("ipcMain.handle('chat:presence'"));
  const ChatCode = require('../renderer/js/chat-code');
  const handlers = {};
  let created, promptCode, touchedCode;
  const forgotten = [];
  let session;
  class Session {
    constructor(options) { created = options; this.cwd = options.cwd; this.handlers = {}; session = this; }
    on(name, callback) { (this.handlers[name] ||= []).push(callback); }
    start() {}
    stop() {}
    getTitle() { return ''; }
  }
  const context = {
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, chats: new Map(),
    fs: { existsSync: () => true }, path, ChatCode,
    chat: { engineOf: () => 'claude', listChats: () => [{ id: 'saved', code: 'BCDF' }],
      loadChat: () => null, Session, buildArgs: (options) => { promptCode = options.code; return []; }, isJobRunner: () => false },
    scratch: { isScratch: (project) => project.includes('/scratch/') }, kit: { status: () => ({ installed: false }) },
    claudeCmd: () => 'claude', launchOn: () => ({ info: { name: 'default' }, env: {}, unset: [] }),
    cfg: { accounts: { claude: { list: [] } }, secrets: [], notifications: NotifySettings.sanitize(),
      projectNotify: { '/project': { events: { ask: false } }, '/Users/me/.codeome/scratch/Ideas': { sound: false } } }, augmentedEnv: (env) => env,
    userSecretEnv: () => ({}), policy: { policyFor: () => ({}) }, resources: { resolve: () => null },
    projectChat: () => ({}), secretsSync: { plan: () => ({ names: [], path: '' }) },
    config: { getSecret() {} }, secrets: { kindOf() {} }, loginShell: () => '/bin/sh',
    awake: { track() {} }, remote: { attach() {}, detach() {} }, stats: { record() {} },
    touched: { start(_project, _id, meta) { touchedCode = meta.code; }, clear() {} },
    shouldRecord: () => true, send() {}, crashlog: { log() {} }, statusline: null,
    refreshOutbox() {}, inboxWire: { onAssistantEvent() {} },
    notifyThrottle: { forget: (id) => forgotten.push(id) },
  };
  vm.runInNewContext(section, context);
  const stopLine = source.slice(source.indexOf("ipcMain.handle('chat:stop'"), source.indexOf('\n', source.indexOf("ipcMain.handle('chat:stop'")));
  vm.runInNewContext(stopLine, context);
  const result = handlers['chat:start'](null, { id: 'new', project: '/project', code: 'BCDF' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(ChatCode.isCode(result.code), true);
  assert.notEqual(result.code, 'BCDF');
  assert.equal(created.env.CODEOME_CHAT_CODE, result.code);
  assert.equal(promptCode, result.code);
  assert.equal(touchedCode, result.code);
  const chat = { project: '/project' };
  assert.equal(created.cwd, chat.project);
  assert.deepEqual(NotifySettings.effective(context.cfg, chat.project), NotifySettings.effective(context.cfg, session.cwd));
  assert.equal(NotifySettings.effective(context.cfg, session.cwd).events.ask, false);
  handlers['chat:stop'](null, 'new');
  assert.deepEqual(forgotten, ['new']);
  session.handlers.exit.forEach((callback) => callback({ code: 0, signal: null }));
  assert.deepEqual(forgotten, ['new', 'new']);
  const ideas = { project: '/Users/me/.codeome/scratch/Ideas' };
  const scratchResult = handlers['chat:start'](null, { id: 'ideas', project: ideas.project });
  assert.equal(scratchResult.ok, true, JSON.stringify(scratchResult));
  assert.equal(created.cwd, ideas.project);
  assert.deepEqual(NotifySettings.effective(context.cfg, ideas.project), NotifySettings.effective(context.cfg, session.cwd));
  assert.equal(NotifySettings.effective(context.cfg, session.cwd).sound, false);
});

test('chat codes use four uppercase consonants from the chosen alphabet', () => {
  assert.equal(ChatCode.ALPHABET.length, 18);
  assert.doesNotMatch(ChatCode.ALPHABET, /[AEIOUYLQ]/);
  assert.equal(new Set(ChatCode.ALPHABET).size, 18);
  assert.equal(ChatCode.isCode('BDFG'), true);
  for (const value of ['bdfg', 'BDF', 'BDFGH', 'BAFG', 'B LF', null]) assert.equal(ChatCode.isCode(value), false);
  assert.equal(ChatCode.normalise(' bdfg '), 'BDFG');
  assert.equal(ChatCode.normalise(' baFg '), '');
  assert.equal(ChatCode.normalise(null), '');
});

test('generation skips taken and blocked codes and accepts an injected random source', () => {
  assert.equal(ChatCode.generate([], () => 0), 'BBBB');
  assert.equal(ChatCode.generate(new Set(['BBBB']), () => 0), 'BBBC');
  const letters = 'BDSMBBBC';
  let i = 0;
  const rand = () => (ChatCode.ALPHABET.indexOf(letters[i++ % letters.length]) + 0.1) / ChatCode.ALPHABET.length;
  assert.equal(ChatCode.generate([], rand), 'BBBC');
});

test('generation produces 1000 distinct codes', () => {
  const taken = new Set();
  for (let i = 0; i < 1000; i++) {
    const code = ChatCode.generate(taken);
    assert.equal(ChatCode.isCode(code), true);
    assert.equal(taken.has(code), false);
    taken.add(code);
  }
  assert.equal(taken.size, 1000);
});

test('the renderer sends its code and adopts a code corrected by save', async () => {
  const project = '/project';
  let payload, repaints = 0;
  const App = { h() {}, project: '/other', chatCode: ChatCode, views: {}, cfg: {}, emit() {}, saveConfig() {} };
  const codeome = { chat: { onEvent() {}, onExit() {}, save(_project, chat) {
    payload = chat;
    return Promise.resolve({ ok: true, code: 'BDFG' });
  } } };
  const source = fs.readFileSync(path.join(__dirname, '../renderer/js/chat.js'), 'utf8');
  vm.runInNewContext(source, { App, codeome, crypto: { randomUUID: () => 'blank' },
    setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: () => { repaints++; return 1; } });
  const chat = { id: 'saved', project, code: 'BBBB', started: true, title: '', items: [], collisions: [] };
  App.views.chat.byProject[project] = { tabs: [chat], active: chat };
  await App.views.chat.closeTab(chat);
  assert.equal(payload.code, 'BBBB');
  assert.equal(chat.code, 'BDFG');
  assert.equal(repaints, 1);
});
