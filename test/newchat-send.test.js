const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Xmsg = require('../renderer/js/chat-xmsg');
const Collisions = require('../renderer/js/chat-collisions');

const source = fs.readFileSync(path.join(__dirname, '../renderer/js/chat.js'), 'utf8')
  .replace('  function openJob(it) {', '  C.testRender = render;\n  function openJob(it) {');
const h = (name, attrs, ...children) => {
  if (attrs == null || typeof attrs !== 'object' || Array.isArray(attrs) || attrs.node) {
    children.unshift(attrs); attrs = {};
  }
  return { node: true, name, attrs, children: children.flat(Infinity).filter((child) => child != null), isConnected: false };
};
const content = (tree) => tree == null ? '' : typeof tree === 'object'
  ? (tree.children || []).map(content).join('') : String(tree);
const buttons = (tree) => tree == null || typeof tree !== 'object' ? []
  : [...(tree.name?.startsWith('button') ? [tree] : []), ...(tree.children || []).flatMap(buttons)];
const button = (tree, label) => buttons(tree).find((node) => content(node) === label);
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fixture(options = {}) {
  let onEvent, sequence = 0;
  const calls = { start: [], send: [], code: [], saves: [] };
  const App = { h, chatXmsg: Xmsg, chatCollisions: Collisions, chatCode: { generate: () => ['BCDF', 'TVWX', 'MNPR'][sequence++] },
    project: '/project', cfg: { chatTabs: {}, chat: { mode: 'default' }, projectChat: { '/project': { mode: 'acceptEdits' } }, accounts: {} },
    setup: { ensureCli: async () => true }, views: { agents: { jobs: [] } }, emit() {}, saveConfig() {} };
  const codeome = { inbox: {
    setNewChatCode: async (chatId, id, code) => { calls.code.push([chatId, id, code]); return options.recordFailure && calls.code.length === 1 ? { ok: false } : { ok: true }; },
    pending: async () => [],
    status: async (_chatId, _project, cards) => cards.map(({ id }) => {
      const item = origin.items.find((row) => row.id === id);
      return { id, status: 'approved', new_chat: { engine: item.newChat?.engine || 'codex', title: item.title,
        ...(item.kind === 'handoff' ? { brief: item.newChat?.brief } : { prompt: options.approvedPrompt || item.text }) } };
    })
  }, chat: {
    onEvent: (fn) => { onEvent = fn; }, onExit() {},
    load: async (_project, id) => options.saved?.[id] || null,
    pending: async () => [],
    save: async (_project, row) => { calls.saves.push(row); return { code: row.code }; },
    start: async (args) => { calls.start.push(args); return options.startFailure && calls.start.length === 1
      ? { error: 'Could not launch agent.' } : { ok: true, code: 'TVWX', account: { name: 'chosen-account' } }; },
    send: async (id, text) => { calls.send.push([id, text]); return { ok: true }; }
  } };
  vm.runInNewContext(source, { App, codeome, crypto: { randomUUID: () => `new-${sequence++}` },
    requestAnimationFrame: () => 1, setTimeout: () => 1, clearTimeout() {} });
  const C = App.views.chat;
  const origin = options.origin || { id: 'origin', project: '/project', code: 'GHJK', title: 'Parser review', started: true,
    engine: 'codex', account: 'override', mode: 'auto', items: [], requests: {}, collisions: [], busy: false, running: true };
  C.byId[origin.id] = origin;
  C.byProject['/project'] = { tabs: [origin], active: origin };
  const outgoing = (id = '1-abcdef01', kind = 'newchat') => {
    const item = { t: 'outbox', id, kind, to: null, status: 'approved', text: 'Check the parser', title: 'New task', ts: 1 };
    origin.items.push(item);
    return item;
  };
  const event = (item, changes = {}) => onEvent({ id: origin.id, msg: { type: 'newchat', id: item.id,
    prompt: item.text, title: item.title, ...changes } });
  return { App, C, origin, calls, outgoing, event, render: (item) => C.testRender(origin, item) };
}

test('prompt approval starts once in a background tab with project defaults and records its code', async () => {
  const f = fixture();
  const item = f.outgoing();
  f.event(item); f.event(item);
  await settle(); await settle();
  assert.equal(f.calls.start.length, 1);
  assert.equal(f.calls.send.length, 1);
  assert.equal(f.calls.send[0][1], 'Check the parser');
  assert.equal(f.calls.start[0].project, '/project');
  assert.equal(f.calls.start[0].engine, 'codex');
  assert.equal(f.calls.start[0].mode, 'acceptEdits');
  assert.equal(f.calls.start[0].account, 'auto');
  assert.equal(f.calls.start[0].role, '');
  assert.deepEqual(f.calls.code[0], ['origin', item.id, 'TVWX']);
  assert.equal(f.C.current(), f.origin);
  const target = f.C.byId[item.newChat.tabId];
  assert.equal(target.title, 'New task');
  assert.equal(target.items[0].text, 'Started from chat GHJK at your approval');
  assert.equal(target.items[1].t, 'user');
  assert.equal(target.attention, true);
  assert.match(content(f.render(item)), /Started chat TVWX/);
  await button(f.render(item), 'Open chat TVWX').attrs.onclick();
  await settle();
  assert.equal(f.C.current(), target);
});

