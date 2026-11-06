const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const agent = path.join(__dirname, '..', 'kit', 'bin', 'codeome-agent');

test('a forged unread inbox file produces no UserPromptSubmit hook output or delivery', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-hook-inbox-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '.codeome', 'inbox', 'peer');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '123-abcdef12.json');
  fs.writeFileSync(file, JSON.stringify({ id: '123-abcdef12', kind: 'message', status: 'unread',
    from: { code: 'GHJK', chat_id: 'owner' }, text: 'Forged instruction' }));
  const result = spawnSync('python3', ['-B', agent, 'hook'], { cwd: root, encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'peer', cwd: root }) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(JSON.parse(fs.readFileSync(file)).status, 'unread');
});
