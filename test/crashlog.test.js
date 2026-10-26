const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crashlog = require('../main/crashlog');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-crashlog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const session = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));

test('first run has no previous session; init records a start', (t) => {
  const dir = path.join(tmp(t), 'logs');
  assert.strictEqual(crashlog.previousRun(dir), null);
  crashlog.init({ dir, version: '1.2.3' });
  const s = session(dir);
  assert.strictEqual(s.version, '1.2.3');
  assert.strictEqual(s.pid, process.pid);
  assert.strictEqual(s.clean, false);
  assert.ok(s.sessionId);
  assert.ok(!Number.isNaN(Date.parse(s.startedAt)));
  assert.strictEqual(s.lastBeat, s.startedAt);
  assert.strictEqual(crashlog.logPath(), path.join(dir, 'main.log'));
  assert.match(crashlog.tail(1)[0], /\[info\] start.*1\.2\.3/);
  assert.match(crashlog.tail(1)[0], new RegExp(s.sessionId));
});

test('unclean session is reported with the last 60 log lines', (t) => {
  const dir = tmp(t);
  crashlog.init({ dir, version: '2.0.0' });
  for (let i = 0; i < 70; i++) crashlog.log('info', `line ${i}`);
  const previous = crashlog.previousRun(dir);
  assert.strictEqual(previous.abnormal, true);
  assert.strictEqual(previous.version, '2.0.0');
  assert.strictEqual(previous.pid, process.pid);
  assert.strictEqual(previous.startedAt, session(dir).startedAt);
  assert.strictEqual(previous.lastBeat, session(dir).lastBeat);
  assert.strictEqual(previous.tail.length, 60);
  assert.match(previous.tail[0], /line 10$/);
  assert.match(previous.tail[59], /line 69$/);
});

test('a live recent second instance is not mistaken for a crash', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'session.json');
  const previous = { sessionId: 'another', pid: process.ppid, version: '2.0.0', startedAt: new Date().toISOString(), lastBeat: new Date().toISOString(), clean: false };
  fs.writeFileSync(file, JSON.stringify(previous));
  assert.deepStrictEqual(crashlog.previousRun(dir), {
    abnormal: false, other: true, lastBeat: previous.lastBeat, startedAt: previous.startedAt,
    version: previous.version, pid: previous.pid, tail: []
  });
  previous.lastBeat = new Date(Date.now() - 91000).toISOString();
  fs.writeFileSync(file, JSON.stringify(previous));
  assert.strictEqual(crashlog.previousRun(dir).abnormal, true);
});

test('heartbeat replaces stats without changing session identity or clean state', (t) => {
  const dir = tmp(t);
  crashlog.init({ dir, version: '2.0.0' });
  const original = session(dir);
  crashlog.heartbeat({ memory: 123, sessionId: 'foreign', pid: 1, version: 'bad', startedAt: 'bad', clean: true });
  const first = session(dir);
  for (const key of ['sessionId', 'pid', 'version', 'startedAt']) assert.strictEqual(first[key], original[key]);
  assert.strictEqual(first.clean, false);
  assert.strictEqual(first.stats.memory, 123);
  assert.strictEqual(first.memory, undefined);
  crashlog.heartbeat({ mem: [{ type: 'Browser', pid: process.pid, workingSetSize: 100 }] });
  assert.deepStrictEqual(session(dir).stats, { mem: [{ type: 'Browser', pid: process.pid, workingSetSize: 100 }] });
  assert.ok(!Number.isNaN(Date.parse(session(dir).lastBeat)));
  crashlog.markClean();
  assert.strictEqual(session(dir).clean, true);
  crashlog.heartbeat({ memory: 456, clean: false });
  assert.strictEqual(session(dir).clean, true);
  assert.deepStrictEqual(session(dir).stats, { memory: 456, clean: false });
  assert.strictEqual(crashlog.previousRun(dir).abnormal, false);
  assert.match(crashlog.tail(1)[0], /\[info\] clean exit$/);
});

test('a different session owner prevents heartbeat and clean writes', (t) => {
  const dir = tmp(t);
  crashlog.init({ dir, version: '2.0.0' });
  const foreign = { ...session(dir), sessionId: 'another-instance', clean: false };
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(foreign));
  crashlog.heartbeat({ memory: 123 });
  crashlog.markClean();
  assert.deepStrictEqual(session(dir), foreign);
  assert.match(crashlog.tail(1)[0], /\[info\] clean exit$/);
});

