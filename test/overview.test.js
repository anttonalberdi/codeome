const test = require('node:test');
const assert = require('node:assert');
const { buildOverview } = require('../renderer/js/overview-model');

test('a linear chat keeps user and agent rows on the main lane with their own tokens and main edges', () => {
  const tok = { in: 10, out: 4, cr: 2, cw: 1 };
  const view = buildOverview({ items: [
    { t: 'user', at: 0, text: 'Explain this' },
    { t: 'text', at: 1000, text: 'Here is the answer', tok }
  ] });
  assert.deepStrictEqual(view, {
    lanes: 1,
    nodes: [
      { id: 'item-0', lane: 0, row: 0, kind: 'user', at: 0, label: 'Explain this', tok: null },
      { id: 'item-1', lane: 0, row: 1, kind: 'agent', at: 1000, label: 'Here is the answer', tok }
    ],
    edges: [{ from: 'item-0', to: 'item-1', kind: 'main' }],
    boxes: [],
    totals: { in: 10, out: 4, cr: 2, cw: 1, costUsd: 0 },
    gaps: {}
  });
});

test('a finished job forks from the preceding main item and merges into the first main item at or after its end time', () => {
  const view = buildOverview({ items: [
    { t: 'user', at: 1000, text: 'Investigate' },
    { t: 'job', id: 'job-a', at: 500, startedAt: 1100, endedAt: 1200, title: 'Check logs', status: 'done' },
    { t: 'text', at: 1199, text: 'Still working' },
    { t: 'text', at: 1200, text: 'Found it' }
  ] });
  assert.deepStrictEqual(view.nodes.map(({ id, lane, row, at }) => ({ id, lane, row, at })), [
    { id: 'item-0', lane: 0, row: 0, at: 1000 },
    { id: 'job-a', lane: 1, row: 1, at: 1100 },
    { id: 'item-2', lane: 0, row: 2, at: 1199 },
    { id: 'item-3', lane: 0, row: 3, at: 1200 }
  ]);
  assert.deepStrictEqual(view.edges, [
    { from: 'item-0', to: 'item-2', kind: 'main' },
    { from: 'item-2', to: 'item-3', kind: 'main' },
    { from: 'item-0', to: 'job-a', kind: 'fork' },
    { from: 'job-a', to: 'item-3', kind: 'merge' }
  ]);
  assert.strictEqual(view.nodes[1].status, 'done');
  assert.strictEqual(view.lanes, 2);
});

test('two jobs running in parallel occupy separate side lanes and can merge into the same later main item', () => {
  const view = buildOverview({ items: [
    { t: 'user', at: 0, text: 'Run both' },
    { t: 'job', id: 'first', startedAt: 10, endedAt: 100, status: 'done' },
    { t: 'job', id: 'second', startedAt: 20, endedAt: 110, status: 'done' },
    { t: 'text', at: 120, text: 'Both finished' }
  ] });
  assert.deepStrictEqual(view.nodes.map((node) => node.lane), [0, 1, 2, 0]);
  assert.strictEqual(view.lanes, 3);
  assert.deepStrictEqual(view.edges.filter((edge) => edge.kind === 'fork'), [
    { from: 'item-0', to: 'first', kind: 'fork' },
    { from: 'item-0', to: 'second', kind: 'fork' }
  ]);
  assert.deepStrictEqual(view.edges.filter((edge) => edge.kind === 'merge'), [
    { from: 'first', to: 'item-3', kind: 'merge' },
    { from: 'second', to: 'item-3', kind: 'merge' }
  ]);
});

test('a running job forks without a merge even when another main item follows it', () => {
  const view = buildOverview({ items: [
    { t: 'user', at: 0, text: 'Start' },
    { t: 'job', id: 'live', at: 10, status: 'running' },
    { t: 'text', at: 20, text: 'Progress' }
  ] });
  assert.deepStrictEqual(view.edges.filter((edge) => edge.kind !== 'main'), [
    { from: 'item-0', to: 'live', kind: 'fork' }
  ]);
  assert.deepStrictEqual([view.nodes[1].kind, view.nodes[1].lane, view.nodes[1].at, view.nodes[1].status],
    ['job', 1, 10, 'running']);
});

test('a failed job keeps its failure status and does not merge after its end time', () => {
  const view = buildOverview({ items: [
    { t: 'user', at: 0, text: 'Start' },
    { t: 'job', id: 'broken', startedAt: 10, endedAt: 20, status: 'failed' },
    { t: 'text', at: 30, text: 'Continue' }
  ] });
  assert.strictEqual(view.nodes[1].status, 'failed');
  assert.deepStrictEqual(view.edges.filter((edge) => edge.kind !== 'main'), [
    { from: 'item-0', to: 'broken', kind: 'fork' }
  ]);
});

