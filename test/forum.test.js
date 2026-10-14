const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CODEOME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-home-'));
const { Forum, parseRaise } = require('../main/forum');

const seats = () => [
  { id: 'a', engine: 'claude', name: 'Alice', persona: 'Careful scientist' },
  { id: 'b', engine: 'codex', name: 'Bob' }
];
const tick = async () => { await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-docs-'));
let fixtureNo = 0;
function fixture(ext, text) {
  const file = path.join(fixtureDir, `doc-${++fixtureNo}${ext}`);
  fs.writeFileSync(file, text);
  return file;
}

class FakeSession extends EventEmitter {
  constructor(seat) { super(); this.seat = seat; this.sent = []; this.controls = []; this.responses = []; this.started = false; this.stopped = false; }
  start() { this.started = true; }
  user(text) { this.sent.push(text); }
  control(request) { this.controls.push(request); return Promise.resolve({}); }
  respond(id, response) { this.responses.push({ id, response }); }
  stop() { this.stopped = true; }
  reply(text) {
    this.emit('message', { type: 'assistant', message: { content: [{ type: 'text', text }] } });
    this.emit('message', { type: 'result' });
  }
}
function setup(extra = {}) {
  const sessions = [];
  const events = [];
  const calls = [];
  const forum = new Forum({ id: 'forum-1', project: '/project', title: 'Research', seats: seats(),
    now: (() => { let ms = 1000; return () => ++ms; })(),
    makeSession: (seat) => { const session = new FakeSession(seat); if (extra.session) extra.session(session, sessions.length); sessions.push(session); return session; },
    check: (seat, prompt, signal) => {
      calls.push({ seat, prompt, signal });
      return extra.check ? extra.check(seat, prompt, signal) : Promise.resolve({ text: 'pass', usage: {} });
    }, settings: extra.settings });
  forum.on('event', (event) => events.push(event));
  return { forum, sessions, events, calls };
}
function ask(session, id, tool, input = {}) {
  session.emit('message', { type: 'control_request', request_id: id,
    request: { subtype: 'can_use_tool', tool_name: tool, input } });
  return session.responses.at(-1).response;
}

test('parseRaise accepts only a first-line pass or raise and trims reasons', () => {
  const cases = [
    ['pass', { raise: false }], ['PASS.', { raise: false }], ['`raise: x`', { raise: true, reason: 'x' }],
    ['raise - x', { raise: true, reason: 'x' }], ['raise x', { raise: true, reason: 'x' }],
    ['garbage', { raise: false }], ['', { raise: false }], ['\n  pass\nraise: ignored', { raise: false }],
    ['raise: ' + 'x'.repeat(220), { raise: true, reason: 'x'.repeat(200) }]
  ];
  for (const [input, want] of cases) assert.deepEqual(parseRaise(input), want, input);
});

test('a seat named at the start of a sentence raises a hand even when its check would pass', async () => {
  const { forum, calls } = setup();
  await forum.post('Bob, do you see anything I missed in the IPC handlers?');
  assert.equal(forum.hands.length, 1);
  assert.equal(forum.hands[0].seatId, 'b');
  assert.match(forum.hands[0].reason, /Addressed/);
  assert.ok(calls.every((call) => call.seat.id !== 'b'));
  await forum.post('I think Bob has a point, but Alice is right.');
  assert.equal(forum.hands.length, 0);
  forum.dispose();
});

test('post records a message, checks seats in parallel, and cancels stale checks and hands', async () => {
  const pending = [];
  const { forum, calls, events } = setup({ check: (_seat, _prompt, signal) => {
    const wait = deferred(); pending.push({ ...wait, signal }); return wait.promise;
  } });
  const first = forum.post('first');
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(forum.transcript[0].speaker, 'user');
  assert.equal(forum.transcript[0].kind, 'message');
  assert.ok(events.some((event) => event.type === 'message' && event.item.text === 'first'));
  pending[0].resolve({ text: 'raise: first point' }); pending[1].resolve({ text: 'pass' });
  await first;
  assert.equal(forum.hands.length, 1);
  const second = forum.post('second');
  await tick();
  assert.equal(forum.hands.length, 0);
  assert.ok(events.some((event) => event.type === 'hand-removed'));
  assert.equal(calls.length, 4);
  pending[2].resolve({ text: 'pass' }); pending[3].resolve({ text: 'raise: new point' });
  await second;
  assert.equal(forum.hands[0].msgId, forum.transcript[1].id);
  forum.dispose();
});

test('a failed or unparseable check passes and reports errors without rejecting post', async () => {
  const { forum, events } = setup({ check: (seat) => seat.id === 'a' ? Promise.reject(new Error('offline')) : { text: 'maybe' } });
  await forum.post('topic');
  assert.equal(forum.hands.length, 0);
  assert.ok(events.some((event) => event.type === 'error' && event.error === 'offline'));
  forum.dispose();
});

test('manual allows queue FIFO; speech uses unseen messages, streams deltas, and asks others afterward', async () => {
  const { forum, sessions, events, calls } = setup({ check: () => ({ text: 'raise: contribution' }) });
  forum.attachDoc(fixture('.md', 'doc head ' + 'z'.repeat(2000)));
  await forum.post('question');
  assert.equal(forum.hands.length, 2);
  assert.match(calls[0].prompt, /Careful scientist/);
  assert.match(calls[0].prompt, /doc head/);
  assert.ok(!calls[0].prompt.includes('z'.repeat(2000)));
  assert.match(calls[0].prompt, /Reply with exactly one line/);
  assert.ok(forum.allow(forum.hands[0].id));
  assert.ok(forum.allow(forum.hands[0].id));
  await tick();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].seat.id, 'a');
  assert.deepEqual(sessions[0].controls[0], { subtype: 'set_permission_mode', mode: 'plan' });
  assert.match(sessions[0].sent[0], /Alice in a moderated forum with Bob/);
  assert.match(sessions[0].sent[0], /do not edit files/);
  assert.match(sessions[0].sent[0], /user: question/);
  sessions[0].emit('message', { type: 'text_delta', text: 'Alic' });
  assert.ok(events.some((event) => event.type === 'message' && event.delta === 'Alic' && event.item.text === 'Alic' && event.item.speaker === 'a'));
  sessions[0].emit('message', { type: 'assistant', message: { content: [{ type: 'text', text: 'Alice ' }, { type: 'tool_use', name: 'Read' }] } });
  sessions[0].emit('message', { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } });
  sessions[0].emit('message', { type: 'result' });
  await tick();
  assert.equal(forum.transcript.at(-1).text, 'Alice \n\nanswer');
  assert.equal(forum.transcript.at(-1).speaker, 'a');
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].seat.id, 'b');
  assert.match(sessions[1].sent[0], /Alice: Alice \n\nanswer/);
  assert.ok(!calls.slice(2).some((call) => call.seat.id === 'a'));
  sessions[1].reply('Bob answer');
  await tick();
  assert.equal(forum.seat('a').seenUpTo, 1);
  assert.equal(forum.transcript.at(-1).speaker, 'b');
  forum.dispose();
});

