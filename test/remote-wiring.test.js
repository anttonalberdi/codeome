const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { validateRemoteConfig } = require('../main/remote-server');
const { createRemote, validateTabsPayload } = require('../main/remote');

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
  const context = { cfg: { remoteDevices: [{ id: 'private', tokenHash: 'secret' }],
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
    chats: new Map(), fs: { existsSync: () => true }, chat: { engineOf: (value) => value },
    createAgentSession: () => ({ s: session, acct: { info: { name: 'Default' } } }),
    remote: { attach: () => calls.push('attach'), detach: () => calls.push('detach') },
    send() {}, scratch: { isScratch: () => false }, stats: { record() {} }, console
  });
  assert.match(handlers['chat:start'](null, { id: 'chat', project: '/project', engine: 'claude' }).error, /failed start/);
  assert.deepEqual(calls, ['attach', 'detach']);
});
