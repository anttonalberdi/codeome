const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { POLICY_DEFAULTS } = require('../main/policy');

function element(name, attrs = {}, children = []) {
  const node = { name, attrs, children: children.flat(Infinity).filter((child) => child != null), fakeNode: true,
    classList: { add() {}, remove() {}, toggle() {} }, append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items.flat(Infinity); },
    querySelectorAll() { return []; }, querySelector() { return null; } };
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

function load() {
  const app = element('div');
  const timers = new Map();
  let nextTimer = 0, saves = 0;
  const App = { h, views: {}, cfg: { policyDefaults: {}, agents: [{ cmd: 'claude' }] },
    listen() {}, saveConfig: async () => { saves++; } };
  const document = { getElementById: () => app, addEventListener() {} };
  const context = { App, codeome: { policy: { defaults: async () => POLICY_DEFAULTS } }, document,
    setTimeout: (fn) => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id) };
  for (const file of ['agentdefaults.js', 'settings.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/js', file), 'utf8'), context);
  }
  const flush = async () => {
    const pending = [...timers.values()]; timers.clear();
    for (const fn of pending) await fn();
  };
  return { App, app, flush, get saves() { return saves; } };
}

test('Agent policy writes app defaults and removes built-in choices', async () => {
  const view = load();
  await view.App.views.settings.open('policy');
  const section = find(view.app, (node) => node.name === 'section.sp-section' && node.attrs['data-id'] === 'policy')[0];
  assert.ok(section);
  assert.equal(find(section, (node) => node.attrs['data-policy-key']).length, POLICY_DEFAULTS.length);
  const choice = (label) => find(section, (node) => node.name === 'button' && node.children.includes(label))[0];
  choice('Never').attrs.onclick();
  assert.equal(view.App.cfg.policyDefaults.slurmSubmit, 'never');
  await view.flush();
  assert.equal(view.saves, 1);
  choice('Ask').attrs.onclick();
  assert.equal(Object.hasOwn(view.App.cfg.policyDefaults, 'slurmSubmit'), false);
  await view.flush();
  assert.equal(view.saves, 2);
});
