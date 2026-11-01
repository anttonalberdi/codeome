const test = require('node:test');
const assert = require('node:assert/strict');
const { createRegistry } = require('../main/remote-decisions');

function setup() {
  const calls = [];
  const session = { respond: (requestId, response) => { calls.push({ requestId, response }); } };
  const registry = createRegistry({ now: () => 1234 });
  const request = (requestId, toolName = 'Bash', input = { command: 'pwd' }, extra = {}) =>
    ({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: toolName, input, ...extra } });
  return { calls, session, registry, request };
}

test('only tool requests are added, with their details and an added event', () => {
  const { registry, session, request } = setup();
  const added = [];
  registry.on('added', (record) => added.push(record));
  assert.equal(registry.add('chat', session, { ...request('r1'), request: { subtype: 'get_usage' } }), null);
  assert.deepEqual(registry.list(), []);
  const record = registry.add('chat', session, request('r1', 'Bash', { command: 'pwd' },
    { title: 'Run command', decision_reason: 'Needed', permission_suggestions: [{ type: 'toolAlwaysAllow' }] }));
  assert.deepEqual(record, {
    requestId: 'r1', chatId: 'chat', toolName: 'Bash', input: { command: 'pwd' }, title: 'Run command',
    decisionReason: 'Needed', permissionSuggestions: [{ type: 'toolAlwaysAllow' }], createdAt: 1234
  });
  assert.deepEqual(added, [record]);
});

test('first answer wins, responds once, and records its source', () => {
  const { registry, session, request, calls } = setup();
  const decided = [];
  registry.on('decided', (event) => decided.push(event));
  const record = registry.add('chat', session, request('r1'));
  assert.deepEqual(registry.answer('chat', 'r1', { allow: true }, 'phone'), { ok: true, record });
  assert.deepEqual(calls, [{ requestId: 'r1', response: { behavior: 'allow', updatedInput: { command: 'pwd' } } }]);
  assert.deepEqual(registry.answer('chat', 'r1', { deny: true }, 'desktop'), { ok: false, reason: 'already-decided' });
  assert.deepEqual(registry.answer('chat', 'missing', { allow: true }, 'phone'), { ok: false, reason: 'unknown' });
  assert.equal(calls.length, 1);
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(decided, [{ requestId: 'r1', chatId: 'chat', source: 'phone', decision: 'allow' }]);
});

test('raw desktop responses are passed through and share first-answer-wins with phone', () => {
  const { registry, session, request, calls } = setup();
  const decided = [];
  registry.on('decided', (event) => decided.push(event));
  registry.add('chat', session, request('r1'));
  const raw = { behavior: 'allow', updatedInput: { command: 'changed' }, updatedPermissions: [{ type: 'toolAlwaysAllow' }] };
  assert.equal(registry.answerRaw('chat', 'r1', raw, 'desktop').ok, true);
  assert.strictEqual(calls[0].response, raw);
  assert.deepEqual(registry.answer('chat', 'r1', { deny: true }, 'phone'), { ok: false, reason: 'already-decided' });
  assert.deepEqual(decided, [{ requestId: 'r1', chatId: 'chat', source: 'desktop', decision: 'allow' }]);
  registry.add('chat', session, request('r2', 'AskUserQuestion', { questions: [{ question: 'Which?' }] }));
  assert.equal(registry.answerRaw('chat', 'r2', { behavior: 'allow', updatedInput: { answers: { 'Which?': 'A' } } }, 'desktop').ok, true);
  assert.equal(decided[1].decision, 'answered');
  registry.add('chat', session, request('r3'));
  assert.deepEqual(registry.answerRaw('chat', 'r3', { behavior: 'allow' }, 'phone'), { ok: false, reason: 'invalid' });
  assert.equal(registry.list().length, 1);
});

