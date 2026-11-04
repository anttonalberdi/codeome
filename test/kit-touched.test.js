const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const agent = path.join(__dirname, '..', 'kit', 'bin', 'codeome-agent');

function project(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-kit-touched-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function record(root, id, files, options = {}) {
  const dir = path.join(root, '.codeome', 'touched');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now() / 1000;
  const value = { chat_id: id, engine: options.engine || 'codex', title: options.title || id,
    updated_at: options.updatedAt ?? now, files: Object.fromEntries(Object.entries(files).map(([file, ts]) =>
      [file, { ts, tool: 'Edit' }])) };
  if (options.acked) value.acked = options.acked;
  const target = path.join(dir, `${id}.json`);
  fs.writeFileSync(target, JSON.stringify(value));
  if (options.mtime) fs.utimesSync(target, options.mtime, options.mtime);
  return target;
}

function run(root, args, input = '', options = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: '', CODEOME_COLLISIONS: 'ask',
    CODEOME_CHAT_ID: '', ...options.env };
  const result = spawnSync('python3', ['-B', agent, ...args], {
    cwd: options.cwd || root, input, encoding: 'utf8', env,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stderr, '');
  return result.stdout;
}

function hook(root, chat, file, tool = 'Edit', options = {}) {
  return run(root, ['hook'], JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool,
    session_id: chat, cwd: options.eventCwd || root, tool_input: tool === 'NotebookEdit' ? { notebook_path: file } : { file_path: file } }), options);
}

test('edit hook asks when the app already recorded the caller file, then remembers the ask', (t) => {
  const root = project(t);
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(root, 'alias'));
  const file = path.join(real, 'new', 'notes.txt');
  record(root, 'other', { [file]: Date.now() / 1000 - 240 }, { title: 'Fix login' });
  record(root, 'caller', { [file]: Date.now() / 1000 }, { engine: 'claude', title: 'My chat' });
  const output = JSON.parse(hook(root, 'caller', 'alias/new/notes.txt'));
  assert.deepEqual(output, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask',
    permissionDecisionReason: `Chat 'Fix login' (codex) edited ${file} 4 min ago.` } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.codeome', 'touched', 'caller.json'))).acked[file] > 0, true);
  assert.equal(hook(root, 'caller', file), '');
  assert.equal(JSON.parse(hook(root, 'fresh', file, 'MultiEdit', { env: { CODEOME_COLLISIONS: 'unknown' } }))
    .hookSpecificOutput.permissionDecision, 'ask');
});

test('hook resolves dot segments before symlinks and uses the nearest real parent for missing files', (t) => {
  const root = project(t);
  const nested = path.join(root, 'deep', 'nested');
  fs.mkdirSync(nested, { recursive: true });
  fs.symlinkSync(nested, path.join(root, 'link'));
  fs.symlinkSync(path.join(root, 'absent-target'), path.join(root, 'broken'));
  const file = path.join(root, 'new.txt');
  const broken = path.join(root, 'broken', 'notes.txt');
  record(root, 'other', { [file]: Date.now() / 1000, [broken]: Date.now() / 1000 });
  assert.equal(JSON.parse(hook(root, 'caller', 'link/../new.txt')).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(JSON.parse(hook(root, 'caller', 'broken/notes.txt')).hookSpecificOutput.permissionDecision, 'ask');
});

test('edit hook remembers acknowledged files and ignores expired, dead, malformed and non-edit events', (t) => {
  const root = project(t);
  const now = Date.now() / 1000;
  const own = path.join(root, 'own.txt');
  const stale = path.join(root, 'stale.txt');
  const deadHeartbeat = path.join(root, 'dead-heartbeat.txt');
  const deadMtime = path.join(root, 'dead-mtime.txt');
  record(root, 'caller', { [own]: now - 50 }, { engine: 'claude', title: 'My chat' });
  record(root, 'other', { [own]: now - 10, [stale]: now - 1801 });
  record(root, 'dead', { [deadHeartbeat]: now - 10 }, { mtime: now - 121 });
  record(root, 'old-file', { [deadMtime]: now - 10 }, { mtime: now - 121 });
  fs.writeFileSync(path.join(root, '.codeome', 'touched', 'broken.json'), '{bad');
  assert.equal(JSON.parse(hook(root, 'caller', own)).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(hook(root, 'caller', own), '');
  assert.equal(hook(root, 'caller', stale), '');
  assert.equal(hook(root, 'caller', deadHeartbeat), '');
  assert.equal(hook(root, 'caller', deadMtime), '');
  assert.equal(run(root, ['hook'], '{bad'), '');
  assert.equal(run(root, ['hook'], JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read',
    session_id: 'caller', cwd: root, tool_input: { file_path: deadHeartbeat } })), '');
  const saved = JSON.parse(fs.readFileSync(path.join(root, '.codeome', 'touched', 'caller.json')));
  assert.equal(saved.title, 'My chat');
  assert.ok(saved.acked[own]);
  assert.equal(saved.files[own].tool, 'Edit');
  assert.ok(saved.files[stale]);
  assert.ok(saved.files[deadHeartbeat]);
  assert.ok(saved.files[deadMtime]);
});

