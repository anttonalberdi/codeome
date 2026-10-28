const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const kit = require('../main/kit');
const jobs = require('../main/jobs');

const testDirs = new Set();
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-kit-'));
  testDirs.add(dir);
  return dir;
};
test.after(() => { for (const dir of testDirs) fs.rmSync(dir, { recursive: true, force: true }); });
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const agentBin = (project) => path.join(project, '.codeome', 'bin', 'codeome-agent');

test('every role has the metadata the installer and router need', () => {
  assert.strictEqual(kit.MANIFEST.version, '0.9.0');
  assert.match(fs.readFileSync(path.join(__dirname, '../kit/roles/_report.md'), 'utf8'), /^## Progress$/m);
  const groups = Object.keys(kit.MANIFEST.groups);
  for (const r of kit.roles()) {
    assert.ok(r.name && r.description && r.tools, r.name);
    assert.ok(groups.includes(r.group), `${r.name}: unknown group ${r.group}`);
    assert.ok(['claude', 'codex', 'cross'].includes(r.engine), `${r.name}: unknown engine ${r.engine}`);
    assert.match(r.body, /## Report/);
  }
});

test('chat and delegation instructions describe log progress watches', () => {
  for (const file of ['chat.md', 'chat-codex.md', 'skills/orchestrate/SKILL.md', 'skills/delegate/SKILL.md']) {
    assert.match(fs.readFileSync(path.join(__dirname, '../kit', file), 'utf8'), /codeome-agent watch/, file);
  }
  for (const file of ['chat.md', 'chat-codex.md']) {
    const body = fs.readFileSync(path.join(__dirname, '../kit', file), 'utf8');
    assert.match(body, /--parser slurm/, file);
    assert.match(body, /--remote-log/, file);
    assert.match(body, /Codex chats and jobs use only local watches/, file);
    assert.match(body, /--timeout SECONDS/, file);
  }
  assert.match(fs.readFileSync(path.join(__dirname, '../kit/chat.md'), 'utf8'), /Pass `--pid` for local Snakemake runs/);
  assert.match(fs.readFileSync(path.join(__dirname, '../kit/roles/_report.md'), 'utf8'), /not Codex roles/);
});

test('install writes roles, skills, routing, runner, hooks and gitignore', () => {
  const p = tmp();
  fs.writeFileSync(path.join(p, '.gitignore'), 'node_modules/\n');
  const r = kit.install(p, { groups: ['research'] });
  assert.deepStrictEqual(r.groups, ['core', 'research']);
  const agent = fs.readFileSync(path.join(p, '.claude/agents/implementer.md'), 'utf8');
  assert.match(agent, /^---\nname: implementer\n/);
  assert.doesNotMatch(agent, /^(group|engine):/m);
  assert.ok(fs.existsSync(path.join(p, '.claude/agents/hpc-operator.md')));
  assert.ok(!fs.existsSync(path.join(p, '.claude/agents/backend.md')));
  const routing = fs.readFileSync(path.join(p, '.claude/skills/orchestrate/routing.md'), 'utf8');
  assert.match(routing, /\| `implementer` \| Codex \| writes \|/);
  assert.match(routing, /\| `reviewer` \| the other engine \| read-only \|/);
  assert.ok(fs.existsSync(path.join(p, '.claude/skills/orchestrate/SKILL.md')));
  assert.ok(fs.statSync(agentBin(p)).mode & 0o100);
  const s = readJson(path.join(p, '.claude/settings.json'));
  assert.strictEqual(s.hooks.PreToolUse[0].matcher, 'Agent');
  assert.ok(s.hooks.SubagentStop[0].hooks[0].command.includes('codeome-agent'));
  assert.ok(s.permissions.allow.includes('Bash(.codeome/bin/codeome-agent *)'));
  assert.match(fs.readFileSync(path.join(p, '.gitignore'), 'utf8'), /^node_modules\/\n\n# Codeome agent jobs\n\.codeome\/jobs\/\n/);
  const st = kit.status(p);
  assert.strictEqual(st.installed, true);
  assert.strictEqual(st.outdated, false);
  assert.deepStrictEqual(st.modified, []);
});

test('reinstall is idempotent and keeps existing settings', () => {
  const p = tmp();
  fs.mkdirSync(path.join(p, '.claude'));
  fs.writeFileSync(path.join(p, '.claude/settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
  kit.install(p);
  const settings = fs.readFileSync(path.join(p, '.claude/settings.json'), 'utf8');
  const gi = fs.readFileSync(path.join(p, '.gitignore'), 'utf8');
  const r = kit.install(p);
  assert.deepStrictEqual(r.written, []);
  assert.strictEqual(fs.readFileSync(path.join(p, '.claude/settings.json'), 'utf8'), settings);
  assert.strictEqual(fs.readFileSync(path.join(p, '.gitignore'), 'utf8'), gi);
  const s = JSON.parse(settings);
  assert.strictEqual(s.model, 'opus');
  assert.strictEqual(s.hooks.Stop[0].hooks[0].command, 'say done');
  assert.strictEqual(s.hooks.SubagentStart.length, 1);
});

test('files edited by the user or present before the kit are never overwritten or removed', () => {
  const p = tmp();
  fs.mkdirSync(path.join(p, '.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude/agents/reviewer.md'), 'my own reviewer');
  kit.install(p, { groups: ['web'] });
  assert.strictEqual(fs.readFileSync(path.join(p, '.claude/agents/reviewer.md'), 'utf8'), 'my own reviewer');
  fs.appendFileSync(path.join(p, '.claude/agents/backend.md'), '\nUse our house style.\n');
  assert.deepStrictEqual(kit.status(p).modified, ['.claude/agents/backend.md']);
  // Dropping the web group removes untouched roles but keeps the edited one.
  const r = kit.install(p, { groups: [] });
  assert.ok(r.removed.includes('.claude/agents/frontend.md'));
  assert.ok(r.kept.includes('.claude/agents/backend.md'));
  assert.ok(!fs.existsSync(path.join(p, '.claude/agents/frontend.md')));
  assert.match(fs.readFileSync(path.join(p, '.claude/agents/backend.md'), 'utf8'), /house style/);
});

test('invalid settings.json is left alone with a warning', () => {
  const p = tmp();
  fs.mkdirSync(path.join(p, '.claude'));
  fs.writeFileSync(path.join(p, '.claude/settings.json'), '{ not json');
  const r = kit.install(p);
  assert.match(r.warning, /not valid JSON/);
  assert.strictEqual(fs.readFileSync(path.join(p, '.claude/settings.json'), 'utf8'), '{ not json');
});

// A stand-in for the codex CLI: records its argv and prompt, writes a result.
function fakeCodex(dir, exitCode = 0) {
  const f = path.join(dir, 'fake-codex');
  fs.writeFileSync(f, `#!/usr/bin/env python3
import json, sys, os
argv = sys.argv[1:]
prompt = sys.stdin.read()
out = argv[argv.index('-o') + 1]
json.dump({'argv': argv, 'cwd': os.getcwd(), 'prompt': prompt, 'codexHome': os.environ.get('CODEX_HOME'), 'jobId': os.environ.get('CODEOME_JOB_ID')}, open(os.path.join(${JSON.stringify(dir)}, 'call.json'), 'w'))
print('session id: 0199-test-session', file=sys.stderr)
if ${exitCode} == 0:
    open(out, 'w').write('## Status\\ndone — fake')
sys.exit(${exitCode})
`);
  fs.chmodSync(f, 0o755);
  return f;
}

// CODEOME_HOME points at an empty folder unless a test writes usage.json there.
function runAgent(project, args, input, env = {}) {
  return spawnSync('python3', ['-B', agentBin(project), ...args], { input, encoding: 'utf8', cwd: project, env: { ...process.env, CODEOME_HOME: path.join(project, '.codeome-home'), ...env } });
}

async function waitFor(fn) {
  const deadline = performance.now() + 15000;
  while (true) {
    const result = await fn();
    if (result) return result;
    if (performance.now() >= deadline) throw new Error('Timed out waiting for the job');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// What Codeome writes to ~/.codeome/usage.json.
function writeUsage(project, { claude = [], codex = [], stopAt = 90, active = {} }) {
  const now = Date.now() / 1000;
  const acct = ([name, dir, fiveHour, weekly]) => ({ name, dir, asOf: now, windows: { fiveHour: { pct: fiveHour, resetsAt: now + 3600 }, weekly: { pct: weekly, resetsAt: now + 86400 } } });
  const eng = (list, a) => ({ active: a || (list[0] || [])[0], accounts: list.map(acct) });
  const dir = path.join(project, '.codeome-home');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ version: 1, updatedAt: now, stopAt, claude: eng(claude, active.claude), codex: eng(codex, active.codex) }));
}

test('codeome-agent runs a Codex job with the role prompt and records it', async () => {
  const p = tmp();
  spawnSync('git', ['init', '-q'], { cwd: p });
  kit.install(p);
  const codex = fakeCodex(p);
  const r = runAgent(p, ['codex', '--role', 'implementer', '--title', 'Add flag'], 'Add a --threads flag.', { CODEOME_CODEX: codex });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /job \S+ done \(codex\/implementer/);
  assert.match(r.stdout, /--resume 0199-test-session/);
  assert.match(r.stdout, /done — fake/);
  const call = readJson(path.join(p, 'call.json'));
  assert.deepStrictEqual([call.argv[0], call.argv[1], call.argv[3], call.argv[4]], ['exec', '-C', '-s', 'workspace-write']);
  assert.strictEqual(fs.realpathSync(call.argv[2]), fs.realpathSync(p));
  assert.match(call.prompt, /You are the implementer/);
  assert.match(call.prompt, /# Your job\nAdd a --threads flag\./);
  assert.match(call.prompt, /## Report/);
  assert.match(call.prompt, /codeome-agent progress/);

  const list = await jobs.list(p);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].status, 'done');
  assert.strictEqual(list[0].session, '0199-test-session');
  assert.strictEqual(list[0].title, 'Add flag');
  assert.strictEqual(call.jobId, list[0].id);
  assert.match((await jobs.read(p, list[0].id, 'result')).content, /done — fake/);
  assert.match((await jobs.read(p, list[0].id, 'brief')).content, /--threads/);
  assert.match((await jobs.read(p, list[0].id, 'log')).content, /session id/);
  assert.ok((await jobs.read(p, '../x', 'log')).error);

  // Follow-up resumes the same session; read-only roles get the read-only sandbox.
  const r2 = runAgent(p, ['codex', '--resume', '0199-test-session'], 'Also update the README.', { CODEOME_CODEX: codex });
  assert.strictEqual(r2.status, 0, r2.stderr);
  const call2 = readJson(path.join(p, 'call.json'));
  assert.deepStrictEqual(call2.argv.slice(0, 3), ['exec', 'resume', '0199-test-session']);
  assert.match(call2.prompt, /Follow-up from the orchestrator/);
  runAgent(p, ['codex', '--role', 'reviewer'], 'Review git diff.', { CODEOME_CODEX: codex });
  assert.ok(readJson(path.join(p, 'call.json')).argv.includes('read-only'));
});

test('codeome-agent pauses a captured session and main jobs resumes it as a linked job', async () => {
  const p = tmp();
  kit.install(p);
  const codex = path.join(p, 'slow-codex');
  fs.writeFileSync(codex, `#!/usr/bin/env python3
import json, os, sys, time
argv = sys.argv[1:]
prompt = sys.stdin.read()
json.dump({'argv': argv, 'prompt': prompt, 'codexHome': os.environ.get('CODEX_HOME')}, open(os.path.join(${JSON.stringify(p)}, 'call.json'), 'w'))
if 'resume' in argv:
    open(argv[argv.index('-o') + 1], 'w').write('## Status\\ndone')
else:
    time.sleep(0.5)
    print(json.dumps({'type': 'thread.started', 'thread_id': 'test-pause-session'}), flush=True)
    time.sleep(30)
`);
  fs.chmodSync(codex, 0o755);
  const saved = { CODEOME_CODEX: process.env.CODEOME_CODEX, CODEOME_HOME: process.env.CODEOME_HOME, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CODEOME_CODEX = codex;
  process.env.CODEOME_HOME = path.join(p, '.codeome-home');
  const pinnedHome = path.join(p, 'pinned-codex-home');
  process.env.CODEX_HOME = pinnedHome;
  const child = spawn('python3', ['-B', agentBin(p), 'codex', '--role', 'implementer'], { cwd: p, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end('Pause this job.');
  try {
    const running = await waitFor(async () => (await jobs.list(p))[0]);
    await waitFor(async () => (await jobs.list(p))[0]?.pauseFifo);
    const early = await jobs.pause(p, running.id);
    assert.match(early.error, /before (its|the) Codex session ID is captured/);
    await waitFor(async () => (await jobs.list(p))[0]?.session);
    const pause = runAgent(p, ['pause', running.id]);
    assert.strictEqual(pause.status, 0, pause.stderr);
    const exit = await new Promise((resolve) => child.on('close', resolve));
    assert.strictEqual(exit, 0);
    const paused = (await jobs.list(p))[0];
    assert.strictEqual(paused.status, 'paused');
    assert.strictEqual(paused.exitCode, 0);
    assert.strictEqual(paused.session, 'test-pause-session');
    assert.strictEqual(runAgent(p, ['list', '--json']).status, 0);
    fs.writeFileSync(path.join(p, '.codeome', 'jobs', paused.id, 'job.json'), JSON.stringify({ ...paused, status: 'pausing', pid: 999999 }));
    assert.strictEqual((await jobs.list(p))[0].status, 'paused');
    process.env.CODEX_HOME = path.join(p, 'other-codex-home');
    const pending = jobs.resume(p, paused.id);
    assert.match((await jobs.resume(p, paused.id)).error, /already resuming/);
    const resumed = await pending;
    assert.strictEqual(resumed.ok, true, resumed.error);
    const next = await waitFor(async () => (await jobs.list(p)).find((j) => j.id === resumed.id && j.status === 'done'));
    assert.strictEqual(next.resumedFrom, paused.id);
    assert.strictEqual((await jobs.list(p)).find((j) => j.id === paused.id).resumedBy, next.id);
    const call = readJson(path.join(p, 'call.json'));
    assert.deepStrictEqual(call.argv.slice(0, 3), ['exec', 'resume', 'test-pause-session']);
    assert.match(call.prompt, /Continue where you left off/);
    assert.strictEqual(call.codexHome, pinnedHome);
    assert.match((await jobs.resume(p, paused.id)).error, /cannot be resumed/);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(p, { recursive: true, force: true });
  }
});

test('resume finds Codex through the login shell when the app PATH is minimal', async () => {
  const p = tmp();
  kit.install(p);
  const binDir = path.join(p, 'login-bin');
  fs.mkdirSync(binDir);
  fs.copyFileSync(fakeCodex(p), path.join(binDir, 'codex'));
  fs.chmodSync(path.join(binDir, 'codex'), 0o755);
  const shell = path.join(p, 'login-shell');
  fs.writeFileSync(shell, '#!/bin/sh\nshift\nshift\nshift\nexport PATH="$FAKE_LOGIN_PATH:$PATH"\nexec "$@"\n');
  fs.chmodSync(shell, 0o755);
  const id = 'paused-login-shell';
  const dir = path.join(p, '.codeome', 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id, engine: 'codex', role: 'implementer', title: 'Resume',
    status: 'paused', session: 'login-session', startedAt: new Date().toISOString() }));
  const saved = Object.fromEntries(['PATH', 'SHELL', 'FAKE_LOGIN_PATH', 'CODEOME_HOME', 'CODEOME_CODEX'].map((key) => [key, process.env[key]]));
  process.env.PATH = '/usr/bin:/bin';
  process.env.SHELL = shell;
  process.env.FAKE_LOGIN_PATH = binDir;
  process.env.CODEOME_HOME = path.join(p, '.codeome-home');
  delete process.env.CODEOME_CODEX;
  try {
    const r = await jobs.resume(p, id);
    assert.strictEqual(r.ok, true, r.error);
    await waitFor(async () => (await jobs.list(p)).find((j) => j.id === r.id && j.status === 'done'));
    assert.deepStrictEqual(readJson(path.join(p, 'call.json')).argv.slice(0, 3), ['exec', 'resume', 'login-session']);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(p, { recursive: true, force: true });
  }
});

test('pause waits for a complete reply and removes an empty reply on timeout', async () => {
  const p = tmp();
  try {
    kit.install(p);
    const id = 'reply-race';
    const dir = path.join(p, '.codeome', 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    const fifo = path.join(dir, 'pause.fifo');
    assert.strictEqual(spawnSync('mkfifo', [fifo]).status, 0);
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id, engine: 'codex', status: 'running', pid: process.pid,
      session: 'reply-session', pauseFifo: fifo, startedAt: new Date().toISOString() }));
    const responder = path.join(p, 'reply-server.py');
    fs.writeFileSync(responder, `import os, select, sys, time
fifo, folder, ready, mode = sys.argv[1:]
read = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
write = os.open(fifo, os.O_WRONLY | os.O_NONBLOCK)
open(ready, 'w').close()
select.select([read], [], [], 5)
request = os.read(read, 1024).decode().strip().split(' ')
reply = os.path.join(folder, request[1])
open(reply, 'w').close()
if mode == 'delayed':
    time.sleep(0.15)
    with open(reply, 'w') as f: f.write('ok')
os.close(read); os.close(write)
`);
    for (const mode of ['delayed', 'timeout']) {
      const ready = path.join(p, mode + '.ready');
      const child = spawn('python3', ['-B', responder, fifo, dir, ready, mode], { stdio: 'ignore' });
      try {
        await waitFor(async () => fs.existsSync(ready));
        const r = runAgent(p, ['pause', id]);
        if (mode === 'delayed') assert.strictEqual(r.status, 0, r.stderr);
        else { assert.notStrictEqual(r.status, 0); assert.match(r.stderr, /did not acknowledge/); }
        assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => /^pause-reply-.*\.txt$/.test(name)), []);
      } finally {
        if (child.exitCode === null) child.kill('SIGTERM');
        if (child.exitCode === null) await new Promise((resolve) => child.once('close', resolve));
      }
    }
  } finally { fs.rmSync(p, { recursive: true, force: true }); }
});

test('cancel during pausing records cancelled instead of paused', async () => {
  const p = tmp();
  kit.install(p);
  const codex = path.join(p, 'slow-stop-codex');
  fs.writeFileSync(codex, `#!/usr/bin/env python3
import json, signal, sys, time
def stop(_signum, _frame):
    time.sleep(0.7)
    sys.exit(143)
signal.signal(signal.SIGTERM, stop)
sys.stdin.read()
print(json.dumps({'type': 'thread.started', 'thread_id': 'cancel-pausing-session'}), flush=True)
time.sleep(30)
`);
  fs.chmodSync(codex, 0o755);
  const child = spawn('python3', ['-B', agentBin(p), 'codex', '--role', 'implementer'], {
    cwd: p, env: { ...process.env, CODEOME_CODEX: codex, CODEOME_HOME: path.join(p, '.codeome-home') }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end('Pause then cancel.');
  try {
    const running = await waitFor(async () => (await jobs.list(p)).find((j) => j.session === 'cancel-pausing-session'));
    assert.strictEqual(runAgent(p, ['pause', running.id]).status, 0);
    await waitFor(async () => (await jobs.list(p)).find((j) => j.id === running.id && j.status === 'pausing'));
    assert.deepStrictEqual(jobs.cancel(p, running.id), { ok: true });
    assert.strictEqual(await new Promise((resolve) => child.on('close', resolve)), 130);
    assert.strictEqual((await jobs.list(p))[0].status, 'cancelled');
    assert.match(jobs.cancel(p, running.id).error, /no longer running/);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    fs.rmSync(p, { recursive: true, force: true });
  }
});

test('pause refuses a job started by an older wrapper after the kit is updated', async () => {
  const p = tmp();
  try {
    kit.install(p);
    const id = 'old-wrapper';
    const dir = path.join(p, '.codeome', 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id, engine: 'codex', status: 'running', pid: process.pid,
      session: 'old-session', startedAt: new Date(Date.now() + 60000).toISOString() }));
    const cli = runAgent(p, ['pause', id]);
    assert.notStrictEqual(cli.status, 0);
    assert.match(cli.stderr, /started with an older wrapper/);
    assert.match((await jobs.pause(p, id)).error, /started with an older wrapper/);
  } finally { fs.rmSync(p, { recursive: true, force: true }); }
});

test('pause refuses a reused PID when the original wrapper FIFO has no reader', async () => {
  const p = tmp();
  try {
    kit.install(p);
    const id = 'reused-pid';
    const dir = path.join(p, '.codeome', 'jobs', id);
    fs.mkdirSync(dir, { recursive: true });
    const staleFifo = path.join(dir, 'pause.fifo');
    spawnSync('mkfifo', [staleFifo]);
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id, engine: 'codex', status: 'running', pid: process.pid,
      session: 'old-session', pauseFifo: staleFifo, startedAt: new Date(Date.now() + 60000).toISOString() }));
    const cli = runAgent(p, ['pause', id]);
    assert.notStrictEqual(cli.status, 0);
    assert.match(cli.stderr, /original wrapper.*unavailable/);
    assert.match((await jobs.pause(p, id)).error, /original wrapper.*unavailable/);
  } finally { fs.rmSync(p, { recursive: true, force: true }); }
});

