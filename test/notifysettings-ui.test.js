const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const NotifySettings = require('../main/notifysettings');

function find(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  return [...(predicate(node) ? [node] : []), ...(node.children || []).flatMap((child) => find(child, predicate))];
}
function element(name, attrs = {}, children = []) {
  const node = { name, attrs, children: children.flat(Infinity).filter((child) => child != null), fakeNode: true,
    value: attrs.value ?? '', hidden: !!attrs.hidden,
    classList: { add() {}, remove() {}, toggle() {} },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items.flat(Infinity); },
    querySelectorAll() { return []; }, querySelector() { return null; }, focus() {},
    setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; },
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
function load(options = {}) {
  const root = element('div');
  const timers = new Map();
  let next = 0, saves = 0;
  let testResult = { ok: true, supported: true };
  const App = { h, views: {}, cfg: { notifications: NotifySettings.sanitize() }, notifySettings: NotifySettings,
    listen() {}, saveConfig: async () => { saves++; } };
  if (options.noNotifySettings) delete App.notifySettings;
  const codeome = { notify: { test: async () => testResult } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/js/settings.js'), 'utf8'),
    { App, codeome, document: { getElementById: () => root, addEventListener() {} },
      setTimeout: (fn) => { const id = ++next; timers.set(id, fn); return id; },
      clearTimeout: (id) => timers.delete(id) });
  return { App, root, setTestResult: (value) => { testResult = value; },
    flush: async () => { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) await fn(); },
    get saves() { return saves; } };
}
const control = (root, label) => find(root, (node) => node.attrs['aria-label'] === label)[0];
const button = (root, label) => find(root, (node) => node.name.startsWith('button') && node.children.includes(label))[0];

test('every general notification control saves the expected config field', async () => {
  const view = load();
  await view.App.views.settings.open('notifications');
  assert.match(view.root.textContent, /never chat text/);
  assert.match(view.root.textContent, /Notify for new issues/);
  assert.match(view.root.textContent, /Phone push \(ntfy\) is separate/);
  const checks = [
    ['Show macOS notifications', (c) => c.enabled],
    ['Agent finished or stopped with an error', (c) => c.events.finished],
    ['Agent needs your input (permission or question)', (c) => c.events.ask],
    ['Approval needed for a message between chats', (c) => c.events.approval],
    ['New message from another chat', (c) => c.events.incoming],
    ['Only when Codeome is not the front window', (c) => c.onlyUnfocused],
    ['Play a sound', (c) => c.sound],
    ['Quiet hours', (c) => c.quietHours.enabled]
  ];
  for (const [label, value] of checks) {
    const input = control(view.root, label);
    assert.equal(find(view.root, (node) => node.name === 'label.check' && node.children.includes(label)).length, 0);
    input.attrs.onchange({ target: { checked: false } });
    assert.equal(value(view.App.cfg.notifications), false, label);
    await view.flush();
  }
  assert.equal(view.saves, checks.length);
});

test('general interval clamps, invalid time is rejected, and valid time saves', async () => {
  const view = load();
  await view.App.views.settings.open('notifications');
  const seconds = control(view.root, 'At most one notification per chat every (seconds)');
  seconds.value = '';
  seconds.attrs.onchange({ target: seconds });
  assert.equal(seconds.value, '30');
  assert.match(view.root.textContent, /Enter a whole number from 5 to 600/);
  seconds.value = 'Infinity'; seconds.attrs.onchange({ target: seconds });
  assert.equal(seconds.value, '30');
  assert.equal(view.App.cfg.notifications.minSeconds, 30);
  seconds.value = '1'; seconds.attrs.onchange({ target: seconds });
  assert.equal(view.App.cfg.notifications.minSeconds, 5);
  seconds.value = '9999'; seconds.attrs.onchange({ target: seconds });
  assert.equal(view.App.cfg.notifications.minSeconds, 600);
  const from = control(view.root, 'From');
  const to = control(view.root, 'To');
  assert.equal(from.attrs.disabled, true);
  assert.equal(to.attrs.disabled, true);
  control(view.root, 'Quiet hours').attrs.onchange({ target: { checked: true } });
  assert.equal(from.disabled, false);
  assert.equal(to.disabled, false);
  from.value = '25:99'; from.attrs.onchange({ target: from });
  assert.equal(view.App.cfg.notifications.quietHours.start, '22:00');
  assert.equal(from.value, '22:00');
  assert.match(view.root.textContent, /HH:MM/);
  from.value = '23:00'; from.attrs.onchange({ target: from });
  assert.equal(view.App.cfg.notifications.quietHours.start, '23:00');
  await view.flush();
  assert.equal(view.saves, 1);
});

test('test notification reports sent, unsupported, and macOS settings hint', async () => {
  const view = load();
  await view.App.views.settings.open('notifications');
  const run = button(view.root, 'Send test notification');
  const status = find(view.root, (node) => node.attrs.role === 'status')[0];
  await run.attrs.onclick();
  assert.equal(status.textContent, 'Sent');
  view.setTestResult({ ok: false, supported: false });
  await run.attrs.onclick();
  assert.equal(status.textContent, 'Notifications are not supported here');
  view.setTestResult({ ok: false, supported: true });
  await run.attrs.onclick();
  assert.match(status.textContent, /System Settings > Notifications.*Electron/);
  view.setTestResult({ ok: false, supported: true, throttled: true });
  await run.attrs.onclick();
  assert.equal(status.textContent, 'Please wait a moment');
});

test('missing notification settings shows a reload message', async () => {
  const view = load({ noNotifySettings: true });
  await view.App.views.settings.open('notifications');
  assert.match(view.root.textContent, /Notification settings are unavailable: reload Codeome/);
});
