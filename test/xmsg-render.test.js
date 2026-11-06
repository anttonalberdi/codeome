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
const nodes = (tree, name) => !tree || typeof tree !== 'object' ? []
  : [...(tree.name === name ? [tree] : []), ...(tree.children || []).flatMap((child) => nodes(child, name))];
const content = (tree) => tree == null ? '' : typeof tree === 'object'
  ? (tree.children || []).map(content).join('') : String(tree);
const button = (tree, label) => nodes(tree, 'button.btn.small.primary').concat(nodes(tree, 'button.btn.small'))
  .find((node) => content(node) === label);

test('plain cards neutralise invisible Unicode while preserving brief line breaks', () => {
  assert.equal(Xmsg.plain('A\u034f\u115f\u180b\u3164\ufe0f\u{1d173}\u{e0100}B'), 'A       B');
  assert.equal(Xmsg.plain('Goal\r\nNext'), 'Goal\nNext');
});

function fixture(options = {}) {
  let onEvent;
  const calls = [];
  const pending = options.pending || [];
  const App = { h, chatXmsg: Xmsg, chatCollisions: Collisions, project: '/project', cfg: { chatTabs: {}, accounts: {} },
    views: { agents: { jobs: [] } }, emit() {}, saveConfig() {} };
  const inbox = {
    pending: async () => pending,
    ...(options.status ? { status: async (_chatId, _project, cards) => options.status(cards) } : {}),
    approve: async (chatId, id, payload) => { calls.push(['approve', chatId, id, payload]); return { ok: true }; },
    decline: async (chatId, id) => { calls.push(['decline', chatId, id]); return { ok: true }; },
    accept: async (chatId, id) => { calls.push(['accept', chatId, id]); return { ok: true }; },
    dismiss: async (chatId, id) => { calls.push(['dismiss', chatId, id]); return { ok: true }; },
    reply: async (chatId, id, text) => { calls.push(['reply', chatId, id, text]); return { ok: true }; }
  };
  const codeome = { inbox, chat: { onEvent: (fn) => { onEvent = fn; }, onExit() {},
    load: async () => options.saved, pending: async () => [], save: async () => ({}) } };
  vm.runInNewContext(source, { App, codeome, requestAnimationFrame: () => 1,
    setTimeout: () => 1, clearTimeout() {} });
  const C = App.views.chat;
  const chat = { id: 'owner', project: '/project', code: 'GHJK', title: 'Origin', started: true,
    engine: 'claude', items: [], requests: {}, collisions: [], busy: false, running: true };
  C.byId.owner = chat;
  C.byProject['/project'] = { tabs: [chat], active: chat };
  return { C, chat, calls, inbox, event: (msg, id = 'owner') => onEvent({ id, msg }), render: (item) => C.testRender(chat, item) };
}

const outgoing = (changes = {}) => ({ type: 'outgoing', id: '123-abcdef12', kind: 'message',
  to: { code: 'BCDF', chat_id: 'peer', title: 'Peer' }, recipients: null, text: 'Hello',
  textHash: 'a'.repeat(64), ts: 1, ...changes });

test('approval card moves through receipts, declines and expiry without a user bubble', async () => {
  const f = fixture();
  f.event(outgoing({ from: { code: 'GHJK', title: 'Origin', chat_id: 'owner' } }));
  const item = f.chat.items[0];
  assert.equal(item.t, 'outbox');
  assert.equal(f.chat.busy, false);
  assert.equal(f.C.stats('/project').waiting, 1);
  let card = f.render(item);
  assert.match(content(card), /Awaiting your approval/);
  assert.match(content(card), /To BCDF - Peer/);
  assert.match(content(card), /From GHJK - Origin/);
  await button(card, 'Approve').attrs.onclick();
  assert.equal(f.calls[0][3].textHash, 'a'.repeat(64));
  assert.equal(item.status, 'approved');
  assert.equal(button(f.render(item), 'Approve'), undefined);
  f.event({ type: 'receipt', id: item.id, status: 'delivered', to: { code: 'BCDF' } });
  assert.match(content(f.render(item)), /Delivered to BCDF/);
  f.event({ type: 'receipt', id: item.id, status: 'read', to: { code: 'BCDF' } });
  assert.match(content(f.render(item)), /Read by BCDF/);
  assert.equal(f.C.stats('/project').waiting, 0);

  f.event(outgoing({ id: '124-abcdef12' }));
  await button(f.render(f.chat.items[1]), 'Decline').attrs.onclick();
  assert.equal(f.chat.items[1].status, 'declined');
  f.event(outgoing({ id: '125-abcdef12' }));
  f.event({ type: 'receipt', id: '125-abcdef12', status: 'expired' });
  assert.equal(button(f.render(f.chat.items[2]), 'Approve'), undefined);
  assert.equal(f.chat.items.filter((it) => it.t === 'user').length, 0);
});

