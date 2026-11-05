const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element(name, attrs = {}, children = []) {
  const classes = new Set();
  const node = { name, attrs, children: children.flat(Infinity).filter((child) => child != null), fakeNode: true,
    value: attrs.value || '', hidden: !!attrs.hidden,
    classList: { add(value) { classes.add(value); }, remove(value) { classes.delete(value); },
      toggle(value) { if (classes.has(value)) classes.delete(value); else classes.add(value); },
      contains(value) { return classes.has(value); } },
    append(...items) { for (const item of items) { if (item && typeof item === 'object') item.parent = this; this.children.push(item); } },
    replaceChildren(...items) { this.children = []; this.append(...items.flat(Infinity)); },
    replaceWith(item) { const index = this.parent.children.indexOf(this); this.parent.children[index] = item; item.parent = this.parent; },
    focus() {},
    scrollIntoView(options) { this.scrolledIntoView = options; },
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
  let nextTimer = 0;
  const timers = new Map();
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
    { App, codeome, document, TextEncoder, TextDecoder,
      setTimeout: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; },
      clearTimeout: (id) => timers.delete(id) });
  return { App, root, errors, calls, saved: () => saved,
    flushTimers: async () => { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) await callback(); },
    setConnected: (value) => { hpcConnected = value; } };
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

const secret = (name, group, note = '') => ({ name, ...(group ? { group } : {}), note,
  terminals: false, agents: false, hpc: false });
const savedList = (root) => find(root, (node) => node.name === 'div.sec-list')[0];
const rowNames = (root) => find(savedList(root), (node) => node.name === 'b.sec-name').map((node) => node.textContent);
const groupHeads = (root) => find(savedList(root), (node) => node.name === 'button.sec-group-head');
const groupHead = (root, label) => groupHeads(root).find((node) => node.children[0].textContent === label);
const groupRows = (head) => head.parent.children[head.parent.children.indexOf(head) + 1];
const suggestions = (input) => find(input.parent, (node) => node.attrs.role === 'option');

test('Secrets groups sort without case sensitivity, count their rows, and put Ungrouped last', async () => {
  const view = load({ secrets: [secret('ZETA_TOKEN', 'zeta'), secret('FIRST_ALPHA', 'alpha'),
    secret('FREE_TOKEN'), secret('BETA_TOKEN', 'Beta'), secret('SECOND_ALPHA', 'alpha')] });
  await view.App.views.settings.open('secrets');
  assert.deepEqual(groupHeads(view.root).map((head) => [head.children[0].textContent, head.children[1].textContent]),
    [['alpha', '2'], ['Beta', '1'], ['zeta', '1'], ['Ungrouped', '1']]);
  assert.deepEqual(rowNames(view.root), ['FIRST_ALPHA', 'SECOND_ALPHA', 'BETA_TOKEN', 'ZETA_TOKEN', 'FREE_TOKEN']);
  for (const head of groupHeads(view.root)) {
    assert.equal(head.attrs['aria-expanded'], 'true');
    assert.equal(head.parent.attrs.role, 'group');
    assert.equal(groupRows(head).attrs.role, 'list');
    assert.equal(groupRows(head).attrs.id, head.attrs['aria-controls']);
  }
});

test('Secrets without groups retain a flat list and show the empty message when none exist', async () => {
  const view = load({ secrets: [secret('SECOND_TOKEN'), secret('FIRST_TOKEN')] });
  await view.App.views.settings.open('secrets');
  assert.deepEqual(groupHeads(view.root), []);
  assert.deepEqual(rowNames(view.root), ['SECOND_TOKEN', 'FIRST_TOKEN']);
  assert.equal(savedList(view.root).children[0].attrs.role, 'list');
  assert.deepEqual(savedList(view.root).children[0].children.map((node) => node.name), ['div.sec-row', 'div.sec-row']);

  const empty = load({ secrets: [] });
  await empty.App.views.settings.open('secrets');
  assert.equal(find(savedList(empty.root), (node) => node.name === 'div.sp-empty')[0].textContent, 'None yet. Add one below.');
});

test('Group headers collapse and expand their row containers', async () => {
  const view = load({ secrets: [secret('BUILD_TOKEN', 'Build'), secret('DEPLOY_TOKEN', 'Deploy')] });
  await view.App.views.settings.open('secrets');
  groupHead(view.root, 'Build').attrs.onclick();
  assert.equal(groupHead(view.root, 'Build').attrs['aria-expanded'], 'false');
  assert.equal(groupRows(groupHead(view.root, 'Build')).hidden, true);
  assert.equal(groupRows(groupHead(view.root, 'Deploy')).hidden, false);
  groupHead(view.root, 'Build').attrs.onclick();
  assert.equal(groupHead(view.root, 'Build').attrs['aria-expanded'], 'true');
  assert.equal(groupRows(groupHead(view.root, 'Build')).hidden, false);
});

