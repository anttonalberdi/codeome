const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { POLICY_DEFAULTS } = require('../main/policy');

function element(name, attrs = {}, children = []) {
  const node = { name, attrs, children: [], fakeNode: true, replaceChildren(...items) { this.children = items.flat(Infinity); } };
  node.children = children.flat(Infinity).filter((item) => item != null);
  return node;
}

function h(name, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || Array.isArray(attrs) || attrs.fakeNode) {
    children.unshift(attrs);
    attrs = {};
  }
  return element(name, attrs, children);
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  return [
    ...(predicate(node) ? [node] : []),
    ...(node.children || []).flatMap((child) => find(child, predicate))
  ];
}

function load() {
  const root = element('section');
  const listeners = {};
  const writes = [];
  const App = {
    h, views: {}, cfg: { projectPolicy: {} }, project: '/projects/alpha', currentView: 'projectSettings',
    basename: (value) => path.basename(value), isIdeas: (value) => value === '/projects/ideas',
    listen: (event, fn) => { (listeners[event] ||= []).push(fn); },
    emit: (event, value) => (listeners[event] || []).forEach((fn) => fn(value))
  };
  const codeome = {
    policy: { defaults: async () => POLICY_DEFAULTS },
    config: { set: async (cfg) => { writes.push(JSON.parse(JSON.stringify(cfg.projectPolicy))); return cfg; } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/js/projectsettings.js'), 'utf8'),
    { App, codeome, document: { querySelector: () => root } });
  return { App, root, writes };
}

test('renders one control per policy switch from backend defaults', async () => {
  const { App, root } = load();
  App.views.projectSettings.init();
  await new Promise(setImmediate);
  const rows = find(root, (node) => node.attrs['data-policy-key']);
  assert.deepEqual(rows.map((row) => row.attrs['data-policy-key']), POLICY_DEFAULTS.map((item) => item.key));
  assert.equal(rows.filter((row) => find(row, (node) => node.attrs.role === 'radiogroup' || node.attrs.role === 'switch').length === 1).length, POLICY_DEFAULTS.length);
});

test('Slurm override saves and returning to the default removes the project entry', async () => {
  const { App, root, writes } = load();
  App.views.projectSettings.init();
  await new Promise(setImmediate);
  const choice = (value) => find(root, (node) => node.name.startsWith('button') && node.children.includes(value))[0];
  await choice('Never').attrs.onclick();
  assert.equal(App.cfg.projectPolicy['/projects/alpha'].slurmSubmit, 'never');
  assert.equal(writes.at(-1)['/projects/alpha'].slurmSubmit, 'never');
  await choice('Ask').attrs.onclick();
  assert.equal(Object.hasOwn(App.cfg.projectPolicy, '/projects/alpha'), false);
  assert.equal(Object.hasOwn(writes.at(-1), '/projects/alpha'), false);
});

test('each project keeps its own policy', async () => {
  const { App, root } = load();
  App.views.projectSettings.init();
  await new Promise(setImmediate);
  const choice = (value) => find(root, (node) => node.name.startsWith('button') && node.children.includes(value))[0];
  await choice('Never').attrs.onclick();
  App.project = '/projects/beta';
  App.emit('project', App.project);
  assert.equal(find(root, (node) => node.attrs.role === 'radio' && node.children.includes('Ask'))[0].attrs['aria-checked'], 'true');
  await choice('Allow (best effort)').attrs.onclick();
  assert.equal(App.cfg.projectPolicy['/projects/alpha'].slurmSubmit, 'never');
  assert.equal(App.cfg.projectPolicy['/projects/beta'].slurmSubmit, 'allow');
});

test('Ideas has agent rules and reset clears only its own overrides', async () => {
  const { App, root } = load();
  App.views.projectSettings.init();
  await new Promise(setImmediate);
  App.project = '/projects/ideas';
  App.emit('project', App.project);
  const choice = (value) => find(root, (node) => node.name.startsWith('button') && node.children.includes(value))[0];
  await choice('Never').attrs.onclick();
  assert.equal(App.cfg.projectPolicy['/projects/ideas'].slurmSubmit, 'never');
  await choice('Reset to defaults').attrs.onclick();
  assert.equal(Object.hasOwn(App.cfg.projectPolicy, '/projects/ideas'), false);
  assert.ok(find(root, (node) => node.children.includes('Ideas')).length);
});
