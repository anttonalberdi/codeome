const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element(name, attrs = {}, children = []) {
  const node = { name, attrs, children: children.flat(Infinity).filter((child) => child != null), fakeNode: true,
    value: attrs.value || '', hidden: !!attrs.hidden,
    classList: { add() {}, remove() {}, toggle() {} },
    append(...items) { for (const item of items) { if (item && typeof item === 'object') item.parent = this; this.children.push(item); } },
    replaceChildren(...items) { this.children = []; this.append(...items.flat(Infinity)); },
    replaceWith(item) { const index = this.parent.children.indexOf(this); this.parent.children[index] = item; item.parent = this.parent; },
    focus() {},
    querySelectorAll() { return []; }, querySelector() { return null; },
    get textContent() { return this.children.map((child) => typeof child === 'string' ? child : child.textContent).join(''); },
    set textContent(value) { this.children = [String(value)]; } };
  for (const child of node.children) if (child && typeof child === 'object') child.parent = node;
  if (name === 'select') node.value = find(node, (child) => child.name === 'option' && child.attrs.selected)[0]?.attrs.value || '';
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

function load({ connected = true, project = '/projects/alpha', syncResult, hasError, secrets, modal } = {}) {
  const root = element('div');
  const listeners = {};
  const errors = [];
  const calls = [];
  let saved = null;
  let hpcConnected = connected;
  const App = {
    h, views: { projects: { list: [project] } }, project,
    cfg: { secrets: secrets || [{ name: 'API_TOKEN', note: '', terminals: false, agents: false, hpc: false }] },
    icons: { trash: '' }, basename: path.basename, tildify: (value) => value, isIdeas: () => false,
    listen: (event, fn) => { (listeners[event] ||= []).push(fn); },
    emit: (event) => (listeners[event] || []).forEach((fn) => fn()),
    saveConfig: async () => { saved = JSON.parse(JSON.stringify(App.cfg)); },
    err: (message) => errors.push(message),
    modal: async (options) => modal ? modal(options) : null
  };
  const codeome = { secrets: {
    has: async (names) => { if (hasError) throw new Error(hasError); return names.map(() => true); },
    set: async (name, value, kind, ext) => { calls.push({ method: 'set', name, value, kind, ext }); return { ok: true }; },
    copy: async (name) => { calls.push({ method: 'copy', name }); return { ok: true, seconds: 30 }; },
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
    { App, codeome, document, TextEncoder, TextDecoder, setTimeout: () => 1, clearTimeout() {} });
  return { App, root, errors, calls, setConnected: (value) => { hpcConnected = value; } };
}

const status = (root) => find(root, (node) => node.name === 'span.hint.sec-hpc-status')[0];
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

const control = (root, label) => find(root, (node) => node.attrs['aria-label'] === label)[0];
const button = (root, label) => find(root, (node) => node.name.startsWith('button') && node.children.includes(label))[0];

test('Text secrets keep the password entry and Copy action', async () => {
  const view = load();
  await view.App.views.settings.open('secrets');
  assert.ok(button(view.root, 'Copy'));
  assert.equal(control(view.root, 'Value').hidden, false);
  control(view.root, 'Name').value = 'SECOND_TOKEN';
  control(view.root, 'Value').value = '  text-value  ';
  await button(view.root, 'Save').attrs.onclick();
  assert.deepEqual(view.calls.find((call) => call.method === 'set'),
    { method: 'set', name: 'SECOND_TOKEN', value: 'text-value', kind: 'text', ext: undefined });
  assert.equal(view.App.cfg.secrets.at(-1).kind, 'text');
});

test('File type uses a picker and sends content only to secrets.set', async () => {
  const view = load();
  await view.App.views.settings.open('secrets');
  const type = control(view.root, 'Type');
  const textValue = control(view.root, 'Value');
  const picker = control(view.root, 'Choose a text file');
  assert.equal(picker.parent.parent.parent.hidden, true);
  type.value = 'file';
  type.attrs.onchange({ target: type });
  assert.equal(textValue.hidden, true);
  assert.equal(picker.parent.parent.parent.hidden, false);
  control(view.root, 'Name').value = 'PRIVATE_KEY';
  const content = 'line one\nline two\n';
  picker.files = [{ name: 'signing.p8', size: Buffer.byteLength(content), arrayBuffer: async () => Uint8Array.from(Buffer.from(content)).buffer }];
  picker.attrs.onchange();
  assert.match(view.root.textContent, /signing\.p8 · 18 bytes/);
  await button(view.root, 'Save').attrs.onclick();
  await new Promise(setImmediate);
  assert.deepEqual(view.calls.find((call) => call.method === 'set'),
    { method: 'set', name: 'PRIVATE_KEY', value: content, kind: 'file', ext: '.p8' });
  assert.deepEqual(JSON.parse(JSON.stringify(view.App.cfg.secrets.at(-1))),
    { name: 'PRIVATE_KEY', note: '', terminals: false, agents: false, kind: 'file', ext: '.p8' });
  const row = find(view.root, (node) => node.name === 'div.sec-row' && node.textContent.includes('PRIVATE_KEY'))[0];
  assert.ok(find(row, (node) => node.name === 'span.pill' && node.textContent === 'file').length);
  assert.equal(button(row, 'Copy'), undefined);
  assert.doesNotMatch(view.root.textContent, /line one/);
});

test('File paste rejects oversized and invalid UTF-8 content before IPC', async () => {
  const view = load();
  await view.App.views.settings.open('secrets');
  control(view.root, 'Name').value = 'PRIVATE_KEY';
  const type = control(view.root, 'Type');
  type.value = 'file'; type.attrs.onchange({ target: type });
  const paste = control(view.root, 'Paste file content');
  paste.value = '€'.repeat(21846);
  await button(view.root, 'Save').attrs.onclick();
  assert.match(view.errors.at(-1), /64 KB/);
  assert.equal(view.calls.filter((call) => call.method === 'set').length, 0);
  paste.value = '\ud800';
  await button(view.root, 'Save').attrs.onclick();
  assert.match(view.errors.at(-1), /UTF-8/);
  assert.equal(view.calls.filter((call) => call.method === 'set').length, 0);
});

test('File picker omits an invalid extension and rejects non-UTF-8 bytes', async () => {
  const view = load();
  await view.App.views.settings.open('secrets');
  control(view.root, 'Name').value = 'PRIVATE_KEY';
  const type = control(view.root, 'Type');
  type.value = 'file'; type.attrs.onchange({ target: type });
  const picker = control(view.root, 'Choose a text file');
  picker.files = [{ name: 'key.bad-name', size: 1, arrayBuffer: async () => Uint8Array.of(0xff).buffer }];
  picker.attrs.onchange();
  await button(view.root, 'Save').attrs.onclick();
  assert.match(view.errors.at(-1), /UTF-8/);
  assert.equal(view.calls.filter((call) => call.method === 'set').length, 0);
  picker.files = [{ name: 'key.bad-name', size: 3, arrayBuffer: async () => Uint8Array.from(Buffer.from('key')).buffer }];
  picker.attrs.onchange();
  await button(view.root, 'Save').attrs.onclick();
  assert.equal(view.calls.find((call) => call.method === 'set').ext, '');
  assert.equal('ext' in view.App.cfg.secrets.at(-1), false);
});

test('File picker and paste strip a leading UTF-8 BOM before sending content', async () => {
  for (const usePicker of [true, false]) {
    const view = load();
    await view.App.views.settings.open('secrets');
    control(view.root, 'Name').value = 'PRIVATE_KEY';
    const type = control(view.root, 'Type');
    type.value = 'file'; type.attrs.onchange({ target: type });
    if (usePicker) {
      const picker = control(view.root, 'Choose a text file');
      const content = Buffer.from('\uFEFFcontent');
      picker.files = [{ name: 'key.p8', size: content.length, arrayBuffer: async () => Uint8Array.from(content).buffer }];
      picker.attrs.onchange();
    } else control(view.root, 'Paste file content').value = '\uFEFFcontent';
    await button(view.root, 'Save').attrs.onclick();
    assert.equal(view.calls.find((call) => call.method === 'set').value, 'content');
  }
});

test('File replacement offers picker or paste and keeps the file kind and extension', async () => {
  let modalBody;
  const view = load({ secrets: [{ name: 'PRIVATE_KEY', note: '', terminals: false, agents: false, hpc: false, kind: 'file', ext: '.p8' }],
    modal: (options) => {
      modalBody = options.body;
      assert.equal(options.fields, undefined);
      const paste = control(options.body, 'Paste file content');
      paste.value = 'replacement\n';
      return true;
    } });
  await view.App.views.settings.open('secrets');
  assert.equal(button(view.root, 'Copy'), undefined);
  await button(view.root, 'Replace…').attrs.onclick();
  assert.ok(control(modalBody, 'Choose a text file'));
  assert.deepEqual(view.calls.find((call) => call.method === 'set'),
    { method: 'set', name: 'PRIVATE_KEY', value: 'replacement\n', kind: 'file', ext: '.p8' });
  assert.doesNotMatch(view.root.textContent, /replacement/);
});
