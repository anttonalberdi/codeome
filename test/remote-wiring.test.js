const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { validateRemoteConfig } = require('../main/remote-server');
const { createRemote, validateTabsPayload } = require('../main/remote');
const notifySettings = require('../main/notifysettings');

const main = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '../main/preload.js'), 'utf8');
const settings = fs.readFileSync(path.join(__dirname, '../renderer/js/settings.js'), 'utf8');

function section(start, end) {
  const from = main.indexOf(start), to = main.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return main.slice(from, to);
}

test('config IPC hides device credentials and preserves them on renderer save', () => {
  const handlers = {};
  let configChanges = 0;
  const events = new EventEmitter();
  events.on('config-changed', () => configChanges++);
  const context = { notifySettings, cfg: { remoteDevices: [{ id: 'private', tokenHash: 'secret' }],
    remote: { enabled: false }, accounts: {}, secrets: [], gitAccounts: [], projectAccounts: {} },
  remote: { events }, pruneRemoteTabs() {},
  ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
  config: { save: (value) => { const error = validateRemoteConfig(value.remote); if (error) throw new Error(error); return value; } },
  usage: { ENV_VAR: {} }, awake: { sync() {} }, remoteService: { sync() {} },
  applyProxy() {}, publishUsage() {}, syncAllSecretsQuietly() {}, mirrorGeneralQuietly() {}
  };
  vm.runInNewContext(section("ipcMain.handle('config:get'", "ipcMain.on('log:renderer'") +
    section("ipcMain.handle('config:set'", "ipcMain.handle('remote:status'"), context);
  const publicConfig = handlers['config:get']();
  assert.equal(publicConfig.remoteDevices, undefined);
  const result = handlers['config:set'](null, { ...publicConfig, remote: { enabled: true } });
  assert.equal(result.remoteDevices, undefined);
  assert.equal(context.cfg.remoteDevices[0].tokenHash, 'secret');
  assert.equal(configChanges, 1);
  const forged = handlers['config:set'](null, { ...result, remoteDevices: [{ id: 'forged' }] });
  assert.equal(forged.remoteDevices, undefined);
  assert.equal(context.cfg.remoteDevices[0].tokenHash, 'secret');
  const current = context.cfg;
  assert.throws(() => handlers['config:set'](null, { ...result,
    remote: { requireDesktopFor: [{ tool: 'Bash', pattern: '[' }] } }), /Invalid remote rule pattern/);
  assert.equal(context.cfg, current);
});

test('chat respond IPC uses the session for a request missing from the registry', () => {
  const handlers = {}, calls = [];
  const remote = createRemote({ send() {}, loadChat() {} });
  const session = new EventEmitter();
  session.respond = (id, payload) => calls.push([id, payload]);
  remote.attach(session, 'chat');
  vm.runInNewContext(section("ipcMain.handle('chat:respond'", "ipcMain.handle('chat:pending'"), {
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, remote
  });
  const response = { behavior: 'deny' };
  assert.deepEqual(handlers['chat:respond'](null, { id: 'chat', requestId: 'late', response }), { ok: true });
  assert.deepEqual(calls, [['late', response]]);
  remote.detach('chat');
});

