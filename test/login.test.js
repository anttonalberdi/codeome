const test = require('node:test');
const assert = require('node:assert');
const login = require('../main/login');

// A stand-in for `ssh -fN` on a pty: the test prints its output and reads what was typed.
function fakeSsh(opts = {}) {
  const typed = [], states = [];
  let data, exit;
  const t = login.start({
    spawn: () => ({ onData: (f) => { data = f; }, onExit: (f) => { exit = f; }, write: (s) => typed.push(s), kill: () => exit({ exitCode: 255 }) }),
    verify: async () => opts.verify !== false,
    password: opts.password || '',
    emit: (s) => states.push(s), onUp: opts.onUp
  });
  const pause = () => new Promise((r) => setTimeout(r, 300));
  return { t, typed, states, last: () => states[states.length - 1], say: async (s) => { data(s); await pause(); }, exit: async (c = 255) => { await exit({ exitCode: c }); } };
}

test('ssh prompts are told apart', () => {
  assert.deepStrictEqual(login.classifyPrompt("abc123@login.cluster.example.org's password: "), { kind: 'password', label: 'Password' });
  assert.deepStrictEqual(login.classifyPrompt('(abc123@login) Password:'), { kind: 'password', label: 'Password' });
  assert.deepStrictEqual(login.classifyPrompt("Enter passphrase for key '/Users/me/.ssh/id_ed25519': "), { kind: 'passphrase', label: 'Passphrase', key: '/Users/me/.ssh/id_ed25519' });
  assert.deepStrictEqual(login.classifyPrompt('Are you sure you want to continue connecting (yes/no/[fingerprint])? '), { kind: 'hostkey', label: 'Fingerprint' });
  assert.deepStrictEqual(login.classifyPrompt('(abc123@login) Verification code:'), { kind: 'code', label: 'Verification code' });
  assert.deepStrictEqual(login.classifyPrompt("One-time password (OATH) for `abc123':"), { kind: 'code', label: "One-time password (OATH) for `abc123'" });
  assert.strictEqual(login.classifyPrompt('Warning: Permanently added mycluster (ED25519) to the list of known hosts.'), null);
});

test('with a key nothing is asked: ssh exits 0 and the shared connection is up', async () => {
  let saved = 0;
  const f = fakeSsh({ onUp: () => saved++ });
  assert.strictEqual(f.last().phase, 'starting');
  await f.exit(0);
  assert.strictEqual(f.last().phase, 'up');
  assert.strictEqual(saved, 1);
  assert.deepStrictEqual(f.typed, []);
});

test('the saved password is typed once; a rejected one is asked for in the window', async () => {
  const f = fakeSsh({ password: 'wrong' });
  await f.say("me@hpc's password: ");
  assert.deepStrictEqual(f.typed, ['wrong\r']);
  assert.strictEqual(f.last().phase, 'waiting');
  await f.say('\r\nPermission denied, please try again.\r\nme@hpc\'s password: ');
  assert.deepStrictEqual(f.typed, ['wrong\r']);
  const s = f.last();
  assert.strictEqual(s.phase, 'prompt');
  assert.strictEqual(s.prompt.kind, 'password');
  assert.match(s.prompt.error, /not accepted/);
  assert.ok(f.t.answer(s.prompt.id, 'right'));
  assert.deepStrictEqual(f.typed, ['wrong\r', 'right\r']);
  assert.strictEqual(f.t.answer(s.prompt.id, 'again'), false);
  await f.exit(0);
  assert.strictEqual(f.last().phase, 'up');
});

test('keyboard-interactive asking the password again counts as rejected', async () => {
  const f = fakeSsh();
  await f.say('(me@hpc) Password:');
  f.t.answer(f.last().prompt.id, 'bad');
  await f.say('\r\n(me@hpc) Password:');
  assert.match(f.last().prompt.error, /not accepted/);
  await f.exit();
});

test('a new host shows its fingerprint and is trusted with yes', async () => {
  const f = fakeSsh();
  await f.say("The authenticity of host 'hpc (10.0.0.1)' can't be established.\r\nED25519 key fingerprint is SHA256:abc.\r\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ");
  const s = f.last();
  assert.strictEqual(s.prompt.kind, 'hostkey');
  assert.match(s.prompt.detail, /SHA256:abc/);
  f.t.answer(s.prompt.id, 'yes');
  assert.deepStrictEqual(f.typed, ['yes\r']);
  await f.exit();
});

test('a failed login says why; stopping it says stopped', async () => {
  const f = fakeSsh();
  await f.say('Warning: Permanently added hpc to the list of known hosts.\r\nme@hpc: Permission denied (publickey,password).\r\n');
  await f.exit(255);
  assert.strictEqual(f.last().phase, 'failed');
  assert.strictEqual(f.last().reason, 'me@hpc: Permission denied (publickey,password).');
  const g = fakeSsh({ verify: false });
  await g.exit(0);
  assert.match(g.last().reason, /no shared connection/);
  const k = fakeSsh();
  k.t.stop();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(k.last().phase, 'stopped');
});
