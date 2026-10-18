const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CODEOME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-oneshot-home-'));
const { oneShot, parseClaude, parseCodex } = require('../main/oneshot');

// A stand-in for either CLI: record its arguments and account, then wait for stdin
// to close before answering. This catches a pipe kept open by the caller.
const FAKE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-oneshot-')), 'fake.js');
fs.writeFileSync(FAKE, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const prompt = args[0] === '-p' ? args[1] : args.at(-1);
// The handler goes first: the record file is what the tests wait for before they send SIGTERM.
process.on('SIGTERM', () => { fs.writeFileSync(process.env.FAKE_SIGNAL, 'SIGTERM'); if (prompt !== 'resist' && prompt !== 'pipe-resist') process.exit(0); });
fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ args, cwd: process.cwd(), pid: process.pid,
  claude: process.env.CLAUDE_CONFIG_DIR || null, codex: process.env.CODEX_HOME || null }));
if (prompt === 'pipe-resist' || prompt === 'pipe-exit') {
  const child = require('child_process').spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'],
    { stdio: ['ignore', 'inherit', 'inherit'] });
  fs.writeFileSync(process.env.FAKE_GRANDCHILD, String(child.pid));
  if (prompt === 'pipe-exit') { console.log(JSON.stringify({ result: 'done' })); process.exit(0); }
}
if (prompt === 'hang' || prompt === 'resist' || prompt === 'pipe-resist') setInterval(() => {}, 1000);
else {
  process.stdin.resume();
  process.stdin.once('end', () => {
    if (prompt === 'exit') { console.error('x'.repeat(410) + 'last stderr'); process.exit(7); }
    if (args[0] === '-p') console.log(JSON.stringify({ result: 'Claude answer', is_error: false,
      usage: { input_tokens: 3, output_tokens: 5 }, total_cost_usd: 0.002 }));
    else {
      console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }));
      console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Codex answer' } }));
      console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 9 } }));
    }
  });
}
`);
fs.chmodSync(FAKE, 0o755);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oneshot-test-'));
let next = 0;
function opts(extra = {}) {
  const id = ++next;
  return { bin: FAKE, prompt: 'hello', timeoutMs: 2000, env: {
    FAKE_RECORD: path.join(tmp, `record-${id}.json`), FAKE_SIGNAL: path.join(tmp, `signal-${id}`),
    FAKE_GRANDCHILD: path.join(tmp, `grandchild-${id}`),
    CLAUDE_CONFIG_DIR: 'inherited-claude', CODEX_HOME: 'inherited-codex'
  }, ...extra };
}
function recorded(options) { return JSON.parse(fs.readFileSync(options.env.FAKE_RECORD, 'utf8')); }
async function untilFile(file) {
  for (let i = 0; i < 200 && !fs.existsSync(file); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(fs.existsSync(file), `missing ${file}`);
}
function reaped(pid) { assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); }
async function eventuallyReaped(pid) {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  reaped(pid);
}

test('pure parsers return final text and usage and reject CLI errors', () => {
  assert.deepEqual(parseClaude(JSON.stringify({ result: 'answer', usage: { input_tokens: 2 }, total_cost_usd: 0.01 })),
    { text: 'answer', usage: { input_tokens: 2, total_cost_usd: 0.01 } });
  assert.throws(() => parseClaude(JSON.stringify({ is_error: true, result: 'bad request' })), /bad request/);
  const lines = [
    { type: 'item.completed', item: { type: 'agent_message', text: 'first' } },
    { type: 'item.completed', item: { type: 'command_execution', text: 'ignored' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'last' } },
    { type: 'turn.completed', usage: { input_tokens: 4 } }
  ].map(JSON.stringify).join('\n') + '\n';
  assert.deepEqual(parseCodex(lines), { text: 'last', usage: { input_tokens: 4 } });
  assert.throws(() => parseCodex('{"type":"error","message":"failed"}\n'), /failed/);
  assert.throws(() => parseCodex('{"type":"turn.failed","error":{"message":"turn failed"}}\n'), /turn failed/);
});

test('Claude passes the verified arguments, account and cwd; stdin reaches EOF', async () => {
  const options = opts({ model: 'sonnet', dir: '~/account-claude' });
  const result = await oneShot('claude', options);
  const call = recorded(options);
  assert.deepEqual(call.args, ['-p', 'hello', '--model', 'sonnet', '--no-session-persistence', '--permission-mode', 'plan',
    '--strict-mcp-config', '--setting-sources', '', '--output-format', 'json']);
  assert.equal(call.claude, path.join(os.homedir(), 'account-claude'));
  assert.equal(call.cwd, fs.realpathSync(process.env.CODEOME_HOME));
  assert.equal(result.text, 'Claude answer');
  assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 5, total_cost_usd: 0.002 });
  assert.ok(result.ms >= 0);
});

test('Claude can omit strict MCP and unset the inherited config dir', async () => {
  const options = opts({ strictMcp: false, dir: '', cwd: tmp });
  await oneShot('claude', options);
  const call = recorded(options);
  assert.equal(call.claude, null);
  assert.equal(call.cwd, fs.realpathSync(tmp));
  assert.deepEqual(call.args, ['-p', 'hello', '--model', 'haiku', '--no-session-persistence', '--permission-mode', 'plan',
    '--setting-sources', '', '--output-format', 'json']);
});

test('Codex passes the verified arguments and returns its last agent message', async () => {
  const options = opts({ model: 'gpt-test', effort: 'medium', dir: '~/account-codex' });
  const result = await oneShot('codex', options);
  const call = recorded(options);
  assert.deepEqual(call.args, ['exec', '-s', 'read-only', '--ephemeral', '--skip-git-repo-check', '--json',
    '-c', 'model_reasoning_effort=medium', '-m', 'gpt-test', 'hello']);
  assert.equal(call.codex, path.join(os.homedir(), 'account-codex'));
  assert.deepEqual({ text: result.text, usage: result.usage },
    { text: 'Codex answer', usage: { input_tokens: 7, output_tokens: 9 } });
});

test('Codex defaults effort and unsets the inherited config dir', async () => {
  const options = opts();
  await oneShot('codex', options);
  const call = recorded(options);
  assert.equal(call.codex, null);
  assert.deepEqual(call.args, ['exec', '-s', 'read-only', '--ephemeral', '--skip-git-repo-check', '--json',
    '-c', 'model_reasoning_effort=low', 'hello']);
});

test('non-zero exit rejects with the stderr tail', async () => {
  const options = opts({ prompt: 'exit' });
  await assert.rejects(oneShot('claude', options), (error) => error.message.includes('last stderr') && !error.message.includes('x'.repeat(410)));
});

test('timeout terminates and reaps the child', async () => {
  const options = opts({ prompt: 'hang', timeoutMs: 500 });
  await assert.rejects(oneShot('codex', options), /^Error: one-shot timed out/);
  const call = recorded(options);
  await untilFile(options.env.FAKE_SIGNAL);
  assert.equal(fs.readFileSync(options.env.FAKE_SIGNAL, 'utf8'), 'SIGTERM');
  reaped(call.pid);
});

test('timeout force kills a child that ignores SIGTERM', async () => {
  const options = opts({ prompt: 'resist', timeoutMs: 500 });
  await assert.rejects(oneShot('codex', options), /^Error: one-shot timed out/);
  const call = recorded(options);
  await untilFile(options.env.FAKE_SIGNAL);
  assert.equal(fs.readFileSync(options.env.FAKE_SIGNAL, 'utf8'), 'SIGTERM');
  reaped(call.pid);
});

test('timeout kills a resistant process group whose grandchild holds stdout', async () => {
  const options = opts({ prompt: 'pipe-resist', timeoutMs: 500 });
  await assert.rejects(oneShot('claude', options), /^Error: one-shot timed out/);
  const call = recorded(options);
  const grandchild = Number(fs.readFileSync(options.env.FAKE_GRANDCHILD, 'utf8'));
  await untilFile(options.env.FAKE_SIGNAL);
  assert.equal(fs.readFileSync(options.env.FAKE_SIGNAL, 'utf8'), 'SIGTERM');
  await eventuallyReaped(call.pid);
  await eventuallyReaped(grandchild);
});

test('an exited wrapper settles after stdout grace and kills a pipe holder', async () => {
  const options = opts({ prompt: 'pipe-exit' });
  const result = await oneShot('claude', options);
  assert.equal(result.text, 'done');
  assert.ok(result.ms < 1500);
  await eventuallyReaped(Number(fs.readFileSync(options.env.FAKE_GRANDCHILD, 'utf8')));
});

test('abort terminates and reaps the child', async () => {
  const controller = new AbortController();
  const options = opts({ prompt: 'hang', signal: controller.signal });
  const pending = oneShot('claude', options);
  await untilFile(options.env.FAKE_RECORD);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  const call = recorded(options);
  await untilFile(options.env.FAKE_SIGNAL);
  assert.equal(fs.readFileSync(options.env.FAKE_SIGNAL, 'utf8'), 'SIGTERM');
  reaped(call.pid);
});
