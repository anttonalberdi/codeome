const test = require('node:test');
const assert = require('node:assert');
const { createIssueStore } = require('../main/issuestore');

const FILE = '/tmp/issues.json';
const PROJECT = '/work/one';
const CREATED = '2026-11-05T12:00:00.000Z';

function memoryFs() {
  const files = new Map();
  const modes = new Map();
  const writeModes = [];
  const calls = [];
  const missing = () => Object.assign(new Error('Missing file'), { code: 'ENOENT' });
  const fs = {
    statSync(file) { if (!files.has(file)) throw missing(); return { size: Buffer.byteLength(files.get(file)) }; },
    readFileSync(file) { if (!files.has(file)) throw missing(); return files.get(file); },
    writeFileSync(file, value, options) {
      calls.push(['write', file]);
      files.set(file, value);
      modes.set(file, options?.mode);
      if (file.endsWith('.tmp')) writeModes.push(options?.mode);
    },
    renameSync(from, to) {
      calls.push(['rename', from, to]);
      if (!files.has(from)) throw missing();
      files.set(to, files.get(from));
      files.delete(from);
      modes.set(to, modes.get(from));
      modes.delete(from);
    },
    chmodSync(file, mode) { calls.push(['chmod', file]); modes.set(file, mode); },
    mkdirSync() {}
  };
  return { fs, files, modes, calls, writeModes };
}

function issue(number, changes = {}) {
  return { number, title: `Issue ${number}`, body: 'Initial body', author: 'human',
    authorAssociation: 'MEMBER', labels: ['bug'], url: `https://github.com/o/r/issues/${number}`,
    createdAt: CREATED, updatedAt: CREATED, state: 'open', ...changes };
}

function setup() {
  const disk = memoryFs();
  let time = Date.parse(CREATED);
  const now = () => time;
  const store = createIssueStore({ file: FILE, fs: disk.fs, now });
  return { ...disk, store, now, advance(ms) { time += ms; } };
}

test('enable seeds the poll state, and status changes survive a round trip', () => {
  const { fs, store, now } = setup();
  assert.deepStrictEqual(store.pollState(PROJECT), { etag: null, enabledAt: null, lastSeen: {}, seenNumbers: [] });
  store.enable(PROJECT);
  assert.strictEqual(store.pollState(PROJECT).enabledAt, new Date(now()).toISOString());
  assert.deepStrictEqual(store.list(PROJECT), []);
  assert.deepStrictEqual(store.applyPoll(PROJECT, { etag: '"v1"', new: [issue(1)], updated: [] }),
    { added: [1], reopened: [] });
  assert.deepStrictEqual(store.pollState(PROJECT).seenNumbers, [1]);
  assert.strictEqual(store.pollState(PROJECT).lastSeen[1], CREATED);
  store.setStatus(PROJECT, 1, 'in-progress', { chat: 'chat-1' });
  const loaded = createIssueStore({ file: FILE, fs, now });
  assert.strictEqual(loaded.list(PROJECT)[0].chat, 'chat-1');
  assert.strictEqual(loaded.pollState(PROJECT).etag, '"v1"');
  loaded.disable(PROJECT);
  assert.deepStrictEqual(loaded.list(PROJECT), []);
  loaded.enable(PROJECT);
  assert.deepStrictEqual(loaded.pollState(PROJECT).seenNumbers, []);
});

test('corrupt and oversized files recover to empty, preserving the corrupt copy', () => {
  const { fs, files, modes } = memoryFs();
  files.set(FILE, '{bad');
  let store = createIssueStore({ file: FILE, fs });
  assert.deepStrictEqual(store.listAll(), []);
  assert.strictEqual(files.get(FILE + '.bak'), '{bad');
  assert.strictEqual(modes.get(FILE + '.bak'), 0o600);
  assert.strictEqual(files.has(FILE), false);
  files.set(FILE, 'x');
  const large = { ...fs, statSync: () => ({ size: 32 * 1024 * 1024 + 1 }) };
  store = createIssueStore({ file: FILE, fs: large });
  assert.deepStrictEqual(store.listAll(), []);
  assert.strictEqual(files.get(FILE + '.bak'), 'x');
});

test('writes replace the file by rename and keep mode 0600', () => {
  const { store, calls, modes, files, writeModes } = setup();
  store.enable(PROJECT);
  assert.deepStrictEqual(calls.slice(-3), [
    ['write', FILE + '.tmp'], ['chmod', FILE + '.tmp'], ['rename', FILE + '.tmp', FILE]
  ]);
  assert.strictEqual(modes.get(FILE), 0o600);
  assert.deepStrictEqual(writeModes, [0o600]);
  assert.deepStrictEqual(calls.filter(([action, file]) => file === FILE + '.tmp').map(([action]) => action), ['write', 'chmod', 'rename']);
  assert.strictEqual(files.has(FILE + '.tmp'), false);
});