test('pause after Codex exits preserves the completed result', async () => {
  const p = tmp();
  kit.install(p);
  const codex = path.join(p, 'finished-codex');
  fs.writeFileSync(codex, `#!/usr/bin/env python3
import json, subprocess, sys
argv = sys.argv[1:]
sys.stdin.read()
print(json.dumps({'type': 'thread.started', 'thread_id': 'finished-session'}), flush=True)
open(argv[argv.index('-o') + 1], 'w').write('finished')
subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(2)'], stdout=sys.stdout, start_new_session=True)
`);
  fs.chmodSync(codex, 0o755);
  const child = spawn('python3', ['-B', agentBin(p), 'codex', '--role', 'implementer'], {
    cwd: p, env: { ...process.env, CODEOME_CODEX: codex, CODEOME_HOME: path.join(p, '.codeome-home') }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end('Finish first.');
  try {
    const job = await waitFor(async () => (await jobs.list(p)).find((j) => j.session === 'finished-session' && fs.existsSync(path.join(p, '.codeome', 'jobs', j.id, 'result.md'))));
    await waitFor(async () => {
      const current = (await jobs.list(p)).find((j) => j.id === job.id);
      if (current.status === 'done') return true;
      try { process.kill(current.childPid, 0); } catch (e) {
        if (e.code === 'ESRCH') return true;
        throw e;
      }
      return false;
    });
    const pause = runAgent(p, ['pause', job.id]);
    assert.notStrictEqual(pause.status, 0);
    assert.match(pause.stderr, /already stopped|is done/);
    assert.strictEqual(await new Promise((resolve) => child.on('close', resolve)), 0);
    assert.strictEqual((await jobs.list(p))[0].status, 'done');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    fs.rmSync(p, { recursive: true, force: true });
  }
});

test('codeome-agent reports failed jobs and unknown roles', async () => {
  const p = tmp();
  kit.install(p);
  const r = runAgent(p, ['codex', '--role', 'implementer'], 'x', { CODEOME_CODEX: fakeCodex(p, 3) });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /failed/);
  assert.ok(readJson(path.join(p, 'call.json')).argv.includes('--skip-git-repo-check'));
  assert.strictEqual((await jobs.list(p))[0].exitCode, 3);
  const bad = runAgent(p, ['codex', '--role', 'wizard'], 'x');
  assert.notStrictEqual(bad.status, 0);
  assert.match(bad.stderr, /no role "wizard"/);
});

test('codeome-agent --worktree runs the job on its own branch', async () => {
  const p = tmp();
  const g = (...a) => spawnSync('git', a, { cwd: p, encoding: 'utf8' });
  g('init', '-q'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  kit.install(p);
  const r = runAgent(p, ['codex', '--role', 'implementer', '--worktree'], 'x', { CODEOME_CODEX: fakeCodex(p) });
  assert.strictEqual(r.status, 0, r.stderr);
  const j = (await jobs.list(p))[0];
  assert.strictEqual(j.branch, 'codeome/' + j.id);
  assert.ok(fs.existsSync(path.join(p, '.codeome/worktrees', j.id)));
  assert.strictEqual(fs.realpathSync(readJson(path.join(p, 'call.json')).cwd), fs.realpathSync(j.worktree));
});

test('hooks record a Claude subagent job from Agent call to stop', async () => {
  const p = tmp();
  kit.install(p);
  const hook = (ev) => { const r = runAgent(p, ['hook'], JSON.stringify(ev)); assert.strictEqual(r.status, 0); return r.stdout; };
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { subagent_type: 'planner', description: 'Plan threads flag', prompt: 'Plan it.' } });
  const startOutput = hook({ hook_event_name: 'SubagentStart', agent_id: 'agent-1', agent_type: 'planner', session_id: 's1', cwd: p });
  let [j] = await jobs.list(p);
  assert.match(JSON.parse(startOutput).hookSpecificOutput.additionalContext, new RegExp(`progress --job ${j.id} --stage`));
  assert.strictEqual(j.engine, 'claude');
  assert.strictEqual(j.status, 'running');
  assert.strictEqual(j.title, 'Plan threads flag');
  assert.strictEqual(j.toolUseId, 'toolu_1'); // links the job to its card in the chat
  assert.strictEqual((await jobs.read(p, j.id, 'brief')).content, 'Plan it.');
  hook({ hook_event_name: 'SubagentStop', agent_id: 'agent-1', agent_type: 'planner', last_assistant_message: '## Status\ndone', agent_transcript_path: '/tmp/t.jsonl' });
  [j] = await jobs.list(p);
  assert.strictEqual(j.status, 'done');
  assert.strictEqual(j.transcript, '/tmp/t.jsonl');
  assert.strictEqual((await jobs.read(p, j.id, 'result')).content, '## Status\ndone');
  // Internal agents (empty type), other tools and garbage input are ignored quietly.
  hook({ hook_event_name: 'SubagentStop', agent_id: 'x', agent_type: '' });
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} });
  const r = runAgent(p, ['hook'], 'not json');
  assert.strictEqual(r.status, 0);
  assert.strictEqual((await jobs.list(p)).length, 1);
});

