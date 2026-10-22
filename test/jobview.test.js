const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { parseClaudeTranscript, parseCodexEvents } = require('../main/jobview');
const jobs = require('../main/jobs');

const line = (type, content, timestamp = '2026-10-10T13:11:00Z') => JSON.stringify({ type, timestamp, message: { content } });

test('pausing Codex jobs settle to paused with a session, or lost without one', () => {
  const base = { engine: 'codex', pid: 999999, startedAt: new Date().toISOString() };
  assert.strictEqual(jobs.settle({ ...base, status: 'pausing', session: 'session-1' }).status, 'paused');
  assert.strictEqual(jobs.settle({ ...base, status: 'pausing' }).status, 'lost');
  assert.strictEqual(jobs.settle({ ...base, status: 'paused', session: 'session-1' }).status, 'paused');
});

test('resume timeout keeps its guard until the first wrapper exits or links', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-resume-guard-'));
  try {
    const id = 'paused-job';
    const dir = path.join(project, '.codeome', 'jobs', id);
    fs.mkdirSync(path.join(project, '.codeome', 'bin'), { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(project, '.codeome', 'bin', 'codeome-agent'), '');
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id, engine: 'codex', status: 'paused', session: 'session-1', role: 'implementer' }));
    let spawned = 0, timeout, poll, child;
    const module = { exports: {} };
    const source = fs.readFileSync(path.join(__dirname, '../main/jobs.js'), 'utf8');
    vm.runInNewContext(source, {
      module, process, setInterval: (fn) => { poll = fn; return 1; }, clearInterval() {},
      setTimeout: (fn) => { timeout = fn; return 2; }, clearTimeout() {},
      require: (name) => {
        if (name === 'child_process') return { spawn: () => {
          spawned++;
          child = new EventEmitter(); child.stdin = { on() {}, end() {} }; child.unref = () => {};
          return child;
        } };
        if (name === './kit') return { status: () => ({ installed: true, outdated: false, missing: [], modified: [] }) };
        if (name === './jobview') return require('../main/jobview');
        return require(name);
      }
    });
    const pending = module.exports.resume(project, id);
    timeout();
    assert.match((await pending).error, /still starting/);
    assert.match((await module.exports.resume(project, id)).error, /already resuming/);
    assert.strictEqual(spawned, 1);
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id, engine: 'codex', status: 'paused', session: 'session-1', resumedBy: 'next' }));
    poll();
    assert.match((await module.exports.resume(project, id)).error, /cannot be resumed/);
    child.emit('exit', 0);
    assert.strictEqual(spawned, 1);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('Claude transcript pairs tool results and keeps unfinished calls from the fixture', () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-subagent.jsonl'), 'utf8');
  const items = parseClaudeTranscript(text);
  assert.strictEqual(items[0].kind, 'user');
  assert.ok(items[0].text.startsWith('Goal:'));
  const tools = items.filter((item) => item.kind === 'tool');
  assert.strictEqual(tools.length, 2);
  assert.strictEqual(tools[0].name, 'Bash');
  assert.ok(tools[0].summary.length <= 120);
  assert.ok(!tools[0].summary.includes('\n'));
  assert.strictEqual(tools[0].result.size, 10717);
  assert.strictEqual(tools[0].result.text.length, 4096);
  assert.strictEqual(tools[0].result.truncated, true);
  assert.strictEqual(tools[0].result.isError, false);
  assert.strictEqual(tools[1].result, null);
  assert.ok(items.some((item) => item.kind === 'thinking'));
  assert.ok(!items.some((item) => item.kind === 'attachment'));
});

test('Claude transcript reads text and result blocks, skips malformed lines and limits results', () => {
  const source = [
    'cut first line',
    line('user', 'Do it'),
    line('assistant', [{ type: 'text', text: 'Working' }, { type: 'thinking', thinking: 'Reasoning' },
      { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/tmp/a' } }]),
    line('user', [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'abc' }, { type: 'text', text: 'def' }], is_error: true }]),
    line('attachment', 'ignore'),
  ].join('\n');
  const items = parseClaudeTranscript(source, { maxResult: 4 });
  assert.deepStrictEqual(items.map((item) => item.kind), ['user', 'text', 'thinking', 'tool']);
  assert.deepStrictEqual(items.slice(0, 3).map((item) => item.text), ['Do it', 'Working', 'Reasoning']);
  assert.strictEqual(items[3].summary, '/tmp/a');
  assert.deepStrictEqual(items[3].result, { text: 'abcd', truncated: true, isError: true, size: 6 });
  assert.deepStrictEqual(parseClaudeTranscript('{bad\n'), []);
});