test('Search narrows rows, expands collapsed groups, and suggests name and group matches up to eight', async () => {
  const secrets = Array.from({ length: 10 }, (_unused, i) => secret(`ITEM_${String(i).padStart(2, '0')}`, 'Research'));
  secrets.push(secret('OTHER_TOKEN', 'Tools'));
  const view = load({ secrets });
  await view.App.views.settings.open('secrets');
  groupHead(view.root, 'Research').attrs.onclick();
  const search = control(view.root, 'Search secrets');
  search.value = 'item_03'; search.attrs.oninput();
  assert.deepEqual(rowNames(view.root), ['ITEM_03']);
  assert.equal(groupHead(view.root, 'Research').attrs['aria-expanded'], 'true');
  assert.equal(groupRows(groupHead(view.root, 'Research')).hidden, false);
  assert.deepEqual(suggestions(search).map((item) => item.children[0].textContent), ['ITEM_03']);
  search.value = 'rEsEaRcH'; search.attrs.oninput();
  assert.equal(rowNames(view.root).length, 10);
  assert.equal(suggestions(search).length, 8);
  assert.deepEqual(suggestions(search).map((item) => item.children[0].textContent),
    secrets.slice(0, 8).map((item) => item.name));
  assert.equal(search.attrs['aria-expanded'], 'true');
  assert.equal(search.parent.children[1].hidden, false);
  control(view.root, 'Clear search').attrs.onclick();
  assert.equal(search.value, '');
  assert.equal(search.attrs['aria-expanded'], 'false');
  assert.equal(rowNames(view.root).length, 11);
  assert.equal(groupRows(groupHead(view.root, 'Research')).hidden, true);
});

test('Search keyboard selection clears the query, opens the picked group, scrolls and highlights its row', async () => {
  const view = load({ secrets: [secret('FIRST_ITEM', 'Tools'), secret('SECOND_ITEM', 'Tools'), secret('OTHER_TOKEN', 'Build')] });
  await view.App.views.settings.open('secrets');
  groupHead(view.root, 'Tools').attrs.onclick();
  const search = control(view.root, 'Search secrets');
  search.value = 'item'; search.attrs.oninput();
  search.attrs.onkeydown({ key: 'ArrowDown' });
  search.attrs.onkeydown({ key: 'ArrowDown' });
  assert.equal(search.attrs['aria-activedescendant'], suggestions(search)[1].attrs.id);
  search.attrs.onkeydown({ key: 'Enter' });
  assert.equal(search.value, '');
  assert.equal(search.attrs['aria-expanded'], 'false');
  assert.equal(control(view.root, 'Clear search').hidden, true);
  assert.deepEqual(rowNames(view.root), ['OTHER_TOKEN', 'FIRST_ITEM', 'SECOND_ITEM']);
  assert.equal(groupHead(view.root, 'Tools').attrs['aria-expanded'], 'true');
  const picked = find(savedList(view.root), (node) => node.name === 'div.sec-row' && node.textContent.includes('SECOND_ITEM'))[0];
  assert.equal(picked.classList.contains('sec-highlight'), true);
  assert.equal(picked.scrolledIntoView.block, 'nearest');
  let reflows = 0;
  Object.defineProperty(picked, 'offsetWidth', { get() { reflows++; return 1; } });
  search.value = 'second'; search.attrs.oninput();
  search.attrs.onkeydown({ key: 'Enter' });
  assert.equal(reflows, 1);
  assert.equal(picked.classList.contains('sec-highlight'), true);
});

test('Escape closes search suggestions, then clears the query; unmatched searches ignore notes', async () => {
  const view = load({ secrets: [secret('ALPHA_TOKEN', 'Build', 'needle'), secret('BETA_TOKEN', 'Deploy')] });
  await view.App.views.settings.open('secrets');
  const search = control(view.root, 'Search secrets');
  search.value = 'alpha'; search.attrs.oninput();
  assert.equal(search.attrs['aria-expanded'], 'true');
  search.attrs.onkeydown({ key: 'Escape' });
  assert.equal(search.attrs['aria-expanded'], 'false');
  assert.equal(search.value, 'alpha');
  assert.deepEqual(rowNames(view.root), ['ALPHA_TOKEN']);
  search.attrs.onkeydown({ key: 'Escape' });
  assert.equal(search.value, '');
  assert.deepEqual(rowNames(view.root), ['ALPHA_TOKEN', 'BETA_TOKEN']);
  search.value = 'needle'; search.attrs.oninput();
  assert.deepEqual(rowNames(view.root), []);
  assert.deepEqual(suggestions(search), []);
  assert.equal(search.parent.children[1].hidden, true);
  assert.equal(find(savedList(view.root), (node) => node.name === 'div.sp-empty')[0].textContent, 'No matching secrets.');
});

