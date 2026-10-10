const test = require('node:test');
const assert = require('node:assert');
const secrets = require('../main/secrets');

test('a secret is named as an environment variable', () => {
  assert.strictEqual(secrets.nameError('GITHUB_TOKEN'), '');
  assert.strictEqual(secrets.nameError('_hf2'), '');
  for (const bad of ['', '2FA', 'MY-TOKEN', 'MY TOKEN', 'A=B', 'X'.repeat(65), null, 12]) assert.ok(secrets.nameError(bad), String(bad));
});

test('names the system or Codeome depend on are refused', () => {
  for (const bad of ['PATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD']) assert.match(secrets.nameError(bad), /used by/);
  assert.strictEqual(secrets.nameError('PATHS'), '');
});

test('a process gets only the secrets switched on for it', () => {
  const store = { 'user:GITHUB_TOKEN': 'ghp_1', 'user:HF_TOKEN': 'hf_2', 'user:BOTH': 'b', 'user:PATH': '/evil', 'zenodo:prod': 'z' };
  const get = (k) => store[k] || '';
  const list = [
    { name: 'GITHUB_TOKEN', terminals: true },
    { name: 'HF_TOKEN', agents: true },
    { name: 'BOTH', terminals: true, agents: true },
    { name: 'COPY_ONLY' },
    { name: 'NO_VALUE', terminals: true, agents: true },
    { name: 'PATH', terminals: true, agents: true },
    { name: 'zenodo:prod', terminals: true },
    null
  ];
  assert.deepStrictEqual(secrets.envFor(list, 'terminals', get), { GITHUB_TOKEN: 'ghp_1', BOTH: 'b' });
  assert.deepStrictEqual(secrets.envFor(list, 'agents', get), { HF_TOKEN: 'hf_2', BOTH: 'b' });
});

test('other kinds of process get none', () => {
  const get = () => 'v';
  const list = [{ name: 'A', terminals: true, agents: true, name2: true }];
  assert.deepStrictEqual(secrets.envFor(list, undefined, get), {});
  assert.deepStrictEqual(secrets.envFor(list, 'name', get), {});
  assert.deepStrictEqual(secrets.envFor(undefined, 'agents', get), {});
});

test('a secret limited to projects is set only in those', () => {
  const get = () => 'v';
  const list = [{ name: 'EVERYWHERE', agents: true }, { name: 'ONE', agents: true, projects: ['/p/a'] }, { name: 'NONE', agents: true, projects: [] }];
  assert.deepStrictEqual(Object.keys(secrets.envFor(list, 'agents', get, '/p/a')), ['EVERYWHERE', 'ONE']);
  assert.deepStrictEqual(Object.keys(secrets.envFor(list, 'agents', get, '/p/b')), ['EVERYWHERE']);
  assert.deepStrictEqual(Object.keys(secrets.envFor(list, 'agents', get, '/p/a/sub')), ['EVERYWHERE']);
  assert.deepStrictEqual(Object.keys(secrets.envFor(list, 'agents', get, null)), ['EVERYWHERE']);
  assert.deepStrictEqual(Object.keys(secrets.envFor(list, 'agents', get)), ['EVERYWHERE']);
});