test('auto budget is spent once per allowed hand; dismiss waits for the next message', async () => {
  const { forum, sessions, calls } = setup({ settings: { defaultBudget: 1 }, check: () => ({ text: 'raise: idea' }) });
  await forum.post('topic');
  await tick();
  assert.equal(forum.budget, 0);
  assert.equal(forum.hands.length, 1);
  assert.equal(sessions.length, 1);
  assert.equal(forum.dismiss(forum.hands[0].id), true);
  assert.equal(forum.hands.length, 0);
  assert.equal(calls.length, 2);
  sessions[0].reply('answer');
  await tick();
  await forum.post('next');
  assert.equal(forum.budget, 0);
  assert.equal(sessions[0].sent.length, 2);
  forum.setBudget(2);
  assert.equal(forum.budgetLimit, 2);
  await forum.post('again');
  assert.ok(forum.budget <= 2);
  forum.dispose();
});

test('mute aborts an in-flight check, removes its hand, and blocks writes until unmuted', async () => {
  const pending = deferred();
  const { forum, calls } = setup({ check: (seat) => seat.id === 'a' ? pending.promise : { text: 'pass' } });
  const round = forum.post('topic');
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(forum.mute('a', true), true);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(forum.grantWrite('a', 'edit'), false);
  pending.resolve({ text: 'raise: stale' });
  await round;
  assert.equal(forum.hands.length, 0);
  forum.mute('a', false);
  await forum.post('next');
  assert.ok(calls.length > 2);
  forum.dispose();
});

test('stop interrupts active speech, clears hands and queued turns, and sets idle', async () => {
  const { forum, sessions, events } = setup({ check: () => ({ text: 'raise: idea' }) });
  await forum.post('topic');
  forum.allow(forum.hands[0].id);
  forum.allow(forum.hands[0].id);
  await tick();
  forum.stop();
  assert.equal(forum.hands.length, 0);
  assert.equal(forum.queue.length, 0);
  assert.equal(forum.budget, 0);
  assert.equal(forum.active, null);
  assert.ok(sessions[0].controls.some((request) => request.subtype === 'interrupt'));
  assert.ok(events.some((event) => event.type === 'state' && event.state === 'idle'));
  sessions[0].reply('late');
  assert.equal(forum.transcript.length, 1);
  forum.dispose();
});