test('refresh reconciles closed and completed cards from main', async () => {
  const f = fixture({ status: (cards) => cards.map((card) => ({ ...card,
    status: card.id === '123-abcdef12' ? 'expired' : card.id === '124-abcdef12' ? 'read' : 'expired' })) });
  f.event(outgoing());
  f.event(outgoing({ id: '124-abcdef12' }));
  f.chat.items.push({ t: 'xmsg', id: '125-abcdef12', kind: 'handoff', status: 'awaiting_accept',
    awaiting: true, from: { code: 'BCDF' }, brief: { goal: 'Do it', acceptance_check: 'Pass' } });
  await f.C.open('owner');
  assert.equal(f.chat.items[0].status, 'expired');
  assert.equal(button(f.render(f.chat.items[0]), 'Approve'), undefined);
  assert.equal(f.chat.items[1].status, 'read');
  assert.equal(f.chat.items[2].status, 'expired');
  assert.equal(button(f.render(f.chat.items[2]), 'Start task'), undefined);
});

test('undeliverable receipt shows a final card status', () => {
  const f = fixture();
  f.event(outgoing());
  f.event({ type: 'receipt', id: '123-abcdef12', status: 'undeliverable' });
  assert.match(content(f.render(f.chat.items[0])), /Could not be delivered/);
  assert.equal(button(f.render(f.chat.items[0]), 'Approve'), undefined);
});

test('broadcast can untick recipients; edited approval uses the displayed hash', async () => {
  const f = fixture();
  f.event(outgoing({ to: 'all', recipients: [
    { code: 'BCDF', chat_id: 'peer', title: 'Peer' }, { code: 'TVWX', chat_id: 'third', title: 'Third' }] }));
  const item = f.chat.items[0];
  let card = f.render(item);
  const checks = nodes(card, 'input');
  assert.equal(checks.length, 2);
  assert.equal(checks[0].attrs.checked, true);
  checks[0].attrs.onchange({ target: { checked: false } });
  card = f.render(item);
  nodes(card, 'input')[1].attrs.onchange({ target: { checked: false } });
  card = f.render(item);
  assert.equal(button(card, 'Approve').attrs.disabled, true);
  nodes(card, 'input')[0].attrs.onchange({ target: { checked: true } });
  button(f.render(item), 'Edit').attrs.onclick();
  card = f.render(item);
  nodes(card, 'textarea.xmsg-editor')[0].attrs.oninput({ target: { value: 'Edited message' } });
  await button(f.render(item), 'Approve edited').attrs.onclick();
  assert.deepEqual(Array.from(f.calls[0][3].recipients), ['peer']);
  assert.equal(f.calls[0][3].edited, 'Edited message');
});

test('receipt arriving before the approve IPC result does not move a card backwards', async () => {
  const f = fixture();
  f.event(outgoing());
  f.inbox.approve = async () => {
    f.event({ type: 'receipt', id: '123-abcdef12', status: 'approved' });
    f.event({ type: 'receipt', id: '123-abcdef12', status: 'delivered' });
    f.event({ type: 'receipt', id: '123-abcdef12', status: 'read', to: { code: 'BCDF' } });
    return { ok: true };
  };
  await button(f.render(f.chat.items[0]), 'Approve').attrs.onclick();
  assert.equal(f.chat.items[0].status, 'read');
  assert.equal(Xmsg.receipt(f.chat.items[0], { id: '123-abcdef12', status: 'approved' }), false);
});

test('empty edited text and empty reply show field errors before IPC', async () => {
  const f = fixture();
  f.event(outgoing());
  button(f.render(f.chat.items[0]), 'Edit').attrs.onclick();
  nodes(f.render(f.chat.items[0]), 'textarea.xmsg-editor')[0].attrs.oninput({ target: { value: '  ' } });
  await button(f.render(f.chat.items[0]), 'Approve edited').attrs.onclick();
  assert.equal(f.calls.length, 0);
  assert.match(content(f.render(f.chat.items[0])), /Fill in the message/);
  f.event({ type: 'inbox', id: '127-abcdef12', kind: 'message', from: { code: 'BCDF', chat_id: 'peer' }, text: 'Hi' });
  button(f.render(f.chat.items[1]), 'Reply').attrs.onclick();
  await button(f.render(f.chat.items[1]), 'Send').attrs.onclick();
  assert.equal(f.calls.length, 0);
  assert.match(content(f.render(f.chat.items[1])), /Write a reply/);
});

