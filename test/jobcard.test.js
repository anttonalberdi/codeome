const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('a Codex chat card follows pause and resume job records', () => {
  const project = '/project';
  const App = { h() {}, project, currentView: 'other', views: { agents: { pane: 'chat' } }, emit() {} };
  const codeome = { chat: { onEvent() {}, onExit() {} } };
  const source = fs.readFileSync(path.join(__dirname, '../renderer/js/chat.js'), 'utf8');
  vm.runInNewContext(source, { App, codeome, document: { hidden: true }, requestAnimationFrame: () => 1 });
  const card = { t: 'job', engine: 'codex', jobId: 'first', status: 'running', startedAt: Date.parse('2026-10-22T08:00:00Z') };
  const chat = { project, busy: true, items: [card] };
  App.views.chat.byProject[project] = { tabs: [chat], active: chat };
  const first = { id: 'first', engine: 'codex', status: 'pausing', startedAt: '2026-10-22T08:00:00Z' };
  App.views.chat.syncJobs(project, [first]);
  assert.equal(card.status, 'pausing');
  assert.equal(card.endedAt, null);
  App.views.chat.syncJobs(project, [{ ...first, status: 'paused', endedAt: '2026-10-22T08:05:00Z' }]);
  assert.equal(card.status, 'paused');
  const second = { id: 'second', engine: 'codex', status: 'running', startedAt: '2026-10-22T08:10:00Z' };
  App.views.chat.syncJobs(project, [{ ...first, status: 'paused', resumedBy: second.id }, second]);
  assert.equal(card.jobId, 'second');
  assert.equal(card.status, 'running');
  assert.equal(card.startedAt, Date.parse(second.startedAt));
  assert.equal(card.endedAt, null);
});
