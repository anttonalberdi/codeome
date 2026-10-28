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

test('job cards copy progress and drop it when the job record no longer has it', () => {
  const project = '/project';
  const App = { h() {}, project, currentView: 'other', views: { agents: { pane: 'chat' } }, emit() {} };
  const codeome = { chat: { onEvent() {}, onExit() {} } };
  const source = fs.readFileSync(path.join(__dirname, '../renderer/js/chat.js'), 'utf8');
  vm.runInNewContext(source, { App, codeome, document: { hidden: true }, requestAnimationFrame: () => 1 });
  const card = { t: 'job', engine: 'codex', jobId: 'job', status: 'running' };
  const chat = { project, busy: true, items: [card] };
  App.views.chat.byProject[project] = { tabs: [chat], active: chat };
  const job = { id: 'job', engine: 'codex', status: 'running' };
  App.views.chat.syncJobs(project, [job]);
  assert.equal(Object.hasOwn(card, 'progress'), false);
  const progress = { updatedAt: '2026-10-22T08:01:00Z', stages: [{ id: 'work', state: 'running' }] };
  App.views.chat.syncJobs(project, [{ ...job, progress }]);
  assert.equal(card.progress, progress);
  App.views.chat.syncJobs(project, [job]);
  assert.equal(Object.hasOwn(card, 'progress'), false);
});

test('saving a chat omits runtime progress without changing the live card', async () => {
  const project = '/project';
  let saved;
  const App = { h() {}, project, currentView: 'other', cfg: { chatTabs: {} }, views: { agents: { pane: 'chat' } }, emit() {} };
  const codeome = { chat: { onEvent() {}, onExit() {}, save(_project, value) { saved = value; } } };
  const source = fs.readFileSync(path.join(__dirname, '../renderer/js/chat.js'), 'utf8');
  vm.runInNewContext(source, { App, codeome, document: { hidden: true }, requestAnimationFrame: () => 1,
    clearTimeout() {}, setTimeout: () => 1 });
  const progress = { stages: [{ id: 'work', state: 'running' }] };
  const card = { t: 'job', id: 'card', status: 'running', progress, result: 'complete' };
  const chat = { id: 'chat', project, started: true, items: [card] };
  const active = { id: 'active', project, started: true, items: [] };
  App.views.chat.byProject[project] = { tabs: [chat, active], active };
  await App.views.chat.closeTab(chat);
  assert.equal(Object.hasOwn(saved.items[0], 'progress'), false);
  assert.equal(saved.items[0].result, 'complete');
  assert.equal(card.progress, progress);
});

function renderHarness(now) {
  const { progressView } = require('../renderer/js/progress');
  const h = (name, attrs, ...children) => {
    if (attrs == null || typeof attrs !== 'object' || Array.isArray(attrs) || attrs.node) {
      children.unshift(attrs); attrs = {};
    }
    return { node: true, name, attrs, children: children.flat(Infinity).filter((child) => child != null), isConnected: false };
  };
  const App = { h, project: '/project', cfg: { accounts: {} }, views: { agents: { jobs: [] } }, emit() {} };
  const codeome = { chat: { onEvent() {}, onExit() {} } };
  const source = fs.readFileSync(path.join(__dirname, '../renderer/js/chat.js'), 'utf8')
    .replace('  function openJob(it) {', '  C.testRender = render; C.testFormatDuration = formatProgressDuration;\n  function openJob(it) {');
  assert.ok(source.includes('C.testRender = render'));
  class FixedDate extends Date { static now() { return now; } }
  vm.runInNewContext(source, { App, codeome, Progress: { progressView }, Date: FixedDate,
    document: { hidden: true }, requestAnimationFrame: () => 1 });
  return { App, render: App.views.chat.testRender, formatDuration: App.views.chat.testFormatDuration };
}

function nodes(tree, name) {
  if (!tree || typeof tree !== 'object') return [];
  return [...(tree.name === name ? [tree] : []), ...(tree.children || []).flatMap((child) => nodes(child, name))];
}

function content(tree) {
  if (tree == null) return '';
  if (typeof tree !== 'object') return String(tree);
  return (tree.children || []).map(content).join('');
}

test('no progress leaves the original job card structure intact', () => {
  const { render } = renderHarness(Date.parse('2026-10-22T08:02:00Z'));
  const chat = { project: '/project' };
  const card = { t: 'job', engine: 'claude', status: 'running', role: 'Analyst', title: 'Analyze data', startedAt: Date.parse('2026-10-22T08:00:00Z') };
  const plain = render(chat, card);
  const empty = render(chat, { ...card, progress: { stages: [] } });
  const structure = (tree) => JSON.stringify(tree, (_key, value) => typeof value === 'function' ? '[function]' : value);
  assert.equal(structure(plain), structure(empty));
  assert.equal(plain.name, 'div.jobcard.running');
  assert.deepEqual(plain.children.map((child) => child.name), ['div.jc-top', 'div.jc-title']);
  assert.deepEqual(plain.children[0].children.map((child) => child.name),
    ['span.pill.ok', 'span.jc-role', 'span.grow', 'span.state.running', 'span.jc-time']);
  assert.equal(content(plain.children[1]), 'Analyze data');
});

