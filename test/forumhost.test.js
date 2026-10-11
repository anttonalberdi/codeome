const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CODEOME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forumhost-home-'));
const { createHost } = require('../main/forumhost');
const store = require('../main/forumstore');
const chat = require('../main/chat');

const tick = async () => { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)); };
class FakeSession extends EventEmitter {
  constructor(seat) { super(); this.seat = seat; this.sent = []; this.controls = []; this.stopped = false; }
  start() { this.started = true; }
  user(text) { this.sent.push(text); }
  control(request) { this.controls.push(request); return Promise.resolve({}); }
  stop() { this.stopped = true; }
  reply(text) {
    this.emit('message', { type: 'assistant', message: { content: [{ type: 'text', text }] } });
    this.emit('message', { type: 'result' });
  }
}
function harness(extra = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'forumhost-project-'));
  const cfg = { forum: { defaultBudget: 0, summaryTokens: 6000, recentMessages: 8,
    checkModel: 'haiku', codexCheckModel: '', checkEffort: 'low', checkTimeoutMs: 30000 },
  accounts: { claude: { list: [{ name: 'claude-account', dir: '/claude-account' }] },
    codex: { list: [{ name: 'codex-account', dir: '/codex-account' }] } } };
  const handlers = new Map(), events = [], sessions = [], checks = [], selections = [], records = [];
  const host = createHost({ getCfg: () => cfg, send: (channel, payload) => events.push({ channel, payload }), idleMs: extra.idleMs,
    makeAgentSession: (seat, folder) => {
      assert.equal(folder, project);
      const session = new FakeSession(seat);
      session.resumedAtStart = !!seat.started; session.idAtStart = seat.sessionId;
      sessions.push(session); return session;
    },
    claudeCmd: () => '/bin/claude --model custom', codexCmd: () => '/bin/codex',
    launchOn: (engine, requested, command) => {
      selections.push({ engine, requested, command });
      return { info: { name: `${engine}-account` }, env: {}, unset: [] };
    },
    stats: { record: (entry) => records.push(entry) }, store,
    oneShot: (engine, options) => {
      checks.push({ engine, options });
      return Promise.resolve({ text: engine === 'claude' ? 'raise: new point' : 'pass', usage: { input_tokens: 2 } });
    } });
  host.register({ handle: (name, fn) => handlers.set(name, fn) });
  const invoke = (name, payload) => handlers.get(name)(null, payload);
  return { project, cfg, host, handlers, invoke, events, sessions, checks, selections, records };
}

test('create, post, allow, stats, save/open, and delete flow through IPC', async () => {
  const h = harness();
  const created = await h.invoke('forum:create', { project: h.project, title: 'Discussion' });
  assert.equal(created.ok, true);
  const { id, seats } = created.forum;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(seats.map((seat) => seat.id), ['claude-1', 'codex-1']);
  assert.ok(seats.every((seat) => /^[0-9a-f-]{36}$/.test(seat.sessionId)));
  assert.deepEqual(seats.map((seat) => seat.account), ['claude-account', 'codex-account']);
  assert.deepEqual(seats.map((seat) => seat.bin), ['/bin/claude', '/bin/codex']);
  assert.deepEqual(seats.map((seat) => seat.dir), ['/claude-account', '/codex-account']);
  assert.ok(h.selections.every((one) => one.requested === 'auto'));
  assert.equal((await h.invoke('forum:post', { id, text: 'What should we do?' })).ok, true);
  await tick();
  assert.ok(h.events.some((one) => one.channel === 'forum:event' && one.payload.id === id && one.payload.event.type === 'message'));
  assert.ok(h.events.some((one) => one.payload.event.type === 'hand'));
  const hand = h.host.forums.get(id).hands[0];
  assert.equal((await h.invoke('forum:allow', { id, handId: hand.id })).ok, true);
  await tick();
  assert.equal(h.sessions.length, 1);
  assert.equal(h.sessions[0].started, true);
  assert.equal(h.sessions[0].controls[0].mode, 'plan');
  h.sessions[0].emit('turn', { input: 7, output: 3, costUsd: 0.01 });
  h.sessions[0].reply('An answer');
  await tick();
  assert.equal(h.records.length, 1);
  assert.deepEqual({ session: h.records[0].session, project: h.records[0].project, account: h.records[0].account,
    engine: h.records[0].engine, forum: h.records[0].forum, seat: h.records[0].seat },
  { session: seats[0].sessionId, project: h.project, account: 'claude-account', engine: 'claude', forum: id, seat: 'claude-1' });
  const doc = path.join(h.project, 'notes.md'); fs.writeFileSync(doc, 'local text');
  assert.equal((await h.invoke('forum:attachDoc', { id, file: doc })).doc.kind, 'md');
  assert.equal((await h.invoke('forum:rename', { id, title: 'Renamed' })).forum.title, 'Renamed');
  h.host.disposeAll();
  assert.ok(h.sessions.every((session) => session.stopped));
  const saved = store.load(h.project, id);
  assert.equal(saved.title, 'Renamed');
  assert.equal(saved.doc.text, undefined);
  assert.equal(saved.doc.path, fs.realpathSync(doc));
  assert.equal(saved.usage['claude-1'].turns, 1);
  assert.equal(saved.seats[0].started, true);
  assert.equal(chat.listChats(h.project).length, 0);
  assert.equal((await h.invoke('forum:list', h.project)).forums[0].id, id);
  const opened = await h.invoke('forum:open', { project: h.project, id });
  assert.equal(opened.forum.doc.text, undefined);
  assert.equal(h.host.forums.get(id).doc.text, 'local text');
  assert.equal((await h.invoke('forum:open', { project: h.project, id })).ok, true);
  assert.equal((await h.invoke('forum:delete', { project: h.project, id })).ok, true);
  assert.equal(store.load(h.project, id), null);
  h.host.disposeAll();
});