test('jobs read serves the transcript path in job.json and tails large JSONL files', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-jobview-'));
  try {
    const dir = path.join(project, '.codeome', 'jobs', 'one');
    fs.mkdirSync(dir, { recursive: true });
    const transcript = path.join(project, 'agent.jsonl');
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ transcript }));
    fs.writeFileSync(transcript, line('user', 'First') + '\n' + line('assistant', [{ type: 'text', text: 'Last' }]));
    assert.deepStrictEqual(await jobs.read(project, 'one', 'transcript'), {
      items: parseClaudeTranscript(fs.readFileSync(transcript, 'utf8')), path: transcript,
    });
    fs.writeFileSync(transcript, line('user', 'x'.repeat(2 * 1024 * 1024)) + '\n' + line('user', 'Last'));
    const tailed = await jobs.read(project, 'one', 'transcript');
    assert.strictEqual(tailed.truncated, true);
    assert.deepStrictEqual(tailed.items.map((item) => item.text), ['Last']);
    fs.writeFileSync(path.join(dir, 'job.json'), '{}');
    assert.deepStrictEqual(await jobs.read(project, 'one', 'transcript'), { items: [], missing: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ transcript: path.join(project, 'wrong.txt') }));
    assert.deepStrictEqual(await jobs.read(project, 'one', 'transcript'), { items: [], missing: true });
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});

test('Codex events pair command calls and read messages and usage from the fixture', () => {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-events.jsonl'), 'utf8');
  const items = parseCodexEvents(text);
  assert.deepStrictEqual(items.map((item) => item.kind), ['event', 'event', 'tool', 'text', 'usage']);
  assert.deepStrictEqual(items.slice(0, 2).map((item) => item.type), ['thread.started', 'turn.started']);
  assert.deepStrictEqual(items[2], {
    kind: 'tool', id: 'item_0', name: 'shell', summary: "/bin/zsh -lc 'echo hi'",
    input: { command: "/bin/zsh -lc 'echo hi'" },
    result: { text: 'hi\n', truncated: false, isError: false, size: 3, exitCode: 0 },
  });
  assert.deepStrictEqual(items[3], { kind: 'text', text: 'ok' });
  assert.strictEqual(items[4].usage.input_tokens, 28928);
});

test('Codex events tolerate malformed and unknown rows, retain running tools, and limit output', () => {
  const source = [
    '{bad',
    JSON.stringify({ type: 'item.started', item: { id: 'running', type: 'command_execution', command: 'echo\n  wait' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'failed', type: 'command_execution', command: 'false', aggregated_output: 'failure', exit_code: 3 } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'thought', type: 'reasoning', text: 'considering' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'edit', type: 'file_change', changes: [{ path: 'a', kind: 'update' }] } }),
    JSON.stringify({ type: 'error', message: 'network error' }),
    JSON.stringify({ type: 'turn.failed', message: 'turn error' }),
    JSON.stringify({ type: 'future.event' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'other', type: 'future_item' } }),
  ].join('\n');
  const items = parseCodexEvents(source, { maxOutput: 4 });
  assert.deepStrictEqual(items.map((item) => item.kind), ['tool', 'tool', 'thinking', 'tool', 'error', 'error', 'event', 'event']);
  assert.deepStrictEqual(items[0].result, null);
  assert.strictEqual(items[0].summary, 'echo wait');
  assert.deepStrictEqual(items[1].result, { text: 'fail', truncated: true, isError: true, size: 7, exitCode: 3 });
  assert.deepStrictEqual(items[2], { kind: 'thinking', text: 'considering' });
  assert.deepStrictEqual(items[3].input, { changes: [{ path: 'a', kind: 'update' }] });
  assert.strictEqual(items[3].summary, '1 files');
  assert.deepStrictEqual(items[3].result, { text: '', truncated: false, isError: false, size: 0, exitCode: null });
  assert.deepStrictEqual(items.slice(4, 6).map((item) => item.text), ['network error', 'turn error']);
  assert.deepStrictEqual(items.slice(6).map((item) => item.type), ['future.event', 'item.completed']);
  assert.deepStrictEqual(parseCodexEvents('{bad\n'), []);
});

test('jobs read serves Codex events from the job directory and reports a missing file', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-jobview-events-'));
  try {
    const dir = path.join(project, '.codeome', 'jobs', 'one');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), '{}');
    const events = path.join(dir, 'events.jsonl');
    assert.deepStrictEqual(await jobs.read(project, 'one', 'events'), { items: [], missing: true });
    const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-events.jsonl'), 'utf8');
    fs.writeFileSync(events, fixture);
    assert.deepStrictEqual(await jobs.read(project, 'one', 'events'), { items: parseCodexEvents(fixture), path: events });
    fs.writeFileSync(events, JSON.stringify({ type: 'error', message: 'x'.repeat(2 * 1024 * 1024) }) + '\n' + JSON.stringify({ type: 'turn.failed', message: 'Last' }));
    const tailed = await jobs.read(project, 'one', 'events');
    assert.strictEqual(tailed.truncated, true);
    assert.deepStrictEqual(tailed.items, [{ kind: 'error', text: 'Last' }]);
  } finally { fs.rmSync(project, { recursive: true, force: true }); }
});