test('Editing row groups persists trimmed and capped values, and removing a group deletes it', async () => {
  const view = load({ secrets: [secret('ALPHA_TOKEN', 'Old')] });
  await view.App.views.settings.open('secrets');
  let group = control(view.root, 'Group for ALPHA_TOKEN');
  group.value = '  New Group  ';
  group.attrs.onchange({ target: group });
  await view.flushTimers();
  await new Promise(setImmediate);
  assert.equal(view.saved().secrets[0].group, 'New Group');
  assert.equal(groupHead(view.root, 'New Group').children[1].textContent, '1');

  group = control(view.root, 'Group for ALPHA_TOKEN');
  group.value = `  ${'G'.repeat(65)}  `;
  group.attrs.onchange({ target: group });
  await view.flushTimers();
  await new Promise(setImmediate);
  assert.equal(view.saved().secrets[0].group, 'G'.repeat(60));
  assert.equal(group.value, 'G'.repeat(60));

  group = control(view.root, 'Group for ALPHA_TOKEN');
  group.value = '   ';
  group.attrs.onchange({ target: group });
  await view.flushTimers();
  await new Promise(setImmediate);
  assert.equal('group' in view.saved().secrets[0], false);
  assert.deepEqual(groupHeads(view.root), []);
});

test('The add form saves a trimmed, capped group on a new secret', async () => {
  const view = load({ secrets: [] });
  await view.App.views.settings.open('secrets');
  control(view.root, 'Name').value = 'NEW_TOKEN';
  control(view.root, 'Value').value = 'abc123';
  control(view.root, 'Group for new secret').value = `  ${'A'.repeat(65)}  `;
  await button(view.root, 'Save').attrs.onclick();
  await new Promise(setImmediate);
  assert.equal(view.saved().secrets[0].group, 'A'.repeat(60));
  assert.equal(groupHead(view.root, 'A'.repeat(60)).children[1].textContent, '1');
});

test('Row and add-form group comboboxes offer existing groups and save picked suggestions', async () => {
  const view = load({ secrets: [secret('ALPHA_TOKEN', 'Build'), secret('BETA_TOKEN', 'Deploy'), secret('GAMMA_TOKEN', 'Build')] });
  await view.App.views.settings.open('secrets');
  const rowGroup = control(view.root, 'Group for ALPHA_TOKEN');
  assert.equal(rowGroup.attrs.role, 'combobox');
  rowGroup.attrs.onfocus();
  assert.deepEqual(suggestions(rowGroup).map((item) => item.textContent), ['Build']);
  rowGroup.value = ''; rowGroup.attrs.oninput();
  assert.deepEqual(suggestions(rowGroup).map((item) => item.textContent), ['Build', 'Deploy']);
  rowGroup.value = 'dEp'; rowGroup.attrs.oninput();
  assert.deepEqual(suggestions(rowGroup).map((item) => item.textContent), ['Deploy']);
  suggestions(rowGroup)[0].attrs.onmousedown({ preventDefault() {} });
  await view.flushTimers();
  await new Promise(setImmediate);
  assert.equal(view.saved().secrets[0].group, 'Deploy');

  const addGroup = control(view.root, 'Group for new secret');
  assert.equal(addGroup.attrs.role, 'combobox');
  addGroup.attrs.onfocus();
  assert.deepEqual(suggestions(addGroup).map((item) => item.textContent), ['Build', 'Deploy']);
  suggestions(addGroup)[0].attrs.onmousedown({ preventDefault() {} });
  assert.equal(addGroup.value, 'Build');
  control(view.root, 'Name').value = 'NEW_TOKEN';
  control(view.root, 'Value').value = 'abc123';
  await button(view.root, 'Save').attrs.onclick();
  assert.equal(view.saved().secrets.at(-1).group, 'Build');
});