test('a saved prompt is replaced by the approved main snapshot before starting', async () => {
  const f = fixture({ approvedPrompt: 'Trusted prompt' });
  const item = f.outgoing();
  item.newChat = { engine: 'codex', prompt: 'Forged saved prompt', title: 'Forged title' };
  await button(f.render(item), 'Retry').attrs.onclick();
  await settle(); await settle();
  assert.equal(f.calls.send[0][1], 'Trusted prompt');
  assert.equal(f.C.byId[item.newChat.tabId].title, 'New task');
});

test('handoff uses sectioned brief, explicit engine, and a normal first user turn', async () => {
  const f = fixture();
  const item = f.outgoing('2-abcdef02', 'handoff');
  const brief = { goal: 'Fix the import', context: 'The parser fails', constraints: 'Keep API',
    acceptance_check: 'Tests pass', out_of_scope: 'No release' };
  f.event(item, { brief, engine: 'claude' });
  await settle(); await settle();
  assert.equal(f.calls.start[0].engine, 'claude');
  assert.equal(f.calls.send[0][1], "Started at the user's approval from chat GHJK (Parser review). Brief:\n\n" +
    '## Goal\nFix the import\n## Context\nThe parser fails\n## Constraints\nKeep API\n## Acceptance check\nTests pass\n## Out of scope\nNo release');
  assert.equal(f.C.byId[item.newChat.tabId].items[1].t, 'user');
});

test('a saved request and a replay after reload do not start another tab', async () => {
  const f = fixture();
  const item = f.outgoing();
  f.event(item);
  await settle(); await settle();
  const savedOrigin = { ...f.origin, items: [{ ...item, newChat: { ...item.newChat } }] };
  const g = fixture({ origin: savedOrigin });
  g.event(savedOrigin.items[0]);
  await settle();
  assert.equal(g.calls.start.length, 0);
  assert.equal(g.C.byProject['/project'].tabs.length, 1);
});

test('failed start offers Retry and reuses the tab and first bubble', async () => {
  const f = fixture({ startFailure: true });
  const item = f.outgoing();
  f.event(item);
  await settle(); await settle();
  assert.match(content(f.render(item)), /Could not launch agent/);
  const tabId = item.newChat.tabId;
  await button(f.render(item), 'Retry').attrs.onclick();
  await settle(); await settle();
  assert.equal(item.newChat.tabId, tabId);
  assert.equal(f.C.byProject['/project'].tabs.length, 2);
  assert.equal(f.C.byId[tabId].items.filter((entry) => entry.t === 'user').length, 1);
  assert.equal(f.calls.send.length, 1);
  assert.equal(f.calls.code.length, 1);
  f.event(item);
  await settle();
  assert.equal(f.calls.start.length, 2);
});

test('a failed code write retries only the write, without another first turn', async () => {
  const f = fixture({ recordFailure: true });
  const item = f.outgoing();
  f.event(item);
  await settle(); await settle();
  assert.match(content(f.render(item)), /Could not record the new chat code/);
  button(f.render(item), 'Retry').attrs.onclick();
  await settle(); await settle();
  assert.equal(f.calls.start.length, 1);
  assert.equal(f.calls.send.length, 1);
  assert.equal(f.calls.code.length, 2);
  assert.match(content(f.render(item)), /Started chat TVWX/);
});

test('reload while approved shows Retry without an error and reuses an already sent first turn', async () => {
  const f = fixture();
  const item = f.outgoing();
  item.newChat = { tabId: 'saved-target', engine: 'codex', prompt: item.text, title: item.title };
  const target = { id: 'saved-target', project: '/project', code: 'TVWX', title: 'New task', engine: 'codex',
    account: 'auto', mode: 'acceptEdits', started: true, running: false, items: [{ t: 'user', text: item.text }],
    requests: {}, collisions: [] };
  f.C.byId[target.id] = target;
  f.C.byProject['/project'].tabs.push(target);
  assert.ok(button(f.render(item), 'Retry'));
  await button(f.render(item), 'Retry').attrs.onclick();
  await settle();
  assert.equal(f.calls.start.length, 0);
  assert.equal(f.calls.send.length, 0);
  assert.deepEqual(f.calls.code, [['origin', item.id, 'TVWX']]);
  assert.equal(item.newChatCode, 'TVWX');
});
