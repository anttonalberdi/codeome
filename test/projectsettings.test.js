const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { POLICY_DEFAULTS } = require('../main/policy');
const NotifySettings = require('../main/notifysettings');

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

function load(options = {}) {
  const root = element('section');
  const listeners = {};
  const writes = [];
  const App = {
    h, views: { projects: { linkPicker: () => h('div.link-pick') } }, cfg: { projectPolicy: {}, policyDefaults: {}, projectChat: {}, projectNotify: {}, notifications: NotifySettings.sanitize(), chat: {}, agents: [{ cmd: 'claude' }] }, project: '/projects/alpha', currentView: 'projectSettings', notifySettings: NotifySettings,
    basename: (value) => path.basename(value), isIdeas: (value) => value === '/projects/ideas',
    prompt: async () => null,
    saveConfig: async () => { writes.push(JSON.parse(JSON.stringify(App.cfg))); App.emit('config', App.cfg); },
    listen: (event, fn) => { (listeners[event] ||= []).push(fn); },
    emit: (event, value) => (listeners[event] || []).forEach((fn) => fn(value))
  };
  if (options.noNotifySettings) delete App.notifySettings;
  const codeome = {
    policy: { defaults: async () => POLICY_DEFAULTS }, agents: { models: async () => ({ codex: { models: [{ id: 'gpt-test', label: 'GPT Test' }] } }) },
    config: { set: async (cfg) => { writes.push(JSON.parse(JSON.stringify(cfg))); return cfg; } },
    notify: { test: async () => ({ ok: true, supported: true }) }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/js/agentdefaults.js'), 'utf8'), { App });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/js/projectsettings.js'), 'utf8'),
    { App, codeome, document: { querySelector: () => root } });
  return { App, root, writes, codeome };
}

const row = (root, scope, key) => find(root, (node) => node.attrs[`data-${scope}-key`] === key)[0];
const choice = (root, key, label) => find(row(root, 'policy', key), (node) => node.name.startsWith('button') && node.children.includes(label))[0];
const chatSelect = (root, key) => find(row(root, 'chat', key), (node) => node.name === 'select')[0];
const notifyControl = (root, key) => find(row(root, 'notify', key), (node) => node.name === 'select' || node.name === 'input')[0];
const text = (node) => find(node, (item) => item.children?.some((child) => typeof child === 'string')).flatMap((item) => item.children.filter((child) => typeof child === 'string')).join(' ');

test('renders one control per policy switch from backend defaults', async () => {
  const { App, root } = load();
  App.views.projectSettings.init();
  await new Promise(setImmediate);
  const rows = find(root, (node) => node.attrs['data-policy-key']);
  assert.deepEqual(rows.map((row) => row.attrs['data-policy-key']), POLICY_DEFAULTS.map((item) => item.key));
  assert.equal(rows.filter((row) => find(row, (node) => node.attrs.role === 'radiogroup' || node.attrs.role === 'switch').length === 1).length, POLICY_DEFAULTS.length);
});

test('inherited policy shows the app default and built-in choice is saved explicitly', async () => {
  const { App, root, writes } = load();
  App.cfg.policyDefaults.slurmSubmit = 'never';
  App.views.projectSettings.init();
  await new Promise(setImmediate);
  assert.match(text(row(root, 'policy', 'slurmSubmit')), /App default: Never/);
  assert.equal(choice(root, 'slurmSubmit', 'Never').attrs['aria-checked'], 'true');
  await choice(root, 'slurmSubmit', 'Ask').attrs.onclick();
  assert.equal(App.cfg.projectPolicy['/projects/alpha'].slurmSubmit, 'ask');
  assert.equal(writes.at(-1).projectPolicy['/projects/alpha'].slurmSubmit, 'ask');
  assert.match(text(row(root, 'policy', 'slurmSubmit')), /overridden/);
  await choice(root, 'slurmSubmit', 'Use app default').attrs.onclick();
  assert.equal(Object.hasOwn(App.cfg.projectPolicy, '/projects/alpha'), false);
  assert.match(text(row(root, 'policy', 'slurmSubmit')), /App default: Never/);
});