test('stop aborts pending raise checks and ignores their late answers', async () => {
  const wait = deferred();
  const { forum, calls } = setup({ check: () => wait.promise });
  const round = forum.post('topic');
  await tick();
  forum.stop();
  assert.ok(calls.every((call) => call.signal.aborted));
  wait.resolve({ text: 'raise: too late' });
  await round;
  assert.equal(forum.hands.length, 0);
  forum.dispose();
});

test('writer lock queues another writer, restores plan, and applies canWrite and mute hooks', async () => {
  const { forum, sessions, events } = setup();
  forum.canWrite = (seat) => seat.id === 'b' && !forum.doc ? 'Attach a document' : true;
  assert.equal(forum.grantWrite('b', 'write now'), false);
  assert.ok(events.some((event) => event.type === 'error' && event.error === 'Attach a document'));
  const docFile = fixture('.md', 'before');
  forum.attachDoc(docFile);
  assert.equal(forum.grantWrite('a', 'edit A'), true);
  assert.equal(forum.grantWrite('b', 'edit B'), true);
  await tick();
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].controls.map((one) => one.mode), ['plan', 'acceptEdits']);
  assert.deepEqual(sessions[0].sent, [`Document (${fs.realpathSync(docFile)}):\nbefore\n\nThe moderator asked you to edit the shared document ${fs.realpathSync(docFile)}: edit A\nEdit only that document; do not touch other files. Reply with a one-line summary of what you changed.`]);
  assert.ok(events.some((event) => event.type === 'seat' && event.state === 'writing'));
  sessions[0].reply('changed A');
  await tick();
  assert.equal(forum.transcript.at(-1).kind, 'write');
  assert.equal(forum.transcript.at(-1).text, 'changed A');
  assert.equal(sessions[0].controls.at(-1).mode, 'plan');
  assert.equal(sessions.length, 2);
  assert.match(sessions[1].sent[0], /edit B\nEdit only that document/);
  forum.stop();
  assert.equal(sessions[1].controls.at(-1).mode, 'plan');
  forum.dispose();
});

test('writer lock stays held until plan mode is restored', async () => {
  const { forum, sessions } = setup();
  forum.attachDoc(fixture('.md', 'before'));
  forum.grantWrite('a', 'edit A');
  forum.grantWrite('b', 'edit B');
  await tick();
  const reset = deferred();
  const original = sessions[0].control.bind(sessions[0]);
  sessions[0].control = (request) => request.mode === 'plan' ? reset.promise : original(request);
  sessions[0].reply('done');
  await tick();
  assert.equal(sessions.length, 1);
  assert.equal(forum.active.seatId, 'a');
  assert.equal(ask(sessions[0], 'late-edit', 'Edit', { file_path: forum.doc.path }).behavior, 'deny');
  reset.resolve({});
  await tick();
  assert.equal(sessions.length, 2);
  forum.dispose();
});

test('stopping during write restoration does not wait for a second result', async () => {
  const { forum, sessions } = setup();
  forum.attachDoc(fixture('.md', 'before'));
  forum.grantWrite('a', 'first'); await tick();
  const reset = deferred();
  const control = sessions[0].control.bind(sessions[0]);
  sessions[0].control = (request) => request.mode === 'plan' ? reset.promise : control(request);
  sessions[0].reply('done'); await tick();
  forum.stop();
  forum.grantWrite('a', 'second'); await tick();
  assert.equal(sessions[0].sent.length, 1);
  reset.resolve({}); await tick();
  assert.equal(sessions[0].sent.length, 2);
  forum.dispose();
});

test('rolling summary covers older messages, uses Claude, and retries after failure', async () => {
  let fail = true;
  const { forum, calls, events } = setup({ settings: { summaryTokens: 1, recentMessages: 1 },
    check: (seat, prompt) => {
      if (prompt.startsWith('Summarise')) {
        if (fail) { fail = false; throw new Error('temporary'); }
        return { text: 'Agreed: test the idea.', usage: { input_tokens: 4 } };
      }
      return { text: 'pass' };
    } });
  await forum.post('first long point');
  await forum.post('second long point');
  assert.equal(forum.summary, '');
  assert.equal(forum.transcript[0].summarized, undefined);
  assert.ok(events.some((event) => event.type === 'error' && event.error === 'temporary'));
  await forum.post('third long point');
  assert.equal(forum.summary, 'Agreed: test the idea.');
  assert.equal(forum.transcript[0].summarized, true);
  assert.equal(forum.transcript[1].summarized, true);
  assert.equal(forum.transcript[2].summarized, undefined);
  assert.equal(forum.summarizedUpTo, forum.transcript[1].id);
  assert.ok(events.some((event) => event.type === 'summary'));
  const summaryCall = calls.find((call) => call.prompt.startsWith('Summarise'));
  assert.equal(summaryCall.seat.engine, 'claude');
  const lastRaise = calls.at(-1).prompt;
  assert.match(lastRaise, /Agreed: test the idea/);
  assert.ok(!lastRaise.includes('first long point'));
  forum.dispose();
});