test('loaded fields, status, snooze time and URL are sanitized', () => {
  const { fs, files } = memoryFs();
  files.set(FILE, JSON.stringify({ projects: { [PROJECT]: { enabledAt: CREATED, items: [
    { ...issue(1), title: 7, labels: ['bug', 8], status: 'invalid', url: 'javascript:alert(1)' },
    { ...issue(2), status: 'snoozed', until: 'tomorrow', url: 'https://user@github.com/o/r/issues/2' },
    { ...issue(3), status: 'snoozed', until: Date.parse(CREATED) + 1000 }
  ] } } }));
  const store = createIssueStore({ file: FILE, fs, now: () => Date.parse(CREATED) });
  const items = store.list(PROJECT);
  assert.strictEqual(items[0].status, 'snoozed');
  assert.strictEqual(items[0].until, Date.parse(CREATED) + 1000);
  assert.strictEqual(items[1].status, 'new');
  assert.strictEqual(items[1].url, '');
  assert.strictEqual(items[2].title, '');
  assert.deepStrictEqual(items[2].labels, ['bug']);
  assert.strictEqual(items[2].status, 'new');
  assert.strictEqual(items[2].url, '');
});

test('expired snoozes keep working in memory if saving fails during load or tick', () => {
  const { fs, files } = memoryFs();
  files.set(FILE, JSON.stringify({ projects: { [PROJECT]: { enabledAt: CREATED, items: [
    { ...issue(1), status: 'snoozed', until: Date.parse(CREATED) - 1 },
    { ...issue(2), status: 'snoozed', until: Date.parse(CREATED) + 1000 }
  ] } } }));
  const failing = { ...fs, writeFileSync() { throw new Error('Unwritable'); } };
  let time = Date.parse(CREATED);
  const store = createIssueStore({ file: FILE, fs: failing, now: () => time });
  assert.strictEqual(store.list(PROJECT).find((item) => item.number === 1).status, 'new');
  time += 1000;
  assert.doesNotThrow(() => store.tick());
  assert.strictEqual(store.list(PROJECT).find((item) => item.number === 2).status, 'new');
  assert.doesNotThrow(() => store.load());
});

test('polling dedupes numbers and reopens dismissed, done or snoozed issues on content changes', () => {
  const { store } = setup();
  store.enable(PROJECT);
  assert.deepStrictEqual(store.applyPoll(PROJECT, { new: [issue(1), issue(1), issue(2)], updated: [] }).added, [1, 2]);
  store.setStatus(PROJECT, 1, 'dismissed');
  assert.deepStrictEqual(store.applyPoll(PROJECT, { new: [], updated: [issue(1, { updatedAt: '2026-11-05T13:00:00Z' })] }),
    { added: [], reopened: [] });
  assert.strictEqual(store.list(PROJECT).find((item) => item.number === 1).status, 'dismissed');
  assert.deepStrictEqual(store.applyPoll(PROJECT, { new: [issue(1, { body: 'Changed body' })], updated: [] }),
    { added: [], reopened: [1] });
  store.setStatus(PROJECT, 1, 'done');
  assert.deepStrictEqual(store.applyPoll(PROJECT, { updated: [issue(1, { title: 'New title' })] }).reopened, [1]);
  store.setStatus(PROJECT, 1, 'snoozed', { until: Date.parse(CREATED) + 60000 });
  assert.deepStrictEqual(store.applyPoll(PROJECT, { updated: [issue(1, { labels: ['feature'] })] }).reopened, [1]);
  store.setStatus(PROJECT, 2, 'in-progress', { chat: 'chat-2' });
  assert.deepStrictEqual(store.applyPoll(PROJECT, { updated: [issue(2, { body: 'Changed' })] }).reopened, []);
  assert.strictEqual(store.list(PROJECT).find((item) => item.number === 2).status, 'in-progress');
  assert.strictEqual(store.list(PROJECT).length, 2);
});

test('expired snoozes become new on read and tick; seen counts and markSeen follow status', () => {
  const { store, advance } = setup();
  store.enable(PROJECT);
  store.applyPoll(PROJECT, { new: [issue(1), issue(2)] });
  assert.strictEqual(store.unseenCount(PROJECT), 2);
  store.markSeen(PROJECT, [2]);
  assert.strictEqual(store.unseenCount(PROJECT), 1);
  store.setStatus(PROJECT, 1, 'snoozed', { until: Date.parse(CREATED) + 1000 });
  assert.strictEqual(store.unseenCount(PROJECT), 0);
  advance(1000);
  store.tick();
  assert.strictEqual(store.unseenCount(PROJECT), 1);
  assert.strictEqual(store.list(PROJECT).find((item) => item.number === 1).status, 'new');
});

