const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Presence = require('../renderer/js/chat-presence');

const deps = {
  waiting: (chat) => Object.keys(chat.requests).length > 0,
  runningJobs: (chat) => chat.items.filter((it) => it.t === 'job' && ['running', 'pausing'].includes(it.status))
};
const chat = (items = []) => ({ id: 'chat-1', project: '/work/project', items, requests: {}, busy: false });

test('presence maps waiting, busy, running jobs, and idle states', () => {
  const c = chat();
  assert.equal(Presence.presenceOf(c, deps).state, 'idle');
  c.busy = true;
  assert.equal(Presence.presenceOf(c, deps).state, 'working');
  c.busy = false;
  c.items.push({ t: 'job', status: 'pausing', title: 'Specialist' });
  assert.equal(Presence.presenceOf(c, deps).state, 'working');
  c.requests.q = {};
  assert.equal(Presence.presenceOf(c, deps).state, 'waiting');
});

test('presence caps and cleans running job titles', () => {
  const c = chat(Array.from({ length: 7 }, (_, i) => ({ t: 'job', status: 'running', title: `Job ${i}\n\u0000` + 'x'.repeat(100) })));
  c.items.push({ t: 'job', status: 'done', title: 'Finished' });
  const result = Presence.presenceOf(c, deps);
  assert.equal(result.jobs.length, 5);
  assert.equal(result.jobs[0].length, 80);
  assert.match(result.jobs[0], /^Job 0 x+/);
  assert.ok(result.jobs.every((title) => !/[\x00-\x1f\x7f-\x9f]/.test(title)));
});

test('presence selects the latest plan and its first heading', () => {
  const c = chat([
    { t: 'perm', tool: 'ExitPlanMode', input: { plan: '# Old plan' } },
    { t: 'perm', tool: 'ExitPlanMode', input: { plan: 'Intro\n\n## New\tplan\u0007\nLater' } }
  ]);
  assert.equal(Presence.presenceOf(c, deps).plan_title, 'New plan');
  c.items.push({ t: 'perm', tool: 'ExitPlanMode', input: { plan: '\n  First\nAnother' } });
  assert.equal(Presence.presenceOf(c, deps).plan_title, 'First');
  c.items.push({ t: 'perm', tool: 'ExitPlanMode', input: { plan: '# ' + 'x'.repeat(210) } });
  assert.equal(Presence.presenceOf(c, deps).plan_title.length, 200);
});

test('presence uses only the first typed user text, never attachments', () => {
  const c = chat([
    { t: 'user', text: 'First\nrequest\u007f ' + 'a'.repeat(220), files: ['/private/source.txt'], contents: 'secret contents' },
    { t: 'user', text: 'Second request' }
  ]);
  const result = Presence.presenceOf(c, deps);
  assert.equal(result.first_request.length, 200);
  assert.match(result.first_request, /^First request a+/);
  assert.ok(!result.first_request.includes('source.txt'));
  assert.ok(!result.first_request.includes('secret contents'));
});

test('empty chat has bounded empty context', () => {
  assert.deepEqual(Presence.presenceOf(chat(), deps), {
    id: 'chat-1', project: '/work/project', state: 'idle', jobs: [], plan_title: '', first_request: ''
  });
});

test('presence removes bidi and tag Unicode before sending', () => {
  const c = chat([{ t: 'user', text: 'A\u202eB\u{e0001}' },
    { t: 'job', status: 'running', title: 'J\u202e\u{e0001}' },
    { t: 'perm', tool: 'ExitPlanMode', input: { plan: '# P\u202e\u{e0001}' } }]);
  const row = Presence.presenceOf(c, deps);
  assert.equal(row.first_request, 'A B');
  assert.equal(row.jobs[0], 'J');
  assert.equal(row.plan_title, 'P');
});

