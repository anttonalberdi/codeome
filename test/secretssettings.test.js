const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element(name, attrs = {}, children = []) {
  const node = { name, attrs, children: children.flat(Infinity).filter((child) => child != null), fakeNode: true,
    classList: { add() {}, remove() {}, toggle() {} },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items.flat(Infinity); },
    querySelectorAll() { return []; }, querySelector() { return null; },
    get textContent() { return this.children.map((child) => typeof child === 'string' ? child : child.textContent).join(''); },
    set textContent(value) { this.children = [String(value)]; } };
  return node;
}
function h(name, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || Array.isArray(attrs) || attrs.fakeNode) {
    children.unshift(attrs); attrs = {};
  }
  return element(name, attrs, children);
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap((child) => find(child, predicate))];
}

function load({ connected = true, project = '/projects/alpha', syncResult, hasError } = {}) {
  const root = element('div');
  const listeners = {};
  const errors = [];
  const calls = [];
  let saved = null;
  let hpcConnected = connected;
  const App = {
    h, views: { projects: { list: [project] } }, project,
    cfg: { secrets: [{ name: 'API_TOKEN', note: '', terminals: false, agents: false, hpc: false }] },
    icons: { trash: '' }, basename: path.basename, tildify: (value) => value, isIdeas: () => false,
    listen: (event, fn) => { (listeners[event] ||= []).push(fn); },
    emit: (event) => (listeners[event] || []).forEach((fn) => fn()),
    saveConfig: async () => { saved = JSON.parse(JSON.stringify(App.cfg)); },
    err: (message) => errors.push(message)
  };
  const codeome = { secrets: {
    has: async () => { if (hasError) throw new Error(hasError); return [true]; },
    hpcStatus: async (selectedProject) => {
      calls.push({ method: 'status', project: selectedProject });
      return { connected: hpcConnected, names: [], skipped: [], path: '~/.codeome/secrets/alpha-12345678.env' };
    },
    sync: async (selectedProject) => {
      calls.push({ method: 'sync', project: selectedProject, hpc: saved.secrets[0].hpc });
      return syncResult || { ok: true, count: 1, names: ['API_TOKEN'], skipped: [], removed: false };
    }
  } };
  const document = { getElementById: () => root, addEventListener() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/js/settings.js'), 'utf8'),
    { App, codeome, document, setTimeout: () => 1, clearTimeout() {} });
  return { App, root, errors, calls, setConnected: (value) => { hpcConnected = value; } };
}

const status = (root) => find(root, (node) => node.attrs.role === 'status')[0];
const syncButton = (root) => find(root, (node) => node.name === 'button.btn.small' && node.children.includes('Sync to HPC'))[0];

test('HPC checkbox saves before sync and shows only synced names and path', async () => {
  const view = load();
  await view.App.views.settings.open('secrets');
  const label = find(view.root, (node) => node.name === 'label.check' && node.children.includes('HPC'))[0];
  assert.match(label.attrs.title, /plaintext.*0600/);
  assert.equal(label.children[0].attrs.checked, false);
  label.children[0].attrs.onchange({ target: { checked: true } });
  await syncButton(view.root).attrs.onclick();
  assert.equal(view.App.cfg.secrets[0].hpc, true);
  assert.deepEqual(view.calls.at(-1), { method: 'sync', project: '/projects/alpha', hpc: true });
  assert.match(status(view.root).textContent, /Synced API_TOKEN to ~\/\.codeome\/secrets\/alpha-12345678\.env/);
  assert.doesNotMatch(view.root.textContent, /secret-value/);
});

test('HPC sync shows disconnected and no-project states', async () => {
  const disconnected = load({ connected: false });
  await disconnected.App.views.settings.open('secrets');
  assert.equal(status(disconnected.root).textContent, 'HPC not connected');
  assert.equal(syncButton(disconnected.root).attrs.disabled, true);
  disconnected.setConnected(true);
  disconnected.App.emit('hpc');
  await new Promise(setImmediate);
  assert.match(status(disconnected.root).textContent, /Sync removes ~\/\.codeome\/secrets\/alpha-12345678\.env/);
  assert.equal(syncButton(disconnected.root).attrs.disabled, false);

  const noProject = load({ project: null });
  await noProject.App.views.settings.open('secrets');
  assert.match(status(noProject.root).textContent, /Open a project/);
  assert.equal(syncButton(noProject.root).attrs.disabled, true);
  assert.equal(noProject.calls.length, 0);
});

test('HPC sync errors are shown through App.err', async () => {
  const view = load({ syncResult: { error: 'Not connected to the HPC.' } });
  await view.App.views.settings.open('secrets');
  await syncButton(view.root).attrs.onclick();
  assert.deepEqual(view.errors, ['Not connected to the HPC.']);
  assert.equal(status(view.root).textContent, 'Not connected to the HPC.');
});

test('secrets view shows a Keychain loading error', async () => {
  const view = load({ hasError: 'Keychain unavailable' });
  await view.App.views.settings.open('secrets');
  assert.match(view.root.textContent, /Keychain unavailable/);
  assert.deepEqual(view.errors, ['Keychain unavailable']);
});