test('progress renders stage rows, accessible bars, duration, ETA, and stalled badge', () => {
  const now = Date.parse('2026-10-22T08:03:00Z');
  const { render } = renderHarness(now);
  const card = { t: 'job', engine: 'claude', status: 'running', title: 'Analyze data', startedAt: now - 180_000,
    progress: { updatedAt: '2026-10-22T08:00:00Z', stages: [
      { id: 'prepare', label: 'Prepare', state: 'done', done: 10, total: 10, unit: 'files', startedAt: '2026-10-22T08:00:00Z', endedAt: '2026-10-22T08:01:00Z' },
      { id: 'work', label: 'Work', state: 'running', done: 3, total: 12, unit: 'files', startedAt: '2026-10-22T08:00:00Z' },
      { id: 'finish', label: 'Finish', state: 'waiting', done: 0, total: 12, unit: 'files' },
      { id: 'report', label: 'Report', state: 'failed' }
    ] } };
  const tree = render({ project: '/project' }, card);
  assert.deepEqual(tree.children.map((child) => child.name), ['div.jc-top', 'div.jc-title', 'div.jc-prog']);
  const toggle = nodes(tree, 'button.jc-prog-toggle')[0];
  assert.equal(toggle.attrs['aria-expanded'], 'true');
  assert.match(content(toggle), /stage 2\/4 · Work/);
  assert.equal(nodes(tree, 'div.jc-prog-row.running').length, 1);
  assert.equal(nodes(tree, 'div.jc-prog-row.waiting').length, 1);
  assert.equal(content(nodes(tree, 'div.jc-prog-row.waiting')[0]), '○Finish');
  assert.equal(nodes(tree, 'div.jc-prog-row.failed').length, 1);
  assert.equal(content(nodes(tree, 'div.jc-prog-row.done')[0]), '✓Prepare10/10 files · 1m');
  const running = nodes(tree, 'div.jc-prog-row.running')[0];
  assert.match(content(running), /3\/12 files · ~9m left/);
  assert.match(content(running), /no update for 180s/);
  assert.equal(nodes(tree, 'span.jc-prog-icon').map((node) => node.attrs['aria-label']).join(','), 'done,running,waiting,failed');
  const bars = nodes(tree, 'div.jc-prog-bar').concat(nodes(tree, 'div.jc-prog-bar.small'));
  assert.deepEqual(bars.map((bar) => [bar.attrs.role, bar.attrs['aria-valuenow'], bar.attrs['aria-valuemin'], bar.attrs['aria-valuemax']]),
    [['progressbar', 31, 0, 100], ['progressbar', 100, 0, 100], ['progressbar', 25, 0, 100]]);
});

test('stopped jobs do not render a running progress stage or live indicators', () => {
  const now = Date.parse('2026-10-22T08:03:00Z');
  const { render } = renderHarness(now);
  for (const status of ['done', 'failed', 'cancelled', 'lost', 'paused', 'stale', 'held']) {
    const card = { t: 'job', engine: 'claude', status, startedAt: now - 180_000,
      progress: { updatedAt: '2026-10-22T08:00:00Z', stages: [
        { id: 'work', label: 'Work', state: 'running', startedAt: '2026-10-22T08:00:00Z', baselineSeconds: 600 }
      ] } };
    const tree = render({ project: '/project' }, card);
    assert.equal(nodes(tree, 'div.jc-prog-row.running').length, 0, status);
    assert.equal(nodes(tree, 'div.jc-prog-row.stopped').length, 1, status);
    assert.equal(nodes(tree, 'span.jc-prog-stall').length, 0, status);
    assert.equal(nodes(tree, 'span.spinner').length, 0, status);
    assert.doesNotMatch(content(tree), /left|no update|elapsed/, status);
  }
});

test('progress toggle changes item state and completed progress starts collapsed', () => {
  const now = Date.parse('2026-10-22T08:03:00Z');
  const { render } = renderHarness(now);
  const chat = { project: '/project' };
  const card = { t: 'job', engine: 'claude', status: 'running', startedAt: now,
    progress: { stages: [{ id: 'work', label: 'Work', state: 'running' }] } };
  const toggle = nodes(render(chat, card), 'button.jc-prog-toggle')[0];
  let stopped = false;
  toggle.attrs.onclick({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(card.progressOpen, false);
  const collapsed = render(chat, card);
  assert.equal(nodes(collapsed, 'div.jc-prog-row.running').length, 0);
  assert.equal(nodes(collapsed, 'button.jc-prog-toggle')[0].attrs['aria-expanded'], 'false');
  nodes(collapsed, 'button.jc-prog-toggle')[0].attrs.onclick({ stopPropagation() {} });
  assert.equal(card.progressOpen, true);
  assert.equal(nodes(render(chat, card), 'div.jc-prog-row.running').length, 1);
  const done = { ...card, progressOpen: undefined, progress: { stages: [{ label: 'Work', state: 'done' }] } };
  const completed = render(chat, done);
  assert.equal(nodes(completed, 'div.jc-prog-row.done').length, 0);
  assert.equal(nodes(completed, 'button.jc-prog-toggle')[0].attrs['aria-expanded'], 'false');
});

test('indeterminate progress shows elapsed and baseline only when available', () => {
  const now = Date.parse('2026-10-22T08:03:00Z');
  const { render } = renderHarness(now);
  const base = { t: 'job', engine: 'claude', status: 'running', startedAt: now,
    progress: { stages: [{ label: 'Work', state: 'running', startedAt: '2026-10-22T08:00:00Z', baselineSeconds: 600 }] } };
  assert.match(content(render({}, base)), /elapsed 3m \/ ~10m · ~7m left/);
  const withoutBaseline = { ...base, progress: { stages: [{ label: 'Work', state: 'running', startedAt: '2026-10-22T08:00:00Z' }] } };
  const tree = render({}, withoutBaseline);
  assert.match(content(tree), /elapsed 3m/);
  assert.doesNotMatch(content(tree), /left|~10m/);
  assert.equal(nodes(tree, 'div.jc-prog-bar.small').length, 0);
});

test('progress durations use compact seconds, minutes, and hours', () => {
  const { formatDuration } = renderHarness(0);
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(192), '3m 12s');
  assert.equal(formatDuration(3900), '1h 05m');
});
