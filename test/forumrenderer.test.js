const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function node(selector) {
  return { selector, children: [], classList: { add() {}, toggle() {} }, setAttribute() {},
    append(...children) { this.children.push(...children); },
    prepend(child) { this.children.unshift(child); },
    replaceChildren(...children) { this.children = children; },
    querySelector() { return null; }, querySelectorAll() { return []; }, focus() {},
    scrollTop: 0, clientHeight: 0, scrollHeight: 0 };
}

test('renderer closes replaced forums, clears cancelled drafts, and keeps local errors visible', async () => {
  const made = [], listeners = {}, closed = [], sequence = [];
  let receive;
  const snapshot = (id) => ({ id, project: '/project', title: id, seats: [], hands: [], transcript: [], budget: 0, budgetLimit: 0 });
  const forum = { onEvent: (fn) => { receive = fn; }, list: async (project) => { sequence.push('list:' + project); return { forums: project === '/project' ? [{ id: 'old' }] : [] }; },
    open: async () => ({ forum: snapshot('old') }), create: async () => ({ forum: snapshot('new') }),
    close: async (id) => { closed.push(id); sequence.push('close:' + id); return { ok: true }; } };
  const App = { h: (selector) => { const el = node(selector); made.push(el); return el; },
    views: { agents: { pane: 'forum' } }, project: '/project', currentView: 'agents',
    listen: (name, fn) => { listeners[name] = fn; }, emit() {}, md: (text) => text,
    err: (message) => { throw new Error(message); } };
  const source = fs.readFileSync(path.join(__dirname, '../renderer/js/forum.js'), 'utf8');
  vm.runInNewContext(source, { App, codeome: { forum }, document: { hidden: true, addEventListener() {} },
    window: { addEventListener() {} }, setTimeout, Date, Math });
  App.views.forum.mount(node('root'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(App.views.forum.snapshot.id, 'old');
  receive({ id: 'old', event: { type: 'message', item: { id: 'draft', speaker: 'claude-1', kind: 'message', text: 'partial' }, delta: 'partial' } });
  receive({ id: 'old', event: { type: 'message-cancelled', id: 'draft' } });
  assert.equal(App.views.forum.snapshot.transcript.length, 0);
  receive({ id: 'old', event: { type: 'message', item: { id: 'm1', speaker: 'user', kind: 'message', text: 'hello' } } });
  receive({ id: 'old', event: { type: 'error', error: 'still visible' } });
  receive({ id: 'old', event: { type: 'summary', summary: 'earlier', summarizedUpTo: 'm1' } });
  const log = made.find((el) => el.selector === 'div.forum-log');
  assert.ok(log.children.some((el) => el.selector === 'div.note.error'));
  await App.views.forum.newForum();
  assert.deepEqual(closed, ['old']);
  App.project = '/other'; listeners.project('/other');
  assert.deepEqual(closed, ['old', 'new']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(sequence.indexOf('close:new') < sequence.indexOf('list:/other'));
});