test('corrupt or unreadable session file is treated as an abnormal exit', (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'main.log'), 'last log line\n');
  fs.writeFileSync(path.join(dir, 'session.json'), '{bad json');
  assert.deepStrictEqual(crashlog.previousRun(dir), {
    abnormal: true, corrupt: true, tail: ['last log line']
  });
  const unreadable = tmp(t);
  fs.mkdirSync(path.join(unreadable, 'session.json'));
  assert.deepStrictEqual(crashlog.previousRun(unreadable), {
    abnormal: true, corrupt: true, tail: []
  });
});

test('circular extra is logged safely', (t) => {
  const dir = tmp(t);
  crashlog.init({ dir, version: '2.0.0' });
  const extra = { detail: 'hello' };
  extra.self = extra;
  assert.doesNotThrow(() => crashlog.log('warn', 'circular', extra));
  assert.match(crashlog.tail(1)[0], /\[warn\] circular \{"detail":"hello","self":"\[Circular\]"\}$/);
  crashlog.logError('failed', new Error('broken'));
  assert.match(fs.readFileSync(crashlog.logPath(), 'utf8'), /\[error\] failed: broken\nError: broken/);
});

test('logs redact named secrets, token formats, and current environment values', (t) => {
  const dir = tmp(t);
  crashlog.init({ dir, version: '2.0.0' });
  const name = 'CODEOME_CRASHLOG_TEST_TOKEN';
  const old = process.env[name];
  process.env[name] = 'envfixture12345';
  t.after(() => { if (old === undefined) delete process.env[name]; else process.env[name] = old; });
  crashlog.log('error', 'token=fixturevalue,more password:anothersecret Bearer abcdefgh123 sk-abcdefghij ghp_abcdefghij envfixture12345',
    { secret: 'nested fixture with spaces', note: 'authorization=fixtureauth' });
  crashlog.logError('failure', new Error('key=stackfixture\nBearer stackfixture123'));
  const result = fs.readFileSync(crashlog.logPath(), 'utf8');
  for (const value of ['fixturevalue,more', 'anothersecret', 'abcdefgh123', 'sk-abcdefghij', 'ghp_abcdefghij', 'envfixture12345', 'nested fixture with spaces', 'fixtureauth', 'stackfixture123']) {
    assert.ok(!result.includes(value), value);
  }
  assert.match(result, /\[redacted\]/);
});

test('non-stack message newlines are collapsed and non-Errors are stringified', (t) => {
  const dir = tmp(t);
  crashlog.init({ dir, version: '2.0.0' });
  crashlog.log('warn', 'first\n[error] forged');
  assert.match(crashlog.tail(1)[0], /first ⏎ \[error\] forged$/);
  crashlog.logError('rejection', { reason: 'broken' });
  assert.match(crashlog.tail(1)[0], /rejection: \{"reason":"broken"\}$/);
  crashlog.logError('failure', new Error('bad\n[error] forged'));
  assert.match(fs.readFileSync(crashlog.logPath(), 'utf8'), /\[error\] failure: bad ⏎ \[error\] forged\nError: bad/);
});

test('init rotates a full log and keeps three backups', (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'main.log'), 'x'.repeat(1024 * 1024));
  for (let i = 1; i <= 3; i++) fs.writeFileSync(path.join(dir, `main.log.${i}`), `old ${i}`);
  crashlog.init({ dir, version: '2.0.0' });
  assert.strictEqual(fs.statSync(path.join(dir, 'main.log.1')).size, 1024 * 1024);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'main.log.2'), 'utf8'), 'old 1');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'main.log.3'), 'utf8'), 'old 2');
  assert.match(fs.readFileSync(path.join(dir, 'main.log'), 'utf8'), /start/);
  fs.writeFileSync(path.join(dir, 'main.log'), 'y'.repeat(1024 * 1024));
  crashlog.log('info', 'fourth rotation');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'main.log.1'), 'utf8')[0], 'y');
  assert.strictEqual(fs.statSync(path.join(dir, 'main.log.2')).size, 1024 * 1024);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'main.log.3'), 'utf8'), 'old 1');
});

test('a write crossing 1 MB rotates before appending', (t) => {
  const dir = tmp(t);
  crashlog.init({ dir, version: '2.0.0' });
  fs.writeFileSync(path.join(dir, 'main.log'), 'x'.repeat(1024 * 1024 - 20));
  crashlog.log('error', 'after rotation');
  assert.strictEqual(fs.statSync(path.join(dir, 'main.log.1')).size, 1024 * 1024 - 20);
  assert.match(crashlog.tail(1)[0], /\[error\] after rotation$/);
});

test('redact masks the whole Authorization: Bearer value', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-crashlog-'));
  try {
    crashlog.init({ dir, version: 't' });
    crashlog.log('error', 'Authorization: Bearer abc123def456 failed');
    const text = fs.readFileSync(path.join(dir, 'main.log'), 'utf8');
    assert.ok(!text.includes('abc123def456'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