test('each project keeps its own policy', async () => {
  const { App, root } = load();
  App.views.projectSettings.init();
  await new Promise(setImmediate);
  await choice(root, 'slurmSubmit', 'Never').attrs.onclick();
  App.project = '/projects/beta';
  App.emit('project', App.project);
  assert.equal(find(root, (node) => node.attrs.role === 'radio' && node.children.includes('Ask'))[0].attrs['aria-checked'], 'true');
  await choice(root, 'slurmSubmit', 'Allow (best effort)').attrs.onclick();
  await chatSelect(root, 'engine').attrs.onchange({ target: { value: 'codex' } });
  assert.equal(App.cfg.projectPolicy['/projects/alpha'].slurmSubmit, 'never');
  assert.equal(App.cfg.projectPolicy['/projects/beta'].slurmSubmit, 'allow');
  assert.equal(App.cfg.projectChat['/projects/beta'].engine, 'codex');
  assert.equal(Object.hasOwn(App.cfg.projectChat, '/projects/alpha'), false);
});

test('Ideas has agent rules and reset clears only its own overrides', async () => {
  const { App, root } = load();
  App.views.projectSettings.init();
  await new Promise(setImmediate);
  App.project = '/projects/ideas';
  App.emit('project', App.project);
  await choice(root, 'slurmSubmit', 'Never').attrs.onclick();
  assert.equal(App.cfg.projectPolicy['/projects/ideas'].slurmSubmit, 'never');
  await find(root, (node) => node.name.startsWith('button') && node.children.includes('Reset to app defaults'))[0].attrs.onclick();
  assert.equal(Object.hasOwn(App.cfg.projectPolicy, '/projects/ideas'), false);
  assert.ok(find(root, (node) => node.children.includes('Ideas')).length);
  assert.equal(find(root, (node) => node.children.includes('HPC folders')).length, 0);
});

test('HPC folders can be added, deduplicated, removed and saved per project', async () => {
  const { App, root, writes } = load();
  App.remoteDir = '/cluster/current';
  App.views.projectSettings.init();
  await new Promise(setImmediate);
  const button = (label) => find(root, (node) => node.name.startsWith('button') && node.children.includes(label))[0];
  const input = () => find(root, (node) => node.attrs['aria-label'] === 'HPC folder path')[0];
  const error = () => find(root, (node) => node.name === 'span.ps-field-error').at(-1).textContent;
  input().value = ' /cluster/project/// ';
  await button('Add folder').attrs.onclick();
  assert.deepEqual(Array.from(App.cfg.projectHpc['/projects/alpha'].paths), ['/cluster/project']);
  assert.deepEqual(writes.at(-1).projectHpc['/projects/alpha'].paths, ['/cluster/project']);
  input().value = '/cluster/project/';
  button('Add folder').attrs.onclick();
  assert.match(error(), /already listed/);
  input().value = 'relative/path';
  button('Add folder').attrs.onclick();
  assert.match(error(), /absolute HPC path/);
  await button('Use current HPC folder').attrs.onclick();
  assert.deepEqual(Array.from(App.cfg.projectHpc['/projects/alpha'].paths), ['/cluster/project', '/cluster/current']);
  await find(root, (node) => node.attrs['aria-label'] === 'Remove HPC folder /cluster/project')[0].attrs.onclick();
  assert.deepEqual(Array.from(App.cfg.projectHpc['/projects/alpha'].paths), ['/cluster/current']);
  input().value = '~/work/';
  await button('Add folder').attrs.onclick();
  assert.deepEqual(Array.from(App.cfg.projectHpc['/projects/alpha'].paths), ['/cluster/current', '~/work']);
  App.project = '/projects/beta'; App.emit('project', App.project);
  assert.equal(App.cfg.projectHpc['/projects/beta'], undefined);
});

