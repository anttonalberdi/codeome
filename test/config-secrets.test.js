const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