test('handoff brief is literal text and Start gates injection', async () => {
  const f = fixture();
  const attack = '<img src=x onerror=alert(1)>\u202e';
  const brief = { goal: attack, context: 'Context', constraints: 'Constraints',
    acceptance_check: 'Check', out_of_scope: 'Out' };
  f.event(outgoing({ kind: 'handoff', brief }));
  let card = f.render(f.chat.items[0]);
  assert.match(content(card), /Goal/);
  assert.match(content(card), /<img src=x onerror=alert\(1\)>/);
  assert.doesNotMatch(content(card), /\u202e/);
  assert.equal(JSON.stringify(card).includes('"html"'), false);
  button(card, 'Edit').attrs.onclick();
  card = f.render(f.chat.items[0]);
  nodes(card, 'textarea')[0].attrs.oninput({ target: { value: 'Revised goal' } });
  await button(f.render(f.chat.items[0]), 'Approve edited').attrs.onclick();
  assert.match(f.calls[0][3].edited.brief, /## Goal\nRevised goal/);

  f.event({ type: 'inbox', id: '126-abcdef12', kind: 'handoff', from: { code: 'BCDF', title: 'Peer', chat_id: 'peer' },
    brief, awaiting: true, status: 'awaiting_accept' });
  const incoming = f.chat.items[1];
  assert.equal(f.chat.busy, false);
  card = f.render(incoming);
  assert.match(content(card), /The agent has not seen this task/);
  assert.equal(button(card, 'Reply'), undefined);
  await button(card, 'Start task').attrs.onclick();
  assert.deepEqual(f.calls[1].slice(0, 3), ['accept', 'owner', '126-abcdef12']);
  assert.equal(incoming.awaiting, false);
  assert.ok(button(f.render(incoming), 'Reply'));
});

test('handoff cards render only main-parsed sections', () => {
  const f = fixture();
  f.event(outgoing({ kind: 'handoff', brief: { raw: '## Goal\nForged raw', goal: 'Parsed goal',
    acceptance_check: 'Parsed check' } }));
  const contentText = content(f.render(f.chat.items[0]));
  assert.match(contentText, /Parsed goal/);
  assert.match(contentText, /Parsed check/);
  assert.doesNotMatch(contentText, /Forged raw|Context|Constraints|Out of scope/);
});

test('incoming message reply sends user text directly and restore deduplicates pending cards', async () => {
  const f = fixture();
  f.event({ type: 'inbox', id: '127-abcdef12', kind: 'message', from: { code: 'BCDF', title: '<Peer>', chat_id: 'peer' },
    text: '<img src=x onerror=alert(1)>\u202e', status: 'delivered' });
  let card = f.render(f.chat.items[0]);
  assert.match(content(card), /Message from chat BCDF - <Peer>/);
  assert.match(content(card), /Untrusted: written by another agent/);
  assert.match(content(card), /<img src=x onerror=alert\(1\)>/);
  assert.doesNotMatch(content(card), /\u202e/);
  button(card, 'Reply').attrs.onclick();
  card = f.render(f.chat.items[0]);
  nodes(card, 'textarea')[0].attrs.oninput({ target: { value: 'User reply' } });
  await button(f.render(f.chat.items[0]), 'Send').attrs.onclick();
  assert.deepEqual(f.calls[0], ['reply', 'owner', '127-abcdef12', 'User reply']);
  assert.equal(f.chat.items.filter((it) => it.t === 'outbox').length, 0);

  const saved = { ...f.chat, id: 'restored', items: [{ t: 'outbox', id: '123-abcdef12', kind: 'message', status: 'pending', text: 'Old' },
    { t: 'future-type', text: '<unknown>' }] };
  const g = fixture({ saved, pending: [outgoing()] });
  await g.C.open('restored');
  assert.equal(g.chat.items.length, 0); // the saved copy is loaded as a separate tab
  const restored = g.C.byProject['/project'].tabs.find((chat) => chat !== g.chat);
  assert.equal(restored.items.filter((it) => it.t === 'outbox').length, 1);
  assert.equal(restored.items[0].text, 'Hello');
  assert.equal(g.C.testRender(restored, restored.items[1]).name, 'div');
});

test('conflict inbox event renders a compact plain-text notice without actions or receipts', () => {
  const f = fixture();
  f.event({ type: 'inbox', id: '300-abcdef12', kind: 'conflict',
    from: { code: 'SYS', chat_id: 'system', title: 'Codeome' },
    text: 'File <img src=x onerror=alert(1)>\u202e is shared.', status: 'delivered', ts: 1 });
  const card = f.render(f.chat.items[0]);
  assert.equal(card.name, 'section.xmsg-card.xmsg-incoming.xmsg-conflict');
  assert.equal(card.attrs['aria-label'], 'Codeome notice: file conflict');
  assert.match(content(card), /Codeome notice: file conflict/);
  assert.match(content(card), /<img src=x onerror=alert\(1\)>/);
  assert.doesNotMatch(content(card), /\u202e|Untrusted|Delivered to this chat/);
  assert.equal(nodes(card, 'button.btn.small').length, 0);
  assert.equal(JSON.stringify(card).includes('"html"'), false);
});