test('edit hook deny, off and warn modes keep their recording rules', (t) => {
  const root = project(t);
  const file = path.join(root, 'shared.txt');
  record(root, 'other', { [file]: Date.now() / 1000 }, { title: 'Other chat' });
  const deny = JSON.parse(hook(root, 'denied', file, 'Write', { env: { CODEOME_COLLISIONS: 'deny' } }));
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /Other chat.*Pick another file or ask the user\.$/);
  assert.equal(fs.existsSync(path.join(root, '.codeome', 'touched', 'denied.json')), false);
  assert.equal(hook(root, 'offchat', file, 'Write', { env: { CODEOME_COLLISIONS: 'off' } }), '');
  assert.equal(fs.existsSync(path.join(root, '.codeome', 'touched', 'offchat.json')), false);
  const warn = JSON.parse(hook(root, 'warned', file, 'NotebookEdit', { env: { CODEOME_COLLISIONS: 'warn' } }));
  assert.match(warn.hookSpecificOutput.additionalContext, /Other chat/);
  assert.equal(warn.systemMessage, warn.hookSpecificOutput.additionalContext);
  const warned = JSON.parse(fs.readFileSync(path.join(root, '.codeome', 'touched', 'warned.json')));
  assert.equal(warned.files[file].tool, 'NotebookEdit');
  assert.ok(warned.acked[file]);
  assert.equal(hook(root, 'warned', file, 'NotebookEdit', { env: { CODEOME_COLLISIONS: 'warn' } }), '');
});

test('touched lists other live files, normalises --path and includes inactive records with --all', (t) => {
  const root = project(t);
  const dir = path.join(root, 'real');
  fs.mkdirSync(dir);
  fs.symlinkSync(dir, path.join(root, 'alias'));
  const live = path.join(dir, 'new', 'notes.txt');
  const own = path.join(root, 'mine.txt');
  const stale = path.join(root, 'stale.txt');
  const dead = path.join(root, 'dead.txt');
  const now = Date.now() / 1000;
  record(root, 'other', { [live]: now - 70, [stale]: now - 1801 }, { title: 'Other chat' });
  record(root, 'caller', { [own]: now - 15 }, { engine: 'claude', title: 'Me' });
  record(root, 'sleeping', { [dead]: now - 15 }, { mtime: now - 121 });
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested);
  const options = { cwd: nested, env: { CODEOME_CHAT_ID: 'caller' } };
  const rows = JSON.parse(run(root, ['touched', '--json'], '', options));
  assert.deepEqual(rows, [{ path: live, chat_id: 'other', engine: 'codex', title: 'Other chat',
    ts: rows[0].ts, tool: 'Edit', live: true }]);
  assert.deepEqual(JSON.parse(run(root, ['touched', '--path', 'alias/new/notes.txt', '--json'], '', options)), rows);
  assert.deepEqual(JSON.parse(run(root, ['touched', '--path', 'missing.txt', '--json'], '', options)), []);
  const all = JSON.parse(run(root, ['touched', '--all', '--json'], '', options));
  assert.deepEqual(all.map((row) => [row.chat_id, row.live]),
    [['sleeping', false], ['caller', true], ['other', true], ['other', false]]);
  assert.match(run(root, ['touched', '--all'], '', options), /Me \(claude\).*\(own\)/);
  assert.match(run(root, ['touched', '--all'], '', options), /stale\.txt.*\(expired\)/);
  assert.match(run(root, ['touched', '--all'], '', options), /dead\.txt.*\(dead\)/);
});

