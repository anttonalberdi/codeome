const test = require('node:test');
const assert = require('node:assert');
const vpn = require('../main/vpn');

// A stand-in for openconnect on a pty: the test prints its output and reads what was typed.
function fakeTunnel(opts = {}) {
  const typed = [], states = [];
  let data, exit, open = false;
  const t = vpn.start({
    spawn: () => ({ onData: (f) => { data = f; }, onExit: (f) => { exit = f; }, write: (s) => typed.push(s), kill: () => exit({ exitCode: 1 }) }),
    portOpen: async () => open,
    user: opts.user || '', password: opts.password || '',
    emit: (s) => states.push(s), onUp: opts.onUp
  });
  const pause = () => new Promise((r) => setTimeout(r, 300));
  return { t, typed, states, last: () => states[states.length - 1], say: async (s) => { data(s); await pause(); }, exit: (c = 1) => exit({ exitCode: c }), up: () => { open = true; } };
}

test('prompts are told apart', () => {
  assert.deepStrictEqual(vpn.classifyPrompt('Username:'), { kind: 'username', label: 'Username' });
  assert.deepStrictEqual(vpn.classifyPrompt('Password: '), { kind: 'password', label: 'Password' });
  assert.deepStrictEqual(vpn.classifyPrompt('GROUP: [KU-Staff|KU-Student]:'), { kind: 'group', label: 'Group', options: ['KU-Staff', 'KU-Student'] });
  assert.deepStrictEqual(vpn.classifyPrompt('Second Password:'), { kind: 'code', label: 'Second Password' });
  assert.strictEqual(vpn.classifyPrompt('POST https://vpn.example.org/'), null);
  assert.strictEqual(vpn.lastLine('Please enter your username and password.\r\n\x1b[1mPassword:'), 'Password:');
});

test('the saved username and password are typed in, then it waits for the MFA approval and comes up', async () => {
  let saved = 0;
  const f = fakeTunnel({ user: 'abc123', password: 's3cret', onUp: () => saved++ });
  await f.say('Please enter your username and password.\r\nUsername:');
  assert.deepStrictEqual(f.typed, ['abc123\r']);
  await f.say('abc123\r\nPassword:');
  assert.deepStrictEqual(f.typed, ['abc123\r', 's3cret\r']);
  assert.strictEqual(f.last().phase, 'waiting');
  f.up();
  await new Promise((r) => setTimeout(r, 1100));
  assert.strictEqual(f.last().phase, 'up');
  assert.strictEqual(saved, 1);
  f.exit();
});

test('a rejected saved password is not sent again: the window is asked, with the reason', async () => {
  const f = fakeTunnel({ user: 'abc123', password: 'wrong' });
  await f.say('Password:');
  await f.say('\r\nLogin failed.\r\nPassword:');
  assert.deepStrictEqual(f.typed, ['wrong\r']);
  const s = f.last();
  assert.strictEqual(s.phase, 'prompt');
  assert.strictEqual(s.prompt.kind, 'password');
  assert.match(s.prompt.error, /not accepted/);
  assert.ok(f.t.answer(s.prompt.id, 'right'));
  assert.deepStrictEqual(f.typed, ['wrong\r', 'right\r']);
  assert.strictEqual(f.last().phase, 'waiting');
  assert.strictEqual(f.t.answer(s.prompt.id, 'again'), false); // an old prompt is not answered twice
  f.exit();
});

test('without saved details the window is asked, and a second-factor code prompt too', async () => {
  const f = fakeTunnel();
  await f.say('Username:');
  assert.strictEqual(f.last().prompt.kind, 'username');
  f.t.answer(f.last().prompt.id, 'abc123');
  await f.say('abc123\r\nPassword:');
  f.t.answer(f.last().prompt.id, 'pw');
  await f.say('\r\nAnswer:');
  assert.deepStrictEqual(f.last().prompt, { id: 3, kind: 'code', label: 'Answer', error: '', saved: false });
  f.exit();
});

test('when openconnect stops on its own the reason is reported; stopping it says stopped', async () => {
  const f = fakeTunnel();
  await f.say('POST https://vpn.example.org/\r\nFailed to obtain WebVPN cookie\r\n');
  f.exit();
  assert.strictEqual(f.last().phase, 'failed');
  assert.strictEqual(f.last().reason, 'Failed to obtain WebVPN cookie');
  const g = fakeTunnel();
  g.t.stop();
  assert.deepStrictEqual(g.typed, ['\x03']);
  g.exit(0);
  assert.strictEqual(g.last().phase, 'stopped');
});