test('summary falls back to an unmuted Codex seat', async () => {
  const { forum, calls } = setup({ settings: { summaryTokens: 1, recentMessages: 1 },
    check: (_seat, prompt) => ({ text: prompt.startsWith('Summarise') ? 'Summary from Bob' : 'pass' }) });
  forum.mute('a', true);
  await forum.post('first long point');
  await forum.post('second long point');
  assert.equal(forum.summary, 'Summary from Bob');
  assert.equal(calls.find((call) => call.prompt.startsWith('Summarise')).seat.id, 'b');
  forum.dispose();
});

test('usage combines Meter turn fields and check tokens, then round-trips with doc and seen state', async () => {
  const { forum, sessions, events } = setup({ check: () => ({ text: 'raise: idea',
    usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 3, total_cost_usd: 0.01 } }) });
  forum.attachDoc(fixture('.gdoc', JSON.stringify({ doc_id: 'doc-1' })));
  await forum.post('topic');
  forum.allow(forum.hands.find((hand) => hand.seatId === 'a').id);
  await tick();
  sessions[0].emit('turn', { input: 9, output: 4, cacheRead: 2, costUsd: 0.03 });
  assert.deepEqual(forum.usage().a, { turns: 1, input: 9, output: 4, cacheRead: 2, costUsd: 0.04, checks: 1, checkTokens: 10 });
  assert.ok(events.some((event) => event.type === 'usage'));
  forum.mute('b', true);
  const snap = JSON.parse(JSON.stringify(forum.snapshot()));
  const restored = setup().forum.restore(snap);
  assert.deepEqual(restored.transcript, forum.transcript);
  assert.deepEqual(restored.doc, forum.doc);
  assert.deepEqual(restored.usage(), forum.usage());
  assert.equal(restored.seat('b').muted, true);
  assert.equal(restored.seat('a').seenUpTo, forum.seat('a').seenUpTo);
  assert.equal(restored.hands.length, 0);
  forum.dispose(); restored.dispose();
});

test('exit during speech adds a note, frees the queue, and recreates the seat next turn', async () => {
  const { forum, sessions, events } = setup({ check: () => ({ text: 'raise: idea' }) });
  await forum.post('topic');
  forum.allow(forum.hands[0].id);
  forum.allow(forum.hands[0].id);
  await tick();
  sessions[0].emit('message', { type: 'text_delta', text: 'partial' });
  sessions[0].emit('exit', { stderr: 'lost' });
  await tick();
  assert.ok(events.some((event) => event.type === 'message-cancelled'));
  assert.equal(forum.transcript.at(-1).kind, 'note');
  assert.match(forum.transcript.at(-1).text, /lost/);
  assert.equal(sessions.length, 2);
  sessions[1].reply('other');
  await tick();
  forum.attachDoc(fixture('.md', 'before'));
  forum.grantWrite('a', 'retry');
  await tick();
  assert.equal(sessions.length, 3);
  assert.equal(sessions[2].seat.id, 'a');
  forum.dispose();
});

test('dispose aborts checks and stops all created sessions', async () => {
  const wait = deferred();
  const { forum, sessions, calls } = setup({ check: (seat) => seat.id === 'a' ? wait.promise : { text: 'pass' } });
  forum.attachDoc(fixture('.md', 'before'));
  forum.grantWrite('b', 'edit');
  await tick();
  const round = forum.post('topic');
  await tick();
  forum.dispose();
  assert.ok(calls[0].signal.aborted);
  assert.ok(sessions.every((session) => session.stopped));
  assert.equal(forum.active, null);
  wait.resolve({ text: 'raise: late' });
  await round;
});

test('attachDoc reads local text, bounds doc events, and feeds head versus full prompts', async () => {
  const text = 'HEAD ' + 'a'.repeat(1800) + 'MIDDLE ' + 'b'.repeat(19000) + 'TAIL';
  const file = fixture('.markdown', text);
  const { forum, calls, sessions, events } = setup({ check: (seat) => ({ text: seat.id === 'a' ? 'raise: read it' : 'pass' }) });
  const doc = forum.attachDoc(file);
  assert.deepEqual(doc, { kind: 'md', path: fs.realpathSync(file), text, mtimeMs: fs.statSync(file).mtimeMs });
  const event = events.find((one) => one.type === 'doc');
  assert.equal(event.doc.text, undefined);
  assert.equal(event.doc.textHead.length, 1500);
  await forum.post('Please read');
  assert.match(calls[0].prompt, /HEAD/);
  assert.ok(!calls[0].prompt.includes('MIDDLE'));
  forum.allow(forum.hands[0].id);
  await tick();
  assert.match(sessions[0].sent[0], /MIDDLE/);
  assert.ok(!sessions[0].sent[0].includes('TAIL'));
  assert.match(sessions[0].sent[0], /\[truncated\]/);
  forum.detachDoc();
  assert.equal(forum.doc, null);
  assert.equal(events.at(-1).doc, null);
  forum.dispose();
});

