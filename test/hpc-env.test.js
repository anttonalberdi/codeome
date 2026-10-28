const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../main/config');
const ssh = require('../main/ssh');
const { Session } = require('../main/chat');
const { CodexSession } = require('../main/codexchat');

const engines = [Session, CodexSession];
const keys = ['CODEOME_HPC_HOST', 'CODEOME_HPC_SOCKET'];

function session(SessionType, host, env) {
  const load = config.load;
  config.load = () => ({ hpc: { host } });
  try { return new SessionType({ id: 'hpc-env', env }); }
  finally { config.load = load; }
}

test('Claude exports the trimmed HPC host and control socket; Codex omits them', () => {
  const env = { KEEP: 'unchanged', CODEOME_HPC_HOST: 'stale', CODEOME_HPC_SOCKET: 'stale' };
  assert.deepEqual(session(Session, '  user@login.cluster-1.org  ', env).env,
    { KEEP: 'unchanged', CODEOME_HPC_HOST: 'user@login.cluster-1.org', CODEOME_HPC_SOCKET: ssh.CONTROL_PATH });
  assert.deepEqual(session(CodexSession, '  user@login.cluster-1.org  ', env).env, { KEEP: 'unchanged' });
  assert.deepEqual(env, { KEEP: 'unchanged', CODEOME_HPC_HOST: 'stale', CODEOME_HPC_SOCKET: 'stale' });
});

test('both chat engines omit HPC variables without a valid host', () => {
  for (const SessionType of engines) {
    for (const host of [undefined, '', '-oProxyCommand=x', 'a b', 'host;rm', 'a'.repeat(300)]) {
      const s = session(SessionType, host, { KEEP: 'unchanged', CODEOME_HPC_HOST: 'stale', CODEOME_HPC_SOCKET: 'stale' });
      assert.deepEqual(s.env, { KEEP: 'unchanged' });
      for (const key of keys) assert.equal(Object.hasOwn(s.env, key), false);
    }
  }
});

test('both chat engines remove inherited HPC variables when no host is configured', () => {
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.CODEOME_HPC_HOST = 'inherited';
    process.env.CODEOME_HPC_SOCKET = 'inherited';
    for (const SessionType of engines) {
      const s = session(SessionType, '  ');
      for (const key of keys) assert.equal(Object.hasOwn(s.env, key), false);
      assert.equal(s.env.PATH, process.env.PATH);
    }
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
