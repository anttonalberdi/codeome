const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createBuffer, fromSaved, redact } = require('../main/remote-items');

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-subagent.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line));

test('text deltas merge and the final assistant block settles the same item', () => {
  const buffer = createBuffer();
  buffer.push({ type: 'text_delta', msgId: 'msg-1', index: 0, text: 'Hel' });
  buffer.push({ type: 'text_delta', msgId: 'msg-1', index: 0, text: 'lo' });
  assert.deepEqual(buffer.tail(10).items.map((item) => item.text), ['Hello']);
  assert.equal(buffer.tail(1).items[0].live, true);
  buffer.push({ type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: 'Hello!' }] } });
  assert.equal(buffer.tail(10).items.length, 1);
  assert.equal(buffer.tail(1).items[0].text, 'Hello!');
  assert.equal(buffer.tail(1).items[0].live, false);
});

test('a real stream-json tool call receives its result and is capped at 4000 chars', () => {
  const buffer = createBuffer();
  const call = fixture.find((row) => row.type === 'assistant' && row.message.content.some((part) => part.type === 'tool_use'));
  const result = fixture.find((row) => row.type === 'user' && Array.isArray(row.message.content) && row.message.content.some((part) => part.type === 'tool_result'));
  buffer.push(call);
  assert.equal(buffer.tail(1).items[0].done, false);
  buffer.push(result);
  const item = buffer.tail(1).items[0];
  assert.equal(item.t, 'tool');
  assert.equal(item.name, 'Bash');
  assert.equal(item.id, 'toolu_example_1');
  assert.equal(item.done, true);
  assert.equal(item.result.length, 4000);
  assert.equal(item.truncated, true);
  assert.ok(item.size > 4000);
  assert.equal(buffer.get(item.id).result.length, 4000);
});

test('tail and before paginate retained items, including empty and eviction boundaries', () => {
  const buffer = createBuffer({ max: 3 });
  assert.deepEqual(buffer.tail(2), { items: [], total: 0, hasMore: false, firstIndex: 0 });
  for (let n = 0; n < 5; n++) buffer.addUser(`message ${n}`);
  assert.deepEqual(buffer.tail(2).items.map((item) => item.i), [3, 4]);
  assert.equal(buffer.tail(2).total, 3);
  assert.equal(buffer.tail(2).firstIndex, 2);
  assert.equal(buffer.tail(2).hasMore, true);
  assert.deepEqual(buffer.before(3, 2).items.map((item) => item.i), [2]);
  assert.equal(buffer.before(3, 2).hasMore, false);
  assert.deepEqual(buffer.before(2, 2).items, []);
  assert.deepEqual(buffer.tail(0).items, []);
  assert.equal(buffer.get('remote-0'), null);
  buffer.addUser('message 5');
  assert.deepEqual(buffer.tail(3).items.map((item) => item.i), [3, 4, 5]);
});

test('image bytes stay out of pages and are fetched by reference id', () => {
  const buffer = createBuffer();
  const raw = Buffer.from('image bytes');
  buffer.addUser('look', { images: [{ type: 'image', source: { media_type: 'image/png', data: raw.toString('base64') } }] });
  const user = buffer.tail(1).items[0];
  assert.deepEqual(user.images[0], { kind: 'image', itemId: `${user.id}:image:0`, mime: 'image/png', bytes: raw.length });
  assert.ok(!JSON.stringify(buffer.tail(1)).includes(raw.toString('base64')));
  assert.deepEqual(buffer.getImage(user.images[0].itemId), { mime: 'image/png', data: raw });
  assert.equal(buffer.getImage('/tmp/image.png'), null);
  buffer.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-image', name: 'Read', input: {} }] } });
  buffer.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-image', content: [
    { type: 'text', text: 'preview' }, { type: 'image', source: { media_type: 'image/jpeg', data: raw.toString('base64') } }
  ] }] } });
  const tool = buffer.tail(1).items[0];
  assert.equal(tool.result, 'preview');
  assert.deepEqual(buffer.getImage(tool.images[0].itemId).data, raw);
  assert.ok(!JSON.stringify(buffer.get(tool.id)).includes(raw.toString('base64')));
  buffer.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-uri', name: 'Read', input: {} }] } });
  buffer.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-uri',
    content: `data:image/png;base64,${raw.toString('base64')}` }] } });
  const uriTool = buffer.tail(1).items[0];
  assert.equal(uriTool.result, '[image]');
  assert.deepEqual(buffer.getImage(uriTool.images[0].itemId).data, raw);
});

