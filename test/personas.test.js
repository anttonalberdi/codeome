const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const chat = require('../main/chat');
const kit = require('../main/kit');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PERSONAS = path.join(__dirname, '..', 'kit', 'personas');
const atPrompt = (args) => args[args.indexOf('--append-system-prompt') + 1];
const linked = ['/work/connected'];
const hpc = { host: 'example-hpc', agentRoot: '/projects/example' };

test('default and unknown personas preserve both engines\' existing prompts', () => {
  const codexText = fs.readFileSync(path.join(__dirname, '..', 'kit', 'chat-codex.md'), 'utf8');
  for (const kitInstalled of [true, false]) {
    const options = { id: ID, kitInstalled, linked, hpc };
    const expectedClaude = chat.systemPrompt(kitInstalled)
      + chat.linkedPrompt(linked, kitInstalled) + chat.hpcPrompt(hpc);
    const defaultArgs = chat.buildArgs(options);
    assert.strictEqual(atPrompt(defaultArgs), expectedClaude);
    assert.ok(!atPrompt(defaultArgs).includes('Keep shared sections'), 'the sync comment must not reach the prompt');
    assert.ok(atPrompt(defaultArgs).includes('## Handling a message'));
    assert.deepStrictEqual(chat.buildArgs({ ...options, persona: 'no-such-persona' }), defaultArgs);

    const expectedCodex = chat.systemPrompt(kitInstalled, codexText)
      + chat.linkedPrompt(linked, kitInstalled, 'codex') + chat.hpcPrompt(hpc, 'codex');
    const defaultCodex = chat.codexPrompt(options);
    assert.strictEqual(defaultCodex, expectedCodex);
    assert.strictEqual(chat.codexPrompt({ ...options, persona: 'no-such-persona' }), defaultCodex);
  }
});

test('a selected persona replaces the chat prompt and retains connected project and HPC notes', () => {
  const [persona] = chat.listPersonas();
  assert.ok(persona, 'at least one shipped persona is needed');
  for (const kitInstalled of [true, false]) {
    const options = { id: ID, kitInstalled, linked, hpc, persona: persona.id };
    const base = chat.personaPrompt(persona.id, kitInstalled);
    assert.ok(base);
    assert.ok(!base.includes('## Handling a message'));
    assert.strictEqual(atPrompt(chat.buildArgs(options)), base
      + chat.linkedPrompt(linked, kitInstalled) + chat.hpcPrompt(hpc));
    assert.strictEqual(chat.codexPrompt(options), base
      + chat.linkedPrompt(linked, kitInstalled, 'codex') + chat.hpcPrompt(hpc, 'codex'));
  }
});

test('kit conditionals resolve both ways and leave no markers in persona prompts', () => {
  const source = 'Shared\n<!-- if kit -->\nWITH_KIT\n<!-- else -->\nWITHOUT_KIT\n<!-- end -->\nPersona';
  assert.strictEqual(chat.systemPrompt(true, source), 'Shared\n\nWITH_KIT\n\nPersona\n');
  assert.strictEqual(chat.systemPrompt(false, source), 'Shared\n\nWITHOUT_KIT\n\nPersona\n');
  for (const { id } of chat.listPersonas()) {
    for (const kitInstalled of [true, false]) {
      assert.ok(!chat.personaPrompt(id, kitInstalled).includes('<!--'), id);
    }
  }
});

test('unknown, unsafe, empty and non-string persona IDs return null', () => {
  for (const id of ['no-such-persona', '../x', '..', '', null, undefined, 3, false, {}, []]) {
    assert.strictEqual(chat.personaPrompt(id, true), null, String(id));
  }
});

test('every shipped persona is listed with metadata and examples are absent from its prompt', () => {
  const files = fs.readdirSync(PERSONAS).filter((file) => file.endsWith('.md') && !file.startsWith('_'));
  const listed = chat.listPersonas();
  assert.deepStrictEqual(listed.map((p) => p.id).sort(), files.map((file) => file.slice(0, -3)).sort());
  assert.ok(!listed.some((p) => p.id === '_base'));
  assert.ok(listed.some((p) => p.examples.length > 0), 'at least one shipped example is needed');
  for (const persona of listed) {
    for (const field of ['name', 'description', 'placeholder']) {
      assert.ok(typeof persona[field] === 'string' && persona[field].trim(), `${persona.id}: ${field}`);
    }
    assert.ok(['claude', 'codex', undefined].includes(persona.engine), `${persona.id}: engine`);
    assert.ok(Array.isArray(persona.examples), `${persona.id}: examples`);
    const prompt = chat.personaPrompt(persona.id, true);
    assert.ok(prompt);
    assert.doesNotMatch(prompt, /^## Examples\s*$/m, persona.id);
    for (const example of persona.examples) {
      assert.ok(typeof example === 'string' && example.trim(), `${persona.id}: blank example`);
      assert.ok(!prompt.includes(example), `${persona.id}: example leaked into prompt`);
    }
  }
});

test('personas are not added to the installable kit roles', () => {
  const roleFiles = fs.readdirSync(path.join(__dirname, '..', 'kit', 'roles'))
    .filter((file) => file.endsWith('.md') && !file.startsWith('_'));
  const roles = kit.roles();
  assert.strictEqual(roles.length, roleFiles.length);
  const roleIds = new Set(roleFiles.map((file) => file.slice(0, -3)));
  for (const role of roles) assert.ok(roleIds.has(role.name), role.name);
  for (const { id } of chat.listPersonas()) {
    if (!roleIds.has(id)) assert.ok(!roles.some((role) => role.name === id), id);
  }
});
