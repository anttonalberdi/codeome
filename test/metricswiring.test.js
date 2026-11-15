const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { buildPayload } = require('../main/metricsview');
const main = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '../main/preload.js'), 'utf8');

test('metrics IPC and terminal metadata are wired together', () => {
  assert.match(main, /ipcMain\.handle\('metrics:agents'/);
  assert.match(preload, /metrics: \{ agents: invoke\('metrics:agents'\) \}/);
  assert.match(main, /ptyMeta\.set\(spec.id, \{ project: spec.project, kind: spec.kind \}\)/);
  const deletions = [...main.matchAll(/ptys\.delete\(([^)]+)\);/g)];
  assert.ok(deletions.length > 0);
  for (const match of deletions) assert.ok(main.slice(match.index + match[0].length).trimStart().startsWith(`ptyMeta.delete(${match[1]});`));
});

test('payload groups and orders live roots, sums projects and Electron processes', () => {
  const items = [
    { project: '/z', kind: 'terminal', id: 'z', label: 'shell', pid: 1 },
    { project: '/a', kind: 'job', id: 'j', label: 'work', pid: 2 },
    { project: '/a', kind: 'chat', id: 'b', label: 'B', pid: 3 },
    { project: '/a', kind: 'chat', id: 'a', label: 'A', pid: 4 },
    { project: '/dead', kind: 'chat', id: 'dead', pid: 5 },
    { project: '/missing', kind: 'chat', id: 'missing' }
  ];
  const totals = Object.fromEntries([1, 2, 3, 4, 5].map((pid) => [pid, { cpu: pid, rssKb: pid * 10, nproc: pid, alive: pid !== 5 }]));
  const result = buildPayload({ items, totals, appMetrics: [
    { cpu: { percentCPUUsage: 2 }, memory: { workingSetSize: 100 } },
    { cpu: { percentCPUUsage: 3 }, memory: { workingSetSize: 200 } }
  ], ncpu: 8, ts: 123 });
  assert.equal(result.ts, 123);
  assert.equal(result.ncpu, 8);
  assert.deepEqual(result.projects.map((p) => p.project), ['/a', '/z']);
  assert.deepEqual(result.projects[0].items.map((i) => i.id), ['a', 'b', 'j']);
  assert.deepEqual(result.projects[0].items[0], { kind: 'chat', id: 'a', label: 'A', pid: 4, cpu: 4, rssKb: 40, nproc: 4 });
  assert.deepEqual(result.projects[0].totals, { cpu: 9, rssKb: 90, nproc: 9 });
  assert.deepEqual(result.app, { cpu: 5, rssKb: 300 });
});

test('unavailable CPU propagates to project totals and failures return errors', () => {
  const result = buildPayload({ items: [1, 2].map((pid) => ({ project: '/a', kind: 'job', id: String(pid), pid })),
    totals: { 1: { alive: true, cpu: null, rssKb: 10, nproc: 1 }, 2: { alive: true, cpu: 5, rssKb: 20, nproc: 2 } }, appMetrics: [], ncpu: 4 });
  assert.deepEqual(result.projects[0].totals, { cpu: null, rssKb: 30, nproc: 3 });
  assert.deepEqual(buildPayload({ totals: { error: 'denied' } }), { error: 'denied' });
  assert.equal(typeof buildPayload({}).error, 'string');
});

test('handler samples once, filters jobs, and returns errors without rejecting', async () => {
  const start = main.indexOf("ipcMain.handle('metrics:agents'");
  const source = main.slice(start, main.indexOf("ipcMain.handle('jobs:list'", start));
  let handler, calls = 0;
  const context = { ipcMain: { handle: (_ch, fn) => { handler = fn; } },
    chats: new Map([['chat', { cwd: '/p', proc: { pid: 10 }, getTitle: () => 'Title' }]]),
    ptys: new Map([['term', { pid: 20 }]]), ptyMeta: new Map([['term', { project: '/p', kind: 'shell' }]]),
    cfg: { openProjects: ['/p', '/p', '/bad'] }, jobs: { list: async (project) => {
      if (project === '/bad') throw new Error('bad directory');
      return [
        { id: 'job', pid: 30, status: 'running' }, { id: 'pausing', pid: 31, status: 'pausing' },
        { id: 'dead', pid: 40, status: 'running' },
        ...['done', 'failed', 'cancelled', 'lost', 'stale', 'paused', 'held'].map((status) => ({ id: status, pid: 50, status })),
        ...[0, 1, 4, -1, 5.5, '60', undefined].map((pid) => ({ id: 'invalid', pid, status: 'running' }))
      ];
    }, alive: (pid) => { assert.ok(Number.isInteger(pid) && pid > 4); return pid !== 40; } },
    procstats: { sample: async (roots) => { calls++; assert.deepEqual(Array.from(roots), [10, 20, 30, 31]); return {}; } },
    app: { getAppMetrics: () => [] }, os: { cpus: () => [1, 2] }, buildPayload: (input) => input };
  vm.runInNewContext(source, context);
  const result = await handler();
  assert.equal(calls, 1);
  assert.equal(result.items.length, 4);
  assert.deepEqual(Array.from(result.items, (item) => item.id), ['chat', 'term', 'job', 'pausing']);
  assert.equal(result.items[0].label, 'Title');
  context.procstats.sample = async () => { throw new Error('unavailable'); };
  assert.equal((await handler()).error, 'unavailable');
});


test('project totals count the union of nested and shared roots, independently per project', () => {
  const { subtreeTotals } = require('../main/procstats');
  for (const cpu of [2, null]) {
    const totals = subtreeTotals([10, 11], [
      { pid: 10, ppid: 1, cpu: 1, rssKb: 10 },
      { pid: 11, ppid: 10, cpu, rssKb: 20 },
      { pid: 12, ppid: 11, cpu: 3, rssKb: 30 }
    ]);
    const items = [
      { project: '/a', kind: 'chat', id: 'parent', label: 'Parent', pid: 10 },
      { project: '/a', kind: 'job', id: 'child', label: 'Child', pid: 11 },
      { project: '/a', kind: 'terminal', id: 'shared', label: 'Shared', pid: 10 },
      { project: '/b', kind: 'job', id: 'other', label: 'Other', pid: 11 }
    ];
    const result = buildPayload({ items, totals, appMetrics: [], ncpu: 4 });
    assert.deepEqual(result.projects[0].totals, { cpu: cpu === null ? null : 6, rssKb: 60, nproc: 3 });
    assert.deepEqual(result.projects[1].totals, { cpu: cpu === null ? null : 5, rssKb: 50, nproc: 2 });
    assert.deepEqual(result.projects[0].items.map((item) => item.nproc), [3, 2, 3]);
    assert.equal(JSON.stringify(result).includes('members'), false);
  }
});
