const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const setup = require('../main/setup');

test('tunnel runs openconnect with ocproxy as a userspace SOCKS proxy', () => {
  const a = setup.tunnelArgs({ server: 'vpn.example.org', user: 'abc123', port: 12000, args: '--authgroup="Staff"' }, '/opt/homebrew/bin/ocproxy');
  assert.deepStrictEqual(a, ['--protocol=anyconnect', '--user=abc123', '--script-tun', '--script', "'/opt/homebrew/bin/ocproxy' -D 12000 -k 30", '--authgroup=Staff', 'vpn.example.org']);
  assert.throws(() => setup.tunnelArgs({ server: '' }), /VPN server/);
});

test('the saved VPN password is typed once, at the first Password: prompt only', () => {
  const sent = [];
  const feed = setup.passwordFiller('s3cret', (s) => sent.push(s));
  feed('POST https://vpn.example.org/\r\nPlease enter your username and password.\r\nPass');
  assert.deepStrictEqual(sent, []);
  feed('word:');
  assert.deepStrictEqual(sent, ['s3cret\r']);
  feed('\r\nLogin failed.\r\nPassword:');
  assert.deepStrictEqual(sent, ['s3cret\r']);
  const second = [];
  const feed2 = setup.passwordFiller('s3cret', (s) => second.push(s));
  feed2('Second Password:');
  assert.deepStrictEqual(second, []);
  const none = [];
  setup.passwordFiller('', (s) => none.push(s))('Password:');
  assert.deepStrictEqual(none, []);
});

test('extra options split on spaces and keep quoted values together', () => {
  assert.deepStrictEqual(setup.splitArgs('--authgroup "Staff" --useragent=AnyConnect'), ['--authgroup', 'Staff', '--useragent=AnyConnect']);
  assert.deepStrictEqual(setup.splitArgs(''), []);
});

test('ports outside the user range fall back to the default', () => {
  assert.strictEqual(setup.portOf({ port: 22 }), setup.DEFAULT_PORT);
  assert.strictEqual(setup.portOf({ port: '12001' }), 12001);
  assert.strictEqual(setup.portOf({}), setup.DEFAULT_PORT);
});

test('the tunnel command survives the shell intact', () => {
  const cmd = setup.tunnelCommand({ server: 'vpn.example.org', user: "o'neil", port: 11080, args: '' });
  // Replace exec with printf to see the words the shell hands to openconnect.
  const out = execFileSync('/bin/sh', ['-c', cmd.replace(/^exec 'openconnect'/, "printf '%s\\n'")], { encoding: 'utf8' });
  assert.deepStrictEqual(out.trim().split('\n'), ['--protocol=anyconnect', "--user=o'neil", '--script-tun', '--script', "'ocproxy' -D 11080 -k 30", 'vpn.example.org']);
});

