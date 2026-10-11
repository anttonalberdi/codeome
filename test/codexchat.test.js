const test = require('node:test');
const { afterEach } = test;
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CODEOME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-home-'));
const { CodexSession, bare, rateLimits, savedThread } = require('../main/codexchat');

// A stand-in for `codex app-server`: answers the handshake, and plays a scripted turn for each message.
const FAKE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-codex-')), 'fake.js');
fs.writeFileSync(FAKE, `
const rl = require('readline').createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const note = (method, params) => out({ method, params });
const T = 'thread-1', TURN = 'turn-1';
let n = 100, waiting = null;
const turnDone = (status = 'completed') => note('turn/completed', { threadId: T, turn: { id: TURN, status, items: [], durationMs: 12 } });
const usageNote = () => note('thread/tokenUsage/updated', { threadId: T, turnId: TURN, tokenUsage: {
  last: { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 50, totalTokens: 1050 },
  total: { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 50, totalTokens: 1050, cacheWriteInputTokens: 0, reasoningOutputTokens: 0 }, modelContextWindow: 200000 } });
const approve = (method, params, then) => { const id = ++n; waiting = { id, then }; out({ id, method, params: { threadId: T, turnId: TURN, ...params } }); };
function play(text) {
  note('turn/started', { threadId: T, turn: { id: TURN, status: 'inProgress', items: [] } });
  if (text === 'hello') {
    note('item/started', { threadId: T, turnId: TURN, item: { type: 'agentMessage', id: 'm1', text: '' } });
    note('item/agentMessage/delta', { threadId: T, turnId: TURN, itemId: 'm1', delta: 'Hel' });
    note('item/agentMessage/delta', { threadId: T, turnId: TURN, itemId: 'm1', delta: 'lo' });
    note('item/completed', { threadId: T, turnId: TURN, item: { type: 'agentMessage', id: 'm1', text: 'Hello' } });
    usageNote(); turnDone();
  } else if (text === 'run' || text === 'runner') {
    const command = text === 'run' ? "/bin/zsh -lc 'ls -la'" : "/bin/zsh -lc '.codeome/bin/codeome-agent list'";
    const item = { type: 'commandExecution', id: 'c1', command, cwd: '/p', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null };
    note('item/started', { threadId: T, turnId: TURN, item });
    approve('item/commandExecution/requestApproval', { itemId: 'c1', command, reason: 'needs ls' }, (r) => {
      const ok = r.decision === 'accept' || r.decision === 'acceptForSession';
      note('item/completed', { threadId: T, turnId: TURN, item: { ...item, status: ok ? 'completed' : 'declined', aggregatedOutput: ok ? 'a\\nb\\n' : null, exitCode: ok ? 0 : null } });
      process.stderr.write('decision=' + JSON.stringify(r.decision) + '\\n');
      turnDone();
    });
  } else if (text === 'edit') {
    const item = { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ path: '/p/a.txt', kind: { type: 'update' }, diff: '' }, { path: '/p/b.txt', kind: { type: 'add' }, diff: '' }] };
    note('item/started', { threadId: T, turnId: TURN, item });
    approve('item/fileChange/requestApproval', { itemId: 'f1', reason: 'write' }, (r) => {
      note('item/completed', { threadId: T, turnId: TURN, item: { ...item, status: r.decision === 'decline' ? 'declined' : 'completed' } });
      turnDone();
    });
  } else if (text === 'mcp') {
    const item = { type: 'mcpToolCall', id: 'x1', server: 's', tool: 'lookup', arguments: { q: 1 }, status: 'inProgress' };
    note('item/started', { threadId: T, turnId: TURN, item });
    note('item/completed', { threadId: T, turnId: TURN, item: { ...item, status: 'completed', result: { content: [{ type: 'text', text: 'found' }] } } });
    turnDone();
  } else if (text === 'ask') {
    approve('item/tool/requestUserInput', { itemId: 'q1', questions: [{ id: 'which', header: 'Pick', question: 'Which one?', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }] }, (r) => {
      process.stderr.write('answers=' + JSON.stringify(r.answers) + '\\n');
      turnDone();
    });
  } else if (text === 'slow') {
    // waits for an interrupt
  } else if (text === 'fail') {
    note('error', { threadId: T, turnId: TURN, willRetry: false, error: { message: 'boom' } });
    turnDone('failed');
  }
}
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return out({ id: m.id, result: { userAgent: 'fake' } });
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    process.stderr.write(m.method + ' ' + JSON.stringify({ ...m.params, threadId: m.params.threadId }) + '\\n');
    return out({ id: m.id, result: { thread: { id: T }, model: 'gpt-fake' } });
  }
  if (m.method === 'account/rateLimits/read') return out({ id: m.id, result: { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 2e9 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 2e9 + 5 } } } });
  if (m.method === 'turn/start') {
    process.stderr.write('turn/start ' + JSON.stringify({ policy: m.params.approvalPolicy, sandbox: m.params.sandboxPolicy, effort: m.params.effort }) + '\\n');
    out({ id: m.id, result: { turn: { id: TURN, status: 'inProgress', items: [] } } });
    return play(m.params.input[0].text);
  }
  if (m.method === 'turn/interrupt') { out({ id: m.id, result: {} }); return turnDone('interrupted'); }
  if (m.id !== undefined && !m.method && waiting && m.id === waiting.id) { const w = waiting; waiting = null; w.then(m.result); }
});
`);

