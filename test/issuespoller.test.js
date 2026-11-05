const test = require('node:test');
const assert = require('node:assert/strict');
const { createIssuesPoller } = require('../main/issuespoller');

function fixture() {
  let time = 100000;
  let nextTimer = 0;
  const timers = new Map();
  const cfg = { issues: { enabled: true, pollMinutes: 10 }, projectIssues: {
    '/one': { enabled: true }, '/two': { enabled: true } } };
  const polls = [], changes = [], errors = [], triage = [];
  const store = {
    pollState: (project) => ({ project }),
    applyPoll: (project, result) => { changes.push(['apply', project]); return result.changes || { added: [], reopened: [] }; }
  };
  let poll = async (project) => { polls.push(project); return {}; };
  const poller = createIssuesPoller({ store, poll: (...args) => poll(...args), getConfig: () => cfg,
    projects: () => ['/one', '/two'], now: () => time,
    setTimer: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimer: (id) => timers.delete(id),
    onChange: (project, change) => changes.push([project, change]),
    onError: (project, error) => errors.push([project, error]),
    triageHook: (project, added) => triage.push([project, added]) });
  return { poller, cfg, store, polls, changes, errors, triage, timers,
    setPoll: (fn) => { poll = fn; }, advance: (ms) => { time += ms; } };
}

test('polls in one serial queue and coalesces an active project', async () => {
  const f = fixture();
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  f.setPoll(async (project) => { f.polls.push(project); if (project === '/one') await first; return {}; });
  const a = f.poller.refresh('/one');
  const duplicate = f.poller.refresh('/one');
  const b = f.poller.refresh('/two');
  assert.strictEqual(duplicate, a);
  await Promise.resolve();
  assert.deepEqual(f.polls, ['/one']);
  release();
  await Promise.all([a, b]);
  assert.deepEqual(f.polls, ['/one', '/two']);
});

test('focus refresh debounces for 30 seconds and force bypasses the cooldown', async () => {
  const f = fixture();
  await f.poller.refresh('/one');
  f.advance(29999);
  await f.poller.refresh('/one');
  assert.equal(f.polls.length, 1);
  await f.poller.refresh('/one', { force: true });
  assert.equal(f.polls.length, 2);
  f.advance(30000);
  await f.poller.refresh('/one');
  assert.equal(f.polls.length, 3);
});

test('forced refresh is limited to once per five seconds per project', async () => {
  const f = fixture();
  await f.poller.refresh('/one', { force: true });
  await f.poller.refresh('/one', { force: true });
  f.advance(4999);
  await f.poller.refresh('/one', { force: true });
  assert.deepEqual(f.polls, ['/one']);
  await f.poller.refresh('/two', { force: true });
  f.advance(1);
  await f.poller.refresh('/one', { force: true });
  assert.deepEqual(f.polls, ['/one', '/two', '/one']);
});

test('retry hints are clamped before they enter backoff or error state', async () => {
  const f = fixture();
  f.setPoll(async () => ({ error: { code: 'limited', retryAfterMs: 1e12 } }));
  await f.poller.refresh('/one');
  assert.strictEqual(f.poller.lastError('/one').retryAfterMs, 3600000);
  f.advance(3600000);
  await f.poller.refresh('/one', { force: true });
  assert.strictEqual(f.poller.lastError('/one').retryAfterMs, 3600000);
});

test('global and project switches prevent polling, including work queued before disable', async () => {
  const f = fixture();
  f.cfg.issues.enabled = false;
  await f.poller.refresh('/one', { force: true });
  f.cfg.issues.enabled = true;
  f.cfg.projectIssues['/one'].enabled = false;
  await f.poller.refresh('/one', { force: true });
  assert.deepEqual(f.polls, []);
  let release;
  f.setPoll(async (project) => { f.polls.push(project); if (project === '/two') await new Promise((resolve) => { release = resolve; }); return {}; });
  const active = f.poller.refresh('/two');
  await Promise.resolve();
  f.cfg.projectIssues['/one'].enabled = true;
  const queued = f.poller.refresh('/one');
  f.cfg.projectIssues['/one'].enabled = false;
  release();
  await Promise.all([active, queued]);
  assert.deepEqual(f.polls, ['/two']);
});

test('retry hint and exponential fallback delay later polls', async () => {
  const f = fixture();
  let attempts = 0;
  f.setPoll(async () => {
    attempts++;
    if (attempts === 1) return { error: { code: 'limited', message: 'Wait', retryAfterMs: 90000 } };
    if (attempts < 4) return { error: { code: 'network', message: 'Offline' } };
    return {};
  });
  await f.poller.refresh('/one');
  f.advance(89999);
  await f.poller.refresh('/one', { force: true });
  assert.equal(attempts, 1);
  f.advance(1);
  await f.poller.refresh('/one');
  assert.equal(attempts, 2);
  f.advance(30000);
  await f.poller.refresh('/one');
  assert.equal(attempts, 3);
  f.advance(59999);
  await f.poller.refresh('/one');
  assert.equal(attempts, 3);
  f.advance(1);
  await f.poller.refresh('/one');
  assert.equal(attempts, 4);
  assert.equal(f.poller.lastError('/one'), null);
});

test('reports changes only for added or reopened items and triages additions', async () => {
  const f = fixture();
  const results = [{ changes: { added: [], reopened: [] } },
    { changes: { added: [1], reopened: [] } }, { changes: { added: [], reopened: [2] } }];
  f.setPoll(async () => results.shift());
  for (let i = 0; i < 3; i++) { await f.poller.refresh('/one', { force: true }); f.advance(5000); }
  assert.deepEqual(f.changes.filter(([key]) => key === '/one'), [
    ['/one', { added: [1], reopened: [] }], ['/one', { added: [], reopened: [2] }]
  ]);
  assert.deepEqual(f.triage, [['/one', [1]]]);
});

test('reports each distinct error once and silently skips unbound projects', async () => {
  const f = fixture();
  const results = [null, { error: { code: 'network', message: 'Offline' } },
    { error: { code: 'network', message: 'Offline' } }, { error: { code: 'auth', message: 'Denied' } }];
  f.setPoll(async () => results.shift());
  await f.poller.refresh('/one', { force: true });
  f.advance(5000);
  await f.poller.refresh('/one', { force: true });
  f.advance(30000);
  await f.poller.refresh('/one', { force: true });
  f.advance(60000);
  await f.poller.refresh('/one', { force: true });
  assert.deepEqual(f.errors.map(([, error]) => error.code), ['network', 'auth']);
  assert.equal(f.changes.length, 0);
});

test('timer reads the current interval each cycle and stop clears it', async () => {
  const f = fixture();
  f.cfg.issues.pollMinutes = 1;
  f.poller.start();
  assert.equal([...f.timers.values()][0].delay, 120000);
  f.cfg.issues.pollMinutes = 3;
  const timer = [...f.timers.values()][0];
  f.timers.clear();
  timer.fn();
  await new Promise(setImmediate);
  assert.equal([...f.timers.values()][0].delay, 180000);
  f.poller.stop();
  assert.equal(f.timers.size, 0);
});

test('poll rejection resolves without throwing and becomes a deduplicated error', async () => {
  const f = fixture();
  f.setPoll(async () => { throw new Error('private failure'); });
  assert.equal(await f.poller.refresh('/one'), null);
  assert.equal(f.errors.length, 1);
  assert.deepEqual(f.poller.lastError('/one'), { code: 'poll_failed', message: 'Could not poll GitHub issues.' });
  f.advance(30000);
  await f.poller.refresh('/one', { force: true });
  assert.equal(f.errors.length, 1);
});