test('the proxy command uses the tunnel when it listens and goes direct otherwise', () => {
  const p = setup.proxyCommand(11080);
  assert.match(p, /nc -z -G 2 127\.0\.0\.1 11080/);
  assert.match(p, /exec nc -X 5 -x 127\.0\.0\.1:11080 "\$0" "\$1"/);
  assert.match(p, /else exec nc "\$0" "\$1"/);
  assert.match(p, /' %h %p$/);
});

test('install plans group Homebrew formulae, casks and other installers', () => {
  const ic = setup.installCommand(['openconnect', 'ocproxy', 'quarto', 'R', 'Rscript', 'nope']);
  assert.strictEqual(ic.command, 'brew install openconnect ocproxy && brew install --cask quarto r');
  assert.strictEqual(ic.brew, true);
  assert.deepStrictEqual(ic.labels, ['OpenConnect', 'ocproxy', 'Quarto', 'R']);
  const git = setup.installCommand(['git']);
  assert.strictEqual(git.command, 'xcode-select --install');
  assert.strictEqual(git.brew, false);
  assert.strictEqual(setup.installCommand(['nope']), null);
});

test('ssh -G output gives the login, keys and any proxy', () => {
  const o = setup.parseSshG('user abc123\nhostname login.cluster.example.org\nport 22\nidentityfile ~/.ssh/id_ed25519\nproxyjump none\nproxycommand none\n');
  assert.deepStrictEqual(o, { identityFiles: ['~/.ssh/id_ed25519'], user: 'abc123', hostname: 'login.cluster.example.org', port: 22 });
  assert.strictEqual(setup.parseSshG('proxyjump bastion\n').proxyJump, 'bastion');
});

test('a missing key is created at the ed25519 path ssh would try', () => {
  const k = setup.findKey(['~/.ssh/codeome-test-none-rsa', '~/.ssh/codeome-test-none-id_ed25519']);
  assert.deepStrictEqual(k, { exists: false, path: '~/.ssh/codeome-test-none-id_ed25519' });
});

test('failed test logins are sorted by what to do next', () => {
  assert.strictEqual(setup.classifyLogin(0, ''), 'ok');
  assert.strictEqual(setup.classifyLogin(255, 'abc123@host: Permission denied (publickey,password).'), 'auth');
  assert.strictEqual(setup.classifyLogin(255, 'Host key verification failed.'), 'hostkey');
  assert.strictEqual(setup.classifyLogin(255, 'nc: getaddrinfo: nodename nor servname provided, or not known\nConnection closed by UNKNOWN port 65535'), 'network');
  assert.strictEqual(setup.classifyLogin(255, 'ssh: connect to host x port 22: Operation timed out'), 'network');
  assert.strictEqual(setup.classifyLogin(1, 'something else'), 'other');
});

test('check hosts and ProxyJump hops give a host and port', () => {
  assert.deepStrictEqual(setup.hostPort('login.cluster.example.org'), { host: 'login.cluster.example.org', port: 22 });
  assert.deepStrictEqual(setup.hostPort('me@bastion:2222,inner'), { host: 'bastion', port: 2222 });
  assert.deepStrictEqual(setup.hostPort('[::1]:2200'), { host: '::1', port: 2200 });
  assert.strictEqual(setup.hostPort(''), null);
});

test('the VPN check uses the check host, else the HPC login', async () => {
  assert.deepStrictEqual(await setup.vpnTarget({ hpc: { host: 'x', vpnCheckHost: 'gate.example:2022', vpn: { mode: 'system' } } }), { host: 'gate.example', port: 2022 });
  assert.deepStrictEqual(await setup.vpnTarget({ hpc: { host: 'me@hpc.example', vpnCheckHost: '', vpn: { mode: 'system' } } }), { host: 'hpc.example', port: 22 });
  // Through the tunnel only the login itself counts.
  assert.deepStrictEqual(await setup.vpnTarget({ hpc: { host: 'me@hpc.example', vpnCheckHost: 'gate.example', vpn: { mode: 'tunnel' } } }), { host: 'hpc.example', port: 22 });
  assert.strictEqual(await setup.vpnTarget({ hpc: { host: '', vpnCheckHost: '', vpn: { mode: 'system' } } }), null);
});

test('failed VPN probes are sorted by what they say about the VPN', () => {
  assert.strictEqual(setup.classifyProbe(0, 'Connection to x port 22 [tcp/ssh] succeeded!'), 'ok');
  assert.strictEqual(setup.classifyProbe(1, 'nc: getaddrinfo: nodename nor servname provided, or not known'), 'dns');
  assert.strictEqual(setup.classifyProbe(1, 'nc: connectx to vpn.example.org port 22 (tcp) failed: Operation timed out'), 'unreachable');
  assert.strictEqual(setup.classifyProbe(1, 'nc: connectx to 127.0.0.1 port 1 (tcp) failed: Connection refused'), 'refused');
  assert.strictEqual(setup.classifyProbe(1, 'nc: connection failed, SOCKS error 4'), 'dns');
  assert.strictEqual(setup.classifyProbe(1, ''), 'other');
});

test('a probe reports a refused port', async () => {
  const r = await setup.probe('127.0.0.1', 1);
  assert.strictEqual(r.result, 'refused');
});
