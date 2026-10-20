const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { hostBlock, addHost } = require('../main/setup');

test('the HPC login wizard writes a Host block and only appends', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-ssh-'));
  const file = path.join(dir, '.ssh', 'config');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, 'Host other\n  HostName o.example.org');
  addHost({ alias: 'mj', hostname: 'login.example.org', user: 'abc', proxyJump: 'u@gw.example.org', port: '2222' }, file);
  const out = fs.readFileSync(file, 'utf8');
  assert.match(out, /^Host other\n {2}HostName o\.example\.org\n\n# Added by Codeome\nHost mj\n {2}HostName login\.example\.org\n {2}User abc\n {2}Port 2222\n {2}ProxyJump u@gw\.example\.org\n$/);
  assert.throws(() => addHost({ alias: 'MJ', hostname: 'x.example.org' }, file), /already has a login/);
  assert.throws(() => addHost({ alias: 'other', hostname: 'x.example.org' }, file), /already has a login/);
});

test('the wizard refuses values that could inject ssh options', () => {
  assert.throws(() => hostBlock({ alias: 'a', hostname: 'h\nProxyCommand evil' }));
  assert.throws(() => hostBlock({ alias: 'a b', hostname: 'h.org' }));
  assert.throws(() => hostBlock({ alias: 'a', hostname: 'h.org', user: 'x y' }));
  assert.throws(() => hostBlock({ alias: 'a', hostname: 'h.org', port: '99999' }));
});
