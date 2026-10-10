const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CODEOME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-home-'));
const stats = require('../main/stats');
const chat = require('../main/chat');

const MODEL = 'claude-haiku-4-5-20251001';
// The messages of a turn, as Claude Code 2.1 sends them: usage on message_start, the
// reply's final size on message_delta, running totals on the result.
const start = (u, parent = null) => ({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'message_start', message: { id: 'm', usage: { output_tokens: 4, ...u } } } });
const delta = (u) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', usage: u } });
const result = (usage, run, extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1000, duration_api_ms: run.apiMs, total_cost_usd: run.cost, usage,
  modelUsage: { [MODEL]: { inputTokens: run.in, outputTokens: run.out, cacheReadInputTokens: run.read, cacheCreationInputTokens: run.write, contextWindow: 200000 } }, ...extra });
const T1 = { input_tokens: 10, cache_creation_input_tokens: 7973, cache_read_input_tokens: 21000 };
const T2 = { input_tokens: 10, cache_creation_input_tokens: 86, cache_read_input_tokens: 28973 };
const R1 = { in: 910, out: 51, read: 21000, write: 7973, cost: 0.019211, apiMs: 1867 };
const R2 = { in: 920, out: 93, read: 49973, write: 8059, cost: 0.0225003, apiMs: 2771 };

