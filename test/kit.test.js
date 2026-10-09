const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const kit = require('../main/kit');
const jobs = require('../main/jobs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-kit-'));
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const agentBin = (project) => path.join(project, '.codeome', 'bin', 'codeome-agent');

test('every role has the metadata the installer and router need', () => {
  const groups = Object.keys(kit.MANIFEST.groups);
  for (const r of kit.roles()) {
    assert.ok(r.name && r.description && r.tools, r.name);
    assert.ok(groups.includes(r.group), `${r.name}: unknown group ${r.group}`);
    assert.ok(['claude', 'codex', 'cross'].includes(r.engine), `${r.name}: unknown engine ${r.engine}`);
    assert.match(r.body, /## Report/);
  }
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
json.dump({'argv': argv, 'cwd': os.getcwd(), 'prompt': prompt, 'codexHome': os.environ.get('CODEX_HOME')}, open(os.path.join(${JSON.stringify(dir)}, 'call.json'), 'w'))
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
  return spawnSync('python3', [agentBin(project), ...args], { input, encoding: 'utf8', cwd: project, env: { ...process.env, CODEOME_HOME: path.join(project, '.codeome-home'), ...env } });
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

  const list = await jobs.list(p);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].status, 'done');
  assert.strictEqual(list[0].session, '0199-test-session');
  assert.strictEqual(list[0].title, 'Add flag');
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
  const hook = (ev) => { const r = runAgent(p, ['hook'], JSON.stringify(ev)); assert.strictEqual(r.status, 0); assert.strictEqual(r.stdout, ''); };
  hook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { subagent_type: 'planner', description: 'Plan threads flag', prompt: 'Plan it.' } });
  hook({ hook_event_name: 'SubagentStart', agent_id: 'agent-1', agent_type: 'planner', session_id: 's1', cwd: p });
  let [j] = await jobs.list(p);
  assert.strictEqual(j.engine, 'claude');
  assert.strictEqual(j.status, 'running');
  assert.strictEqual(j.title, 'Plan threads flag');
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