// A failed test must not leave its fake server running.
const live = [];
afterEach(() => { for (const s of live.splice(0)) s.stop(); });

function session(opts = {}) {
  const s = new CodexSession({ id: opts.id || 'chat-' + Math.random().toString(36).slice(2), cwd: os.tmpdir(), shell: '/bin/sh', bin: process.execPath, args: [FAKE],
    env: process.env, ...opts });
  s.messages = [];
  live.push(s);
  s.on('message', (m) => s.messages.push(m));
  s.start();
  return s;
}
const until = (s, pred, ms = 8000) => new Promise((resolve, reject) => {
  const hit = () => s.messages.find(pred);
  if (hit()) return resolve(hit());
  const t = setTimeout(() => { s.off('message', on); reject(new Error('timeout; saw ' + JSON.stringify(s.messages.map((m) => m.type + (m.subtype ? '/' + m.subtype : ''))))); }, ms);
  const on = () => { const m = hit(); if (m) { clearTimeout(t); s.off('message', on); resolve(m); } };
  s.on('message', on);
});
const done = (s) => new Promise((r) => { s.once('exit', r); s.stop(); });
const result = (s, n = 1) => until(s, () => s.messages.filter((m) => m.type === 'result').length >= n).then(() => s.messages.filter((m) => m.type === 'result')[n - 1]);

test('a reply streams as text deltas, then one assistant message, and the turn ends with a result and the meter', async () => {
  const s = session({ model: 'gpt-fake', effort: 'high' });
  const limits = new Promise((r) => s.once('rateLimits', r));
  s.user('hello');
  const r = await result(s);
  const kinds = s.messages.map((m) => m.type + (m.subtype ? '/' + m.subtype : ''));
  assert.deepStrictEqual(kinds.filter((k) => k !== 'context'), ['system/init', 'text_delta', 'text_delta', 'assistant', 'turn_usage', 'result/success']);
  assert.deepStrictEqual(s.messages.find((m) => m.type === 'system'), { type: 'system', subtype: 'init', session_id: 'thread-1', model: 'gpt-fake' });
  assert.deepStrictEqual(s.messages.filter((m) => m.type === 'text_delta').map((m) => [m.msgId, m.index, m.text]), [['m1', 0, 'Hel'], ['m1', 0, 'lo']]);
  const a = s.messages.find((m) => m.type === 'assistant');
  assert.deepStrictEqual(a.message.content, [{ type: 'text', text: 'Hello' }]);
  assert.strictEqual(a.message.id, 'm1');
  assert.strictEqual(r.subtype, 'success');
  assert.strictEqual(s.threadId, 'thread-1');
  const ctx = s.messages.find((m) => m.type === 'context');
  assert.deepStrictEqual(ctx, { type: 'context', used: 1050, window: 200000 });
  const t = s.messages.find((m) => m.type === 'turn_usage');
  assert.strictEqual(t.input, 400); assert.strictEqual(t.cacheRead, 600); assert.strictEqual(t.output, 50); assert.strictEqual(t.window, 200000);
  assert.deepStrictEqual(await limits, { five_hour: { used_percentage: 12, resets_at: 2e9 }, seven_day: { used_percentage: 40, resets_at: 2e9 + 5 } });
  const exit = await done(s);
  assert.ok(exit.stderr.includes('"effort":"high"') && exit.stderr.includes('workspaceWrite'), exit.stderr);
});

test('a command asks for approval; allowing runs it and its output comes back as a tool result', async () => {
  const s = session();
  s.user('run');
  const req = await until(s, (m) => m.type === 'control_request');
  assert.strictEqual(req.request.subtype, 'can_use_tool');
  assert.strictEqual(req.request.tool_name, 'Bash');
  assert.strictEqual(req.request.input.command, 'ls -la');
  const use = s.messages.find((m) => m.type === 'assistant').message.content[0];
  assert.deepStrictEqual([use.type, use.name, use.input], ['tool_use', 'Bash', { command: 'ls -la' }]);
  s.respond(req.request_id, { behavior: 'allow', updatedInput: req.request.input });
  await result(s);
  const res = s.messages.find((m) => m.type === 'user').message.content[0];
  assert.deepStrictEqual([res.type, res.tool_use_id, res.content, res.is_error], ['tool_result', use.id, 'a\nb\n', false]);
  assert.ok((await done(s)).stderr.includes('decision="accept"'));
});

test('declining an approval tells Codex to decline and the result is an error', async () => {
  const s = session();
  s.user('run');
  const req = await until(s, (m) => m.type === 'control_request');
  s.respond(req.request_id, { behavior: 'deny', message: 'no' });
  await result(s);
  assert.strictEqual(s.messages.find((m) => m.type === 'user').message.content[0].is_error, true);
  assert.ok((await done(s)).stderr.includes('decision="decline"'));
});