test('attachDoc rejects oversized, non-regular, unsupported, and invalid pointer files', () => {
  const { forum } = setup();
  assert.equal(forum.attachDoc(fixture('.txt', 'plain')).kind, 'md');
  const old = forum.doc;
  assert.throws(() => forum.attachDoc(fixture('.md', 'x'.repeat(200001))), /200,000 bytes/);
  const directory = path.join(fixtureDir, `folder-${++fixtureNo}.md`);
  fs.mkdirSync(directory);
  assert.throws(() => forum.attachDoc(directory), /regular file/);
  for (const ext of ['.gsheet', '.gslides', '.pdf']) {
    assert.throws(() => forum.attachDoc(fixture(ext, '{}')), /Unsupported document type/);
  }
  assert.throws(() => forum.attachDoc(fixture('.gdoc', '{}')), /no document id/);
  assert.equal(forum.doc, old);
  forum.dispose();
});

test('refreshDoc notices external edits before raise and speak, and keeps text if removed', async () => {
  const file = fixture('.md', 'original');
  const { forum, calls, sessions, events } = setup({ check: (seat) => ({ text: seat.id === 'a' ? 'raise: read' : 'pass' }) });
  forum.attachDoc(file);
  await forum.post('first');
  fs.writeFileSync(file, 'changed before raise');
  fs.utimesSync(file, new Date(2000000000000), new Date(2000000000000));
  await forum.post('second');
  assert.ok(calls.at(-1).prompt.includes('changed before raise'));
  fs.writeFileSync(file, 'changed before speak');
  fs.utimesSync(file, new Date(2000000005000), new Date(2000000005000));
  forum.allow(forum.hands[0].id);
  await tick();
  assert.match(sessions[0].sent[0], /changed before speak/);
  assert.equal(forum.doc.text, 'changed before speak');
  fs.unlinkSync(file);
  await forum.post('third');
  assert.equal(forum.doc.text, 'changed before speak');
  assert.ok(events.some((event) => event.type === 'error' && /Could not refresh document/.test(event.error)));
  forum.dispose();
});

test('Google Doc pointer yields an id, seat-specific context, and a guarded write', async () => {
  const pointer = JSON.stringify({ doc_id: 'abc_123-xyz', resource_key: 'key', email: 'a@example.org' });
  const file = fixture('.gdoc', pointer);
  const { forum, sessions, events } = setup();
  const doc = forum.attachDoc(file);
  assert.deepEqual(doc, { kind: 'gdoc', path: fs.realpathSync(file), docId: 'abc_123-xyz' });
  assert.equal(doc.text, undefined);
  assert.equal(forum.docContext(forum.seat('a'), { full: false }), 'A shared Google Doc is attached (id abc_123-xyz).');
  assert.match(forum.docContext(forum.seat('a'), { full: true }), /Google Docs connector tools/);
  assert.match(forum.docContext(forum.seat('a'), { full: true }), /never write the \.gdoc pointer file/);
  assert.match(forum.docContext(forum.seat('b'), { full: true }), /you cannot read it; rely on what is said in the forum/);
  assert.ok(!forum.raisePrompt(forum.seat('a')).includes('connector tools'));
  assert.match(forum.speakPrompt(forum.seat('b')), /you cannot read it/);
  assert.equal(forum.grantWrite('b', 'edit'), false);
  assert.equal(forum.grantWrite('a', 'add a title'), true);
  await tick();
  assert.match(sessions[0].sent[0], /shared document abc_123-xyz: add a title/);
  assert.ok(!sessions[0].sent[0].includes(file));
  sessions[0].reply('Added title');
  await tick();
  assert.ok(events.some((event) => event.type === 'doc' && event.changed === true && event.kind === 'gdoc'));
  assert.equal(fs.readFileSync(file, 'utf8'), pointer);
  forum.dispose();
});

test('canWrite requires a document and reserves Google Docs for Claude', () => {
  const { forum } = setup();
  const claude = forum.seat('a'), codex = forum.seat('b');
  assert.equal(forum.canWrite(claude, null), 'No document is attached.');
  assert.equal(forum.grantWrite('a', 'edit'), false);
  assert.equal(forum.canWrite(codex, { kind: 'md' }), true);
  assert.equal(forum.canWrite(codex, { kind: 'gdoc' }), 'Codex cannot edit Google Docs; ask a Claude seat.');
  assert.equal(forum.canWrite(claude, { kind: 'gdoc' }), true);
  forum.dispose();
});

