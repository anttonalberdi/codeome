const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CODEOME_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-home-'));
const chat = require('../main/chat');
const policy = require('../main/policy');
const usage = require('../main/usage');
const scratch = require('../main/scratch');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

test('the orchestrator prompt keeps only the part for this project', () => {
  const src = 'A\n<!-- if kit -->\nTEAM\n<!-- else -->\nSOLO\n<!-- end -->\nB\n';
  assert.strictEqual(chat.systemPrompt(true, src), 'A\n\nTEAM\n\nB\n');
  assert.strictEqual(chat.systemPrompt(false, src), 'A\n\nSOLO\n\nB\n');
  // The shipped prompt has both parts and no markers left over.
  for (const k of [true, false]) assert.ok(!/<!--/.test(chat.systemPrompt(k)));
  assert.ok(chat.systemPrompt(true).includes('codeome-agent codex'));
  assert.ok(!chat.systemPrompt(false).includes('codeome-agent codex'));
});

test('arguments start a new session or resume one, with the configured extras first', () => {
  const a = chat.buildArgs({ id: ID, kitInstalled: true, extra: ['--model', 'opus'], mode: 'default' });
  assert.deepStrictEqual(a.slice(0, 3), ['--model', 'opus', '-p']);
  for (const f of ['--input-format', '--output-format', '--permission-prompt-tool', '--append-system-prompt']) assert.ok(a.includes(f), f);
  assert.strictEqual(a[a.indexOf('--session-id') + 1], ID);
  assert.ok(!a.includes('--permission-mode'));
  const r = chat.buildArgs({ id: ID, resume: true, mode: 'acceptEdits' });
  assert.strictEqual(r[r.indexOf('--resume') + 1], ID);
  assert.ok(!r.includes('--session-id'));
  assert.strictEqual(r[r.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.ok(!chat.buildArgs({ id: ID, mode: 'bogus' }).includes('--permission-mode'));
});

test('project rules join the prompt and the existing Claude settings only when set', () => {
  const settings = path.join(process.env.CODEOME_HOME, 'status-settings.json');
  const base = { statusLine: { type: 'command', command: 'status' }, permissions: { allow: ['Read(*)'], ask: ['Bash(*)'] } };
  fs.writeFileSync(settings, JSON.stringify(base));
  const options = { id: ID, kitInstalled: true, settings };
  const original = chat.buildArgs(options);
  assert.deepStrictEqual(chat.buildArgs({ ...options, policyAtSpawn: policy.policyFor({}, '/p') }), original);
  const restricted = chat.buildArgs({ ...options, policyAtSpawn: { slurmSubmit: 'never' } });
  assert.match(restricted[restricted.indexOf('--append-system-prompt') + 1], /Do not submit Slurm jobs/);
  const merged = JSON.parse(restricted[restricted.indexOf('--settings') + 1]);
  assert.deepStrictEqual(merged.statusLine, base.statusLine);
  assert.deepStrictEqual(merged.permissions.ask, ['Bash(*)']);
  assert.deepStrictEqual(merged.permissions.allow, ['Read(*)']);
  assert.ok(merged.permissions.deny.includes('Bash(sbatch *)'));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), base);
  const inline = chat.buildArgs({ ...options, settings: JSON.stringify(base), policyAtSpawn: { slurmSubmit: 'never' } });
  assert.ok(JSON.parse(inline[inline.indexOf('--settings') + 1]).permissions.deny.includes('Bash(sbatch *)'));
  assert.ok(!original[original.indexOf('--append-system-prompt') + 1].includes('Do not submit Slurm jobs'));
});

test('project rule settings survive malformed and non-array Claude settings', () => {
  const rules = { slurmSubmit: 'never' };
  const atSettings = (settings) => {
    const args = chat.buildArgs({ id: ID, settings, policyAtSpawn: rules });
    return JSON.parse(args[args.indexOf('--settings') + 1]);
  };
  const settings = path.join(process.env.CODEOME_HOME, 'bad-settings.json');
  fs.writeFileSync(settings, '{bad json');
  assert.ok(atSettings(settings).permissions.deny.includes('Bash(sbatch *)'));
  assert.ok(atSettings('{bad json').permissions.deny.includes('Bash(sbatch *)'));
  assert.deepStrictEqual(atSettings('{"permissions":{"deny":"Bash(*)","allow":null}}').permissions.allow, []);
  assert.deepStrictEqual(atSettings('{"permissions":{"deny":"Bash(*)","allow":null}}').permissions.deny[0], 'Bash(sbatch *)');
});