test('a running Codex job whose runner died shows as lost', () => {
  const j = jobs.settle({ engine: 'codex', status: 'running', pid: 999999, startedAt: new Date().toISOString() });
  assert.strictEqual(j.status, 'lost');
  assert.strictEqual(jobs.settle({ engine: 'claude', status: 'running', startedAt: '2020-01-01T00:00:00Z' }).status, 'stale');
});

test('codeome-agent runs Codex jobs on an account with headroom and holds them at the limit', async () => {
  const p = tmp();
  kit.install(p);
  const codex = fakeCodex(p);
  const env = { CODEOME_CODEX: codex, CODEX_HOME: '' };
  writeUsage(p, { codex: [['Main', '', 95, 40], ['Work', '~/.codex-work', 20, 30]] });
  const r = runAgent(p, ['codex', '--role', 'implementer'], 'x', env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /using Codex account "Work"/);
  assert.strictEqual(readJson(path.join(p, 'call.json')).codexHome, path.join(os.homedir(), '.codex-work'));
  const j = (await jobs.list(p))[0];
  assert.strictEqual(j.account, 'Work');

  // A follow-up stays in the account that holds the session, even past the limit.
  writeUsage(p, { codex: [['Main', '', 10, 10], ['Work', '~/.codex-work', 96, 30]] });
  const r2 = runAgent(p, ['codex', '--resume', '0199-test-session'], 'more', env);
  assert.strictEqual(r2.status, 75);
  assert.match(r2.stdout, /NOT started \(usage limit\).*cannot move to another account/s);

  // The default account runs without CODEX_HOME; every account past the limit holds the job.
  runAgent(p, ['codex', '--role', 'implementer'], 'x', env);
  assert.strictEqual(readJson(path.join(p, 'call.json')).codexHome, null);
  writeUsage(p, { codex: [['Main', '', 91, 10], ['Work', '~/.codex-work', 20, 99]] });
  const held = runAgent(p, ['codex', '--role', 'implementer'], 'x', env);
  assert.strictEqual(held.status, 75);
  assert.match(held.stdout, /Every Codex account is past 90%/);
  assert.strictEqual(runAgent(p, ['codex', '--role', 'implementer', '--ignore-limits'], 'x', env).status, 0);
  assert.match(runAgent(p, ['usage'], '', env).stdout, /codex  Work +LIMIT/);
});

