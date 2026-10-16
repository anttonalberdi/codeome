const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CODEOME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-scratch-'));
const scratch = require('../main/scratch');
const usage = require('../main/usage');
const chat = require('../main/chat');
const kit = require('../main/kit');

const NOTE = 'There is no project here. This is a free space to discuss ideas and possible new projects; no code base to edit unless the user asks to draft files.';

test('scratch folder is created on demand and reused', () => {
  const expected = path.join(usage.home(), 'scratch');
  assert.equal(fs.existsSync(expected), false);
  assert.equal(scratch.dir(), expected);
  assert.equal(fs.statSync(expected).isDirectory(), true);
  assert.equal(scratch.dir(), expected);
  assert.equal(scratch.isScratch(expected), true);
  assert.equal(scratch.isScratch(path.join(expected, '..', 'scratch')), true);
  assert.equal(scratch.isScratch(usage.home()), false);
  assert.equal(scratch.isScratch(path.join(expected, 'child')), false);
  assert.equal(scratch.isScratch(null), false);
});

test('scratch instructions appear only for the scratch cwd', () => {
  const cwd = scratch.dir();
  const other = usage.home();
  for (const installed of [true, false]) {
    assert.ok(chat.systemPrompt(installed, undefined, cwd).includes(NOTE));
    assert.ok(!chat.systemPrompt(installed, undefined, other).includes(NOTE));
  }
  const at = (args) => args[args.indexOf('--append-system-prompt') + 1];
  assert.ok(at(chat.buildArgs({ id: 'scratch', kitInstalled: false, cwd })).includes(NOTE));
  assert.ok(chat.codexPrompt({ kitInstalled: false, cwd }).includes(NOTE));
  assert.ok(chat.forumPrompt(cwd).includes(NOTE));
  assert.ok(!chat.codexPrompt({ kitInstalled: false, cwd: other }).includes(NOTE));
  assert.ok(!chat.forumPrompt(other).includes(NOTE));
  const persona = chat.listPersonas()[0];
  assert.ok(chat.personaPrompt(persona.id, false, cwd).includes(NOTE));
  assert.ok(!chat.personaPrompt(persona.id, false, other).includes(NOTE));
});

test('the agent kit cannot be installed in scratch', () => {
  const cwd = scratch.dir();
  assert.throws(() => kit.install(cwd), /cannot be installed in Ideas/);
  assert.equal(fs.existsSync(path.join(cwd, '.codeome')), false);
});