test('an explicit prompt replaces the chat, connected project and HPC instructions', () => {
  const options = { id: ID, kitInstalled: true, linked: ['/w/api'], hpc: { host: 'myhpc' } };
  const appended = (args) => args[args.indexOf('--append-system-prompt') + 1];
  assert.strictEqual(appended(chat.buildArgs({ ...options, prompt: 'Forum instructions' })), 'Forum instructions');
  assert.strictEqual(appended(chat.buildArgs({ ...options, prompt: '' })), '');
  assert.strictEqual(appended(chat.buildArgs(options)), chat.systemPrompt(true) + chat.linkedPrompt(['/w/api'], true) + chat.hpcPrompt({ host: 'myhpc' }));
});

test('connected projects are added as folders and named in the prompt', () => {
  const plain = chat.buildArgs({ id: ID, kitInstalled: true });
  assert.ok(!plain.includes('--add-dir'));
  assert.ok(!plain[plain.indexOf('--append-system-prompt') + 1].includes('Connected projects'));
  const a = chat.buildArgs({ id: ID, resume: true, kitInstalled: true, linked: ['/w/api', '/w/web site'] });
  assert.deepStrictEqual(a.filter((_x, i) => a[i - 1] === '--add-dir'), ['/w/api', '/w/web site']);
  const prompt = a[a.indexOf('--append-system-prompt') + 1];
  assert.ok(prompt.includes('## Connected projects') && prompt.includes('- `web site`: /w/web site'));
  assert.ok(prompt.includes('Codex jobs'));
  assert.ok(!chat.linkedPrompt(['/w/api'], false).includes('Codex'));
  assert.strictEqual(chat.linkedPrompt([], true), '');
});

test('the folder for agent projects on the HPC is named in the prompt', () => {
  const at = (a) => a[a.indexOf('--append-system-prompt') + 1];
  assert.ok(!at(chat.buildArgs({ id: ID, hpc: { host: 'myhpc', agentRoot: '' } })).includes('Projects on the HPC'));
  const prompt = at(chat.buildArgs({ id: ID, hpc: { host: 'myhpc', agentRoot: '/projects/lab/me/projects/' } }));
  assert.ok(prompt.includes('## Projects on the HPC') && prompt.includes('`ssh myhpc`') && prompt.includes('under `/projects/lab/me/projects/`'));
  assert.ok(!chat.hpcPrompt({ agentRoot: '/p' }).includes('ssh'));
  assert.strictEqual(chat.hpcPrompt(null), '');
});

test('the prompt tells the agent to reach the HPC through Codeome\'s control socket', () => {
  const p = chat.hpcPrompt({ host: 'myhpc', agentRoot: '' });
  assert.ok(p.includes('## Reaching the HPC') && p.includes('codeome-cm') && p.includes('ControlMaster=no') && p.includes('-O check myhpc'));
  assert.ok(!p.includes('Projects on the HPC'));
  assert.ok(!chat.hpcPrompt({ agentRoot: '/p' }).includes('Reaching the HPC'));
  assert.ok(chat.hpcPrompt({ host: 'myhpc' }).includes('hpc-operator') && !chat.hpcPrompt({ host: 'myhpc' }, 'codex').includes('hpc-operator'));
});

test('the model chosen in Settings replaces a --model in the command', () => {
  assert.deepStrictEqual(chat.withModel(['--model', 'opus', '--verbose'], ''), ['--model', 'opus', '--verbose']);
  assert.deepStrictEqual(chat.withModel(['--model', 'opus', '--verbose'], 'claude-fable-5-1'), ['--verbose', '--model', 'claude-fable-5-1']);
  assert.deepStrictEqual(chat.withModel(['--model=opus'], 'sonnet'), ['--model', 'sonnet']);
  const a = chat.buildArgs({ id: ID, extra: ['--model', 'opus'], model: 'haiku' });
  assert.deepStrictEqual(a.slice(0, 3), ['--model', 'haiku', '-p']);
});

test('the effort chosen in Settings is passed on, replacing one in the command', () => {
  const a = chat.buildArgs({ id: ID, extra: ['--effort', 'low'], model: 'sonnet', effort: 'high' });
  assert.deepStrictEqual(a.slice(0, 5), ['--model', 'sonnet', '--effort', 'high', '-p']);
  assert.ok(!chat.buildArgs({ id: ID, effort: '' }).includes('--effort'));
  assert.ok(!chat.buildArgs({ id: ID, effort: 'bogus' }).includes('--effort'));
});

