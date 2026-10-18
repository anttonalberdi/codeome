const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element(selector, attrs, ...kids) {
  if (attrs && (typeof attrs !== 'object' || attrs.selector || Array.isArray(attrs))) {
    kids.unshift(attrs); attrs = null;
  }
  const handlers = {};
  const el = {
    selector, children: [], hidden: !!attrs?.hidden, value: attrs?.value || '',
    title: attrs?.title || '', classList: { add() {}, remove() {} },
    addEventListener(name, fn) { handlers[name] = fn; },
    dispatch(name) { handlers[name]?.(); },
    append(...items) {
      for (const item of items) {
        const previous = this.children.at(-1);
        if (previous && typeof previous === 'object') previous.nextSibling = item;
        this.children.push(item);
      }
    },
    replaceChildren(...items) { this.children = items; this.replacements = (this.replacements || 0) + 1; },
    querySelector() { return null; }
  };
  Object.defineProperty(el, 'innerHTML', { set() { el.children = []; } });
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key.startsWith('on')) handlers[key.slice(2)] = value;
    else if (key === 'value') el.value = value;
    else el[key] = value;
  }
  el.append(...kids.filter((kid) => kid != null));
  return el;
}

function load() {
  const listeners = {}, visited = [], searches = [], roots = [];
  let trees = [], missing = null, now = 100000;
  let worktreeLoader = async () => ({ worktrees: trees });
  const App = {
    h: element, project: '/a/proj', views: { transfer: {
      queueList: () => ({ el: element('queue'), count: () => 0 }), open() {}, summary: () => ''
    } },
    cfg: { ui: { panes: {} }, hpc: { host: '' }, storage: { host: '' } },
    icons: { swap: '', folder: '', file: '' },
    stack: ({ sections }) => ({ el: element('stack'), title: (side) => side,
      panes: Object.fromEntries(sections.map((s) => [s.id, {}])) }),
    listen: (event, fn) => { listeners[event] = fn; },
    iconBtn: (_icon, _title, action) => { const button = element('button'); button.action = action; return button; },
    hiddenBtn: () => element('button'),
    isIdeas: () => false,
    basename: (p) => p.split('/').pop(), dirname: (p) => p.slice(0, p.lastIndexOf('/')) || '/',
    join: (a, b) => a.replace(/\/$/, '') + '/' + b,
    fmtSize: () => '', fmtAgo: () => ''
  };
  const codeome = { local: {
    list: async (dir) => { visited.push(dir); return dir === missing ? { error: 'Missing folder' } : { cwd: dir, entries: [] }; },
    worktrees: async (root) => { roots.push(root); return worktreeLoader(root); },
    search: async (root) => { searches.push(root); return { results: [] }; }
  } };
  const document = { hidden: false, querySelector: () => element('root') };
  const source = fs.readFileSync(path.join(__dirname, '../renderer/js/files.js'), 'utf8');
  vm.runInNewContext(source, { App, codeome, document, setInterval() {}, setTimeout() {}, clearTimeout() {}, Date: { now: () => now } });
  const F = App.views.files;
  F.init();
  return { F, App, listeners, visited, searches, roots,
    setTrees(value) { trees = value; }, setWorktreeLoader(value) { worktreeLoader = value; },
    setMissing(value) { missing = value; }, advance(ms) { now += ms; } };
}

const main = { path: '/a/proj', branch: 'main', head: '1234567890', isMain: true };
const detached = { path: '/a/proj-2', branch: null, head: 'abcdef123456', isMain: false };
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('worktree row stays hidden for zero and one tree, then shows labels for two', async () => {
  const t = load();
  const { worktreeRow: row, worktreeSelect: select } = t.F.panes.local;
  assert.equal(row.hidden, true);
  t.listeners.project(t.App.project);
  await flush();
  assert.equal(row.hidden, true);
  t.setTrees([main]);
  await t.F.panes.local.section.tools.at(-1).action();
  assert.equal(row.hidden, true);
  t.setTrees([main, detached]);
  await t.F.panes.local.section.tools.at(-1).action();
  assert.equal(row.hidden, false);
  assert.equal(select.children[1].children[0], 'main (main)');
  assert.equal(select.children[2].children[0], 'detached @ abcdef1');
  assert.equal(select.children[2].title, '/a/proj-2');
  const options = select.children;
  await t.F.refresh('local');
  assert.equal(select.children, options);
});

test('selecting and browsing sync to the containing tree with path boundaries', async () => {
  const t = load();
  const nested = { path: '/a/proj/sub', branch: 'feature', head: 'fedcba9876', isMain: false };
  t.setTrees([main, nested, detached]);
  t.listeners.project(t.App.project);
  await flush();
  const select = t.F.panes.local.worktreeSelect;
  const searchBox = t.F.panes.local.searchBox;
  searchBox.value = 'needle';
  await t.F.search('needle');
  select.value = detached.path;
  select.dispatch('change');
  await flush();
  assert.equal(t.F.local.dir, detached.path);
  assert.equal(select.value, detached.path);
  assert.equal(searchBox.value, '');
  assert.equal(t.F.local.searching, false);
  await t.F.go('local', '/a/proj/sub/deep');
  assert.equal(select.value, nested.path);
  await t.F.search('needle');
  assert.equal(t.searches.at(-1), nested.path);
  await t.F.go('local', '/a/proj-2/deep');
  assert.equal(select.value, detached.path);
  await t.F.go('local', '/a/proj-other');
  assert.equal(select.value, '');
  t.F.panes.local.section.tools[1].action();
  await flush();
  assert.equal(t.F.local.dir, t.App.project);
  assert.equal(select.value, main.path);
});

