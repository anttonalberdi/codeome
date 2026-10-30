const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const { EventEmitter } = require('events');

const calls = [];
const chatFile = require.resolve('../main/chat');
const codexFile = require.resolve('../main/codexchat');
const originalLoad = Module._load;
Module._load = function (name, parent, ...args) {
  if (name === 'child_process' && [chatFile, codexFile].includes(parent.filename)) return { spawn: (...call) => {
    calls.push(call);
    const proc = new EventEmitter();
    proc.stdin = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    return proc;
  } };
  return originalLoad.call(this, name, parent, ...args);
};
let Session, CodexSession;
try {
  ({ Session } = require('../main/chat'));
  ({ CodexSession } = require('../main/codexchat'));
} finally { Module._load = originalLoad; }

const prefix = ['taskpolicy', '-b', 'nice', '-n', '10'];

test('Claude session prefixes the spawn command only when requested', () => {
  const start = (options = {}) => {
    const session = new Session({ id: 'claude', cwd: '/project', shell: '/bin/sh', bin: '/bin/agent', args: ['--flag'], ...options });
    session.start();
    return calls.at(-1)[1];
  };
  assert.deepEqual(start({ prefix }), ['-l', '-c', 'exec taskpolicy -b nice -n 10 "$0" "$@"', '/bin/agent', '--flag']);
  assert.deepEqual(start({ prefix: [] }), ['-l', '-c', 'exec "$0" "$@"', '/bin/agent', '--flag']);
  assert.deepEqual(start(), ['-l', '-c', 'exec "$0" "$@"', '/bin/agent', '--flag']);
});

test('Codex session prefixes the spawn command only when requested', () => {
  const start = (options = {}) => {
    const session = new CodexSession({ id: 'codex', cwd: '/project', shell: '/bin/sh', bin: '/bin/agent', args: ['--flag'], ...options });
    session.boot = () => Promise.resolve();
    session.start();
    return calls.at(-1)[1];
  };
  assert.deepEqual(start({ prefix }), ['-l', '-c', 'exec taskpolicy -b nice -n 10 "$0" "$@"', '/bin/agent', '--flag', 'app-server']);
  assert.deepEqual(start({ prefix: [] }), ['-l', '-c', 'exec "$0" "$@"', '/bin/agent', '--flag', 'app-server']);
  assert.deepEqual(start(), ['-l', '-c', 'exec "$0" "$@"', '/bin/agent', '--flag', 'app-server']);
});