test('rate limit events become status-line readings that usage reads back', () => {
  const ev = { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.335, resetsAt: 2e9 }, seven_day: { utilization: 0.11, resetsAt: 2e9 + 1 } } } };
  const rl = chat.rateLimits(ev);
  assert.deepStrictEqual(rl, { five_hour: { used_percentage: 33.5, resets_at: 2e9 }, seven_day: { used_percentage: 11, resets_at: 2e9 + 1 } });
  assert.strictEqual(chat.rateLimits({ type: 'rate_limit_event', rate_limit_info: {} }), null);
  chat.recordUsage('', rl);
  const back = usage.readClaude('');
  assert.strictEqual(back.windows.fiveHour.pct, 33.5);
  assert.strictEqual(back.windows.weekly.resetsAt, 2e9 + 1);
});

test('only top-level text deltas pass through, tagged with their message', () => {
  const cur = {};
  assert.strictEqual(chat.slim({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } }, cur), null);
  assert.deepStrictEqual(chat.slim({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'hi' } } }, cur),
    { type: 'text_delta', msgId: 'm1', index: 1, text: 'hi' });
  assert.strictEqual(chat.slim({ type: 'stream_event', parent_tool_use_id: 't', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } }, cur), null);
  assert.strictEqual(chat.slim({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta' } } }, cur), null);
  const a = { type: 'assistant' };
  assert.strictEqual(chat.slim(a, cur), a);
});

test('conversations are saved per project and listed newest first', () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-proj-'));
  const other = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
  chat.saveChat(p, { id: ID, title: 'First', started: true, items: [{ t: 'user', text: 'hello' }] });
  chat.saveChat(p, { id: other, title: 'Second', items: [] });
  const list = chat.listChats(p);
  assert.deepStrictEqual(list.map((c) => c.id).sort(), [ID, other].sort());
  assert.strictEqual(list.find((c) => c.id === ID).messages, 1);
  assert.strictEqual(chat.loadChat(p, ID).items[0].text, 'hello');
  assert.strictEqual(chat.loadChat(p, '../../etc/passwd'), null);
  assert.ok(chat.saveChat(p, { id: 'nope' }).error);
  chat.deleteChat(p, other);
  assert.deepStrictEqual(chat.listChats(p).map((c) => c.id), [ID]);
  assert.deepStrictEqual(chat.listChats(path.join(p, 'missing')), []);
});

test('an Ideas chat moves into an existing project with its embedded project updated', () => {
  const from = scratch.dir(), to = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-promote-'));
  chat.saveChat(from, { id: ID, title: 'Idea', items: [{ t: 'user', text: 'hello' }] });
  assert.deepStrictEqual(chat.moveChat(ID, from, to), { ok: true });
  assert.deepStrictEqual(chat.listChats(from), []);
  assert.deepStrictEqual(chat.listChats(to).map((c) => c.id), [ID]);
  assert.strictEqual(chat.loadChat(to, ID).project, to);
});

test('chat promotion refuses other sources and invalid targets without removing the source', () => {
  const from = scratch.dir(), other = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-promote-'));
  const id = '1f8fad5b-d9cb-469f-a165-70867728950e';
  chat.saveChat(from, { id, title: 'Keep' });
  chat.saveChat(other, { id: ID, title: 'Other' });
  assert.throws(() => chat.moveChat(ID, other, from), /Source must be Ideas/);
  assert.throws(() => chat.moveChat(id, from, from), /Target must be a project/);
  const alias = path.join(other, 'ideas-link');
  fs.symlinkSync(from, alias);
  assert.throws(() => chat.moveChat(id, from, alias), /Target must be a project/);
  assert.throws(() => chat.moveChat(id, from, path.join(other, 'missing')), /Project folder not found/);
  chat.saveChat(other, { id, title: 'Collision' });
  assert.throws(() => chat.moveChat(id, from, other), /already exists/);
  assert.strictEqual(chat.loadChat(from, id).title, 'Keep');
  assert.strictEqual(chat.loadChat(other, id).title, 'Collision');
});

