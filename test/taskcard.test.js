const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { progressView } = require('../renderer/js/progress');

const source = fs.readFileSync(path.join(__dirname, '../renderer/js/chat.js'), 'utf8')
  .replace('  function openJob(it) {', '  C.testRender = render;\n  function openJob(it) {');

function harness(now = Date.parse('2026-10-22T08:03:00Z')) {
  const project = '/project';
  const h = (name, attrs, ...children) => {
    if (attrs == null || typeof attrs !== 'object' || Array.isArray(attrs) || attrs.node) {
      children.unshift(attrs); attrs = {};
    }
    return { node: true, name, attrs, children: children.flat(Infinity).filter((child) => child != null), isConnected: false };
  };
  let onEvent;
  let snapshot = {};
  let calls = [];
  let saved;
  const App = { h, project, cfg: { chatTabs: {} }, currentView: 'other',
    views: { agents: { pane: 'chat', refreshSoon() {} } }, emit() {} };
  const codeome = { chat: {
    onEvent(fn) { onEvent = fn; }, onExit() {}, save(_project, value) { saved = value; },
    load: async () => null
  }, tasks: { async progress(p, keys) { calls.push([p, [...keys]]); if (snapshot instanceof Error) throw snapshot; return snapshot; } } };
  class FixedDate extends Date { static now() { return now; } }
  vm.runInNewContext(source, { App, codeome, Progress: { progressView }, Date: FixedDate,
    document: { hidden: true }, crypto: { randomUUID: () => 'blank' }, localStorage: { getItem: () => null },
    requestAnimationFrame: () => 1, setTimeout: () => 1, clearTimeout() {} });
  const chat = { id: 'chat', project, busy: true, started: true, items: [], tools: {}, stream: {}, requests: {} };
  App.views.chat.byProject[project] = { tabs: [chat], active: chat };
  App.views.chat.byId[chat.id] = chat;
  const event = (msg) => onEvent({ id: chat.id, msg });
  const use = (id, name, command, extra = {}) => event({ type: 'assistant', message: { content: [
    { type: 'tool_use', id, name, input: { command, ...extra } }
  ] } });
  const result = (id, content, is_error = false) => event({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: id, content, is_error }
  ] } });
  return { App, codeome, chat, event, use, result, render: App.views.chat.testRender,
    setSnapshot(value) { snapshot = value; }, calls: () => calls, saved: () => saved };
}

function nodes(tree, name) {
  if (!tree || typeof tree !== 'object') return [];
  return [...(tree.name === name ? [tree] : []), ...(tree.children || []).flatMap((child) => nodes(child, name))];
}