test('Enter keeps a typed group unless a suggestion is highlighted', async () => {
  const view = load({ secrets: [secret('PROD_TOKEN', 'Production'), secret('DEV_TOKEN', 'Development')] });
  await view.App.views.settings.open('secrets');
  const group = control(view.root, 'Group for DEV_TOKEN');
  group.value = 'Prod'; group.attrs.oninput();
  assert.deepEqual(suggestions(group).map((item) => item.textContent), ['Production']);
  let prevented = false;
  group.attrs.onkeydown({ key: 'Enter', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(group.value, 'Prod');
  assert.equal(group.attrs['aria-expanded'], 'false');
  group.attrs.onchange({ target: group });
  await new Promise(setImmediate);
  assert.equal(view.App.cfg.secrets[1].group, 'Prod');

  const addGroup = control(view.root, 'Group for new secret');
  addGroup.value = 'Prod'; addGroup.attrs.oninput();
  addGroup.attrs.onkeydown({ key: 'Enter' });
  assert.equal(addGroup.value, 'Prod');
});

test('Enter picks a highlighted group suggestion', async () => {
  const view = load({ secrets: [secret('PROD_TOKEN', 'Production'), secret('DEV_TOKEN', 'Development')] });
  await view.App.views.settings.open('secrets');
  const group = control(view.root, 'Group for DEV_TOKEN');
  group.value = 'Prod'; group.attrs.oninput();
  group.attrs.onkeydown({ key: 'ArrowDown' });
  let prevented = false;
  group.attrs.onkeydown({ key: 'Enter', preventDefault: () => { prevented = true; } });
  await new Promise(setImmediate);
  assert.equal(prevented, true);
  assert.equal(view.App.cfg.secrets[1].group, 'Production');

  const addGroup = control(view.root, 'Group for new secret');
  addGroup.value = 'Prod'; addGroup.attrs.oninput();
  addGroup.attrs.onkeydown({ key: 'ArrowDown' });
  addGroup.attrs.onkeydown({ key: 'Enter' });
  assert.equal(addGroup.value, 'Production');
});

test('Collapsed groups and the search query survive a group edit redraw', async () => {
  const view = load({ secrets: [secret('BUILD_TOKEN', 'Build'), secret('DEPLOY_TOKEN', 'Deploy')] });
  await view.App.views.settings.open('secrets');
  groupHead(view.root, 'Build').attrs.onclick();
  const search = control(view.root, 'Search secrets');
  search.value = 'TOKEN'; search.attrs.oninput();
  const group = control(view.root, 'Group for DEPLOY_TOKEN');
  group.value = 'Operations'; group.attrs.onchange({ target: group });
  await new Promise(setImmediate);
  assert.equal(control(view.root, 'Search secrets').value, 'TOKEN');
  assert.deepEqual(rowNames(view.root), ['BUILD_TOKEN', 'DEPLOY_TOKEN']);
  control(view.root, 'Clear search').attrs.onclick();
  assert.equal(groupHead(view.root, 'Build').attrs['aria-expanded'], 'false');
  assert.equal(groupRows(groupHead(view.root, 'Build')).hidden, true);
});

test('Group headers toggle visibly during search and reset their override when the query changes', async () => {
  const view = load({ secrets: [secret('BUILD_TOKEN', 'Build'), secret('DEPLOY_TOKEN', 'Deploy')] });
  await view.App.views.settings.open('secrets');
  const search = control(view.root, 'Search secrets');
  search.value = 'build'; search.attrs.oninput();
  groupHead(view.root, 'Build').attrs.onclick();
  assert.equal(groupHead(view.root, 'Build').attrs['aria-expanded'], 'false');
  assert.equal(groupRows(groupHead(view.root, 'Build')).hidden, true);
  groupHead(view.root, 'Build').attrs.onclick();
  assert.equal(groupHead(view.root, 'Build').attrs['aria-expanded'], 'true');
  groupHead(view.root, 'Build').attrs.onclick();
  search.value = 'token'; search.attrs.oninput();
  assert.equal(groupHead(view.root, 'Build').attrs['aria-expanded'], 'true');
});

test('Saved secret lists contain only listitems', async () => {
  for (const secrets of [[secret('PLAIN_TOKEN')], [secret('BUILD_TOKEN', 'Build'), secret('FREE_TOKEN')]]) {
    const view = load({ secrets });
    await view.App.views.settings.open('secrets');
    const lists = find(savedList(view.root), (node) => node.attrs.role === 'list');
    assert.ok(lists.length);
    for (const list of lists) {
      assert.ok(list.children.length);
      assert.ok(list.children.every((child) => child.attrs.role === 'listitem'));
    }
    if (secrets.some((item) => item.group)) {
      assert.deepEqual(lists.map((list) => list.attrs['aria-label']), ['Build', 'Ungrouped']);
      assert.ok(groupHeads(view.root).every((head) => head.parent.attrs.role === 'group'));
    } else assert.equal(lists[0].attrs['aria-label'], 'Saved secrets');
  }
});