test('Claude session history and subagents copy to the target project cwd', () => {
  const from = scratch.dir(), to = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-promote-'));
  const account = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-acct-'));
  const keyed = (project) => fs.realpathSync(project).replace(/[^A-Za-z0-9]/g, '-');
  const source = path.join(account, 'projects', keyed(from));
  fs.mkdirSync(path.join(source, ID, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(source, ID + '.jsonl'), '{"n":1}\n');
  fs.writeFileSync(path.join(source, ID, 'subagents', 'agent.jsonl'), '{}\n');
  chat.copyProjectSession(account, ID, from, to);
  const target = path.join(account, 'projects', keyed(to));
  assert.strictEqual(fs.readFileSync(path.join(target, ID + '.jsonl'), 'utf8'), '{"n":1}\n');
  assert.strictEqual(fs.readFileSync(path.join(target, ID, 'subagents', 'agent.jsonl'), 'utf8'), '{}\n');
  assert.ok(fs.existsSync(path.join(source, ID + '.jsonl')));
});

// A stand-in for `claude -p` that speaks just enough stream-json.
const FAKE = `
const rl = require('readline').createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
console.log('login shell noise');
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.type === 'control_request') return out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { mode: m.request.mode } } });
  if (m.type === 'control_response') return out({ type: 'result', subtype: 'success', result: 'answer:' + JSON.stringify(m.response.response.updatedInput.answers) });
  out({ type: 'system', subtype: 'hook_started' });
  out({ type: 'system', subtype: 'init', session_id: 's' });
  out({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Q?' }] } } });
});
`;

test('a session relays messages, answers permission requests and its own control requests', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-fake-'));
  const fake = path.join(dir, 'fake.js');
  fs.writeFileSync(fake, FAKE);
  const s = new chat.Session({ id: ID, cwd: dir, shell: '/bin/sh', bin: process.execPath, args: [fake], env: process.env });
  const seen = [];
  const done = new Promise((resolve) => s.on('message', (m) => {
    seen.push(m);
    if (m.type === 'control_request') s.respond(m.request_id, { behavior: 'allow', updatedInput: { ...m.request.input, answers: { 'Q?': 'Yes' } } });
    if (m.type === 'result') resolve(m);
  }));
  s.start();
  assert.deepStrictEqual(await s.control({ subtype: 'set_permission_mode', mode: 'plan' }), { mode: 'plan' });
  s.user('hello');
  const res = await done;
  assert.strictEqual(res.result, 'answer:{"Q?":"Yes"}');
  assert.deepStrictEqual(seen.map((m) => m.type + (m.subtype ? '/' + m.subtype : '')), ['system/init', 'control_request', 'turn_usage', 'result/success']);
  const exited = new Promise((resolve) => s.on('exit', resolve));
  s.stop();
  await exited;
});

test('Claude permission checks use the latest project policy before auto approval', () => {
  const values = { slurmSubmit: 'never' };
  const s = new chat.Session({ id: ID, cwd: '/p', policy: () => values, autoAllow: () => true });
  const answers = [], shown = [];
  s.respond = (id, answer) => answers.push([id, answer]);
  s.on('message', (m) => shown.push(m));
  const request = (id) => s.handle({ type: 'control_request', request_id: id,
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'sbatch job.sh' } } });
  request('never');
  assert.strictEqual(answers[0][1].behavior, 'deny');
  assert.match(answers[0][1].message, /Slurm job submission/);
  values.slurmSubmit = 'allow';
  s.autoAllow = () => false;
  request('allow');
  assert.strictEqual(answers[1][1].behavior, 'allow');
  values.slurmSubmit = 'ask';
  s.autoAllow = () => true;
  request('ask');
  assert.strictEqual(answers[2][1].behavior, 'allow'); // existing autoAllow flow
  assert.strictEqual(shown.length, 0);
  s.autoAllow = () => false;
  request('ask-panel');
  assert.deepStrictEqual(answers.map(([id]) => id), ['never', 'allow', 'ask']);
  assert.strictEqual(shown[0].request_id, 'ask-panel');
});

test('only plain job-runner commands are approved without asking', () => {
  const ok = [
    `.codeome/bin/codeome-agent codex --role explorer --title "What does add compute" <<'BRIEF'\nGoal: read calc.py; report $x and \`y\` (data only)\nrm -rf /\nBRIEF`,
    '.codeome/bin/codeome-agent list',
    '.codeome/bin/codeome-agent show 20261009-221238-explorer-3411',
    `.codeome/bin/codeome-agent codex --role reviewer --title 'Review: parser (part 2)' --worktree --sandbox read-only <<BRIEF\nx\nBRIEF\n`
  ];
  const bad = [
    `.codeome/bin/codeome-agent codex --role x <<'BRIEF'\nhi\nBRIEF\nrm -rf ~`,       // a command after the heredoc
    `.codeome/bin/codeome-agent codex --role x <<'BRIEF'\nhi`,                       // never closed
    '.codeome/bin/codeome-agent list; rm -rf ~',
    '.codeome/bin/codeome-agent list && curl evil.example',
    '.codeome/bin/codeome-agent codex --title "$(whoami)" --role x',
    '.codeome/bin/codeome-agent codex --role x --ignore-limits',
    '.codeome/bin/codeome-agent hook',
    '.codeome/bin/codeome-agent list > /tmp/out',
    'python3 .codeome/bin/codeome-agent list\nls',
    'rm -rf ~',
    ''
  ];
  for (const c of ok) assert.ok(chat.isJobRunner(c), c);
  for (const c of bad) assert.ok(!chat.isJobRunner(c), c);
});