test('obvious credential patterns are masked in output without changing stored data', () => {
  const secret = 'abcdef0123456789abcdef0123456789';
  const text = `Authorization: Basic ${secret}\nBearer abc.def-123\nexport API_KEY=${secret}\nPASSWORD: ${secret}\nMY_TOKEN ${secret}`;
  const buffer = createBuffer();
  buffer.addUser(text);
  const item = buffer.tail(1).items[0];
  assert.ok(!item.text.includes(secret));
  assert.match(item.text, /Authorization: \[REDACTED\]/);
  assert.match(item.text, /Bearer \[REDACTED\]/);
  assert.match(item.text, /API_KEY=\[REDACTED\]/);
  assert.match(item.text, /PASSWORD:\s*\[REDACTED\]/);
  assert.match(item.text, /MY_TOKEN \[REDACTED\]/);
  assert.equal(redact('ordinary text'), 'ordinary text');
});

test('quoted keys, short flags, token shapes, URLs and private keys are redacted', () => {
  const secrets = [
    '"api_key": "sk-1234567890abcdef"', '--token abc123', 'ghp_0123456789abcdef',
    'github_pat_0123456789abcdef', 'sk-abcdefgh1234', 'AKIAABCDEFGHIJKLMNOP',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature',
    'https://user:pass@host.example/path',
    '-----BEGIN PRIVATE KEY-----\nprivatebytes\n-----END PRIVATE KEY-----'
  ];
  const output = redact(secrets.join('\n'));
  for (const secret of ['sk-1234567890abcdef', 'abc123', 'ghp_0123456789abcdef',
    'github_pat_0123456789abcdef', 'sk-abcdefgh1234', 'AKIAABCDEFGHIJKLMNOP',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature', 'user:pass', 'privatebytes'])
    assert.equal(output.includes(secret), false, secret);
  assert.match(output, /api_key/);
  assert.match(output, /https:\/\/\[REDACTED\]@host\.example/);
});

test('redaction caps long fields and handles adversarial plain text promptly', () => {
  const start = performance.now();
  const plain = redact('a'.repeat(100000));
  const curl = redact('curl '.repeat(50000));
  assert.ok(performance.now() - start < 50);
  assert.ok(plain.length < 8300);
  assert.ok(curl.length < 8300);
  assert.match(plain, /\[TRUNCATED\]$/);
  assert.ok(Buffer.byteLength(redact('😀'.repeat(5000)).split('…[TRUNCATED]')[0], 'utf8') <= 8192);
});

test('permission and question requests move from pending to decided or cancelled', () => {
  const buffer = createBuffer();
  buffer.push({ type: 'control_request', request_id: 'req-1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } });
  buffer.push({ type: 'control_request', request_id: 'req-2', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which?' }] } } });
  assert.deepEqual(buffer.tail(2).items.map((item) => item.state), ['pending', 'pending']);
  buffer.markDecided('req-1', 'allow', 'phone');
  buffer.push({ type: 'control_cancel_request', request_id: 'req-2' });
  const [perm, ask] = buffer.tail(2).items;
  assert.equal(perm.decided, 'allow');
  assert.equal(perm.state, 'decided');
  assert.equal(perm.source, 'phone');
  assert.equal(ask.state, 'cancelled');
  assert.equal(ask.expired, true);
  assert.equal(buffer.markDecided('req-2', 'allow'), null);
});

test('question decisions retain answer values and duplicate requests update one card', () => {
  const buffer = createBuffer();
  const request = { type: 'control_request', request_id: 'r1', request: {
    subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Which?' }] }
  } };
  buffer.push(request);
  buffer.push({ ...request, request: { ...request.request, input: { questions: [{ question: 'Which new?' }] } } });
  assert.equal(buffer.tail(10).items.length, 1);
  assert.equal(buffer.tail(1).items[0].questions[0].question, 'Which new?');
  buffer.markDecided('r1', 'answered', 'phone', { 'Which new?': 'A, B' });
  assert.deepEqual(buffer.tail(1).items[0].answers, { 'Which new?': 'A, B' });
});

test('approval previews flag omitted or shortened input while full registry input stays separate', () => {
  const buffer = createBuffer();
  buffer.push({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool',
    tool_name: 'Bash', input: { command: 'x'.repeat(700), hidden: 'full detail' } } });
  const item = buffer.tail(1).items[0];
  assert.equal(item.truncated, true);
  assert.equal(item.input.command.length, 601);
  assert.equal(item.input.hidden, undefined);
});

test('image bytes evict oldest references at the per-buffer byte limit', () => {
  const buffer = createBuffer({ maxImageBytes: 5 });
  const add = (data) => buffer.addUser('image', { images: [{ mime: 'image/png', data: Buffer.from(data) }] });
  add('abc');
  const first = buffer.tail(1).items[0].images[0].itemId;
  add('def');
  assert.equal(buffer.getImage(first), null);
  assert.equal(buffer.get(buffer.tail(2).items[0].id).images.length, 0);
  assert.equal(buffer.tail(1).items[0].images.length, 1);
  add('123456');
  assert.equal(buffer.tail(1).items[0].images, undefined);
});

test('agent and Codex tool calls use the saved job card shape', () => {
  const buffer = createBuffer();
  buffer.push({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'agent-1', name: 'Agent', input: { subagent_type: 'reviewer', description: 'Check the change' } },
    { type: 'tool_use', id: 'codex-1', name: 'Bash', input: { command: '.codeome/bin/codeome-agent codex --role implementer --title "Add tests"' } }
  ] } });
  const [agent, codex] = buffer.tail(2).items;
  assert.deepEqual([agent.t, agent.engine, agent.role, agent.title, agent.status], ['job', 'claude', 'reviewer', 'Check the change', 'running']);
  assert.deepEqual([codex.t, codex.engine, codex.role, codex.title, codex.status], ['job', 'codex', 'implementer', 'Add tests', 'running']);
});

test('fromSaved keeps renderer shapes and continues indices after seeded items', () => {
  const buffer = fromSaved({ items: [{ t: 'user', text: 'hello' }, { t: 'tool', id: 'tool-1', name: 'Read', input: {}, done: true, result: 'ok' }] });
  assert.deepEqual(buffer.tail(2).items.map((item) => [item.t, item.i]), [['user', 0], ['tool', 1]]);
  assert.equal(buffer.get('tool-1').result, 'ok');
  buffer.addUser('later');
  assert.equal(buffer.tail(1).items[0].i, 2);
});

test('saved pending cards expire and saved live text is settled', () => {
  const buffer = fromSaved({ items: [
    { t: 'text', text: 'partial', live: true },
    { t: 'perm', requestId: 'p1', input: { command: 'pwd' } },
    { t: 'ask', requestId: 'a1', questions: [{ question: 'Which?' }] }
  ] });
  const [text, perm, ask] = buffer.tail(3).items;
  assert.equal(text.live, false);
  for (const card of [perm, ask]) { assert.equal(card.state, 'cancelled'); assert.equal(card.expired, true); }
  assert.equal(buffer.markDecided('p1', 'allow'), null);
  assert.equal(buffer.markDecided('a1', 'answered', 'phone', { 'Which?': 'A' }), null);
});
