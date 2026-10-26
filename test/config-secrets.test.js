const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const source = fs.readFileSync(path.join(__dirname, '../main/config.js'), 'utf8');
const secrets = source.slice(source.indexOf('function readSecrets()'), source.indexOf('function secretsEncrypted()'));

test('a damaged secret store is not overwritten by setSecret', () => {
  let writes = 0;
  const context = {
    fs: { readFileSync: () => Buffer.from('damaged'), mkdirSync: () => {}, writeFileSync: () => { writes++; } },
    file: () => '/secrets.bin', app: { getPath: () => '/tmp' }, Buffer,
    safeStorage: { isEncryptionAvailable: () => true, decryptString: () => { throw new Error('decrypt failed'); }, encryptString: () => Buffer.from('') }
  };
  vm.runInNewContext(secrets, context);
  assert.strictEqual(context.getSecret('github:a'), '');
  assert.throws(() => context.setSecret('github:a', 'new'), /decrypt failed/);
  assert.strictEqual(writes, 0);
});

test('a missing secret store can be created', () => {
  let written;
  const context = {
    fs: { readFileSync: () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; },
      mkdirSync: () => {}, writeFileSync: (_name, data) => { written = data; } },
    file: () => '/secrets.bin', app: { getPath: () => '/tmp' }, Buffer,
    safeStorage: { isEncryptionAvailable: () => false }
  };
  vm.runInNewContext(secrets, context);
  context.setSecret('github:a', 'new');
  assert.deepStrictEqual(JSON.parse(written.toString()), { 'github:a': 'new' });
});

test('secret kind and extension are sanitised on save and load', () => {
  const configPath = require.resolve('../main/config');
  let data;
  const fakeFs = {
    readFileSync: () => data,
    mkdirSync: () => {},
    writeFileSync: (_name, value) => { data = value; }
  };
  const originalLoad = Module._load;
  Module._load = function (name, parent, ...args) {
    if (name === 'electron') return { app: { getPath: () => '/unused' }, safeStorage: {} };
    if (name === 'fs' && parent && parent.filename === configPath) return fakeFs;
    return originalLoad.call(this, name, parent, ...args);
  };
  let config;
  try { config = require('../main/config'); }
  finally { Module._load = originalLoad; }

  const entries = [
    { name: 'LEGACY', terminals: true },
    { name: 'FILE', kind: 'file', ext: '.p8', filename: '../original.p8' },
    { name: 'BAD_KIND', kind: 'other', ext: '.p8' },
    { name: 'BAD_EXT', kind: 'file', ext: '../key' },
    { name: 'LONG_EXT', kind: 'file', ext: '.' + 'x'.repeat(17) }
  ];
  const saved = config.save({ ...config.DEFAULTS, secrets: entries });
  assert.deepStrictEqual(saved.secrets, [
    { name: 'LEGACY', terminals: true, kind: 'text' },
    { name: 'FILE', kind: 'file', ext: '.p8' },
    { name: 'BAD_KIND', kind: 'text' },
    { name: 'BAD_EXT', kind: 'file' },
    { name: 'LONG_EXT', kind: 'file' }
  ]);
  data = JSON.stringify({ secrets: entries });
  assert.deepStrictEqual(config.load().secrets, saved.secrets);
});