test('successful local write refreshes text, emits a bounded doc event, and snapshots reload it', async () => {
  const file = fixture('.md', 'before');
  const { forum, sessions, events } = setup();
  forum.attachDoc(file);
  assert.equal(forum.grantWrite('b', 'replace the introduction'), true);
  await tick();
  assert.equal(sessions[0].sent[0], `Document (${fs.realpathSync(file)}):\nbefore\n\nThe moderator asked you to edit the shared document ${fs.realpathSync(file)}: replace the introduction\nEdit only that document; do not touch other files. Reply with a one-line summary of what you changed.`);
  fs.writeFileSync(file, 'after');
  fs.utimesSync(file, new Date(2000000010000), new Date(2000000010000));
  sessions[0].reply('Replaced introduction');
  await tick();
  assert.equal(forum.doc.text, 'after');
  assert.ok(events.some((event) => event.type === 'doc' && event.doc.textHead === 'after' && event.doc.text === undefined));
  const snapshot = forum.snapshot();
  assert.equal(snapshot.doc.text, undefined);
  fs.writeFileSync(file, 'changed after snapshot');
  const restored = setup().forum.restore(snapshot);
  assert.equal(restored.doc.text, 'changed after snapshot');
  assert.equal(restored.doc.path, fs.realpathSync(file));
  forum.dispose(); restored.dispose();
});

test('speaking seats answer and deny tool requests except approved reads', async () => {
  const { forum, sessions, events } = setup({ check: (seat) => ({ text: seat.id === 'a' ? 'raise: idea' : 'pass' }) });
  await forum.post('question'); forum.allow(forum.hands[0].id); await tick();
  const s = sessions[0];
  assert.deepEqual(ask(s, 'read', 'Read', { file_path: '/project/x.md' }),
    { behavior: 'allow', updatedInput: { file_path: '/project/x.md' } });
  for (const tool of ['Bash', 'WebFetch', 'Edit', 'ExitPlanMode', 'Permissions'])
    assert.equal(ask(s, tool, tool, { command: 'do not log this' }).behavior, 'deny');
  assert.equal(ask(s, 'question', 'AskUserQuestion', { questions: [] }).message, 'Ask the moderator in the forum instead.');
  ask(s, 'bash-again', 'Bash', {});
  assert.equal(events.filter((event) => event.type === 'message' && event.item.kind === 'note' && /Bash denied/.test(event.item.text)).length, 1);
  assert.ok(!forum.transcript.some((item) => item.text.includes('do not log this')));
  forum.dispose();
});

test('write requests allow only the attached local file and deny Codex commands', async () => {
  const file = fixture('.md', 'before');
  const other = fixture('.md', 'other');
  const { forum, sessions } = setup();
  forum.attachDoc(file); forum.grantWrite('b', 'edit'); await tick();
  const s = sessions[0];
  assert.equal(ask(s, 'file', 'Edit', { file_path: file }).behavior, 'allow');
  assert.equal(ask(s, 'other', 'Edit', { file_path: other }).behavior, 'deny');
  assert.equal(ask(s, 'many', 'Edit', { file_path: `${file}, ${other}` }).behavior, 'deny');
  assert.equal(ask(s, 'command', 'Bash', { command: 'echo hi' }).behavior, 'deny');
  assert.equal(ask(s, 'unknown', 'Mystery', {}).behavior, 'deny');
  s.reply('Edited'); await tick();
  forum.dispose();
});

test('Google Docs permission is scoped to the attached id and write turn', async () => {
  const file = fixture('.gdoc', JSON.stringify({ doc_id: 'attached' }));
  const { forum, sessions } = setup({ check: (seat) => ({ text: seat.id === 'a' ? 'raise: idea' : 'pass' }) });
  forum.attachDoc(file); await forum.post('question'); forum.allow(forum.hands[0].id); await tick();
  const s = sessions[0];
  assert.equal(ask(s, 'read', 'mcp__claude_ai_Google_Docs__read_doc', { document_id: 'attached' }).behavior, 'allow');
  assert.equal(ask(s, 'other', 'mcp__claude_ai_Google_Docs__read_doc', { document_id: 'other' }).behavior, 'deny');
  assert.equal(ask(s, 'nested', 'mcp__claude_ai_Google_Docs__read_doc', { document: { id: 'other' } }).behavior, 'deny');
  assert.equal(ask(s, 'update', 'mcp__claude_ai_Google_Docs__update_doc', { document_id: 'attached' }).behavior, 'deny');
  s.reply('Idea'); await tick();
  forum.grantWrite('a', 'edit'); await tick();
  assert.equal(ask(s, 'update-write', 'mcp__claude_ai_Google_Docs__update_doc', { document_id: 'attached' }).behavior, 'allow');
  assert.equal(ask(s, 'other-write', 'mcp__claude_ai_Google_Docs__update_doc', { document_id: 'other' }).behavior, 'deny');
  forum.dispose();
});