test('per-forum settings override checks and survive a flushed reopen', async () => {
  const h = harness();
  const { forum } = await h.invoke('forum:create', { project: h.project });
  const id = forum.id;
  const changed = await h.invoke('forum:setSettings', { id, settings: { defaultBudget: 2, summaryTokens: 2500, recentMessages: 3 } });
  assert.equal(changed.settings.summaryTokens, 2500);
  assert.equal((await h.invoke('forum:setBudget', { id, n: 4 })).budget, 4);
  assert.equal((await h.invoke('forum:post', { id, text: 'New topic' })).ok, true);
  await tick();
  assert.equal(h.checks.length, 2);
  const claude = h.checks.find((one) => one.engine === 'claude').options;
  const codex = h.checks.find((one) => one.engine === 'codex').options;
  assert.equal(claude.model, 'haiku');
  assert.equal(codex.model, '');
  assert.equal(claude.effort, 'low');
  assert.equal(claude.timeoutMs, 30000);
  assert.equal(claude.cwd, process.env.CODEOME_HOME);
  assert.equal(claude.dir, '/claude-account');
  assert.equal(claude.strictMcp, true);
  assert.equal(h.host.forums.get(id).settings.recentMessages, 3);
  h.host.disposeAll();
  const record = store.load(h.project, id);
  assert.equal(record.settings.defaultBudget, 4);
  assert.equal(record.settings.summaryTokens, 2500);
  const reopened = await h.invoke('forum:open', { project: h.project, id });
  assert.equal(reopened.ok, true);
  assert.equal(h.host.forums.get(id).settings.defaultBudget, 4);
  assert.equal(h.host.forums.get(id).settings.summaryTokens, 2500);
  h.host.disposeAll();
});

test('validation rejects bad projects, ids, paths, and oversized text', async () => {
  const h = harness();
  assert.match((await h.invoke('forum:create', { project: '/missing/project' })).error, /Project folder/);
  const { forum } = await h.invoke('forum:create', { project: h.project });
  const id = forum.id;
  assert.match((await h.invoke('forum:open', { project: h.project, id: '../bad' })).error, /Bad forum id/);
  assert.match((await h.invoke('forum:delete', { project: h.project, id: '../bad' })).error, /Bad forum id/);
  assert.match((await h.invoke('forum:post', { id: '../bad', text: 'hi' })).error, /Bad forum id/);
  assert.match((await h.invoke('forum:attachDoc', { id, file: 'relative.md' })).error, /absolute/);
  assert.match((await h.invoke('forum:post', { id, text: 'x'.repeat(20001) })).error, /20,000/);
  assert.match((await h.invoke('forum:grantWrite', { id, seatId: 'claude-1', instruction: 'x'.repeat(20001) })).error, /20,000/);
  assert.equal((await h.invoke('forum:mute', { id, seatId: 'codex-1', muted: true })).ok, true);
  assert.equal((await h.invoke('forum:stop', { id })).ok, true);
  h.host.disposeAll();
});