test('registry remembers cancelled and cleared request ids for desktop fallback', () => {
  const { registry, session, request } = setup();
  registry.add('chat', session, request('r1'));
  registry.cancel('chat', 'r1');
  assert.equal(registry.knows('chat', 'r1'), true);
  assert.equal(registry.knows('chat', 'never'), false);
  registry.add('chat', session, request('r2'));
  registry.clearChat('chat');
  assert.equal(registry.knows('chat', 'r2'), true);
});

test('desktop may send updated permissions, while phone only allows once', () => {
  const { registry, session, request, calls } = setup();
  const permissions = [{ type: 'toolAlwaysAllow', tool: 'Bash' }];
  registry.add('chat', session, request('desktop'));
  registry.add('chat', session, request('phone'));
  assert.equal(registry.answer('chat', 'desktop', { allow: true, updatedPermissions: permissions }, 'desktop').ok, true);
  assert.equal(registry.answer('chat', 'phone', { allow: true, updatedPermissions: permissions }, 'phone').ok, true);
  assert.deepEqual(calls.map((call) => call.response), [
    { behavior: 'allow', updatedInput: { command: 'pwd' }, updatedPermissions: permissions },
    { behavior: 'allow', updatedInput: { command: 'pwd' } }
  ]);
});

test('deny uses the supplied message or the default', () => {
  const { registry, session, request, calls } = setup();
  const decided = [];
  registry.on('decided', (event) => decided.push(event));
  registry.add('chat', session, request('r1'));
  registry.add('chat', session, request('r2'));
  assert.equal(registry.answer('chat', 'r1', { deny: true, message: 'No thanks' }, 'phone').ok, true);
  assert.equal(registry.answer('chat', 'r2', { deny: true }, 'desktop').ok, true);
  assert.deepEqual(calls.map((call) => call.response), [
    { behavior: 'deny', message: 'No thanks' }, { behavior: 'deny', message: 'The user declined this.' }
  ]);
  assert.deepEqual(decided.map((event) => event.decision), ['deny', 'deny']);
});

test('AskUserQuestion answers preserve the original input and answer by question text', () => {
  const { registry, session, request, calls } = setup();
  const input = { questions: [
    { question: 'Which one?', multiSelect: false, options: [] },
    { question: 'Which tags?', multiSelect: true, options: [] }
  ], other: 'kept' };
  const answers = { 'Which one?': 'A', 'Which tags?': ['X', 'Y'] };
  const decided = [];
  registry.on('decided', (event) => decided.push(event));
  registry.add('chat', session, request('r1', 'AskUserQuestion', input));
  assert.equal(registry.answer('chat', 'r1', { answers }, 'phone').ok, true);
  const normalized = { 'Which one?': 'A', 'Which tags?': 'X, Y' };
  assert.deepEqual(calls, [{ requestId: 'r1', response: { behavior: 'allow', updatedInput: { ...input, answers: normalized } } }]);
  assert.deepEqual(decided, [{ requestId: 'r1', chatId: 'chat', source: 'phone', decision: 'answered', answers: normalized }]);
});

test('invalid question answers leave the request pending', () => {
  const { registry, session, request, calls } = setup();
  registry.add('chat', session, request('r1', 'AskUserQuestion', { questions: [
    { question: 'Single?', multiSelect: false }, { question: 'Multiple?', multiSelect: true }
  ] }));
  for (const answers of [null, {}, { 'Single?': 'A' },
    { 'Single?': ['A'], 'Multiple?': 'B' },
    { 'Single?': 'A', 'Multiple?': [4] },
    { 'Single?': 'A', 'Multiple?': 'B', unknown: 'C' }]) {
    assert.deepEqual(registry.answer('chat', 'r1', { answers }, 'phone'), { ok: false, reason: 'invalid' });
  }
  assert.equal(calls.length, 0);
  assert.equal(registry.list().length, 1);
  assert.equal(registry.answer('chat', 'r1', { answers: { 'Single?': 'A', 'Multiple?': 'B, C' } }, 'desktop').ok, true);
});