test('triage validates fields, caps strings and becomes stale when the issue changes', () => {
  const { store } = setup();
  store.enable(PROJECT);
  store.applyPoll(PROJECT, { new: [issue(1)] });
  assert.strictEqual(store.needsTriage(PROJECT, 1), true);
  store.setTriage(PROJECT, 1, { action: 'fix', size: 7, summary: 's'.repeat(700),
    proposedPlan: 'p'.repeat(7000), draftReply: 'r'.repeat(5000), extra: 'discard' });
  const saved = store.list(PROJECT)[0];
  assert.strictEqual(saved.triage.action, 'fix');
  assert.strictEqual(saved.triage.size, undefined);
  assert.strictEqual(saved.triage.summary.length, 600);
  assert.strictEqual(saved.triage.proposedPlan.length, 6000);
  assert.strictEqual(saved.triage.draftReply.length, 4000);
  assert.strictEqual(saved.triage.extra, undefined);
  assert.strictEqual(saved.triage.key, saved.triageKey);
  assert.strictEqual(store.needsTriage(PROJECT, 1), false);
  store.applyPoll(PROJECT, { updated: [issue(1, { body: 'Changed body' })] });
  assert.strictEqual(store.needsTriage(PROJECT, 1), true);
  assert.strictEqual(store.setTriage(PROJECT, 1, { action: 'invalid' }).action, 'none');
});

test('lists newest first; the item cap evicts done and dismissed issues first', () => {
  const { store } = setup();
  store.enable(PROJECT);
  const batch = Array.from({ length: 200 }, (_, i) => issue(i + 1, {
    createdAt: new Date(Date.parse(CREATED) + i * 1000).toISOString(),
    updatedAt: new Date(Date.parse(CREATED) + i * 1000).toISOString() }));
  store.applyPoll(PROJECT, { new: batch });
  store.setStatus(PROJECT, 200, 'done');
  store.applyPoll(PROJECT, { new: [issue(201, { createdAt: '2026-11-06T00:00:00Z', updatedAt: '2026-11-06T00:00:00Z' })] });
  assert.strictEqual(store.list(PROJECT).length, 200);
  assert.strictEqual(store.list(PROJECT)[0].number, 201);
  assert.strictEqual(store.list(PROJECT).some((item) => item.number === 200), false);
  assert.strictEqual(store.listAll().length, 200);
});

test('item cap evicts done, dismissed, seen and snoozed oldest first', () => {
  const { store } = setup();
  store.enable(PROJECT);
  store.applyPoll(PROJECT, { new: Array.from({ length: 200 }, (_, i) => issue(i + 1,
    i === 0 ? { createdAt: '2026-11-05T12:00:02Z' } : {})) });
  for (const [number, status] of [[1, 'done'], [2, 'done'], [3, 'dismissed'], [4, 'seen'], [5, 'snoozed']]) {
    store.setStatus(PROJECT, number, status, status === 'snoozed' ? { until: Date.parse(CREATED) + 60000 } : {});
  }
  for (const [number, evicted] of [[201, 2], [202, 1], [203, 3], [204, 4], [205, 5]]) {
    store.applyPoll(PROJECT, { new: [issue(number)] });
    assert.strictEqual(store.list(PROJECT).some((item) => item.number === evicted), false);
  }
});

test('a flood retains the earliest 200 unread issues and leaves skipped numbers unseen', () => {
  const { store } = setup();
  store.enable(PROJECT);
  const result = store.applyPoll(PROJECT, { new: Array.from({ length: 250 }, (_, i) => issue(i + 1)) });
  assert.deepStrictEqual(result.added, Array.from({ length: 200 }, (_, i) => i + 1));
  assert.deepStrictEqual(store.list(PROJECT).map((item) => item.number).sort((a, b) => a - b), result.added);
  assert.deepStrictEqual(store.pollState(PROJECT).seenNumbers, result.added);
  store.markSeen(PROJECT, [1]);
  assert.deepStrictEqual(store.applyPoll(PROJECT, { new: [issue(201)] }).added, [201]);
  assert.strictEqual(store.list(PROJECT).some((item) => item.number === 1), false);
});

test('special project keys cannot alter store state', () => {
  const { store } = setup();
  for (const key of ['__proto__', 'constructor', 'hasOwnProperty']) {
    assert.throws(() => store.enable(key), /project path/i);
    assert.throws(() => store.pollState(key), /project path/i);
    assert.throws(() => store.applyPoll(key, { new: [issue(1)] }), /project path/i);
  }
  assert.deepStrictEqual(store.listAll(), []);
});

test('special project keys in saved JSON are ignored', () => {
  const { fs, files } = memoryFs();
  for (const key of ['__proto__', 'constructor', 'hasOwnProperty']) {
    files.set(FILE, JSON.stringify({ projects: { [key]: { enabledAt: CREATED, items: [issue(1)] } } }));
    const store = createIssueStore({ file: FILE, fs });
    assert.deepStrictEqual(store.listAll(), []);
  }
});

test('bad status, numbers and snooze time are rejected', () => {
  const { store } = setup();
  store.enable(PROJECT);
  store.applyPoll(PROJECT, { new: [issue(1)] });
  assert.throws(() => store.setStatus(PROJECT, 2, 'unknown'), /status/i);
  assert.throws(() => store.setStatus(PROJECT, -1, 'done'), /number/i);
  assert.throws(() => store.setStatus(PROJECT, 2.5, 'done'), /number/i);
  assert.throws(() => store.setStatus(PROJECT, 1, 'snoozed'), /until/i);
  assert.throws(() => store.markSeen(PROJECT, ['2']), /numbers/i);
});
