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

test('file metadata and content are validated without exposing the content', () => {
  assert.strictEqual(secrets.MAX_FILE, 65536);
  assert.strictEqual(secrets.kindOf({}), 'text');
  assert.strictEqual(secrets.kindOf({ kind: 'file' }), 'file');
  assert.strictEqual(secrets.kindOf({ kind: 'other' }), 'text');
  for (const ext of [undefined, '', '.p8', '.A1', '.' + 'x'.repeat(16)]) assert.strictEqual(secrets.extError(ext), '');
  for (const ext of ['p8', '.', '.a/b', '.a\0b', '../p8', '.' + 'x'.repeat(17), 7]) assert.ok(secrets.extError(ext));
  for (const value of ['x', 'a\nb', 'é'.repeat(32768)]) assert.strictEqual(secrets.valueError('file', value), '');
  for (const value of ['', 'a\0b', 'x'.repeat(65537), 'é'.repeat(32769), '\ud800', Buffer.from([0xff]), null]) assert.ok(secrets.valueError('file', value));
  assert.strictEqual(secrets.valueError('text', 'a\0b'), '');
});

test('file secrets require a placement callback and never enter the env as content', () => {
  const list = [
    { name: 'OLD', terminals: true },
    { name: 'FILE', kind: 'file', ext: '.p8', terminals: true },
    { name: 'EMPTY', kind: 'file', terminals: true },
    { name: 'NUL', kind: 'file', terminals: true },
    { name: 'LARGE', kind: 'file', terminals: true }
  ];
  const store = { 'user:OLD': 'plain', 'user:FILE': 'line 1\nline 2', 'user:EMPTY': '',
    'user:NUL': 'a\0b', 'user:LARGE': 'x'.repeat(65537) };
  const get = (k) => store[k];
  assert.deepStrictEqual(secrets.envFor(list, 'terminals', get), { OLD: 'plain' });
  const placed = [];
  const env = secrets.envFor(list, 'terminals', get, null, (s, value) => {
    placed.push([s.name, value]);
    return '/private/FILE.p8';
  });
  assert.deepStrictEqual(env, { OLD: 'plain', FILE: '/private/FILE.p8' });
  assert.deepStrictEqual(placed, [['FILE', 'line 1\nline 2']]);
  assert.deepStrictEqual(secrets.envFor(list, 'terminals', get, null, () => ''), { OLD: 'plain' });
});

test('a failed file placement skips that variable and keeps the other secrets', () => {
  const list = [{ name: 'BAD', kind: 'file', agents: true }, { name: 'GOOD', kind: 'file', agents: true }, { name: 'TEXT', agents: true }];
  const content = 'private content';
  const env = secrets.envFor(list, 'agents', () => content, '/project', (s) => {
    if (s.name === 'BAD') throw new Error(content);
    return '/private/GOOD';
  });
  assert.deepStrictEqual(env, { GOOD: '/private/GOOD', TEXT: content });
  assert.strictEqual(JSON.stringify(env).includes('BAD'), false);
});