test('moving a conversation copies its transcript and subagent files into the other account folder', () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-acct-a-')), b = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-acct-b-'));
  const src = path.join(a, 'projects', '-Users-me-proj');
  fs.mkdirSync(path.join(src, ID, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(src, ID + '.jsonl'), '{"n":1}\n');
  fs.writeFileSync(path.join(src, ID, 'subagents', 'agent-1.jsonl'), '{}\n');
  chat.moveSession(a, b, ID);
  const dest = path.join(b, 'projects', '-Users-me-proj');
  assert.strictEqual(fs.readFileSync(path.join(dest, ID + '.jsonl'), 'utf8'), '{"n":1}\n');
  assert.ok(fs.existsSync(path.join(dest, ID, 'subagents', 'agent-1.jsonl')));
  // Moving back after more turns replaces the older copy.
  fs.writeFileSync(path.join(dest, ID + '.jsonl'), '{"n":1}\n{"n":2}\n');
  chat.moveSession(b, a, ID);
  assert.strictEqual(fs.readFileSync(path.join(src, ID + '.jsonl'), 'utf8'), '{"n":1}\n{"n":2}\n');
  assert.throws(() => chat.moveSession(a, b, '1f8fad5b-d9cb-469f-a165-70867728950e'), /no transcript/);
  assert.throws(() => chat.moveSession(a, b, '../x'), /Bad chat/);
});

test('a Codex chat has its own prompt, with the notes on connected projects and the HPC', () => {
  const p = chat.codexPrompt({ kitInstalled: true, linked: ['/w/api'], hpc: { host: 'myhpc', agentRoot: '/projects/lab/projects' } });
  assert.ok(!/<!--/.test(p));
  assert.ok(p.includes('running on Codex') && p.includes('codeome-agent codex'));
  assert.ok(/Claude specialists are not available/.test(p));
  assert.ok(/cannot read or edit a live Google Doc/.test(p) && p.includes('.gdoc'));
  assert.ok(p.includes('- `api`: /w/api') && p.includes('AGENTS.md') && !p.includes('which are loaded'));
  assert.ok(p.includes('## Projects on the HPC'));
  const solo = chat.codexPrompt({ kitInstalled: false });
  assert.ok(!solo.includes('codeome-agent codex') && !solo.includes('## Connected projects'));
  // The Claude prompt is unchanged by the engine.
  assert.ok(chat.systemPrompt(true).includes('Agent tool'));
  assert.match(chat.codexPrompt({ kitInstalled: true, policyAtSpawn: { slurmSubmit: 'never' } }), /Do not submit Slurm jobs/);
  assert.ok(!chat.codexPrompt({ kitInstalled: true }).includes('Do not submit Slurm jobs'));
});

test('forum participants have a separate moderated discussion prompt', () => {
  const prompt = chat.forumPrompt();
  assert.match(prompt, /moderat/i);
  assert.match(prompt, /read-only/);
  assert.doesNotMatch(prompt, /Codeome|\bjobs\b|\bskills\b/i);
});

test('a saved chat remembers its engine, and older ones are Claude', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-proj-'));
  const id2 = '1f8fad5b-d9cb-469f-a165-70867728950e';
  chat.saveChat(project, { id: ID, title: 'A', engine: 'codex', items: [] });
  chat.saveChat(project, { id: id2, title: 'B', items: [] });
  const by = Object.fromEntries(chat.listChats(project).map((c) => [c.id, c.engine]));
  assert.deepStrictEqual(by, { [ID]: 'codex', [id2]: 'claude' });
  assert.strictEqual(chat.engineOf('bogus'), 'claude');
});

test('a saved chat lists its persona role, while older chats have an empty role', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-proj-'));
  const older = '1f8fad5b-d9cb-469f-a165-70867728950e';
  const persona = chat.listPersonas()[0];
  assert.ok(persona, 'at least one shipped persona is needed');
  chat.saveChat(project, { id: ID, role: persona.id, items: [] });
  chat.saveChat(project, { id: older, items: [] });
  const by = Object.fromEntries(chat.listChats(project).map((c) => [c.id, c.role]));
  assert.deepStrictEqual(by, { [ID]: persona.id, [older]: '' });
  assert.strictEqual(chat.loadChat(project, ID).role, persona.id);
});
