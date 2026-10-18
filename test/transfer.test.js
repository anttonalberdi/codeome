const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// transfer.js is a renderer script; load it with just enough of App and the bridge around it.
function load({ up = () => true, existing = [], modal = async () => true } = {}) {
  const started = [], cancelled = [], asked = [], on = {};
  const App = {
    views: { files: { title: (s) => s, isUp: (s) => up(s) } }, cfg: { ui: {}, hpc: { host: 'hpc' }, storage: { host: 'erda' } },
    basename: (p) => p.replace(/\/+$/, '').split('/').pop(),
    dirname: (p) => { const s = p.replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i <= 0 ? '/' : s.slice(0, i); },
    h: (tag, ...a) => ({ tag, children: a.filter((x) => x && typeof x === 'object' && !Array.isArray(x) && !x.tag ? false : true) }),
    modal: async (o) => { asked.push(o); return modal(o); }, emit: () => {}, listen: () => {}, toast: () => {}, err: () => {}, requireHpc: () => true, requireStorage: () => true
  };
  const lister = { list: async () => ({ entries: existing.map((name) => ({ name })) }) };
  const codeome = { local: lister, remote: lister, storage: lister, transfer: {
    start: async (t) => { started.push(t); return { id: t.id }; }, cancel: (id) => cancelled.push(id),
    onProgress: (f) => { on.progress = f; }, onDone: (f) => { on.done = f; }
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/js/transfer.js'), 'utf8'), { App, codeome, setTimeout: () => {}, Date });
  const X = App.views.transfer;
  X.init();
  return { X, App, started, cancelled, asked, on };
}
const items = (...names) => names.map((n) => ({ path: '/data/' + n, size: 10 }));
const flush = () => new Promise((r) => setImmediate(r));
const states = (X) => X.queue.map((t) => t.status).join(' ');

test('the queue starts as many transfers as may run at once, oldest first', async () => {
  const { X, started, on } = load();
  X.enqueue('local', items('a', 'b', 'c'), 'remote', '/scratch');
  await flush();
  assert.equal(states(X), 'running running queued');
  assert.deepEqual(started.map((t) => t.src), ['/data/a', '/data/b']);
  on.done({ id: X.queue[0].id, code: 0 });
  await flush();
  assert.equal(states(X), 'done running running');
  assert.equal(X.summary(X.queue), '2 running · 1 done');
});

test('the number at a time comes from the settings, between 1 and 4', () => {
  const { X, App } = load();
  App.cfg.ui.transfer = { parallel: 1 };
  X.enqueue('local', items('a', 'b'), 'remote', '/scratch');
  assert.equal(states(X), 'running queued');
  App.cfg.ui.transfer.parallel = 9;
  assert.equal(X.parallel(), 4);
});

test('a paused queue starts nothing until it resumes', () => {
  const { X } = load();
  X.setPaused(true);
  X.enqueue('local', items('a'), 'storage', '/archive');
  assert.equal(states(X), 'queued');
  X.setPaused(false);
  assert.equal(states(X), 'running');
});

test('a failure keeps its reason and can be tried again under a new name', async () => {
  const { X, started, on } = load();
  const [t] = X.enqueue('local', items('a'), 'remote', '/scratch');
  await flush();
  const first = t.id;
  on.done({ id: first, code: 23, error: 'rsync: permission denied' });
  assert.equal(t.status, 'failed');
  assert.equal(t.error, 'rsync: permission denied');
  X.retry(t);
  await flush();
  assert.equal(t.status, 'running');
  assert.notEqual(t.id, first);
  // What is left of the first try no longer counts.
  on.done({ id: first, code: 1, error: 'late' });
  assert.equal(t.status, 'running');
  assert.equal(started.length, 2);
});

test('cancelling a running transfer stops it and starts the next', () => {
  const { X, cancelled } = load();
  X.enqueue('local', items('a', 'b', 'c'), 'remote', '/scratch');
  X.cancel(X.queue[0]);
  assert.equal(states(X), 'cancelled running running');
  assert.deepEqual(cancelled, [X.queue[0].id]);
  X.clearFinished();
  assert.equal(states(X), 'running running');
});

test('a transfer to a host that is not connected fails without blocking the rest', () => {
  const { X } = load({ up: (s) => s !== 'storage' });
  X.enqueue('local', items('a'), 'storage', '/archive');
  X.enqueue('local', items('b'), 'remote', '/scratch');
  assert.equal(states(X), 'failed running');
  assert.equal(X.queue[0].error, 'Not connected to storage');
});

test('copies within a host skip what is already there, and the storage has none', () => {
  const { X } = load();
  assert.equal(X.enqueue('local', items('a'), 'local', '/data').length, 0);
  assert.equal(X.enqueue('local', [{ path: '/data/dir', dir: true }], 'local', '/data/dir/sub').length, 0);
  assert.equal(X.enqueue('local', items('a'), 'local', '/elsewhere').length, 1);
  assert.equal(X.enqueue('storage', items('a'), 'storage', '/elsewhere').length, 0);
  assert.equal(X.route('remote', 'storage').via, 'terminal');
  assert.equal(X.route('storage', 'local').via, 'main');
});

test('folders sort first, then by the chosen column', () => {
  const { X } = load();
  const entries = [{ name: 'b.txt', dir: false, size: 5, mtime: 2 }, { name: 'z', dir: true, size: 0, mtime: 9 }, { name: 'a.txt', dir: false, size: 9, mtime: 1 }];
  const names = (sort) => X.sortEntries(entries, sort).map((e) => e.name).join(' ');
  assert.equal(names({ key: 'name', asc: true }), 'z a.txt b.txt');
  assert.equal(names({ key: 'size', asc: false }), 'z a.txt b.txt');
  assert.equal(names({ key: 'mtime', asc: false }), 'z b.txt a.txt');
});

test('favourite folders are kept per host, once each', () => {
  const { X, App } = load();
  App.saveConfig = () => {};
  X.addFav('remote', '/projects/a'); X.addFav('remote', '/projects/a'); X.addFav('local', '/projects/a');
  assert.deepEqual(App.cfg.transferFavs.remote, ['/projects/a']);
  assert.ok(X.isFav('local', '/projects/a') && !X.isFav('storage', '/projects/a'));
  X.toggleFav('remote', '/projects/a');
  assert.ok(!X.isFav('remote', '/projects/a'));
});

test('a name already at the destination is replaced or skipped as asked', async () => {
  const replace = load({ existing: ['a'], modal: async () => true });
  replace.X.enqueue('local', items('a', 'b'), 'remote', '/scratch');
  await flush();
  assert.equal(replace.asked.length, 1);
  assert.deepEqual(replace.started.map((t) => t.src).sort(), ['/data/a', '/data/b']);

  const skip = load({ existing: ['a'], modal: async () => null });
  skip.X.enqueue('local', items('a', 'b'), 'remote', '/scratch');
  await flush();
  assert.equal(states(skip.X), 'skipped running');
  assert.deepEqual(skip.started.map((t) => t.src), ['/data/b']);
});

test('"for every other file" keeps the answer for the rest of the queue', async () => {
  const t = load({ existing: ['a', 'b', 'c'], modal: async (o) => { o.body.children[0].checked = true; return null; } });
  t.X.enqueue('local', items('a', 'b', 'c'), 'remote', '/scratch');
  await flush();
  assert.equal(t.asked.length, 1);
  assert.equal(states(t.X), 'skipped skipped skipped');
});
