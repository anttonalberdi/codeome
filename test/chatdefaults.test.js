const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const project = '/work/project';

test('new chat defaults resolve project, app, and remembered choices', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/js/chat.js'), 'utf8');
  const opened = [];
  const App = { h() {}, project, views: {
    projects: { linksOf: () => [] }, terminals: { open: (options) => opened.push(options) }
  }, shq: (value) => JSON.stringify(value), cfg: {
    chat: { model: 'sonnet', effort: 'low', mode: 'auto', engine: 'claude' },
    projectChat: { [project]: { model: 'opus', effort: 'high', mode: 'plan', engine: 'codex' } },
    agents: [{ cmd: 'claude' }, { cmd: 'codex' }]
  } };
  const codeome = { chat: { onEvent() {}, onExit() {} } };
  vm.runInNewContext(source, { App, codeome, localStorage: { getItem: () => 'acceptEdits' } });
  const resolve = (cfg, at, saved, opts) => JSON.parse(JSON.stringify(App.views.chat.resolveDefaults(cfg, at, saved, opts)));
  assert.deepEqual(resolve(App.cfg, project, 'acceptEdits'), {
    model: 'opus', effort: 'high', codexModel: '', codexEffort: '', mode: 'plan', engine: 'codex'
  });
  assert.equal(resolve(App.cfg, '/other', 'acceptEdits').mode, 'auto');
  assert.equal(resolve(App.cfg, '/other', 'acceptEdits', { engine: 'codex', mode: 'default' }).engine, 'codex');
  assert.equal(resolve(App.cfg, '/other', 'acceptEdits', { mode: 'default' }).mode, 'default');
  App.cfg.chat.mode = '';
  App.cfg.chat.engine = '';
  assert.equal(resolve(App.cfg, '/other', 'acceptEdits').mode, 'acceptEdits');
  assert.equal(resolve(App.cfg, '/other', 'acceptEdits').engine, 'claude');
  App.cfg.projectChat[project] = { model: '-bad', effort: 'minimal', mode: 'invalid', engine: 'toString' };
  assert.equal(resolve(App.cfg, project, 'acceptEdits').model, 'sonnet');
  assert.equal(resolve(App.cfg, project, 'acceptEdits').effort, 'low');
  assert.equal(resolve(App.cfg, project, 'acceptEdits').mode, 'acceptEdits');
  assert.equal(resolve(App.cfg, project, 'acceptEdits').engine, 'claude');
  App.cfg.projectChat[project].model = ' opus';
  assert.equal(resolve(App.cfg, project, 'acceptEdits').model, 'sonnet');
});

test('blank chats refresh defaults on activation and reuse, while explicit and started choices stay', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/js/chat.js'), 'utf8');
  let nextId = 0;
  const App = { h() {}, project, views: {}, cfg: { chat: { mode: 'auto', engine: 'claude' }, projectChat: {} },
    emit() {}, saveConfig() {} };
  const codeome = { chat: { onEvent() {}, onExit() {} } };
  vm.runInNewContext(source, { App, codeome, localStorage: { getItem: () => null },
    crypto: { randomUUID: () => String(++nextId) }, setTimeout: () => 0, clearTimeout() {} });
  const C = App.views.chat;
  await C.newChat();
  const blank = C.current();
  assert.equal(blank.engine, 'claude');
  assert.equal(blank.mode, 'auto');
  App.cfg.projectChat[project] = { engine: 'codex', mode: 'plan' };
  C.activate(blank);
  assert.equal(blank.engine, 'codex');
  assert.equal(blank.mode, 'plan');
  App.cfg.projectChat[project] = { engine: 'claude', mode: 'acceptEdits' };
  await C.newChat();
  assert.equal(C.current(), blank);
  assert.equal(blank.engine, 'claude');
  assert.equal(blank.mode, 'acceptEdits');
  await C.newChat({ engine: 'codex', mode: 'default' });
  assert.equal(blank.engine, 'codex');
  assert.equal(blank.mode, 'default');
  App.cfg.projectChat[project] = { engine: 'claude', mode: 'auto' };
  C.activate(blank);
  assert.equal(blank.engine, 'codex');
  assert.equal(blank.mode, 'default');
  blank.started = true;
  await C.newChat();
  assert.notEqual(C.current(), blank);
  C.activate(blank);
  assert.equal(blank.engine, 'codex');
  assert.equal(blank.mode, 'default');
});
