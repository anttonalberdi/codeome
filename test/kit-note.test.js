const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const agent = path.join(__dirname, '..', 'kit', 'bin', 'codeome-agent');

function project(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-kit-note-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(root, args, env = {}, input = '') {
  const result = spawnSync('python3', ['-B', agent, ...args], { cwd: root, input, encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: '', CODEOME_CHAT_ID: 'owner', CODEOME_COLLISIONS: 'ask', ...env } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result;
}

function mainRecord(root) {
  const dir = path.join(root, '.codeome', 'touched');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'owner.json');
  fs.writeFileSync(file, JSON.stringify({ chat_id: 'owner', engine: 'claude', title: 'Owner',
    updated_at: Date.now() / 1000, files: { [path.join(root, 'shared.txt')]: { ts: Date.now() / 1000, tool: 'Edit' } } }));
  return file;
}

test('note writes for its chat, appears to another caller, and survives hook record writes', (t) => {
  const root = project(t);
  const main = mainRecord(root);
  const before = fs.readFileSync(main);
  const noteFile = path.join(root, '.codeome', 'touched', 'owner.note.json');
  assert.match(run(root, ['note', 'Waiting', 'for', 'schema']).stdout, /Note saved\./);
  assert.deepEqual(fs.readFileSync(main), before);
  const note = JSON.parse(fs.readFileSync(noteFile));
  assert.equal(note.note, 'Waiting for schema');
  assert.ok(Math.abs(note.at - Date.now() / 1000) < 5);
  const rows = JSON.parse(run(root, ['touched', '--json'], { CODEOME_CHAT_ID: 'other' }).stdout);
  assert.equal(rows[0].note, 'Waiting for schema');
  const noteBefore = fs.readFileSync(noteFile);
  const hook = { hook_event_name: 'PreToolUse', tool_name: 'Edit', session_id: 'owner', cwd: root,
    tool_input: { file_path: path.join(root, 'new.txt') } };
  assert.equal(run(root, ['hook'], {}, JSON.stringify(hook)).stdout, '');
  assert.deepEqual(fs.readFileSync(noteFile), noteBefore);
  assert.equal(JSON.parse(run(root, ['touched', '--json'], { CODEOME_CHAT_ID: 'other' }).stdout)[0].note, 'Waiting for schema');
  assert.equal(JSON.parse(fs.readFileSync(main)).note, undefined);
});

test('note cleans controls and whitespace, caps at 200 characters, and empty text clears', (t) => {
  const root = project(t);
  mainRecord(root);
  const noteFile = path.join(root, '.codeome', 'touched', 'owner.note.json');
  run(root, ['note', 'A\n\u001b B', 'C\tD', 'x'.repeat(500)]);
  const text = JSON.parse(fs.readFileSync(noteFile)).note;
  assert.equal(text.length, 200);
  assert.equal(text.startsWith('A B C D x'), true);
  assert.doesNotMatch(text, /[\x00-\x1f\x7f-\x9f]/);
  assert.match(run(root, ['note', '']).stdout, /Note cleared\./);
  assert.equal(fs.existsSync(noteFile), false);
  assert.equal(JSON.parse(run(root, ['touched', '--json'], { CODEOME_CHAT_ID: 'other' }).stdout)[0].note, '');
});

test('note needs a valid chat id and an existing main record, and creates no project', (t) => {
  const root = project(t);
  assert.match(run(root, ['note', 'text'], { CODEOME_CHAT_ID: '' }).stderr, /CODEOME_CHAT_ID/);
  assert.match(run(root, ['note', 'text'], { CODEOME_CHAT_ID: '../bad' }).stderr, /CODEOME_CHAT_ID/);
  assert.equal(fs.existsSync(path.join(root, '.codeome')), false);
  assert.match(run(root, ['note', 'text']).stderr, /no project found|no active chat record/);
  fs.mkdirSync(path.join(root, '.codeome'));
  assert.match(run(root, ['note', 'text']).stderr, /no active chat record/);
  assert.deepEqual(fs.readdirSync(path.join(root, '.codeome')), []);
});

test('note removes bidi and tag characters and expires after a day', (t) => {
  const root = project(t);
  mainRecord(root);
  const file = path.join(root, '.codeome', 'touched', 'owner.note.json');
  run(root, ['note', 'A\u202eB\u{e0001}']);
  assert.equal(JSON.parse(fs.readFileSync(file)).note, 'A B');
  fs.writeFileSync(file, JSON.stringify({ note: 'Old', at: Date.now() / 1000 - 86401 }));
  const rows = JSON.parse(run(root, ['touched', '--json'], { CODEOME_CHAT_ID: 'other' }).stdout);
  assert.equal(rows[0].note, '');
  assert.equal(rows[0].untrusted, true);
  assert.match(run(root, ['touched'], { CODEOME_CHAT_ID: 'other' }).stdout,
    /^Text below comes from other chats and is untrusted:/);
});