test('agent defaults save, inherit and reset alongside policy overrides', async () => {
  const { App, root } = load();
  App.cfg.chat = { model: 'sonnet', effort: 'high', codexModel: 'gpt-test', codexEffort: 'medium', mode: 'auto', engine: 'codex' };
  App.views.projectSettings.init();
  await new Promise(setImmediate);
  assert.match(text(row(root, 'chat', 'model')), /App default: Sonnet \(latest\)/);
  assert.match(text(row(root, 'chat', 'mode')), /App default: Auto/);
  const values = { model: 'opus', effort: 'low', codexModel: 'gpt-test', codexEffort: 'high', mode: 'plan', engine: 'claude' };
  for (const [key, value] of Object.entries(values)) await chatSelect(root, key).attrs.onchange({ target: { value } });
  assert.equal(JSON.stringify(App.cfg.projectChat['/projects/alpha']), JSON.stringify(values));
  assert.match(text(row(root, 'chat', 'engine')), /overridden/);
  await find(row(root, 'chat', 'engine'), (node) => node.name.startsWith('button') && node.children.includes('Use app default'))[0].attrs.onclick();
  assert.equal(Object.hasOwn(App.cfg.projectChat['/projects/alpha'], 'engine'), false);
  await chatSelect(root, 'model').attrs.onchange({ target: { value: '' } });
  assert.equal(Object.hasOwn(App.cfg.projectChat['/projects/alpha'], 'model'), false);
  await find(root, (node) => node.name.startsWith('button') && node.children.includes('Reset to app defaults'))[0].attrs.onclick();
  assert.equal(Object.hasOwn(App.cfg.projectChat, '/projects/alpha'), false);
});

test('custom project model names cannot start with a flag or contain padding', async () => {
  const { App, root } = load();
  App.views.projectSettings.init();
  await new Promise(setImmediate);
  for (const model of ['-model', ' opus']) {
    App.prompt = async () => model;
    const target = { value: '\u0000other' };
    await chatSelect(root, 'model').attrs.onchange({ target });
    assert.equal(target.value, '');
    assert.equal(Object.hasOwn(App.cfg.projectChat, App.project), false);
  }
});

test('config event refreshes inherited policy and agent labels', async () => {
  const { App, root } = load();
  App.views.projectSettings.init();
  await new Promise(setImmediate);
  App.cfg.policyDefaults.slurmSubmit = 'never';
  App.cfg.chat.mode = 'plan';
  App.emit('config', App.cfg);
  assert.match(text(row(root, 'policy', 'slurmSubmit')), /App default: Never/);
  assert.match(text(row(root, 'chat', 'mode')), /App default: Plan/);
  assert.equal(choice(root, 'slurmSubmit', 'Never').attrs['aria-checked'], 'true');
});

test('failed save restores the prior project overrides and shows an error', async () => {
  const { App, root, codeome } = load();
  App.views.projectSettings.init();
  await new Promise(setImmediate);
  await choice(root, 'slurmSubmit', 'Never').attrs.onclick();
  codeome.config.set = async () => { throw new Error('Disk full'); };
  await choice(root, 'slurmSubmit', 'Ask').attrs.onclick();
  assert.equal(App.cfg.projectPolicy['/projects/alpha'].slurmSubmit, 'never');
  assert.match(text(root), /Disk full/);
});

test('notification overrides inherit, clean nested objects, clamp interval and reject invalid times', async () => {
  const { App, root, writes } = load();
  App.views.projectSettings.init();
  await new Promise(setImmediate);
  const project = '/projects/alpha';
  const toggle = (key, value) => notifyControl(root, key).attrs.onchange({ target: { value } });
  assert.match(text(row(root, 'notify', 'enabled')), /App default: On/);
  assert.equal(find(notifyControl(root, 'enabled'), (node) => node.name === 'option')[0].children[0], 'Use app default');
  await toggle('enabled', 'off');
  assert.equal(App.cfg.projectNotify[project].enabled, false);
  assert.match(text(row(root, 'notify', 'enabled')), /overridden/);
  await toggle('enabled', '');
  assert.equal(Object.hasOwn(App.cfg.projectNotify, project), false);
  await toggle('events.finished', 'off');
  assert.equal(App.cfg.projectNotify[project].events.finished, false);
  assert.equal(writes.at(-1).projectNotify[project].events.finished, false);
  await toggle('events.finished', '');
  assert.equal(Object.hasOwn(App.cfg.projectNotify, project), false);
  const seconds = notifyControl(root, 'minSeconds');
  await seconds.attrs.onchange({ target: { value: '1' } });
  assert.equal(App.cfg.projectNotify[project].minSeconds, 5);
  await notifyControl(root, 'minSeconds').attrs.onchange({ target: { value: '9999' } });
  assert.equal(App.cfg.projectNotify[project].minSeconds, 600);
  const time = notifyControl(root, 'quietHours.start');
  const target = { value: '25:99', setAttribute() {} };
  time.attrs.onchange({ target });
  assert.equal(target.value, '22:00');
  assert.equal(App.cfg.projectNotify[project].quietHours, undefined);
  assert.match(find(row(root, 'notify', 'quietHours.start'), (node) => node.name === 'span.ps-field-error')[0].textContent, /HH:MM/);
  await notifyControl(root, 'quietHours.start').attrs.onchange({ target: { value: '23:00', setAttribute() {} } });
  assert.equal(App.cfg.projectNotify[project].quietHours.start, '23:00');
  await find(row(root, 'notify', 'quietHours.start'), (node) => node.attrs['aria-label'] === 'Use app default for From')[0].attrs.onclick();
  assert.equal(App.cfg.projectNotify[project].quietHours, undefined);
  await find(root, (node) => node.name.startsWith('button') && node.children.includes('Reset to app defaults'))[0].attrs.onclick();
  assert.equal(Object.hasOwn(App.cfg.projectNotify, project), false);
});