test('the context reading follows the main thread, and a turn is the change in the running totals', () => {
  const m = new stats.Meter();
  assert.strictEqual(m.feed({ type: 'system', subtype: 'init', model: MODEL }), null);
  assert.deepStrictEqual(m.feed(start(T1)), { context: { used: 28987, window: 0 } });
  assert.strictEqual(m.feed(start({ input_tokens: 5000 }, 'toolu_1')), null); // a subagent has its own context
  assert.deepStrictEqual(m.feed({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm', usage: { ...T1, output_tokens: 4 }, content: [{ type: 'tool_use', name: 'Agent' }] } }), null);
  assert.deepStrictEqual(m.feed(delta({ ...T1, output_tokens: 42 })), { context: { used: 29025, window: 0 } });
  const a = m.feed(result({ ...T1, output_tokens: 42 }, R1)).turn;
  assert.deepStrictEqual([a.input, a.output, a.cacheRead, a.cacheWrite, a.costUsd, a.apiMs], [910, 51, 21000, 7973, 0.019211, 1867]);
  assert.deepStrictEqual([a.before, a.context, a.window, a.tools, a.subagents, a.model, a.error], [0, 29025, 200000, 1, 1, MODEL, false]);

  m.feed(start(T2));
  // A message_delta with the reply's size alone keeps the input it started with.
  assert.deepStrictEqual(m.feed(delta({ output_tokens: 42 })), { context: { used: 29111, window: 200000 } });
  const b = m.feed(result({ ...T2, output_tokens: 42 }, R2)).turn;
  assert.deepStrictEqual([b.input, b.output, b.cacheRead, b.cacheWrite, b.costUsd, b.apiMs], [10, 42, 28973, 86, 0.003289, 904]);
  assert.deepStrictEqual([b.before, b.context, b.tools], [29025, 29111, 0]);
  assert.deepStrictEqual(b.run, { input: 920, output: 93, cacheRead: 49973, cacheWrite: 8059, costUsd: 0.0225003, apiMs: 2771 });
});

test('a summarised conversation counts the compaction and keeps the peak', () => {
  const m = new stats.Meter();
  m.feed(start({ input_tokens: 150000 }));
  m.feed({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 167000 } });
  m.feed(start({ input_tokens: 30000 }));
  const t = m.feed(result({ input_tokens: 30000, output_tokens: 4 }, { in: 180000, out: 8, read: 0, write: 0, cost: 1, apiMs: 10 })).turn;
  assert.deepStrictEqual([t.compactions, t.peak, t.context], [1, 167000, 30004]);
});

test('a resumed session goes on from its totals, or from zero when Claude Code started them again', () => {
  const run = { input: 910, output: 51, cacheRead: 21000, cacheWrite: 7973, costUsd: 0.019211, apiMs: 1867 };
  const own = { ...T2, output_tokens: 42 };
  // The totals carried on.
  let m = new stats.Meter({ resumed: true, context: 29025, run });
  let t = m.feed(result(own, R2)).turn;
  assert.deepStrictEqual([t.input, t.cacheRead, t.before], [10, 28973, 29025]);
  // The totals started again: all of them belong to this turn.
  m = new stats.Meter({ resumed: true, context: 29025, run: { ...run, cacheRead: 900000 } });
  t = m.feed(result(own, { in: 15, out: 42, read: 28973, write: 86, cost: 0.004, apiMs: 900 })).turn;
  assert.deepStrictEqual([t.input, t.output, t.cacheRead, t.cacheWrite, t.costUsd], [15, 42, 28973, 86, 0.004]);
  // A conversation from before totals were kept: only the turn's own usage counts, once.
  m = new stats.Meter({ resumed: true });
  t = m.feed(result(own, R2)).turn;
  assert.deepStrictEqual([t.input, t.output, t.cacheRead, t.cacheWrite, t.costUsd], [10, 42, 28973, 86, 0]);
  t = m.feed(result(own, { in: 930, out: 135, read: 78946, write: 8145, cost: 0.03, apiMs: 3000 })).turn;
  assert.deepStrictEqual([t.input, t.output, t.cacheRead], [10, 42, 28973]);
});

test('the window is the session model\'s, not a subagent\'s', () => {
  const mu = { 'claude-opus-5-5': { contextWindow: 200000 }, 'claude-haiku-4-5': { contextWindow: 1000000 } };
  assert.strictEqual(stats.windowOf(mu, 'claude-opus-5-5'), 200000);
  assert.strictEqual(stats.windowOf(mu, 'claude-opus-5-5[1m]'), 200000);
  assert.strictEqual(stats.windowOf(mu, 'unknown'), 1000000);
  assert.strictEqual(stats.windowOf(undefined, 'x'), 0);
});

test('a session sends its meter\'s readings to the panel and the turn to the log', () => {
  const s = new chat.Session({ id: 'x', meter: { resumed: true, context: 100 } });
  const seen = [], turns = [];
  s.on('message', (m) => seen.push(m.type));
  s.on('turn', (t) => turns.push(t));
  s.handle(start(T1));
  s.handle(result({ ...T1, output_tokens: 4 }, R1));
  assert.deepStrictEqual(seen, ['context', 'turn_usage', 'result']);
  assert.strictEqual(turns[0].before, 100);
});

test('turns are appended one line each, and a broken line is skipped', () => {
  stats.record({ at: 1, session: 'a', project: '/p', account: 'me', input: 1, run: { input: 9 } });
  fs.appendFileSync(stats.file(), '{"at": 2, "sess\n');
  stats.record({ at: 3, session: 'b', project: '/p', input: 2 });
  assert.deepStrictEqual(stats.read(), [{ at: 1, session: 'a', project: '/p', account: 'me', input: 1 }, { at: 3, session: 'b', project: '/p', input: 2 }]);
});

test('the summary adds turns up by day, project, session and context fill', () => {
  const now = new Date(2026, 9, 10, 12).getTime(), day = 86400000;
  const turn = (o) => ({ project: '/p/one', input: 100, output: 10, cacheRead: 1000, cacheWrite: 0, costUsd: 0.01, ms: 500, window: 200000, before: 0, context: 20000, peak: 20000, compactions: 0, ...o });
  const sum = stats.summary([
    turn({ at: now - 40 * day, session: 'old' }),
    turn({ at: now - day, session: 'a' }),
    turn({ at: now - day + 1000, session: 'a', before: 120000, context: 150000, peak: 170000, compactions: 1, costUsd: 0.05 }),
    turn({ at: now - 1000, session: 'b', project: '/p/two', window: 0 })
  ], { days: 30, now });
  assert.deepStrictEqual([sum.total.turns, sum.total.sessions, sum.total.compacted, sum.total.tokens], [3, 2, 1, 3330]);
  assert.strictEqual(Math.round(sum.total.costUsd * 100), 7);
  assert.deepStrictEqual(sum.byDay.map((d) => [d.day, d.turns]), [['2026-10-10', 1], ['2026-10-09', 2]]);
  assert.deepStrictEqual(sum.byProject.map((p) => [p.project, p.sessions, p.turns]), [['/p/one', 1, 2], ['/p/two', 1, 1]]);
  assert.deepStrictEqual(sum.sessions.map((s) => [s.session, s.turns, s.peakPct, s.compactions]), [['b', 1, null, 0], ['a', 2, 85, 1]]);
  // A turn without a known window is in no fill band.
  assert.deepStrictEqual(sum.fill.map((f) => [f.from, f.to, f.turns]), [[0, 25, 1], [25, 50, 0], [50, 75, 1], [75, 100, 0]]);
});