test('failed plan restoration and edit grant stop the session before its next turn', async () => {
  const { forum, sessions, events } = setup({ session: (session, index) => {
    if (index === 1) {
      const control = session.control.bind(session);
      session.control = (request) => request.mode === 'acceptEdits' ? Promise.resolve({ error: 'grant failed' }) : control(request);
    }
  } });
  forum.attachDoc(fixture('.md', 'before'));
  forum.grantWrite('a', 'first'); await tick();
  const first = sessions[0];
  const control = first.control.bind(first);
  first.control = (request) => request.mode === 'plan' ? Promise.resolve({ error: 'No answer from Claude Code.' }) : control(request);
  first.reply('Changed'); await tick();
  assert.equal(first.stopped, true);
  assert.equal(forum.sessions.has('a'), false);
  assert.ok(events.some((event) => event.type === 'message' && /session was stopped/.test(event.item.text)));
  forum.grantWrite('a', 'second'); await tick();
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].controls[0].mode, 'plan');
  assert.equal(sessions[1].stopped, true);
  forum.grantWrite('a', 'third'); await tick();
  assert.equal(sessions.length, 3);
  forum.dispose();
});

test('initial plan control and cancellation errors discard the session', async () => {
  const { forum, sessions } = setup({ check: (seat) => ({ text: seat.id === 'a' ? 'raise: idea' : 'pass' }),
    session: (session, index) => {
      if (index === 0) session.control = () => Promise.resolve({ error: 'plan failed' });
    } });
  await forum.post('first'); forum.allow(forum.hands[0].id); await tick();
  assert.equal(sessions[0].stopped, true);
  assert.equal(forum.sessions.has('a'), false);
  forum.attachDoc(fixture('.md', 'before'));
  forum.grantWrite('a', 'edit'); await tick();
  const second = sessions[1];
  const control = second.control.bind(second);
  second.control = (request) => request.mode === 'plan' ? Promise.resolve({ error: 'restore failed' }) : control(request);
  forum.stop(); await tick();
  assert.equal(second.stopped, true);
  assert.equal(forum.sessions.has('a'), false);
  forum.dispose();
});

test('stale results after stop cannot finish a later turn on the same seat', async () => {
  const { forum, sessions, events } = setup({ check: (seat) => ({ text: seat.id === 'a' ? 'raise: idea' : 'pass' }) });
  await forum.post('first'); forum.allow(forum.hands[0].id); await tick();
  sessions[0].emit('message', { type: 'text_delta', text: 'draft' });
  forum.stop();
  assert.ok(events.some((event) => event.type === 'message-cancelled'));
  await forum.post('second'); forum.allow(forum.hands[0].id); await tick();
  assert.equal(sessions[0].sent.length, 1);
  assert.equal(ask(sessions[0], 'stale-tool', 'Bash', {}).behavior, 'deny');
  ask(sessions[0], 'stale-tool-again', 'Bash', {});
  assert.equal(events.filter((event) => event.type === 'message' && /Bash denied/.test(event.item.text)).length, 1);
  sessions[0].reply('stale'); await tick();
  assert.equal(sessions[0].sent.length, 2);
  assert.ok(!forum.transcript.some((item) => item.text === 'stale'));
  sessions[0].reply('new'); await tick();
  assert.ok(forum.transcript.some((item) => item.text === 'new'));
  forum.dispose();
});

test('muting a speaker quarantines its interrupted result until unmuted', async () => {
  const { forum, sessions } = setup({ check: (seat) => ({ text: seat.id === 'a' ? 'raise: idea' : 'pass' }) });
  await forum.post('first'); forum.allow(forum.hands[0].id); await tick();
  forum.mute('a', true);
  forum.mute('a', false);
  await forum.post('second'); forum.allow(forum.hands[0].id); await tick();
  assert.equal(sessions[0].sent.length, 1);
  sessions[0].reply('interrupted'); await tick();
  assert.equal(sessions[0].sent.length, 2);
  assert.ok(!forum.transcript.some((item) => item.text === 'interrupted'));
  forum.dispose();
});

test('seenUpTo advances only to the prompt boundary and excludes own replies', async () => {
  const { forum, sessions } = setup({ check: (seat) => ({ text: seat.id === 'a' ? 'raise: idea' : 'pass' }) });
  await forum.post('first'); forum.allow(forum.hands[0].id); await tick();
  await forum.post('arrived while speaking');
  assert.equal(forum.seat('a').seenUpTo, 0);
  sessions[0].reply('my answer'); await tick();
  assert.equal(forum.seat('a').seenUpTo, 1);
  const next = forum.speakPrompt(forum.seat('a'));
  assert.match(next, /arrived while speaking/);
  assert.doesNotMatch(next, /Alice: my answer/);
  forum.dispose();
});