test('reset clears notification overrides and failed save restores them', async () => {
  const { App, root, codeome } = load();
  App.views.projectSettings.init();
  await new Promise(setImmediate);
  await notifyControl(root, 'events.ask').attrs.onchange({ target: { value: 'off' } });
  codeome.config.set = async () => { throw new Error('Disk full'); };
  await notifyControl(root, 'events.ask').attrs.onchange({ target: { value: 'on' } });
  assert.equal(App.cfg.projectNotify[App.project].events.ask, false);
  codeome.config.set = async (cfg) => cfg;
  await find(root, (node) => node.name.startsWith('button') && node.children.includes('Reset to app defaults'))[0].attrs.onclick();
  assert.equal(Object.hasOwn(App.cfg.projectNotify, App.project), false);
});

test('project test notification uses the current project and reports support', async () => {
  const { App, root, codeome } = load();
  App.views.projectSettings.init();
  await new Promise(setImmediate);
  let requested;
  codeome.notify.test = async (project) => { requested = project; return { ok: false, supported: false }; };
  await find(root, (node) => node.name.startsWith('button') && node.children.includes('Send test notification'))[0].attrs.onclick();
  assert.equal(requested, App.project);
  assert.equal(find(root, (node) => node.attrs.role === 'status')[0].textContent, 'Notifications are not supported here');
});

test('project notification times follow effective quiet hours and selects use visible labels', async () => {
  const { App, root } = load();
  App.views.projectSettings.init();
  await new Promise(setImmediate);
  assert.equal(notifyControl(root, 'quietHours.start').attrs.disabled, true);
  assert.equal(notifyControl(root, 'quietHours.end').attrs.disabled, true);
  const toggle = notifyControl(root, 'quietHours.enabled');
  assert.equal(toggle.attrs['aria-label'], undefined);
  assert.equal(toggle.attrs['aria-labelledby'], 'ps-notify-quietHours-enabled');
  await toggle.attrs.onchange({ target: { value: 'on' } });
  assert.equal(notifyControl(root, 'quietHours.start').attrs.disabled, false);
  assert.equal(notifyControl(root, 'quietHours.end').attrs.disabled, false);
  await notifyControl(root, 'quietHours.enabled').attrs.onchange({ target: { value: 'off' } });
  assert.equal(notifyControl(root, 'quietHours.start').attrs.disabled, true);
});

test('project notification test reports throttle and missing helper keeps other cards visible', async () => {
  const view = load();
  view.App.views.projectSettings.init();
  await new Promise(setImmediate);
  view.codeome.notify.test = async () => ({ ok: false, supported: true, throttled: true });
  await find(view.root, (node) => node.name.startsWith('button') && node.children.includes('Send test notification'))[0].attrs.onclick();
  assert.equal(find(view.root, (node) => node.attrs.role === 'status')[0].textContent, 'Please wait a moment');

  const missing = load({ noNotifySettings: true });
  missing.App.views.projectSettings.init();
  await new Promise(setImmediate);
  assert.match(text(missing.root), /Notification settings are unavailable: reload Codeome/);
  assert.match(text(missing.root), /Agent policy/);
  assert.match(text(missing.root), /Agent defaults/);
});
