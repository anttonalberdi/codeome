const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Collisions = require('../renderer/js/chat-collisions');

test('recent collisions keep five distinct paths and expire after 30 minutes', () => {
  const now = 2_000_000;
  let list = [];
  for (let i = 0; i < 6; i++) list = Collisions.add(list, { path: `/project/${i}`, others: [] }, now + i);
  assert.deepEqual(list.map((entry) => entry.path), ['/project/5', '/project/4', '/project/3', '/project/2', '/project/1']);
  list = Collisions.add(list, { path: '/project/3', others: [{ title: 'Other' }] }, now + 6);
  assert.equal(list.length, 5);
  assert.equal(list[0].path, '/project/3');
  assert.equal(list[0].others[0].title, 'Other');
  assert.equal(Collisions.recent(list, now + 6 + Collisions.TTL_MS).length, 0);
});

test('collision text uses project paths, titles, short ids, and singular counts', () => {
  const collision = { path: '/project/src/a.js', others: [
    { chat_id: '1234567890', engine: 'codex', title: 'Fix parser' },
    { chat_id: 'abcdef1234', engine: 'claude', title: '' }
  ] };
  assert.equal(Collisions.line(collision, '/project'), 'Also edited by Fix parser (Codex), abcdef12 (Claude): src/a.js');
  assert.equal(Collisions.displayPath('/project-two/a.js', '/project'), '/project-two/a.js');
  assert.equal(Collisions.countText(1), '1 collision');
  assert.equal(Collisions.countText(2), '2 collisions');
});

test('chat:event collision reaches the owning chat and project stats', () => {
  let onEvent;
  const project = '/project';
  const App = { h() {}, project, chatCollisions: Collisions, views: {}, cfg: {}, emit() {} };
  const codeome = { chat: { onEvent: (listener) => { onEvent = listener; }, onExit() {} } };
  const source = fs.readFileSync(path.join(__dirname, '../renderer/js/chat.js'), 'utf8');
  vm.runInNewContext(source, { App, codeome, requestAnimationFrame: () => 1,
    setTimeout: () => 1, clearTimeout() {} });
  const chat = { id: 'a', project, items: [], requests: {}, collisions: [], engine: 'codex' };
  const C = App.views.chat;
  C.byId.a = chat;
  C.byProject[project] = { tabs: [chat], active: chat };
  onEvent({ id: 'a', msg: { type: 'collision', path: '/project/a.js', others: [{ title: 'Other', engine: 'claude' }] } });
  assert.equal(chat.items.length, 0);
  assert.equal(chat.collisions.length, 1);
  assert.equal(C.stats(project).collisions, 1);
  onEvent({ id: 'a', msg: { type: 'collision', path: '/project/a.js', others: [] } });
  assert.equal(chat.collisions.length, 1);
  const second = { id: 'b', project, items: [], requests: {}, collisions: [], engine: 'claude' };
  C.byId.b = second;
  C.byProject[project].tabs.push(second);
  onEvent({ id: 'b', msg: { type: 'collision', path: '/project/a.js', others: [] } });
  assert.equal(C.stats(project).collisions, 2);
});