test('the hook refuses new Claude subagents when the session account is past the limit', async () => {
  const p = tmp();
  kit.install(p);
  const call = { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_9', tool_input: { subagent_type: 'planner', prompt: 'Plan.' } };
  writeUsage(p, { claude: [['Personal', '', 93, 50], ['Work', '~/.claude-work', 10, 10]] });
  const r = runAgent(p, ['hook'], JSON.stringify(call), { CLAUDE_CONFIG_DIR: '' });
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.strictEqual(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /Claude account "Personal" is at 5-hour 93%.*"Work"/s);
  assert.ok(!fs.existsSync(path.join(p, '.codeome/jobs/.pending')));
  // The other account's session goes ahead (and nothing is printed).
  const ok = runAgent(p, ['hook'], JSON.stringify(call), { CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude-work') });
  assert.strictEqual(ok.stdout, '');
  assert.strictEqual(fs.readdirSync(path.join(p, '.codeome/jobs/.pending')).length, 1);
});

test('agents list kit roles and the project\'s own, with engine and models', () => {
  const p = tmp();
  kit.install(p);
  fs.writeFileSync(path.join(p, '.claude/agents/stats.md'), '---\nname: stats\ndescription: Checks statistics | carefully.\ntools: Read, Grep\n---\n\nBody.\n');
  const list = kit.agents(p);
  const by = Object.fromEntries(list.map((a) => [a.name, a]));
  assert.strictEqual(by.implementer.engine, 'codex');
  assert.strictEqual(by.implementer.kit, true);
  assert.strictEqual(by.implementer.access, 'writes');
  assert.strictEqual(by.explorer.claudeModel, 'sonnet');
  assert.strictEqual(by.reviewer.engine, 'cross');
  assert.strictEqual(by.stats.kit, false);
  assert.strictEqual(by.stats.engine, 'claude');
  assert.strictEqual(by.stats.access, 'read-only');
});

test('setting an agent\'s engine and models updates routing, frontmatter and agents.json, and survives kit updates', () => {
  const p = tmp();
  kit.install(p);
  const routing = path.join(p, '.claude/skills/orchestrate/routing.md');
  let a = kit.setAgent(p, 'implementer', { engine: 'claude', claudeModel: 'opus' });
  assert.strictEqual(a.engine, 'claude');
  assert.strictEqual(a.claudeModel, 'opus');
  assert.match(fs.readFileSync(routing, 'utf8'), /\| `implementer` \| Claude \| writes \|/);
  assert.match(fs.readFileSync(path.join(p, '.claude/agents/implementer.md'), 'utf8'), /^---\nname: implementer\n[\s\S]*\nmodel: opus\n---\n/);
  // Changed by Codeome, so still counted as unedited; a reinstall keeps the choices.
  assert.deepStrictEqual(kit.status(p).modified, []);
  assert.deepStrictEqual(kit.install(p).written, []);
  a = kit.setAgent(p, 'explorer', { claudeModel: '' });
  assert.doesNotMatch(fs.readFileSync(path.join(p, '.claude/agents/explorer.md'), 'utf8'), /^model:/m);
  kit.setAgent(p, 'debugger', { codexModel: 'gpt-6-sol' });
  assert.deepStrictEqual(readJson(path.join(p, '.codeome/agents.json')).roles, { implementer: { engine: 'claude', claudeModel: 'opus' }, explorer: { claudeModel: '' }, debugger: { codexModel: 'gpt-6-sol' } });
  // Back to the kit default drops the override.
  kit.setAgent(p, 'implementer', { engine: 'codex', claudeModel: '' });
  assert.deepStrictEqual(readJson(path.join(p, '.codeome/agents.json')).roles.implementer, undefined);
  assert.match(fs.readFileSync(routing, 'utf8'), /\| `implementer` \| Codex \|/);
  // A user-edited file is patched in place and stays "edited".
  fs.appendFileSync(path.join(p, '.claude/agents/tester.md'), '\nHouse rules.\n');
  kit.setAgent(p, 'tester', { claudeModel: 'haiku' });
  const tester = fs.readFileSync(path.join(p, '.claude/agents/tester.md'), 'utf8');
  assert.match(tester, /\nmodel: haiku\n---/);
  assert.match(tester, /House rules/);
  assert.ok(kit.status(p).modified.includes('.claude/agents/tester.md'));
  // Effort: Claude's in the frontmatter beside the model, Codex's in agents.json.
  a = kit.setAgent(p, 'tester', { claudeModel: 'opus', claudeEffort: 'high', codexEffort: 'xhigh' });
  assert.strictEqual(a.claudeEffort, 'high');
  assert.strictEqual(a.codexEffort, 'xhigh');
  assert.match(fs.readFileSync(path.join(p, '.claude/agents/tester.md'), 'utf8'), /\nmodel: opus\neffort: high\n---/);
  assert.strictEqual(readJson(path.join(p, '.codeome/agents.json')).roles.tester.codexEffort, 'xhigh');
  kit.setAgent(p, 'planner', { claudeEffort: 'max' });
  assert.deepStrictEqual(kit.install(p).written, []);
  assert.match(fs.readFileSync(path.join(p, '.claude/agents/planner.md'), 'utf8'), /^effort: max$/m);
  kit.setAgent(p, 'planner', { claudeEffort: '' });
  assert.doesNotMatch(fs.readFileSync(path.join(p, '.claude/agents/planner.md'), 'utf8'), /^effort:/m);
  assert.strictEqual(readJson(path.join(p, '.codeome/agents.json')).roles.planner, undefined);
  assert.throws(() => kit.setAgent(p, 'tester', { claudeEffort: 'minimal' }), /Unknown effort/);
  assert.throws(() => kit.setAgent(p, 'tester', { engine: 'gemini' }), /Unknown engine/);
  assert.throws(() => kit.setAgent(p, 'tester', { codexModel: 'x; rm -rf /' }), /Not a model/);
  assert.throws(() => kit.setAgent(p, '../x', {}), /Bad agent/);
});

test('the project\'s own agents get a routing row when an engine is chosen, kept on reinstall', () => {
  const p = tmp();
  kit.install(p);
  fs.writeFileSync(path.join(p, '.claude/agents/stats.md'), '---\nname: stats\ndescription: Checks statistics.\ntools: Read, Edit\n---\n\nBody.\n');
  kit.setAgent(p, 'stats', { engine: 'codex' });
  const routing = path.join(p, '.claude/skills/orchestrate/routing.md');
  assert.match(fs.readFileSync(routing, 'utf8'), /\| `stats` \| Codex \| writes \| Checks statistics\. \|/);
  kit.install(p);
  assert.match(fs.readFileSync(routing, 'utf8'), /\| `stats` \| Codex \|/);
  assert.strictEqual(kit.agents(p).find((a) => a.name === 'stats').engine, 'codex');
});

test('creating agents records their tools and engine without replacing existing roles', () => {
  const p = tmp(), home = tmp();
  kit.install(p);
  const project = kit.createAgent({ scope: 'project', project: p, name: 'data-aide', description: 'Checks data.', engine: 'codex', tools: 'read-only' });
  assert.strictEqual(project.path, path.join(p, '.claude/agents/data-aide.md'));
  assert.match(fs.readFileSync(project.path, 'utf8'), /tools: Read, Grep, Glob, Bash\n/);
  assert.match(fs.readFileSync(project.path, 'utf8'), /## Report/);
  assert.strictEqual(readJson(path.join(p, '.codeome/agents.json')).roles['data-aide'].engine, 'codex');
  assert.match(fs.readFileSync(path.join(p, '.claude/skills/orchestrate/routing.md'), 'utf8'), /\| `data-aide` \| Codex \| read-only \|/);
  assert.ok(kit.createAgent({ scope: 'project', project: p, name: 'data-aide', description: '', engine: 'claude', tools: 'edits' }).error);
  assert.ok(kit.createAgent({ scope: 'project', project: p, name: 'reviewer', description: '', engine: 'claude', tools: 'edits' }).error);
  const general = kit.createAgent({ scope: 'general', home, name: 'note-aide', description: 'Checks notes.', engine: 'codex', tools: 'edits' });
  assert.match(fs.readFileSync(general.path, 'utf8'), /^codeome-engine: codex$/m);
  assert.strictEqual(kit.generalAgents(home)[0].engine, 'codex');
});

test('promotion copies agents and mirroring preserves account edits', () => {
  const p = tmp(), other = tmp(), home = tmp(), account = tmp(), account2 = tmp();
  kit.install(p);
  kit.install(other);
  kit.createAgent({ scope: 'project', project: p, name: 'data-aide', description: 'Checks data.', engine: 'codex', tools: 'edits' });
  const promoted = kit.promoteAgent({ project: p, name: 'data-aide', toGeneral: true, toProjects: [other], home });
  assert.strictEqual(promoted.general, 'created');
  assert.strictEqual(promoted.projects[other], 'created');
  assert.match(fs.readFileSync(path.join(other, '.claude/skills/orchestrate/routing.md'), 'utf8'), /\| `data-aide` \| Codex \|/);
  assert.strictEqual(kit.promoteAgent({ project: p, name: 'data-aide', toGeneral: true, toProjects: [other], home, accountDirs: [account2] }).general, 'exists');
  const target2 = path.join(account2, 'agents/data-aide.md');
  assert.ok(fs.existsSync(target2));
  const target = path.join(account, 'agents/data-aide.md');
  assert.deepStrictEqual(kit.mirrorGeneral({ home, accountDirs: [account] }).written, [target]);
  fs.appendFileSync(target, '\nAccount edit.\n');
  fs.appendFileSync(path.join(home, 'agents/data-aide.md'), '\nGeneral edit.\n');
  assert.deepStrictEqual(kit.mirrorGeneral({ home, accountDirs: [account] }).skipped, [target]);
  assert.match(fs.readFileSync(target, 'utf8'), /Account edit/);
  assert.deepStrictEqual(kit.mirrorGeneral({ home, accountDirs: [account2] }).written, [target2]);
  fs.unlinkSync(path.join(home, 'agents/data-aide.md'));
  assert.deepStrictEqual(kit.mirrorGeneral({ home, accountDirs: [account, account2] }).removed, [target2]);
  assert.ok(fs.existsSync(target));
});

test('codeome-agent falls back to a general role', () => {
  const p = tmp(), home = tmp();
  kit.install(p);
  kit.createAgent({ scope: 'general', home, name: 'note-aide', description: 'Checks notes.', engine: 'codex', tools: 'read-only' });
  const r = runAgent(p, ['codex', '--role', 'note-aide'], 'Check notes.', { CODEOME_HOME: home, CODEOME_CODEX: fakeCodex(p) });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(readJson(path.join(p, 'call.json')).prompt, /You are the note-aide/);
});

test('codeome-agent uses the Codex model chosen for the role unless --model is given', () => {
  const p = tmp();
  kit.install(p);
  const codex = fakeCodex(p);
  kit.setAgent(p, 'implementer', { codexModel: 'gpt-6-sol' });
  let r = runAgent(p, ['codex', '--role', 'implementer'], 'x', { CODEOME_CODEX: codex });
  assert.strictEqual(r.status, 0, r.stderr);
  let argv = readJson(path.join(p, 'call.json')).argv;
  assert.strictEqual(argv[argv.indexOf('-m') + 1], 'gpt-6-sol');
  r = runAgent(p, ['codex', '--role', 'implementer', '--model', 'gpt-6-luna'], 'x', { CODEOME_CODEX: codex });
  argv = readJson(path.join(p, 'call.json')).argv;
  assert.strictEqual(argv[argv.indexOf('-m') + 1], 'gpt-6-luna');
  runAgent(p, ['codex', '--role', 'tester'], 'x', { CODEOME_CODEX: codex });
  assert.ok(!readJson(path.join(p, 'call.json')).argv.includes('-m'));
});

test('codeome-agent makes connected projects writable for Codex jobs, and only for fresh write jobs', () => {
  const p = tmp(), other = tmp();
  kit.install(p);
  const codex = fakeCodex(p);
  const env = { CODEOME_CODEX: codex, CODEOME_LINKED: [other, path.join(p, 'missing'), p].join(path.delimiter) };
  let r = runAgent(p, ['codex', '--role', 'implementer'], 'x', env);
  assert.strictEqual(r.status, 0, r.stderr);
  let argv = readJson(path.join(p, 'call.json')).argv;
  const dirs = argv.map((a, i) => (a === '--add-dir' ? argv[i + 1] : null)).filter(Boolean);
  assert.deepStrictEqual(dirs, [other]);
  runAgent(p, ['codex', '--role', 'reviewer'], 'x', env);
  assert.ok(!readJson(path.join(p, 'call.json')).argv.includes('--add-dir'));
  runAgent(p, ['codex', '--role', 'implementer'], 'x', { CODEOME_CODEX: codex });
  assert.ok(!readJson(path.join(p, 'call.json')).argv.includes('--add-dir'));
});

test('the kit tells the team about the open HPC connection, secrets and Google documents', () => {
  const read = (...f) => fs.readFileSync(path.join(__dirname, '..', 'kit', ...f), 'utf8');
  const orch = read('skills', 'orchestrate', 'SKILL.md');
  assert.ok(/Reaching the HPC/.test(orch) && /Connected projects:/.test(orch) && /general-purpose/.test(orch) && /Running as a Codex chat/.test(orch));
  assert.ok(/general-purpose/.test(read('skills', 'delegate', 'SKILL.md')));
  assert.ok(/general-purpose/.test(read('chat.md')) && !/hand it to a Claude specialist/.test(read('chat.md')));
  assert.ok(/codeome-cm/.test(read('roles', 'hpc-operator.md')) && /Settings → Secrets/.test(read('roles', 'hpc-operator.md')));
  for (const r of ['release-manager', 'backend']) assert.ok(/environment variable/.test(read('roles', r + '.md')), r);
  for (const r of ['analyst', 'report-writer', 'pipeline-engineer']) assert.ok(/hpc-operator/.test(read('roles', r + '.md')), r);
  assert.ok(/network, the HPC/.test(read('chat-codex.md')));
});

test('skills follow the role groups, and list with their files and edits', () => {
  const groups = Object.keys(kit.MANIFEST.groups);
  for (const s of kit.skills()) {
    assert.ok(s.description && s.files['SKILL.md'], s.name);
    assert.ok(groups.includes(s.group), `${s.name}: unknown group ${s.group}`);
    assert.doesNotMatch(s.files['SKILL.md'], /^group:/m);
  }
  const p = tmp();
  kit.install(p, { groups: [] });
  assert.ok(fs.existsSync(path.join(p, '.claude/skills/delegate/SKILL.md')));
  assert.ok(!fs.existsSync(path.join(p, '.claude/skills/release')));
  kit.install(p, { groups: ['release'] });
  const agent = fs.readFileSync(path.join(p, '.claude/agents/release-manager.md'), 'utf8');
  // Every playbook the role is told to read is installed with it.
  for (const f of agent.match(/`(\w[\w-]*\.md)`/g).map((x) => x.slice(1, -1))) assert.ok(fs.existsSync(path.join(p, '.claude/skills/release', f)), f);
  fs.mkdirSync(path.join(p, '.claude/skills/lab-report'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude/skills/lab-report/SKILL.md'), '---\nname: lab-report\ndescription: Mine.\n---\n');
  fs.appendFileSync(path.join(p, '.claude/skills/release/cran.md'), '\nOur maintainer is Ada.\n');
  const list = kit.skillList(p);
  assert.deepStrictEqual(list.map((s) => s.name), ['cross-review', 'delegate', 'lab-report', 'orchestrate', 'release']);
  const by = Object.fromEntries(list.map((s) => [s.name, s]));
  assert.deepStrictEqual([by.orchestrate.kit, by.orchestrate.group, by.orchestrate.command, by.orchestrate.edited], [true, 'core', true, false]);
  assert.deepStrictEqual(by.orchestrate.files.map((f) => f.name), ['SKILL.md', 'routing.md']);
  assert.deepStrictEqual([by.release.group, by.release.command, by.release.edited], ['release', false, true]);
  assert.deepStrictEqual(by.release.files.filter((f) => f.edited).map((f) => f.name), ['cran.md']);
  assert.deepStrictEqual([by['lab-report'].kit, by['lab-report'].command], [false, true]);
  // Dropping the group removes the untouched playbooks and keeps the edited one.
  const r = kit.install(p, { groups: [] });
  assert.ok(r.removed.includes('.claude/skills/release/pypi.md'));
  assert.ok(r.kept.includes('.claude/skills/release/cran.md'));
});

test('global agents and skills list apart from the project\'s, with name clashes marked both ways', () => {
  const p = tmp(), g = tmp();
  kit.install(p);
  assert.deepStrictEqual([kit.globalAgents(g, p), kit.globalSkills(g, p)], [[], []]);
  fs.mkdirSync(path.join(g, 'agents'));
  fs.writeFileSync(path.join(g, 'agents/tester.md'), '---\nname: tester\ndescription: My own tester.\ntools: Read, Grep\nmodel: haiku\n---\n\nBody.\n');
  fs.writeFileSync(path.join(g, 'agents/tidy.md'), '---\nname: tidy\ndescription: Tidies up.\n---\n\nBody.\n');
  for (const n of ['delegate', 'thesis', '.trash']) fs.mkdirSync(path.join(g, 'skills', n), { recursive: true });
  fs.writeFileSync(path.join(g, 'skills/delegate/SKILL.md'), '---\nname: delegate\ndescription: Mine.\n---\n');
  fs.writeFileSync(path.join(g, 'skills/thesis/SKILL.md'), '---\nname: thesis\ndescription: House style.\nuser-invocable: false\n---\n');
  fs.writeFileSync(path.join(g, 'skills/thesis/figures.md'), 'Figures.\n');
  fs.writeFileSync(path.join(g, 'skills/.trash/SKILL.md'), '---\nname: old\n---\n');

  const ga = Object.fromEntries(kit.globalAgents(g, p).map((a) => [a.name, a]));
  assert.deepStrictEqual(Object.keys(ga), ['tester', 'tidy']);
  assert.deepStrictEqual([ga.tester.claudeModel, ga.tester.access, ga.tester.replacedByProject], ['haiku', 'read-only', true]);
  assert.deepStrictEqual([ga.tidy.access, ga.tidy.replacedByProject, ga.tidy.path], ['writes', false, path.join(g, 'agents/tidy.md')]);
  const gs = Object.fromEntries(kit.globalSkills(g, p).map((s) => [s.name, s]));
  assert.deepStrictEqual(Object.keys(gs), ['delegate', 'thesis']);
  assert.deepStrictEqual([gs.delegate.replacesProject, gs.delegate.command], [true, true]);
  assert.deepStrictEqual([gs.thesis.replacesProject, gs.thesis.command, gs.thesis.files.map((f) => f.name)], [false, false, ['SKILL.md', 'figures.md']]);
  // Without a project nothing clashes.
  assert.ok(kit.globalAgents(g).every((a) => !a.replacedByProject) && kit.globalSkills(g).every((s) => !s.replacesProject));

  // The project's lists say which of theirs meet a global one: its agent wins, its skill loses.
  const pa = Object.fromEntries(kit.agents(p, g).map((a) => [a.name, a]));
  assert.deepStrictEqual([pa.tester.replacesGlobal, pa.planner.replacesGlobal], [true, false]);
  const ps = Object.fromEntries(kit.skillList(p, g).map((s) => [s.name, s]));
  assert.deepStrictEqual([ps.delegate.replacedByGlobal, ps.orchestrate.replacedByGlobal], [true, false]);
  assert.ok(kit.agents(p).every((a) => !a.replacesGlobal));

  // Model and effort go into the global file's frontmatter; the project and its kit record are untouched.
  const a = kit.setGlobalAgent(g, 'tidy', { claudeModel: 'opus', claudeEffort: 'high' }, p);
  assert.deepStrictEqual([a.claudeModel, a.claudeEffort], ['opus', 'high']);
  assert.match(fs.readFileSync(path.join(g, 'agents/tidy.md'), 'utf8'), /\nmodel: opus\neffort: high\n---/);
  kit.setGlobalAgent(g, 'tester', { claudeModel: '' });
  assert.doesNotMatch(fs.readFileSync(path.join(g, 'agents/tester.md'), 'utf8'), /^model:/m);
  assert.deepStrictEqual(kit.status(p).modified, []);
  assert.ok(!fs.existsSync(path.join(p, '.codeome/agents.json')));
  assert.throws(() => kit.setGlobalAgent(g, 'nobody', {}), /No global agent/);
  assert.throws(() => kit.setGlobalAgent(g, 'tidy', { claudeEffort: 'minimal' }), /Unknown effort/);
  assert.throws(() => kit.setGlobalAgent(g, '../x', {}), /Bad agent/);
});

test('the figure-designer role installs with its skill, and compose.py keeps panels vector with unique ids', () => {
  const p = tmp();
  kit.install(p, { groups: ['research'] });
  const role = fs.readFileSync(path.join(p, '.claude/agents/figure-designer.md'), 'utf8');
  assert.match(role, /\.claude\/skills\/figures\/SKILL\.md/);
  const dir = path.join(p, '.claude/skills/figures');
  assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')) && fs.existsSync(path.join(dir, 'compose.py')));
  const panel = (id) => `<svg xmlns='http://www.w3.org/2000/svg' width='100pt' height='50pt' viewBox='0 0 100 50'><defs><clipPath id='cp'><rect width='100' height='50'/></clipPath></defs><g clip-path='url(#cp)'><rect id='${id}' width='10' height='10'/></g></svg>`;
  fs.writeFileSync(path.join(p, 'a.svg'), panel('r'));
  fs.writeFileSync(path.join(p, 'b.svg'), panel('r'));
  const r = spawnSync('python3', ['-B', '-I', path.join(dir, 'compose.py'), path.join(p, 'out.svg'), '--width', '100', '--cols', '2', path.join(p, 'a.svg'), path.join(p, 'b.svg')], { encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') return; // no python3 on this machine
  assert.strictEqual(r.status, 0, r.stderr);
  const out = fs.readFileSync(path.join(p, 'out.svg'), 'utf8');
  assert.ok(!/<image\b/.test(out));
  const ids = [...out.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.strictEqual(new Set(ids).size, ids.length, ids.join());
  assert.match(out, /url\(#p1-cp\)/);
  assert.match(out, />b<\/text>/);
});