test('autoAllow answers a request without the panel being asked, as for Claude', async () => {
  const seen = [];
  const s = session({ autoAllow: (r) => { seen.push(r); return r.tool_name === 'Bash' && /^\.codeome\/bin\/codeome-agent\s/.test(r.input.command); } });
  s.user('runner');
  await result(s);
  assert.strictEqual(seen[0].input.command, '.codeome/bin/codeome-agent list');
  assert.ok(!s.messages.some((m) => m.type === 'control_request'));
  assert.ok((await done(s)).stderr.includes('decision="accept"'));
});

test('auto mode allows command approvals without asking the panel', async () => {
  const s = session({ mode: 'auto' });
  s.user('runner');
  await result(s);
  assert.ok(!s.messages.some((m) => m.type === 'control_request'));
  assert.ok((await done(s)).stderr.includes('decision="accept"'));
});

test('file changes show as one Edit or Write per file, with a permission request naming the files', async () => {
  const s = session();
  s.user('edit');
  const req = await until(s, (m) => m.type === 'control_request');
  assert.deepStrictEqual([req.request.tool_name, req.request.input.file_path], ['Edit', '/p/a.txt, /p/b.txt']);
  const uses = s.messages.filter((m) => m.type === 'assistant').map((m) => m.message.content[0]);
  assert.deepStrictEqual(uses.map((u) => [u.name, u.input.file_path]), [['Edit', '/p/a.txt'], ['Write', '/p/b.txt']]);
  s.respond(req.request_id, { behavior: 'allow', updatedInput: {} });
  await result(s);
  const ids = s.messages.filter((m) => m.type === 'user').map((m) => m.message.content[0].tool_use_id);
  assert.deepStrictEqual(ids, uses.map((u) => u.id));
  await done(s);
});

test('an MCP tool call is a tool named after the tool, with the server text as its result', async () => {
  const s = session();
  s.user('mcp');
  await result(s);
  const use = s.messages.find((m) => m.type === 'assistant').message.content[0];
  assert.deepStrictEqual([use.name, use.input], ['lookup', { q: 1 }]);
  assert.strictEqual(s.messages.find((m) => m.type === 'user').message.content[0].content, 'found');
  await done(s);
});

test('a question from Codex is an AskUserQuestion and the answer goes back by question id', async () => {
  const s = session();
  s.user('ask');
  const req = await until(s, (m) => m.type === 'control_request');
  assert.strictEqual(req.request.tool_name, 'AskUserQuestion');
  assert.deepStrictEqual(req.request.input.questions[0].options.map((o) => o.label), ['A', 'B']);
  s.respond(req.request_id, { behavior: 'allow', updatedInput: { ...req.request.input, answers: { 'Which one?': 'B' } } });
  await result(s);
  assert.ok((await done(s)).stderr.includes('answers={"which":{"answers":["B"]}}'));
});

test('interrupt ends the turn; a failed turn reports its error; modes map to policies', async () => {
  const s = session();
  s.user('slow');
  await until(s, (m) => m.type === 'system');
  assert.deepStrictEqual(await s.control({ subtype: 'interrupt' }), {});
  const r = await result(s);
  assert.strictEqual(r.interrupted, true);
  assert.deepStrictEqual(await s.control({ subtype: 'set_permission_mode', mode: 'plan' }), {});
  assert.ok((await s.control({ subtype: 'set_permission_mode', mode: 'nope' })).error);
  assert.ok((await s.control({ subtype: 'bogus' })).error);
  s.user('fail');
  const f = await result(s, 2);
  assert.deepStrictEqual([f.subtype, f.is_error, f.result], ['error_during_execution', true, 'boom']);
  const exit = await done(s);
  assert.ok(exit.stderr.includes('"policy":"on-request","sandbox":{"type":"readOnly"}'), exit.stderr);
});

test('a resumed chat finds its thread again and takes the instructions', async () => {
  const id = 'chat-resume';
  const first = session({ id, instructions: 'Be brief.' });
  await until(first, () => false, 300).catch(() => {});
  first.user('hello');
  await result(first);
  assert.ok((await done(first)).stderr.includes('thread/start') && true);
  assert.strictEqual(savedThread(id), 'thread-1');
  const again = session({ id, resume: true, instructions: 'Be brief.' });
  again.user('hello');
  await result(again);
  const exit = await done(again);
  assert.ok(exit.stderr.includes('thread/resume') && exit.stderr.includes('"threadId":"thread-1"') && exit.stderr.includes('"developerInstructions":"Be brief."'), exit.stderr);
});

test('helpers: the shell wrapper is stripped, and rate limit windows are told apart', () => {
  assert.strictEqual(bare("/bin/zsh -lc 'echo it'\\''s'"), "echo it's");
  assert.strictEqual(bare('bash -lc "echo \\"x\\""'), 'echo "x"');
  assert.strictEqual(bare('ls -la'), 'ls -la');
  assert.deepStrictEqual(rateLimits({ primary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1 } }), { seven_day: { used_percentage: 5, resets_at: 1 } });
  assert.strictEqual(rateLimits(null), null);
});