test('schedule defers payload creation until debounce and stops refresh after stopped reply', async () => {
  const timers = new Map();
  let next = 0, payloads = 0;
  const c = { running: true };
  const scheduler = Presence.createScheduler({
    getPayload: () => { payloads++; return { state: 'idle' }; },
    push: () => ({ ok: false }),
    setTimer: (fn) => { const id = ++next; timers.set(id, fn); return id; },
    clearTimer: (id) => timers.delete(id),
  });
  scheduler.schedule(c);
  scheduler.schedule(c);
  assert.equal(payloads, 0);
  const first = [...timers][0]; timers.delete(first[0]); first[1]();
  assert.equal(payloads, 1);
  c.running = false;
  await Promise.resolve();
  assert.equal(timers.size, 0);
});

test('scheduler debounces changes, dedupes pushes, refreshes, and cancels', () => {
  let time = 0, next = 0;
  const timers = new Map(), pushed = [];
  const setTimer = (fn, ms) => { const id = ++next; timers.set(id, { fn, at: time + ms }); return id; };
  const clearTimer = (id) => timers.delete(id);
  const advance = (ms) => {
    const end = time + ms;
    while (true) {
      const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      time = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }
    time = end;
  };
  const c = { state: 'idle' };
  const scheduler = Presence.createScheduler({ getPayload: (value) => ({ state: value.state }), push: (payload) => pushed.push(payload.state),
    now: () => time, setTimer, clearTimer });
  scheduler.schedule(c);
  advance(300);
  c.state = 'working'; scheduler.schedule(c);
  advance(499);
  assert.deepEqual(pushed, []);
  advance(1);
  assert.deepEqual(pushed, ['working']);
  scheduler.schedule(c);
  advance(600);
  assert.deepEqual(pushed, ['working']);
  c.state = 'waiting'; scheduler.schedule(c);
  advance(500);
  assert.deepEqual(pushed, ['working', 'waiting']);
  advance(120000);
  assert.deepEqual(pushed, ['working', 'waiting', 'waiting']);
  scheduler.cancel(c);
  advance(240000);
  assert.equal(pushed.length, 3);
  assert.equal(timers.size, 0);
});

test('renderer reports a background project chat and stops after project close', () => {
  let onEvent, next = 0;
  const timers = new Map(), pushed = [];
  const setTimer = (fn) => { const id = ++next; timers.set(id, fn); return id; };
  const clearTimer = (id) => timers.delete(id);
  const App = { h() {}, project: '/foreground', chatPresence: {
    ...Presence, createScheduler: (opts) => Presence.createScheduler({ ...opts, setTimer, clearTimer })
  }, views: {}, cfg: {}, emit() {} };
  const codeome = { chat: {
    onEvent: (fn) => { onEvent = fn; }, onExit() {}, stop() {},
    presence: (payload) => { pushed.push(payload); return { ok: true }; }
  } };
  const source = fs.readFileSync(path.join(__dirname, '../renderer/js/chat.js'), 'utf8');
  vm.runInNewContext(source, { App, codeome, setTimeout: setTimer, clearTimeout: clearTimer });
  const C = App.views.chat;
  const background = { id: 'other', project: '/background', started: true, running: true, busy: false,
    items: [{ t: 'user', text: 'Inspect files' }], requests: {}, collisions: [], collisionTimer: null };
  C.byId[background.id] = background;
  C.byProject[background.project] = { tabs: [background], active: background };
  background.running = false;
  onEvent({ id: background.id, msg: { type: 'system', subtype: 'init' } });
  assert.equal(timers.size, 0);
  background.running = true;
  onEvent({ id: background.id, msg: { type: 'unrelated_delta', text: '' } });
  assert.equal(timers.size, 0);
  onEvent({ id: background.id, msg: { type: 'system', subtype: 'init' } });
  for (const [id, fn] of [...timers]) { timers.delete(id); fn(); }
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].project, '/background');
  assert.equal(pushed[0].state, 'working');
  C.closeProject(background.project);
  assert.equal(timers.size, 0);
});