function content(tree) {
  if (tree == null) return '';
  return typeof tree === 'object' ? (tree.children || []).map(content).join('') : String(tree);
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

test('Bash and Monitor watch calls share one card, with validated key and label', () => {
  const t = harness();
  t.use('bash', 'Bash', 'codeome-agent watch --task vitest-a3f --label "Test suite"', { run_in_background: true });
  t.use('monitor', 'Monitor', 'codeome-agent watch --task vitest-a3f --label "Test suite"');
  assert.equal(t.chat.items.length, 1);
  assert.equal(t.chat.items[0].t, 'progress');
  assert.equal(t.chat.items[0].key, 'vitest-a3f');
  assert.equal(t.chat.items[0].label, 'Test suite');
  assert.equal(t.chat.tools.bash, t.chat.tools.monitor);
  t.use('bare', 'Bash', "codeome-agent watch --task other --label 'Other task'");
  assert.equal(t.chat.items[1].label, 'Other task');
  t.use('fallback', 'Bash', 'codeome-agent watch --task third');
  assert.equal(t.chat.items[2].label, 'third');
  t.use('monitor-only', 'Monitor', 'codeome-agent watch --task fourth');
  assert.equal(t.chat.items[3].t, 'progress');
});

test('unrelated tools and invalid watch keys stay plain tool lines', () => {
  const t = harness();
  const commands = [
    ['Bash', 'npm test', {}],
    ['Bash', 'npm test', { run_in_background: true }],
    ['Monitor', 'npm test', {}],
    ['Bash', 'codeome-agent watch --task ../escape', {}],
    ['Monitor', 'codeome-agent watch --task a..b', {}],
    ['Bash', 'codeome-agent watch --task -bad', {}]
  ];
  commands.forEach(([name, command, extra], index) => t.use('tool' + index, name, command, extra));
  assert.equal(t.chat.items.length, commands.length);
  assert.ok(t.chat.items.every((it) => it.t === 'tool'));
});

test('background result stays running, then task notifications finish the card', async () => {
  for (const [notification, expected] of [['completed', 'done'], ['killed', 'cancelled'], ['failed', 'failed']]) {
    const t = harness();
    t.use('watch', 'Bash', 'codeome-agent watch --task suite', { run_in_background: true });
    t.result('watch', 'Command running in background');
    assert.equal(t.chat.items[0].status, 'running');
    t.event({ type: 'system', subtype: 'task_notification', tool_use_id: 'watch', status: notification });
    await settled();
    assert.equal(t.chat.items[0].status, expected);
    assert.equal(t.chat.items[0].endedAt, Date.parse('2026-10-22T08:03:00Z'));
  }
});

test('foreground watch results finish successfully or with an error', async () => {
  for (const [error, expected] of [[false, 'done'], [true, 'failed']]) {
    const t = harness();
    t.use('watch', 'Bash', 'codeome-agent watch --task suite');
    t.result('watch', 'final output', error);
    await settled();
    assert.equal(t.chat.items[0].status, expected);
  }
});

test('a watch detached with shell & stays running until its stages finish', async () => {
  for (const [states, expected, error] of [[['done', 'done'], 'done', false], [['done', 'failed'], 'failed', true]]) {
    const t = harness();
    t.use('watch', 'Bash', 'npx vitest > /tmp/run.log 2>&1 & pid=$!; codeome-agent watch --task suite --pid "$pid" &');
    const card = t.chat.items[0];
    assert.equal(card.detached, true);
    t.result('watch', 'Process exited', error);
    assert.equal(card.status, 'running');
    assert.equal(card.endedAt, undefined);
    t.setSnapshot({ suite: { stages: states.map((state) => ({ state, startedAt: new Date(card.startedAt).toISOString() })) } });
    await t.App.views.chat.syncTasks('/project');
    assert.equal(card.status, expected);
    assert.equal(card.endedAt, Date.parse('2026-10-22T08:03:00Z'));
    t.chat.busy = false;
    await t.App.views.chat.closeTab(t.chat);
    assert.equal(t.saved().items[0].status, expected);
    assert.equal(t.saved().items[0].detached, true);
  }
});

test('a trailing shell & detaches the watch, but && and quoted ampersands do not', async () => {
  for (const [command, detached] of [
    ['codeome-agent watch --task suite &\necho watching', true],
    ['codeome-agent watch --task suite & echo $!', true],
    ['codeome-agent watch --task suite &; echo $!', true],
    ['codeome-agent watch --task suite &&', false],
    ['codeome-agent watch --task suite && echo done', false],
    ['codeome-agent watch --task suite --label "A &"', false],
    ["codeome-agent watch --task suite --label 'A &'", false]
  ]) {
    const t = harness();
    t.use('watch', 'Bash', command);
    assert.equal(!!t.chat.items[0].detached, detached, command);
    if (!detached) {
      t.result('watch', 'final output');
      await settled();
      assert.equal(t.chat.items[0].status, 'done', command);
    }
  }
});

test('long commands are not scanned past 4096 characters', () => {
  const t = harness();
  t.use('long', 'Bash', `${'x'.repeat(4096)} codeome-agent watch --task suite`);
  assert.equal(t.chat.items[0].t, 'tool');
});

test('Monitor start result leaves the progress card running', async () => {
  const t = harness();
  t.use('monitor', 'Monitor', 'codeome-agent watch --task suite');
  t.result('monitor', 'Monitor started');
  await settled();
  assert.equal(t.chat.items[0].status, 'running');
  t.event({ type: 'system', subtype: 'task_notification', tool_use_id: 'monitor', status: 'completed' });
  await settled();
  assert.equal(t.chat.items[0].status, 'done');
});

test('syncTasks copies and drops progress, ignores reused keys, and skips IPC without live cards', async () => {
  const t = harness();
  await t.App.views.chat.syncTasks('/project');
  assert.equal(t.calls().length, 0);
  t.use('watch', 'Bash', 'codeome-agent watch --task suite');
  const card = t.chat.items[0];
  const progress = { stages: [{ label: 'Run', state: 'running', startedAt: new Date(card.startedAt).toISOString() }] };
  t.setSnapshot({ suite: progress });
  await t.App.views.chat.syncTasks('/project');
  assert.equal(card.progress, progress);
  assert.deepEqual(t.calls()[0], ['/project', ['suite']]);
  t.setSnapshot({});
  await t.App.views.chat.syncTasks('/project');
  assert.equal(Object.hasOwn(card, 'progress'), false);
  t.setSnapshot({ suite: { stages: [{ state: 'running', startedAt: new Date(card.startedAt - 10001).toISOString() }] } });
  await t.App.views.chat.syncTasks('/project');
  assert.equal(Object.hasOwn(card, 'progress'), false);
  card.status = 'done';
  await t.App.views.chat.syncTasks('/project');
  assert.equal(t.calls().length, 3);
});

test('syncTasks includes recently finished cards while another card runs', async () => {
  const t = harness();
  t.use('first', 'Bash', 'codeome-agent watch --task first');
  t.use('second', 'Bash', 'codeome-agent watch --task second');
  t.chat.items[0].status = 'done';
  t.chat.items[0].endedAt = Date.parse('2026-10-22T08:03:00Z');
  await t.App.views.chat.syncTasks('/project');
  assert.deepEqual(t.calls()[0], ['/project', ['first', 'second']]);
});

test('terminal stage snapshots finish cards before a notification', async () => {
  for (const [state, expected] of [['done', 'done'], ['failed', 'failed']]) {
    const t = harness();
    t.use('watch', 'Bash', 'codeome-agent watch --task suite');
    t.setSnapshot({ suite: { stages: [{ state, startedAt: new Date(t.chat.items[0].startedAt).toISOString() }] } });
    await t.App.views.chat.syncTasks('/project');
    assert.equal(t.chat.items[0].status, expected);
    assert.ok(t.chat.items[0].progress);
  }
});

test('terminal progress decides the outcome over tool results and notifications', async () => {
  for (const [states, kind, outcome, expected] of [
    [['failed'], 'notification', 'completed', 'failed'],
    [['failed'], 'result', false, 'failed'],
    [['done', 'done'], 'notification', 'completed', 'done'],
    [null, 'notification', 'completed', 'done'],
    [null, 'notification', 'killed', 'cancelled']
  ]) {
    const t = harness();
    t.use('watch', 'Bash', 'codeome-agent watch --task suite');
    const card = t.chat.items[0];
    if (states) t.setSnapshot({ suite: { stages: states.map((state) => ({ state, startedAt: new Date(card.startedAt).toISOString() })) } });
    if (kind === 'result') t.result('watch', 'watch finished', outcome);
    else t.event({ type: 'system', subtype: 'task_notification', tool_use_id: 'watch', status: outcome });
    assert.equal(card.status, 'running');
    await settled();
    assert.equal(card.status, expected);
  }
});

test('failed cards stay failed and progress fetch failure falls back to the notification', async () => {
  const t = harness();
  t.use('watch', 'Bash', 'codeome-agent watch --task suite');
  t.setSnapshot({ suite: { stages: [{ state: 'failed', startedAt: new Date(t.chat.items[0].startedAt).toISOString() }] } });
  await t.App.views.chat.syncTasks('/project');
  t.event({ type: 'system', subtype: 'task_notification', tool_use_id: 'watch', status: 'completed' });
  await settled();
  assert.equal(t.chat.items[0].status, 'failed');
  const other = harness();
  other.use('watch', 'Bash', 'codeome-agent watch --task suite');
  other.setSnapshot(new Error('IPC failed'));
  other.event({ type: 'system', subtype: 'task_notification', tool_use_id: 'watch', status: 'completed' });
  await settled();
  assert.equal(other.chat.items[0].status, 'done');
});

test('a later completion cannot undo a cancelled notification', async () => {
  const t = harness();
  t.use('watch', 'Bash', 'codeome-agent watch --task suite');
  t.event({ type: 'system', subtype: 'task_notification', tool_use_id: 'watch', status: 'killed' });
  await settled();
  t.event({ type: 'system', subtype: 'task_notification', tool_use_id: 'watch', status: 'completed' });
  await settled();
  assert.equal(t.chat.items[0].status, 'cancelled');
});

test('save keeps command progress and strips job progress; restore stops orphaned cards', async () => {
  const t = harness();
  const progress = { stages: [{ label: 'Run', state: 'done' }] };
  t.chat.items.push({ t: 'progress', id: 'task', key: 'suite', status: 'done', progress });
  t.chat.items.push({ t: 'job', id: 'job', status: 'done', progress });
  t.chat.busy = false;
  await t.App.views.chat.closeTab(t.chat);
  assert.equal(t.saved().items[0].progress, progress);
  assert.equal(Object.hasOwn(t.saved().items[1], 'progress'), false);
  assert.equal(t.chat.items[1].progress, progress);

  const stale = { t: 'progress', id: 'old', key: 'suite', status: 'running', startedAt: 1, progress };
  t.codeome.chat.load = async () => ({ id: 'restored', project: '/project', started: true, items: [stale] });
  await t.App.views.chat.open('restored');
  assert.equal(stale.status, 'stale');
  assert.ok(stale.endedAt);
  assert.equal(stale.progress, progress);
});

test('task card renders waiting, bars, rows, stall badge, and an accessible toggle', () => {
  const now = Date.parse('2026-10-22T08:03:00Z');
  const t = harness(now);
  const card = { t: 'progress', key: 'suite', label: 'Test suite', status: 'running', startedAt: now - 180000 };
  const waiting = t.render(t.chat, card);
  assert.equal(waiting.name, 'div.jobcard.taskcard.running');
  assert.equal(waiting.attrs.onclick, undefined);
  assert.match(content(waiting), /CommandTest suite running3 minwaiting for first output…/);
  card.progress = { updatedAt: '2026-10-22T08:00:00Z', stages: [
    { label: 'Prepare', state: 'done', done: 1, total: 1 },
    { label: 'Run', state: 'running', done: 2, total: 10, startedAt: '2026-10-22T08:00:00Z' }
  ] };
  const tree = t.render(t.chat, card);
  assert.equal(nodes(tree, 'div.jc-prog-row.done').length, 1);
  assert.equal(nodes(tree, 'div.jc-prog-row.running').length, 1);
  assert.match(content(tree), /no update for 180s/);
  const bars = [...nodes(tree, 'div.jc-prog-bar'), ...nodes(tree, 'div.jc-prog-bar.small')];
  assert.equal(bars.length, 3);
  assert.ok(bars.every((bar) => bar.attrs.role === 'progressbar' && bar.attrs['aria-valuenow'] >= 0));
  assert.equal(nodes(tree, 'div.jc-prog-bar')[0].attrs['aria-label'], 'Overall command progress');
  const toggle = nodes(tree, 'button.jc-prog-toggle')[0];
  assert.equal(toggle.attrs['aria-expanded'], 'true');
  toggle.attrs.onclick({ stopPropagation() {} });
  assert.equal(card.progressOpen, false);
  assert.equal(nodes(t.render(t.chat, card), 'div.jc-prog-row.running').length, 0);
  card.status = 'stale'; card.progressOpen = true;
  assert.equal(nodes(t.render(t.chat, card), 'div.jc-prog-row.stopped').length, 1);
});