test('respond throwing leaves the request pending for a retry', () => {
  const { registry, session, request } = setup();
  let calls = 0;
  session.respond = () => { if (++calls === 1) throw new Error('closed'); };
  registry.add('chat', session, request('r1'));
  assert.deepEqual(registry.answer('chat', 'r1', { allow: true }, 'phone'), { ok: false, reason: 'error' });
  assert.equal(registry.list().length, 1);
  assert.equal(registry.answer('chat', 'r1', { allow: true }, 'desktop').ok, true);
  assert.equal(calls, 2);
});

test('cancel and clearChat remove requests and emit events', () => {
  const { registry, session, request } = setup();
  const cancelled = [], cleared = [];
  registry.on('cancelled', (record) => cancelled.push(record));
  registry.on('cleared', (chatId) => cleared.push(chatId));
  registry.add('a', session, request('a1'));
  registry.add('a', session, request('a2'));
  registry.add('b', session, request('b1'));
  registry.cancel('a', 'a1');
  assert.deepEqual(registry.list('a').map((record) => record.requestId), ['a2']);
  registry.clearChat('a');
  assert.deepEqual(registry.list().map((record) => record.requestId), ['b1']);
  assert.deepEqual(cancelled.map((record) => record.requestId), ['a1']);
  assert.deepEqual(cleared, ['a']);
  assert.deepEqual(registry.answer('a', 'a1', { allow: true }, 'phone'), { ok: false, reason: 'unknown' });
});

test('list and returned records are copies, including nested input', () => {
  const { registry, session, request } = setup();
  const input = { nested: { value: 1 } };
  const record = registry.add('a', session, request('r1', 'Bash', input));
  input.nested.value = 2;
  record.input.nested.value = 3;
  const listed = registry.list();
  listed[0].input.nested.value = 4;
  assert.equal(registry.list()[0].input.nested.value, 1);
  assert.equal(registry.list('b').length, 0);
});

test('same request id in two chats stays independent and rejects a mismatched chat', () => {
  const { registry, request } = setup();
  const a = [], b = [];
  registry.add('a', { respond: (...args) => a.push(args) }, request('codex-0'));
  registry.add('b', { respond: (...args) => b.push(args) }, request('codex-0'));
  assert.equal(registry.list().length, 2);
  assert.deepEqual(registry.answer('c', 'codex-0', { allow: true }, 'phone'), { ok: false, reason: 'chat-mismatch' });
  assert.deepEqual(registry.cancel('c', 'codex-0'), { ok: false, reason: 'chat-mismatch' });
  assert.equal(registry.answer('b', 'codex-0', { deny: true }, 'phone').ok, true);
  assert.equal(registry.answer('a', 'codex-0', { allow: true }, 'phone').ok, true);
  assert.deepEqual(a, [['codex-0', { behavior: 'allow', updatedInput: { command: 'pwd' } }]]);
  assert.deepEqual(b, [['codex-0', { behavior: 'deny', message: 'The user declined this.' }]]);
});

test('a duplicate request updates its pending record without adding another', () => {
  const { registry, session, request } = setup();
  registry.add('chat', session, request('r1', 'Bash', { command: 'old' }));
  registry.add('chat', session, request('r1', 'Bash', { command: 'new' }));
  assert.equal(registry.list('chat').length, 1);
  assert.equal(registry.list('chat')[0].input.command, 'new');
  assert.equal(registry.list('chat')[0].createdAt, 1234);
});

test('known and decided histories evict oldest entries and detach can forget one chat', () => {
  const { registry, session, request } = setup();
  for (let n = 0; n < 2001; n++) {
    registry.add('a', session, request(`r${n}`));
    registry.answer('a', `r${n}`, { allow: true }, 'phone');
  }
  assert.equal(registry.knows('a', 'r0'), false);
  assert.deepEqual(registry.answer('a', 'r0', { allow: true }, 'phone'), { ok: false, reason: 'unknown' });
  assert.equal(registry.knows('a', 'r2000'), true);
  registry.add('b', session, request('r2000'));
  registry.clearChat('a', true);
  assert.equal(registry.knows('a', 'r2000'), false);
  assert.equal(registry.knows('b', 'r2000'), true);
});
