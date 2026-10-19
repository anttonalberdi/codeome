const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const projectChat = require('../main/projectchat');

test('forum sessions cannot inherit chat job auto-approval on either engine', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
  const start = source.indexOf('function createAgentSession(');
  const end = source.indexOf("\nipcMain.handle('chat:start'", start);
  assert.ok(start >= 0 && end > start);
  const made = [];
  class Session extends EventEmitter { constructor(options) { super(); made.push(options); } }
  const cfg = { accounts: { claude: { list: [{ name: 'account' }] }, codex: { list: [{ name: 'account' }] } }, chat: {}, projectLinks: {} };
  const context = { fs, path, cfg, policy: require('../main/policy'), statusline: null, Session, CodexSession: Session, scratch: { isScratch: () => false },
    kit: { status: () => ({ installed: true }) }, claudeCmd: () => 'claude', codexCmd: () => 'codex',
    launchOn: () => ({ info: { name: 'account' }, env: {}, unset: [] }),
    augmentedEnv: (env) => env, userSecretEnv: () => ({}), secretsSync: { plan: () => ({ names: [], path: '' }) }, config: { getSecret: () => '' }, loginShell: () => '/bin/sh',
    projectChat, chat: { Session, isJobRunner: () => true, buildArgs: () => [], forumPrompt: () => 'forum', codexPrompt: () => 'chat', recordUsage: () => {} },
    console };
  const create = vm.runInNewContext(source.slice(start, end) + '\ncreateAgentSession;', context);
  for (const engine of ['claude', 'codex']) {
    create({ id: 'chat', project: __dirname, engine });
    assert.equal(made.at(-1).autoAllow({ tool_name: 'Bash', input: { command: 'runner' } }), true);
    assert.equal(made.at(-1).policy().slurmSubmit, 'ask');
    context.cfg = { ...cfg, projectPolicy: { [__dirname]: { slurmSubmit: 'never' } } };
    assert.equal(made.at(-1).policy().slurmSubmit, 'never');
    context.cfg = cfg;
    create({ id: 'forum', project: __dirname, engine, forum: true });
    assert.equal(made.at(-1).autoAllow({ tool_name: 'Bash', input: { command: 'runner' } }), false);
  }
});

test('chat and forum sessions receive the project model and effort', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
  const start = source.indexOf('function createAgentSession(');
  const end = source.indexOf("\nipcMain.handle('chat:start'", start);
  const made = [], built = [];
  class Session extends EventEmitter { constructor(options) { super(); made.push(options); } }
  const cfg = { accounts: { claude: { list: [{ name: 'account' }] }, codex: { list: [{ name: 'account' }] } },
    chat: { model: 'sonnet', effort: 'low', codexModel: 'gpt-app', codexEffort: 'medium' },
    projectChat: { [__dirname]: { model: 'opus', effort: 'high', codexModel: 'gpt-project', codexEffort: 'xhigh' } } };
  const context = { fs, path, cfg, policy: require('../main/policy'), statusline: null, CodexSession: Session,
    scratch: { isScratch: () => false }, kit: { status: () => ({ installed: false }) },
    claudeCmd: () => 'claude', codexCmd: () => 'codex',
    launchOn: () => ({ info: { name: 'account' }, env: {}, unset: [] }),
    augmentedEnv: (env) => env, userSecretEnv: () => ({}), secretsSync: { plan: () => ({ names: [], path: '' }) }, config: { getSecret: () => '' }, loginShell: () => '/bin/sh',
    projectChat, chat: { Session, isJobRunner: () => false,
      buildArgs: (options) => { built.push(options); return []; }, forumPrompt: () => 'forum', codexPrompt: () => 'chat', recordUsage: () => {} } };
  const create = vm.runInNewContext(source.slice(start, end) + '\ncreateAgentSession;', context);
  for (const forum of [false, true]) {
    create({ id: 'claude', project: __dirname, engine: 'claude', forum });
    assert.equal(built.at(-1).model, 'opus');
    assert.equal(built.at(-1).effort, 'high');
    create({ id: 'codex', project: __dirname, engine: 'codex', forum });
    assert.equal(made.at(-1).model, 'gpt-project');
    assert.equal(made.at(-1).effort, 'xhigh');
  }
});
