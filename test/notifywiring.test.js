const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const notifySettings = require('../main/notifysettings');
const { createNotifyThrottle } = require('../main/notifythrottle');

const main = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '../main/preload.js'), 'utf8');

test('notification IPC validates the sender and kind and derives project from the chat', () => {
  const section = main.slice(main.indexOf('function validNotifySender('), main.indexOf("ipcMain.handle('issues:list'"));
  assert.match(section, /event\?\.sender === win\.webContents &&\s*event\.senderFrame === win\.webContents\.mainFrame/);
  assert.match(section, /!\/\^\[A-Za-z0-9_-\]\+\$\/\.test\(payload\.chatId\)/);
  assert.match(section, /\['finished', 'error', 'ask', 'approval', 'incoming'\]\.includes\(payload\.kind\)/);
  assert.match(section, /notifySettings\.effective\(cfg, chats\.get\(payload\.chatId\)\.cwd\)/);
  assert.doesNotMatch(section, /payload\.project/);
  assert.match(section, /body: notifySettings\.body\(session\.cwd, kind, merged\)/);
  assert.equal((section.match(/if \(!notifyAllowed\(settings, /g) || []).length, 2);
  assert.match(section, /send\('notify:open', \{ chatId \}\)/);
  assert.match(main, /app\.on\('before-quit', \(\) => \{\s*quitting = true;\s*notifyThrottle\.close\(\)/);
  assert.match(main, /notifications: notifySettings\.sanitize\(c\.notifications\),\s*projectNotify: notifySettings\.sanitizeProject\(c\.projectNotify\)/);
  assert.match(preload, /show: \(payload\) => ipcRenderer\.invoke\('notify:show', payload\)/);
  assert.match(preload, /onOpen: on\('notify:open'\)/);
});

test('notification handler rejects forged senders and keeps text out of notification bodies', () => {
  const handlers = {}, shown = [], opened = [];
  let time = 10000;
  class FakeDate extends Date { static now() { return time; } }
  const frame = {}, contents = { mainFrame: frame };
  const win = { webContents: contents, isDestroyed: () => false, isFocused: () => false,
    show: () => {}, focus: () => {} };
  class Notification {
    static isSupported() { return true; }
    constructor(options) { this.options = options; this.handlers = {}; shown.push(this); }
    on(event, fn) { this.handlers[event] = fn; }
    show() {}
  }
  const context = { win, chats: new Map([['chat_1', { cwd: '/work/RealProject' }]]),
    cfg: { notifications: { onlyUnfocused: true } }, notifySettings, Notification, Date: FakeDate,
    notifyThrottle: { push: (chatId, _interval, payload) => context.showChatNotification(chatId, payload.kind, false) },
    send: (channel, payload) => opened.push([channel, payload]),
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } } };
  const section = main.slice(main.indexOf('function validNotifySender('), main.indexOf("ipcMain.handle('issues:list'"));
  vm.runInNewContext(section + '\nthis.showChatNotification = showChatNotification; this.activeChatNotifications = activeChatNotifications;', context);
  const event = { sender: contents, senderFrame: frame };
  assert.equal(handlers['notify:show']({ sender: {}, senderFrame: frame }, { chatId: 'chat_1', kind: 'ask' }).ok, false);
  assert.equal(handlers['notify:show']({ sender: contents, senderFrame: {} }, { chatId: 'chat_1', kind: 'ask' }).ok, false);
  assert.equal(handlers['notify:show'](event, { chatId: '../bad', kind: 'ask' }).ok, false);
  assert.equal(handlers['notify:show'](event, { chatId: 'chat_1', kind: 'private text' }).ok, false);
  assert.equal(handlers['notify:show'](event, { chatId: 'chat_1', kind: 'error', project: '/private/secret', text: 'private text' }).ok, true);
  assert.equal(shown[0].options.body, 'RealProject: agent stopped with an error');
  assert.equal(JSON.stringify(shown[0].options).includes('private text'), false);
  shown[0].handlers.click();
  assert.equal(context.activeChatNotifications.size, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [['notify:open', { chatId: 'chat_1' }]]);
  win.isFocused = () => true;
  assert.equal(handlers['notify:show'](event, { chatId: 'chat_1', kind: 'ask' }).ok, false);
  assert.deepEqual(JSON.parse(JSON.stringify(handlers['notify:test'](event, { project: '/private/secret' }))),
    { ok: true, supported: true });
  assert.equal(shown[1].options.body, 'test notification');
  assert.deepEqual(JSON.parse(JSON.stringify(handlers['notify:test'](event, {}))),
    { ok: false, supported: true, throttled: true });
  assert.equal(shown.length, 2);
  time += 1999;
  assert.equal(handlers['notify:test'](event, {}).throttled, true);
  time++;
  assert.equal(handlers['notify:test'](event, {}).ok, true);
  assert.equal(shown.length, 3);

  win.isFocused = () => false;
  for (let i = 0; i < 51; i++) context.showChatNotification('chat_1', 'ask');
  assert.equal(context.activeChatNotifications.size, 50);
  const last = shown.at(-1);
  last.handlers.close();
  assert.equal(context.activeChatNotifications.has(last), false);
  assert.equal(context.activeChatNotifications.size, 49);

  const ideas = { project: '/Users/me/.codeome/scratch/Ideas' };
  context.chats.set('ideas', { cwd: ideas.project });
  context.cfg.projectNotify = { [ideas.project]: { enabled: false } };
  assert.equal(notifySettings.effective(context.cfg, ideas.project).enabled, false);
  assert.equal(handlers['notify:show'](event, { chatId: 'ideas', kind: 'ask' }).ok, false);
});

test('main throttle binding passes chat id, payload kind and merged label at runtime', () => {
  let time = 0, timer;
  const shown = [];
  const declaration = main.slice(main.indexOf('const notifyThrottle = '), main.indexOf('\n', main.indexOf('const notifyThrottle = ')));
  const context = { createNotifyThrottle: (options) => createNotifyThrottle({ ...options, now: () => time,
    setTimer: (fn) => { timer = fn; return 1; }, clearTimer: () => { timer = null; } }),
  showChatNotification: (chatId, kind, merged) => shown.push([chatId, notifySettings.body('/work/RealProject', kind, merged)]) };
  vm.runInNewContext(declaration + '\nthis.throttle = notifyThrottle;', context);
  context.throttle.push('chat_1', 5, { kind: 'ask' });
  time = 1000;
  context.throttle.push('chat_1', 5, { kind: 'approval' });
  time = 5000;
  timer();
  assert.deepEqual(shown, [['chat_1', 'RealProject: needs your input'], ['chat_1', 'RealProject: new activity']]);
});