test('an approved ExitPlanMode wraps visible work up to but not including the next user row and strips its heading', () => {
  const view = buildOverview({ items: [
    { t: 'user', at: 0, text: 'Plan this' },
    { t: 'perm', tool: 'ExitPlanMode', decided: 'allow', input: { plan: '## Build parser\nThen check it' } },
    { t: 'text', at: 10, text: 'Implementing' },
    { t: 'job', id: 'build', startedAt: 20, status: 'running' },
    { t: 'text', at: 30, text: 'Done' },
    { t: 'user', at: 40, text: 'Next task' }
  ] });
  assert.deepStrictEqual(view.boxes, [{ startRow: 1, endRow: 4, title: 'Build parser', lanes: 2 }]);
  assert.strictEqual(view.nodes[4].row, view.boxes[0].endRow);
});

test('an approved Gate 1 box includes the Gate 2 item and ends before the next visible row', () => {
  const gate1 = '# Execute plan?\nWith checks';
  const view = buildOverview({ items: [
    { t: 'user', at: 0, text: 'Make a plan' },
    { t: 'ask', questions: [{ header: 'Gate 1', question: gate1 }], answers: { [gate1]: 'Approved, proceed' } },
    { t: 'text', at: 10, text: 'Executing' },
    { t: 'ask', questions: [{ header: 'Gate 2', question: 'Review results?' }] },
    { t: 'text', at: 20, text: 'After review' },
    { t: 'user', at: 30, text: 'Another request' }
  ] });
  // Gate 2 is hidden, so its inclusive item boundary is the next visible node row.
  assert.deepStrictEqual(view.boxes, [{ startRow: 1, endRow: 2, title: 'Execute plan?', lanes: 1 }]);
  assert.strictEqual(view.nodes[2].label, 'After review');
});

test('denied native and Gate 1 plans do not create boxes', () => {
  const prompt = 'Execute this plan?';
  const view = buildOverview({ items: [
    { t: 'user', at: 0, text: 'Plan' },
    { t: 'perm', tool: 'ExitPlanMode', decided: 'deny', input: { plan: '# Denied' } },
    { t: 'ask', questions: [{ header: 'Gate 1', question: prompt }], answers: { [prompt]: 'Reject' } },
    { t: 'text', at: 10, text: 'Revising' }
  ] });
  assert.deepStrictEqual(view.boxes, []);
});

test('a gap is recorded only when consecutive visible items with known times are more than five minutes apart', () => {
  const view = buildOverview({ items: [
    { t: 'user', at: 0 },
    { t: 'text', at: 300000 },
    { t: 'text', at: 600001 },
    { t: 'text' },
    { t: 'text', at: 900001 },
    { t: 'text', at: 1200002 },
    { t: 'text', at: NaN },
    { t: 'text', at: 1800000 }
  ] });
  assert.deepStrictEqual(view.gaps, { 2: 300001, 5: 300001 });
  assert.deepStrictEqual(view.nodes.map((node) => node.at), [0, 300000, 600001, null, 900001, 1200002, null, 1800000]);
});

test('empty and missing chat data return an empty overview with zero totals', () => {
  const empty = { lanes: 1, nodes: [], edges: [], boxes: [], totals: { in: 0, out: 0, cr: 0, cw: 0, costUsd: 0 }, gaps: {} };
  assert.deepStrictEqual(buildOverview(), empty);
  assert.deepStrictEqual(buildOverview({ items: [] }), empty);
  assert.deepStrictEqual(buildOverview({ items: null }), empty);
});

test('chat usage takes precedence over item token sums and missing or nonfinite token values count as zero', () => {
  const items = [
    { t: 'user', at: 0 },
    { t: 'text', at: 10, tok: { in: 10, out: 4, cr: NaN, cw: 2 } },
    { t: 'text', at: 20, tok: { in: 3, out: Infinity, cr: 5 } },
    { t: 'text', at: 30 }
  ];
  assert.deepStrictEqual(buildOverview({ items }).totals, { in: 13, out: 4, cr: 5, cw: 2, costUsd: 0 });
  assert.deepStrictEqual(buildOverview({ items, usage: {
    input: 100, output: 20, cacheRead: 30, cacheWrite: 40, costUsd: 0.25
  } }).totals, { in: 100, out: 20, cr: 30, cw: 40, costUsd: 0.25 });
});