test('no-conflict hook writes an atomic record and keeps the newest 200 files', (t) => {
  const root = project(t);
  fs.mkdirSync(path.join(root, '.codeome'));
  const first = path.join(root, 'new.txt');
  assert.equal(hook(root, 'newchat', first), '');
  const dir = path.join(root, '.codeome', 'touched');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'newchat.json')));
  assert.equal(saved.chat_id, 'newchat');
  assert.equal(saved.engine, 'claude');
  assert.equal(saved.title, 'newchat');
  assert.deepEqual(saved.files[first], { ts: saved.updated_at, tool: 'Edit' });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['newchat.json']);
  const now = Date.now() / 1000;
  const files = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [path.join(root, `old-${i}.txt`), now - 300 + i]));
  record(root, 'full', files, { engine: 'claude', title: 'Full' });
  assert.equal(hook(root, 'full', path.join(root, 'latest.txt')), '');
  const capped = JSON.parse(fs.readFileSync(path.join(dir, 'full.json')));
  assert.equal(Object.keys(capped.files).length, 200);
  assert.equal(capped.files[path.join(root, 'old-0.txt')], undefined);
  assert.ok(capped.files[path.join(root, 'latest.txt')]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['full.json', 'newchat.json']);
});

test('old updated_at stays live with fresh mtime, and expired acknowledgements ask again', (t) => {
  const root = project(t);
  const file = path.join(root, 'shared.txt');
  const old = Date.now() / 1000 - 200;
  record(root, 'other', { [file]: Date.now() / 1000 }, { updatedAt: old });
  record(root, 'caller', { [file]: Date.now() / 1000 }, { acked: { [file]: Date.now() / 1000 - 1801 } });
  assert.equal(JSON.parse(hook(root, 'caller', file)).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(JSON.parse(run(root, ['touched', '--json'], '', { env: { CODEOME_CHAT_ID: 'caller' } }))[0].live, true);
});

test('hook finds the project above a subfolder and leaves folders outside a kit alone', (t) => {
  const root = project(t);
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested);
  const file = path.join(root, 'shared.txt');
  record(root, 'other', { [file]: Date.now() / 1000 });
  assert.equal(JSON.parse(hook(root, 'caller', file, 'Edit', { cwd: nested, eventCwd: nested }))
    .hookSpecificOutput.permissionDecision, 'ask');

  const outside = project(t);
  const child = path.join(outside, 'child');
  fs.mkdirSync(child);
  assert.equal(hook(outside, 'caller', 'new.txt', 'Edit', { cwd: child, eventCwd: child }), '');
  assert.equal(fs.existsSync(path.join(outside, '.codeome')), false);
});

test('hook normalisation handles a symlink loop and denies an uncheckable path in deny mode', (t) => {
  const root = project(t);
  fs.symlinkSync('loop', path.join(root, 'loop'));
  const file = path.join(root, 'loop', 'notes.txt');
  record(root, 'other', { [file]: Date.now() / 1000 });
  assert.equal(JSON.parse(hook(root, 'caller', file)).hookSpecificOutput.permissionDecision, 'ask');
  const denied = JSON.parse(hook(root, 'bad', 'bad\u0000path', 'Edit', { env: { CODEOME_COLLISIONS: 'deny' } }));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(denied.hookSpecificOutput.permissionDecisionReason, "Could not check this path for other chats' edits");
  assert.equal(hook(root, 'bad', 'bad\u0000path'), '');
});

test('record scan skips oversized files and reads at most 100 records', (t) => {
  const root = project(t);
  const file = path.join(root, 'shared.txt');
  const now = Date.now() / 1000;
  for (let i = 0; i < 101; i++) record(root, `peer-${String(i).padStart(3, '0')}`, { [file]: now });
  const oversized = record(root, 'oversized', { [file]: now });
  fs.appendFileSync(oversized, ' '.repeat(1024 * 1024));
  const rows = JSON.parse(run(root, ['touched', '--all', '--json']));
  assert.equal(rows.length, 99);
  assert.equal(rows.some((row) => row.chat_id === 'peer-100'), false);
  assert.equal(rows.some((row) => row.chat_id === 'oversized'), false);
});

test('hook sanitises titles in reasons and caps acknowledgement history', (t) => {
  const root = project(t);
  const file = path.join(root, 'shared.txt');
  record(root, 'other', { [file]: Date.now() / 1000 }, { title: 'Unsafe\n\u0000title' + 'x'.repeat(100) });
  const acked = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [path.join(root, `old-${i}.txt`), i]));
  record(root, 'caller', {}, { acked });
  const reason = JSON.parse(hook(root, 'caller', file)).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /Chat 'Unsafe title/);
  assert.doesNotMatch(reason, /\n|\u0000/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.codeome', 'touched', 'other.json'))).title.length > 80, true);
  assert.equal(JSON.parse(run(root, ['touched', '--all', '--json'])).find((row) => row.chat_id === 'other').title.length, 80);
  const saved = JSON.parse(fs.readFileSync(path.join(root, '.codeome', 'touched', 'caller.json')));
  assert.equal(Object.keys(saved.acked).length, 200);
  assert.ok(saved.acked[file]);
});