test('state changes are saved after the debounce without closing the forum', async () => {
  const h = harness();
  const { forum } = await h.invoke('forum:create', { project: h.project });
  await h.invoke('forum:post', { id: forum.id, text: 'Keep this message' });
  await tick();
  assert.equal(store.load(h.project, forum.id).transcript.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 950));
  assert.equal(store.load(h.project, forum.id).transcript[0].text, 'Keep this message');
  h.host.disposeAll();
});

test('a seat is resumable only after a completed turn, and a failed resume gets a new id', async () => {
  const h = harness();
  const { forum } = await h.invoke('forum:create', { project: h.project });
  const live = h.host.forums.get(forum.id);
  await h.invoke('forum:post', { id: forum.id, text: 'first' }); await tick();
  await h.invoke('forum:allow', { id: forum.id, handId: live.hands[0].id }); await tick();
  assert.equal(live.seat('claude-1').started, undefined);
  h.sessions[0].reply('first answer'); await tick();
  assert.equal(live.seat('claude-1').started, true);
  h.sessions[0].emit('exit', {}); await tick();
  await h.invoke('forum:post', { id: forum.id, text: 'second' }); await tick();
  await h.invoke('forum:allow', { id: forum.id, handId: live.hands[0].id }); await tick();
  assert.equal(h.sessions[1].resumedAtStart, true);
  const oldId = h.sessions[1].idAtStart;
  h.sessions[1].emit('exit', {}); await tick();
  assert.equal(live.seat('claude-1').started, false);
  assert.notEqual(live.seat('claude-1').sessionId, oldId);
  h.sessions[1].emit('turn', { input: 9 });
  assert.equal(live.seat('claude-1').started, false);
  await h.invoke('forum:post', { id: forum.id, text: 'third' }); await tick();
  await h.invoke('forum:allow', { id: forum.id, handId: live.hands[0].id }); await tick();
  assert.equal(h.sessions[2].resumedAtStart, false);
  assert.equal(h.sessions[2].idAtStart, live.seat('claude-1').sessionId);
  h.host.disposeAll();
});

test('close flushes and disposes a forum; reopen restores it, and idle forums close', async () => {
  const h = harness({ idleMs: 80 });
  const { forum } = await h.invoke('forum:create', { project: h.project });
  const live = h.host.forums.get(forum.id);
  await h.invoke('forum:post', { id: forum.id, text: 'saved' }); await tick();
  await h.invoke('forum:allow', { id: forum.id, handId: live.hands[0].id }); await tick();
  assert.equal((await h.invoke('forum:close', { id: forum.id })).ok, true);
  assert.equal(h.host.forums.has(forum.id), false);
  assert.ok(h.sessions[0].stopped);
  assert.equal(store.load(h.project, forum.id).transcript[0].text, 'saved');
  assert.equal((await h.invoke('forum:open', { project: h.project, id: forum.id })).ok, true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(h.host.forums.has(forum.id), false);
  h.host.disposeAll();
});

test('idle cleanup waits for an active seat turn to finish', async () => {
  const h = harness({ idleMs: 30 });
  const { forum } = await h.invoke('forum:create', { project: h.project });
  const live = h.host.forums.get(forum.id);
  await h.invoke('forum:post', { id: forum.id, text: 'topic' }); await tick();
  await h.invoke('forum:allow', { id: forum.id, handId: live.hands[0].id }); await tick();
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(h.host.forums.has(forum.id), true);
  h.sessions[0].reply('done'); await tick();
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(h.host.forums.has(forum.id), false);
  h.host.disposeAll();
});

test('host validates labels and clamps a saved budget on reopen', async () => {
  const h = harness();
  assert.match((await h.invoke('forum:create', { project: h.project, title: 1 })).error, /Forum title/);
  assert.match((await h.invoke('forum:create', { project: h.project, seats: [{ engine: 'claude', name: 'x'.repeat(81) }] })).error, /Seat name/);
  assert.match((await h.invoke('forum:create', { project: h.project, seats: [{ engine: 'claude', persona: 'x'.repeat(501) }] })).error, /Seat persona/);
  const { forum } = await h.invoke('forum:create', { project: h.project });
  await h.invoke('forum:close', { id: forum.id });
  const record = store.load(h.project, forum.id);
  store.save(h.project, { ...record, budget: 99, budgetLimit: 99, settings: { defaultBudget: 2 } });
  const opened = await h.invoke('forum:open', { project: h.project, id: forum.id });
  assert.equal(opened.forum.budget, 2);
  assert.equal(opened.forum.budgetLimit, 2);
  h.host.disposeAll();
});