test('write prompts include unseen discussion and advance the seat cursor', async () => {
  const { forum, sessions } = setup();
  forum.attachDoc(fixture('.md', 'source'));
  await forum.post('Please fix the result');
  forum.summary = 'Earlier agreement';
  forum.grantWrite('a', 'Correct the result'); await tick();
  assert.match(sessions[0].sent[0], /Earlier agreement/);
  assert.match(sessions[0].sent[0], /user: Please fix the result/);
  assert.match(sessions[0].sent[0], /The moderator asked you to edit/);
  sessions[0].reply('Corrected'); await tick();
  assert.equal(forum.seat('a').seenUpTo, 1);
  forum.dispose();
});

test('attachment and restore reject symlinks to unsupported real files', () => {
  const secret = fixture('.key', 'private');
  const link = path.join(fixtureDir, `link-${++fixtureNo}.md`);
  fs.symlinkSync(secret, link);
  const { forum, events } = setup();
  assert.throws(() => forum.attachDoc(link), /Unsupported document type/);
  forum.restore({ ...forum.snapshot(), doc: { kind: 'md', path: link } });
  assert.equal(forum.doc, null);
  assert.ok(events.some((event) => event.type === 'error' && /restore document/.test(event.error)));
  assert.throws(() => forum.attachDoc(fixture('.gdoc', 'x'.repeat(65537))), /65,536 bytes/);
  forum.dispose();
});

test('refresh rejects a replaced document path and keeps the last safe text', () => {
  const file = fixture('.md', 'safe text');
  const secret = fixture('.key', 'secret text');
  const { forum, events } = setup();
  forum.attachDoc(file);
  fs.unlinkSync(file); fs.symlinkSync(secret, file);
  forum.refreshDoc();
  assert.equal(forum.doc.text, 'safe text');
  assert.ok(events.some((event) => event.type === 'error' && /Unsupported document type/.test(event.error)));
  const restored = setup().forum.restore(forum.snapshot());
  assert.equal(restored.doc, null);
  forum.dispose(); restored.dispose();
});

test('a changed Google Doc pointer is detached before another turn', async () => {
  const file = fixture('.gdoc', JSON.stringify({ doc_id: 'first' }));
  const { forum, events } = setup();
  forum.attachDoc(file);
  fs.writeFileSync(file, JSON.stringify({ doc_id: 'second' }));
  await forum.post('next');
  assert.equal(forum.doc, null);
  assert.ok(events.some((event) => event.type === 'error' && /pointer changed/.test(event.error)));
  forum.dispose();
});

test('large discussion prompts cap each message and stay below argv limits', async () => {
  const { forum, calls } = setup({ settings: { summaryTokens: 1, recentMessages: 100 },
    check: () => ({ text: 'pass' }) });
  forum.transcript = Array.from({ length: 100 }, (_v, i) => ({ id: `m${i}`, speaker: 'user', kind: 'message', text: `unique-${i}:` + 'x'.repeat(20000) }));
  const raise = forum.raisePrompt(forum.seat('a'));
  assert.ok(raise.length <= 60000);
  assert.ok(!raise.includes('x'.repeat(4001)));
  assert.ok(raise.includes('unique-99'));
  assert.ok(!raise.includes('unique-0'));
  forum.settings.recentMessages = 1;
  await forum.summarize(forum.round);
  assert.ok(calls[0].prompt.length <= 60000);
  assert.ok(!calls[0].prompt.includes('x'.repeat(4001)));
  forum.dispose();
});

test('an aborted check cannot reset the state of a newer checking round', async () => {
  const waits = [];
  const { forum, events } = setup({ check: (seat) => {
    if (seat.id === 'b') return { text: 'pass' };
    const wait = deferred(); waits.push(wait); return wait.promise;
  } });
  const first = forum.post('first'); await tick();
  const second = forum.post('second'); await tick();
  waits[0].resolve({ text: 'pass' }); await first;
  assert.equal(events.filter((event) => event.type === 'seat' && event.seatId === 'a').at(-1).state, 'checking');
  waits[1].resolve({ text: 'pass' }); await second;
  forum.dispose();
});

test('failed or empty speech makes a note without another raise round', async () => {
  const { forum, sessions, calls } = setup({ check: (seat) => ({ text: seat.id === 'a' ? 'raise: idea' : 'pass' }) });
  await forum.post('first'); forum.allow(forum.hands[0].id); await tick();
  const checked = calls.length;
  sessions[0].emit('message', { type: 'result', is_error: true, result: 'tool failed' }); await tick();
  assert.equal(calls.length, checked);
  assert.equal(forum.transcript.at(-1).kind, 'note');
  await forum.post('second'); forum.allow(forum.hands[0].id); await tick();
  sessions[0].emit('message', { type: 'result' }); await tick();
  assert.equal(forum.transcript.at(-1).kind, 'note');
  assert.equal(calls.length, checked + 2);
  forum.dispose();
});