test('device rename and HPC file rename use distinct IPC routes', async () => {
  const handlers = {}, commands = [], renamed = [];
  vm.runInNewContext(section("ipcMain.handle('remote:renameDevice'", "ipcMain.handle('remote:delete'"), {
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    remoteService: { rename: (...args) => { renamed.push(args); return true; } },
    ssh: { exec: async (_host, command) => { commands.push(command); return { code: 0 }; } },
    cfg: { hpc: { host: 'hpc' } }, q: (value) => JSON.stringify(value)
  });
  assert.equal(handlers['remote:renameDevice'](null, { id: 'a'.repeat(32), label: 'Phone' }), true);
  assert.deepEqual(renamed, [['a'.repeat(32), 'Phone']]);
  assert.equal((await handlers['remote:rename'](null, { from: 'a'.repeat(32), to: 'new' })).ok, true);
  assert.deepEqual(commands, ['mv "' + 'a'.repeat(32) + '" "new"']);
  assert.match(preload, /rename: \(from, to\) => ipcRenderer\.invoke\('remote:rename', \{ from, to \}\)/);
  assert.match(preload, /renameDevice: \(id, label\) => ipcRenderer\.invoke\('remote:renameDevice', \{ id, label \}\)/);
  assert.match(settings, /codeome\.remote\.renameDevice\(device\.id, next\)/);
  assert.match(settings, /result\.error === 'no-magicdns' \? "Tailscale's HTTPS name is not available\. Follow the Tailscale setup steps above/);
  assert.match(settings, /void checkTailscale\(\);\s*try \{ paintStatus/);
  assert.match(settings, /App\.setup\.install\(\['tailscale'\]/);
});

test('Serve IPC accepts only setup and stop actions', async () => {
  const handlers = {}, calls = [];
  vm.runInNewContext(section("ipcMain.handle('remote:serve'", "ipcMain.handle('remote:ntfy'"), {
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    remoteService: { serveSetup: (port) => { calls.push(['setup', port]); return 'setup-ok'; },
      serveStop: () => { calls.push('stop'); return 'stop-ok'; } }
  });
  assert.equal(handlers['remote:serve'](null, { action: 'setup' }), 'setup-ok');
  assert.equal(handlers['remote:serve'](null, { action: 'setup', expectedHttpsPort: 8443 }), 'setup-ok');
  assert.equal(handlers['remote:serve'](null, { action: 'stop' }), 'stop-ok');
  for (const payload of [null, {}, { action: 'funnel' }, { action: 'SETUP' }, { action: ['setup'] },
    { action: 'setup', expectedHttpsPort: 80 }, { action: 'setup', expectedHttpsPort: '443' },
    { action: 'setup', expectedHttpsPort: null }])
    assert.equal(handlers['remote:serve'](null, payload).error, 'invalid-action');
  assert.deepEqual(calls, [['setup', undefined], ['setup', 8443], 'stop']);
  assert.match(preload, /serve: \(payload\) => ipcRenderer\.invoke\('remote:serve', payload\)/);
  assert.match(settings, /expectedHttpsPort: fresh\.serve\.httpsPort/);
  assert.match(settings, /!companionReady\(\)/);
  assert.match(settings, /If you created this exact mapping yourself, it will be removed too/);
});

test('Serve setup stays disabled until the companion listens, and completed steps disappear', async () => {
  const make = (name, attrs, ...children) => {
    if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs) || attrs.fakeNode) {
      children.unshift(attrs); attrs = {};
    }
    const node = { name, attrs, fakeNode: true, children: children.flat(Infinity).filter((child) => child != null),
      disabled: !!attrs.disabled, title: attrs.title || '', hidden: !!attrs.hidden,
      append(...items) { this.children.push(...items.flat(Infinity).filter((item) => item != null)); },
      replaceChildren(...items) { this.children = []; this.append(...items); },
      get textContent() { return this.children.map((child) => typeof child === 'string' ? child : child.textContent).join(''); },
      set textContent(value) { this.children = [String(value)]; } };
    return node;
  };
  const find = (node, predicate) => !node || typeof node !== 'object' ? [] :
    [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap((child) => find(child, predicate))];
  let status = { enabled: false, listening: false, mode: 'serve', port: 47821, devices: [] };
  let notifyStatus;
  const tailscale = { installed: true, running: true, loggedIn: true, dnsName: 'mac.tailnet.ts.net',
    serve: { state: 'off', httpsPort: 443 }, command: 'tailscale serve --bg --https=443 http://127.0.0.1:47821' };
  const context = { h: make, phoneController: null,
    section: (_id, _title, _intro, ...children) => make('section', {}, ...children),
    card: (_title, ...children) => make('card', {}, ...children),
    row: (_label, control) => make('row', {}, control),
    check: () => make('check'), select: () => make('select'),
    stepRow: (_state, title, detail) => make('step', {}, title, detail),
    btn: (label, onclick) => make('button', { onclick }, label),
    App: { cfg: { remote: { enabled: false, mode: 'serve', port: 0, ntfy: {} } } },
    codeome: { remote: { onStatus: (callback) => { notifyStatus = callback; return () => {}; },
      status: async () => status, tailscale: async () => tailscale } },
    clearInterval() {}, setInterval() {} };
  const start = settings.indexOf('  const PHONE_BASH_DEFAULTS');
  const end = settings.indexOf('  function appearanceSection(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(`${settings.slice(start, end)}\nthis.phoneSection = phoneSection;`, context);
  const view = context.phoneSection({ remote: context.App.cfg.remote });
  await context.phoneController.start();
  await new Promise(setImmediate);
  const result = find(view, (node) => node.name === 'div.phone-helper-result')[0];
  const setup = find(result, (node) => node.name === 'button.btn.small' && node.textContent === 'Set up Tailscale Serve')[0];
  assert.equal(setup.disabled, true);
  assert.match(setup.title, /Turn on the phone companion/);
  assert.match(result.textContent, /HTTPS Certificates/);
  status = { ...status, enabled: true, listening: true };
  notifyStatus(status);
  assert.equal(setup.disabled, false);
  tailscale.serve = { state: 'active', httpsPort: 443, url: 'https://mac.tailnet.ts.net' };
  const check = find(view, (node) => node.name === 'button.btn.small' && node.textContent === 'Check Tailscale')[0];
  assert.ok(check);
  await check.attrs.onclick();
  assert.equal(find(result, (node) => node.name === 'ol').length, 0);
  assert.match(result.textContent, /Run it yourself/);
});

test('remote tabs IPC accepts known projects, coalesces latest payload and prunes old projects', () => {
  const handlers = {};
  const remote = createRemote({ send() {} });
  const timers = new Map();
  let nextTimer = 0;
  const setTimeout = (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; };
  const clearTimeout = (id) => timers.delete(id);
  const tick = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach((fn) => fn()); };
  const context = { ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, remote,
    path, setTimeout, clearTimeout, validateTabsPayload, cfg: { openProjects: ['/known'], activeProject: '/known' }, chats: new Map() };
  vm.runInNewContext(section('const pendingRemoteTabs', "ipcMain.handle('remote:pair'"), context);
  const tab = { id: 'chat', title: 'Chat', state: 'idle', label: 'Finished; session open',
    jobs: 0, engine: 'claude', role: '', active: true, updatedAt: 12 };
  assert.equal(handlers['remote:tabs'](null, { project: '/known', tabs: [tab] }).ok, true);
  assert.equal(remote.tabs.get('/known').tabs[0].id, 'chat');
  handlers['remote:tabs'](null, { project: '/known/', tabs: [{ ...tab, title: 'Second' }] });
  handlers['remote:tabs'](null, { project: '/known', tabs: [{ ...tab, title: 'Latest' }] });
  assert.equal(remote.tabs.get('/known').tabs[0].title, 'Chat');
  tick();
  assert.equal(remote.tabs.get('/known').tabs[0].title, 'Latest');
  tick();
  assert.equal(timers.size, 0);
  assert.match(handlers['remote:tabs'](null, { project: '/forged', tabs: [] }).error, /Invalid/);
  assert.match(handlers['remote:tabs'](null, { project: '/known', tabs: [{ ...tab, jobs: NaN }] }).error, /Invalid/);
  context.cfg = { openProjects: ['/other'], activeProject: '/other' };
  handlers['remote:tabs'](null, { project: '/other', tabs: [] });
  assert.deepEqual([...remote.tabs.keys()], ['/other']);
  context.clearRemoteTabs();
  tick();
  assert.equal(remote.tabs.size, 0);
  assert.equal(timers.size, 0);
  assert.match(main, /win\.webContents\.on\('render-process-gone', clearRemoteTabs\)/);
  assert.match(main, /win\.webContents\.on\('destroyed', clearRemoteTabs\)/);
  assert.match(preload, /tabs: \(payload\) => ipcRenderer\.invoke\('remote:tabs', payload\)/);
});

test('a failed chat start detaches the remote session', () => {
  const handlers = {}, calls = [];
  const session = new EventEmitter();
  session.start = () => { throw new Error('failed start'); };
  vm.runInNewContext(section("ipcMain.handle('chat:start'", 'const forumHost ='), {
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    ChatCode: require('../renderer/js/chat-code'),
    chats: new Map(), fs: { existsSync: () => true }, chat: { engineOf: (value) => value, listChats: () => [] },
    createAgentSession: () => ({ s: session, acct: { info: { name: 'Default' } } }),
    createInboxIpc: () => ({}), inboxWire: { onAssistantEvent() {} },
    remote: { attach: () => calls.push('attach'), detach: () => calls.push('detach') },
    send() {}, scratch: { isScratch: () => false }, stats: { record() {} }, console
  });
  assert.match(handlers['chat:start'](null, { id: 'chat', project: '/project', engine: 'claude' }).error, /failed start/);
  assert.deepEqual(calls, ['attach', 'detach']);
});
