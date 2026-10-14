const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

test('forum sessions cannot inherit chat job auto-approval on either engine', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
  const start = source.indexOf('function createAgentSession(');
  const end = source.indexOf("\nipcMain.handle('chat:start'", start);
  assert.ok(start >= 0 && end > start);
  const made = [];
  class Session extends EventEmitter { constructor(options) { super(); made.push(options); } }
  const cfg = { accounts: { claude: { list: [{ name: 'account' }] }, codex: { list: [{ name: 'account' }] } }, chat: {}, projectLinks: {} };
  const context = { fs, path, cfg, statusline: null, Session, CodexSession: Session,
    kit: { status: () => ({ installed: true }) }, claudeCmd: () => 'claude', codexCmd: () => 'codex',
    launchOn: () => ({ info: { name: 'account' }, env: {}, unset: [] }),
    augmentedEnv: (env) => env, userSecretEnv: () => ({}), loginShell: () => '/bin/sh',
    chat: { Session, isJobRunner: () => true, buildArgs: () => [], forumPrompt: () => 'forum', codexPrompt: () => 'chat', recordUsage: () => {} },
    console };
  const create = vm.runInNewContext(source.slice(start, end) + '\ncreateAgentSession;', context);
  for (const engine of ['claude', 'codex']) {
    create({ id: 'chat', project: __dirname, engine });
    assert.equal(made.at(-1).autoAllow({ tool_name: 'Bash', input: { command: 'runner' } }), true);
    create({ id: 'forum', project: __dirname, engine, forum: true });
    assert.equal(made.at(-1).autoAllow({ tool_name: 'Bash', input: { command: 'runner' } }), false);
  }
});