test('poll is rate limited and a vanished selected tree returns to the project', async () => {
  const t = load();
  t.setTrees([main, detached]);
  t.listeners.project(t.App.project);
  await flush();
  await t.F.go('local', detached.path + '/sub');
  const initial = t.roots.length;
  await t.F.poll('local');
  assert.equal(t.roots.length, initial);
  t.advance(10000);
  await t.F.poll('local');
  assert.equal(t.roots.length, initial + 1);
  t.setTrees([main]);
  t.setMissing(detached.path + '/sub');
  await t.F.panes.local.section.tools.at(-1).action();
  assert.equal(t.F.local.dir, main.path);
  assert.equal(t.F.panes.local.worktreeRow.hidden, true);
});

test('one worktree keeps a subfolder project as the search root', async () => {
  const t = load();
  t.App.project = '/a/proj/subfolder';
  t.setTrees([main]);
  t.listeners.project(t.App.project);
  await flush();
  assert.equal(t.F.panes.local.worktreeRow.hidden, true);
  await t.F.search('needle');
  assert.equal(t.searches.at(-1), t.App.project);
});

test('worktree IPC errors and exceptions preserve the list and current folder', async () => {
  const t = load();
  t.setTrees([main, detached]);
  t.listeners.project(t.App.project);
  await flush();
  await t.F.go('local', detached.path);
  const select = t.F.panes.local.worktreeSelect;
  const refresh = t.F.panes.local.section.tools.at(-1).action;
  for (const loader of [async () => ({ error: 'git timed out' }), async () => { throw new Error('IPC failed'); }]) {
    t.setWorktreeLoader(loader);
    const before = t.visited.length;
    await refresh();
    assert.equal(t.F.local.dir, detached.path);
    assert.equal(select.value, detached.path);
    assert.equal(t.F.worktrees.length, 2);
    assert.equal(t.F.panes.local.worktreeRow.hidden, false);
    assert.deepEqual(t.visited.slice(before), [detached.path]);
  }
});

test('a stale in-flight result cannot replace worktrees for a new project', async () => {
  const t = load();
  let finishOld;
  t.setWorktreeLoader((root) => root === '/a/proj'
    ? new Promise((resolve) => { finishOld = resolve; })
    : Promise.resolve({ worktrees: [{ ...main, path: '/b/proj' }, { ...detached, path: '/b/proj-2' }] }));
  t.listeners.project(t.App.project);
  t.App.project = '/b/proj';
  t.listeners.project(t.App.project);
  await flush();
  assert.equal(t.F.worktrees[0].path, '/b/proj');
  finishOld({ worktrees: [main, detached] });
  await flush();
  assert.equal(t.F.worktrees[0].path, '/b/proj');
  assert.deepEqual(t.roots, ['/a/proj', '/b/proj']);
});

test('ordinary refreshes and polls throttle worktree loads; the Refresh button forces one', async () => {
  const t = load();
  t.listeners.project(t.App.project);
  await flush();
  const initial = t.roots.length;
  await t.F.refresh('local');
  await t.F.refresh('local');
  await t.F.poll('local');
  assert.equal(t.roots.length, initial);
  t.advance(10000);
  await t.F.refresh('local');
  assert.equal(t.roots.length, initial + 1);
  await t.F.refresh('local');
  assert.equal(t.roots.length, initial + 1);
  await t.F.panes.local.section.tools.at(-1).action();
  assert.equal(t.roots.length, initial + 2);
});

test('the local poll refreshes the directory while a worktree request is pending', async () => {
  const t = load();
  t.listeners.project(t.App.project);
  await flush();
  t.advance(10000);
  t.setWorktreeLoader(() => new Promise(() => {}));
  const before = t.visited.length;
  await t.F.poll('local');
  assert.equal(t.visited.length, before + 1);
  assert.equal(t.roots.length, 2);
});

test('the canonical project root matches an aliased local folder', async () => {
  const t = load();
  t.App.project = '/tmp/a/proj';
  t.setWorktreeLoader(async () => ({ root: '/private/tmp/a/proj', worktrees: [
    { ...main, path: '/private/tmp/a/proj' }, { ...detached, path: '/private/tmp/a/proj-2' }
  ] }));
  t.listeners.project(t.App.project);
  await flush();
  await t.F.go('local', '/tmp/a/proj/sub');
  assert.equal(t.F.panes.local.worktreeSelect.value, '/private/tmp/a/proj');
  await t.F.search('needle');
  assert.equal(t.searches.at(-1), '/private/tmp/a/proj');
});
