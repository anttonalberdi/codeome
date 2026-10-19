// The agent chat: one headless Claude Code process per conversation, driven over
// stream-json. Claude Code is the orchestrator: it answers directly or hands work to
// specialist Claude subagents and Codex jobs. Plain Node (no Electron) so it is testable.
//
//   claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio
//   in:  {type:'user'}               a user turn (queued if one is running)
//        {type:'control_request'}    interrupt, set_permission_mode
//        {type:'control_response'}   answers to can_use_tool: permissions and AskUserQuestion
//   out: system/init, assistant, user (tool results), stream_event (partial text),
//        rate_limit_event, control_request (can_use_tool), result (end of a turn)
// The panel also gets two messages of ours, from the session's token meter (stats.js):
//        {type:'context'} how full the context window is, {type:'turn_usage'} what a turn used.
//
// Conversations are saved (as the chat panel shows them) in ~/.codeome/chats/<project>/.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const usage = require('./usage');
const scratch = require('./scratch');
const ssh = require('./ssh');
const { Meter } = require('./stats');
const { parseFrontmatter } = require('./kit');
const projectPolicy = require('./policy');

const PROMPT = path.join(__dirname, '..', 'kit', 'chat.md');
const PROMPT_CODEX = path.join(__dirname, '..', 'kit', 'chat-codex.md');
const PERSONAS = path.join(__dirname, '..', 'kit', 'personas');
const PROMPT_FORUM = path.join(__dirname, '..', 'kit', 'forum.md');
const ENGINES = ['claude', 'codex'];
const engineOf = (e) => (ENGINES.includes(e) ? e : 'claude');
const MODES = ['default', 'acceptEdits', 'auto', 'plan'];
// System messages the panel has no use for.
const QUIET = new Set(['hook_started', 'hook_response', 'hook_progress', 'thinking_tokens', 'status']);
const SCRATCH_NOTE = 'There is no project here. This is a free space to discuss ideas and possible new projects; no code base to edit unless the user asks to draft files.';

// The orchestrator's instructions, with the part for projects with or without the kit.
function systemPrompt(kitInstalled, text = fs.readFileSync(PROMPT, 'utf8'), cwd) {
  const isScratch = scratch.isScratch(cwd);
  const hasScratchNote = text.includes('<!-- if scratch -->');
  const prompt = text
    .replace(/<!-- Keep shared sections in sync between kit\/chat\.md and kit\/personas\/_base\.md\. -->\n/g, '')
    .replace(/<!-- if kit -->([\s\S]*?)<!-- else -->([\s\S]*?)<!-- end -->/g, (_m, yes, no) => (kitInstalled ? yes : no))
    .replace(/<!-- if scratch -->([\s\S]*?)<!-- end scratch -->/g, (_m, note) => (isScratch ? note : ''))
    .replace(/\n{3,}/g, '\n\n').trim();
  return prompt + (isScratch && !hasScratchNote ? '\n\n' + SCRATCH_NOTE : '') + '\n';
}

function readPersona(id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) return null;
  try {
    const text = fs.readFileSync(path.join(PERSONAS, id + '.md'), 'utf8');
    if (!/^---\n[\s\S]*?\n---\n?/.test(text)) return null;
    const { meta, body } = parseFrontmatter(text);
    if (!meta.name || !meta.description || !meta.placeholder || !body.trim()) return null;
    const lines = body.split('\n');
    const start = lines.findIndex((line) => /^## Examples\s*$/.test(line));
    const end = start < 0 ? -1 : lines.findIndex((line, i) => i > start && /^## /.test(line));
    const examples = start < 0 ? [] : lines.slice(start + 1, end < 0 ? undefined : end)
      .map((line) => line.match(/^[-*] (.+)$/)).filter(Boolean).map((m) => m[1].trim());
    const prompt = (start < 0 ? body : [...lines.slice(0, start), ...lines.slice(end < 0 ? lines.length : end)].join('\n')).trim();
    return { meta, examples, prompt };
  } catch { return null; }
}

function listPersonas() {
  let names; try { names = fs.readdirSync(PERSONAS); } catch { return []; }
  return names.filter((n) => n.endsWith('.md') && !n.startsWith('_')).map((n) => {
    const id = n.slice(0, -3);
    const p = readPersona(id);
    if (!p) return null;
    return { id, name: p.meta.name, description: p.meta.description,
      engine: ENGINES.includes(p.meta.engine) ? p.meta.engine : undefined,
      placeholder: p.meta.placeholder, examples: p.examples };
  }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

function personaPrompt(id, kitInstalled, cwd) {
  const p = readPersona(id);
  if (!p) return null;
  try { return systemPrompt(kitInstalled, fs.readFileSync(path.join(PERSONAS, '_base.md'), 'utf8') + '\n\n' + p.prompt, cwd); } catch { return null; }
}

// What the orchestrator is told about the projects connected to this one (see projects.js),
// whose folders it gets with --add-dir. '' when there are none.
function linkedPrompt(linked, kitInstalled, engine = 'claude') {
  if (!linked || !linked.length) return '';
  if (engine === 'codex') return ['', '## Connected projects', '',
    'The user has connected this project to the folders below. Treat them and this project as parts of one larger project: read and search them as the task needs, and follow their `AGENTS.md` and `CLAUDE.md` files.',
    '', ...linked.map((d) => `- \`${path.basename(d)}\`: ${d}`), '',
    '- Relative paths are in this project. Name a connected project when you mean a file there.',
    '- Each folder can be its own git repository, so check and commit them one at a time.',
    '- The sandbox may refuse writes outside this project. If it does, say so and let the user decide; don\'t work around it.'
  ].join('\n') + '\n';
  return ['', '## Connected projects', '',
    'The user has connected this project to the folders below. Treat them and this project as parts of one larger project: read, search and edit them as the task needs, and follow their `CLAUDE.md` files, which are loaded.',
    '', ...linked.map((d) => `- \`${path.basename(d)}\`: ${d}`), '',
    '- Relative paths are in this project. Name a connected project when you mean a file there.',
    '- Each folder can be its own git repository, so check and commit them one at a time.',
    kitInstalled ? '- The team, the jobs and the Codex runner belong to this project. Codex jobs can read the connected folders but write only here, so make changes there yourself or give them to a Claude specialist.' : null
  ].filter((l) => l !== null).join('\n') + '\n';
}

// What the orchestrator is told about the HPC: how to reach it through the connection
// Codeome keeps open (its ssh control socket), and the folder its projects go in
// (Settings → HPC → Agent projects). '' when neither a host nor a folder is set.
function hpcPrompt(hpc, engine = 'claude') {
  const host = String((hpc && hpc.host) || '').trim();
  const root = String((hpc && hpc.agentRoot) || '').trim().replace(/(.)\/+$/, '$1');
  if (!host && !root) return '';
  const out = [];
  if (host) {
    const via = `${ssh.rsyncSshCommand()} -o BatchMode=yes ${host}`;
    out.push('', '## Reaching the HPC', '',
      `Codeome keeps one authenticated connection to the HPC open (an ssh control socket in \`${ssh.CONTROL_PATH}\`). The user has already logged in through it, with their password or one-time code, so you can use it without prompting.`,
      '',
      `- Run commands on the HPC with \`${via} '<command>'\`. Use exactly that host name: the socket is keyed by it.`,
      `- To check the connection: \`ssh -o ControlPath=${ssh.CONTROL_PATH} -O check ${host}\` (it prints "Master running" when it is up).`,
      '- Never say there is no connection to the HPC because a plain `ssh` or a Codex sandbox failed. Try the command above first, and report "not connected" only when `-O check` fails; then ask the user to connect from Codeome\'s HPC tab.',
      '- Keep the `ControlMaster=no` option: it makes ssh use the open connection and never start a login of its own.',
      engine === 'codex'
        ? '- Give this command in every HPC brief. If the sandbox refuses the socket or the network, say so in one line and tell the user that a Claude chat can do the HPC work; don\'t work around the sandbox.'
        : '- Give this command in every HPC brief, and tell the specialist to use it. Codex jobs have no network, so HPC work goes to a Claude role such as the hpc-operator.');
  }
  if (root) {
    out.push('', '## Projects on the HPC', '',
      `Work that you or your team run on the HPC${host ? ` (\`ssh ${host}\`)` : ''} goes in one folder per project under \`${root}/\`, named after the project in lowercase words joined by hyphens.`,
      '',
      '- Before creating a folder, list the ones there and reuse the one this project already has.',
      '- Keep scripts, environments, logs and results inside that folder, and give its path in every HPC brief.',
      '- Use another place only when the user or the project\'s `CLAUDE.md` names one for this project.');
  }
  return out.join('\n') + '\n';
}

// What the orchestrator is told about the user's secrets enabled for this project's agents
// (Settings → Secrets): names only, never values or notes (a note may hold a credential). secrets:
// { list: [{ name, local, hpc }], hpcPath } with local false for one that is on the HPC only; with hpcPath the project's env file on the HPC (shown when any secret is on it). '' when none.
function secretsPrompt(secrets, engine = 'claude') {
  const list = ((secrets && secrets.list) || []).filter((s) => s && typeof s.name === 'string' && s.name);
  if (!list.length) return '';
  const onHpc = list.filter((s) => s.hpc);
  const hpcPath = String((secrets && secrets.hpcPath) || '').trim();
  const out = ['', '## Secrets set for this project', '',
    `These variables are set${engine === 'codex' ? ' (Codex may hide those with KEY, SECRET or TOKEN in the name)' : ''}; their values are never shown to you. Use them by name.`, '',
    ...list.map((s) => `- \`${s.name}\`${s.local === false ? ' (HPC only: not in your local environment)' : s.hpc ? ' (also on the HPC)' : ''}`)];
  if (onHpc.length && hpcPath) out.push('',
    `On the HPC they are in \`${hpcPath}\` (private, in the home folder). Run \`source ${hpcPath}\` in any script or command there that needs them; Codeome's HPC terminals do it already, and \`sbatch\` jobs inherit them.`);
  return out.join('\n') + '\n';
}

// The Codex orchestrator's instructions in full: its own prompt, then the same notes on
// connected projects and the HPC. Codex has no command line to put them on; this is the
// text CodexSession gets as `instructions`.
function codexPrompt({ kitInstalled, linked = [], hpc = null, secrets = null, persona, cwd, policyAtSpawn } = {}) {
  return (personaPrompt(persona, kitInstalled, cwd) || systemPrompt(kitInstalled, fs.readFileSync(PROMPT_CODEX, 'utf8'), cwd)) + linkedPrompt(linked, kitInstalled, 'codex') + hpcPrompt(hpc, 'codex') + secretsPrompt(secrets, 'codex') + projectPolicy.policyPrompt(policyAtSpawn);
}

function forumPrompt(cwd) {
  return systemPrompt(false, fs.readFileSync(PROMPT_FORUM, 'utf8'), cwd);
}

// The configured command's extra words with a value chosen in Settings, which wins
// over the same flag in the command. '' keeps the command as it is.
function withFlag(extra, flag, value) {
  if (!value) return extra;
  const out = [];
  for (let i = 0; i < extra.length; i++) {
    if (extra[i] === flag) { i++; continue; }
    if (extra[i].startsWith(flag + '=')) continue;
    out.push(extra[i]);
  }
  return [...out, flag, value];
}
const withModel = (extra, model) => withFlag(extra, '--model', model);
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// extra: words after the CLI name in the configured command (e.g. --model opus).
// linked: folders of the projects connected to this one. hpc: the HPC settings (host, agentRoot).
// secrets: see secretsPrompt.
function buildArgs({ id, resume, mode, kitInstalled, extra = [], model = '', effort = '', linked = [], hpc = null, secrets = null, settings = '', persona, prompt, cwd, policyAtSpawn }) {
  const args = [...withFlag(withModel(extra, model), '--effort', EFFORTS.includes(effort) ? effort : ''), '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--append-system-prompt', (prompt === undefined ? (personaPrompt(persona, kitInstalled, cwd) || systemPrompt(kitInstalled, undefined, cwd)) + linkedPrompt(linked, kitInstalled) + hpcPrompt(hpc) + secretsPrompt(secrets) : prompt) + projectPolicy.policyPrompt(policyAtSpawn)];
  for (const d of linked) args.push('--add-dir', d);
  const rules = projectPolicy.policySettings(policyAtSpawn);
  if (Object.keys(rules).length) {
    let base = {};
    try {
      if (settings) base = JSON.parse(settings.trimStart().startsWith('{') ? settings : fs.readFileSync(settings, 'utf8'));
      if (!base || typeof base !== 'object' || Array.isArray(base)) base = {};
    } catch { base = {}; }
    const permissions = base.permissions && typeof base.permissions === 'object' && !Array.isArray(base.permissions) ? base.permissions : {};
    settings = JSON.stringify({ ...base, permissions: { ...permissions,
      deny: [...(Array.isArray(permissions.deny) ? permissions.deny : []), ...rules.permissions.deny],
      allow: [...(Array.isArray(permissions.allow) ? permissions.allow : []), ...rules.permissions.allow] } });
  }
  if (settings) args.push('--settings', settings);
  args.push(resume ? '--resume' : '--session-id', id);
  if (mode && mode !== 'default' && MODES.includes(mode)) args.push('--permission-mode', mode);
  return args;
}

// rate_limit_event → the status line's rate_limits shape, which usage.readClaude() reads.
function rateLimits(m) {
  const w = m && m.rate_limit_info && m.rate_limit_info.unifiedWindows;
  if (!w) return null;
  const one = (x) => (x && x.utilization != null ? { used_percentage: Math.round(x.utilization * 1000) / 10, resets_at: x.resetsAt || null } : null);
  const out = {};
  if (one(w.five_hour)) out.five_hour = one(w.five_hour);
  if (one(w.seven_day)) out.seven_day = one(w.seven_day);
  return Object.keys(out).length ? out : null;
}

// Same file and format as codeome-statusline's record().
function recordUsage(dir, rl) {
  const d = path.join(usage.home(), 'usage');
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, `claude-${usage.accountKey(dir)}.json`);
  fs.writeFileSync(p + '.tmp', JSON.stringify({ dir: dir || '', at: Date.now() / 1000, rate_limits: rl }));
  fs.renameSync(p + '.tmp', p);
}

// Codeome's own job runner, as the kit's skills call it: one codeome-agent command,
// optionally with a heredoc brief, and no other shell syntax. Its Bash permission rule
// does not match the heredoc form, so the chat approves these itself. Starting a job past
// the usage limit (--ignore-limits) still asks.
const RUNNER = /^\.codeome\/bin\/codeome-agent\s+(codex|usage|list|show|cancel)(\s|$)/;
function isJobRunner(command) {
  const lines = String(command || '').replace(/\s+$/, '').split('\n');
  let first = lines[0].trim();
  if (!RUNNER.test(first) || /--ignore-limits\b/.test(first)) return false;
  const doc = first.match(/\s<<-?\s*(['"]?)([A-Za-z_]\w*)\1$/);
  if (doc) {
    first = first.slice(0, doc.index);
    // The brief is data; the first line equal to the delimiter must be the last line.
    const end = lines.findIndex((l, i) => i > 0 && (doc[0].includes('<<-') ? l.trim() : l) === doc[2]);
    if (end !== lines.length - 1) return false;
  } else if (lines.length > 1) return false;
  // Quoted arguments may hold anything but expansions; outside quotes, no shell operators.
  const bare = first.replace(/'[^']*'/g, "''").replace(/"([^"\\$`]*)"/g, '""');
  return !/[;&|`$<>()\\'"{}*?!\[\]~]/.test(bare.replace(/''|""/g, ''));
}

// Partial assistant text only; the rest of the stream_event traffic is noise here.
function slim(m, cur) {
  if (m.type !== 'stream_event') return m;
  const e = m.event || {};
  if (e.type === 'message_start') { cur.msg = e.message && e.message.id; return null; }
  if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && !m.parent_tool_use_id) {
    return { type: 'text_delta', msgId: cur.msg, index: e.index, text: e.delta.text };
  }
  return null;
}

class Session extends EventEmitter {
  // shell: a login shell, so the agent's tools see the same PATH as a terminal.
  // autoAllow(request): true for tool requests the host approves without asking.
  // meter: where a resumed conversation's token meter picks up (see stats.Meter).
  constructor({ id, cwd, shell, bin, args, env, autoAllow, meter, policy }) {
    super();
    Object.assign(this, { id, cwd, shell, bin, args, env, autoAllow, policy });
    this.seq = 0; this.waiting = new Map(); this.stderr = ''; this.stream = {};
    this.meter = new Meter(meter);
  }

  start() {
    this.proc = spawn(this.shell, ['-l', '-c', 'exec "$0" "$@"', this.bin, ...this.args], { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line[0] !== '{') continue; // login-shell chatter
        let m; try { m = JSON.parse(line); } catch { continue; }
        this.handle(m);
      }
    });
    this.proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.proc.stdin.on('error', () => {});
    this.proc.on('error', (e) => { this.stderr += String(e.message || e); });
    this.proc.on('close', (code, signal) => {
      for (const w of this.waiting.values()) w({ error: 'The session ended.' });
      this.waiting.clear();
      this.emit('exit', { code, signal, stderr: this.stderr.trim() });
    });
  }

  handle(m) {
    if (m.type === 'control_response') {
      const r = m.response || {};
      const w = this.waiting.get(r.request_id);
      if (w) { this.waiting.delete(r.request_id); w(r.subtype === 'error' ? { error: r.error || 'Request failed' } : r.response || {}); }
      return;
    }
    if (m.type === 'system' && QUIET.has(m.subtype)) return;
    if (m.type === 'rate_limit_event') this.emit('rateLimits', rateLimits(m));
    const u = this.meter.feed(m);
    if (u && u.context) this.emit('message', { type: 'context', ...u.context });
    if (u && u.turn) { this.emit('turn', u.turn); this.emit('message', { type: 'turn_usage', ...u.turn }); }
    const r = m.type === 'control_request' && m.request;
    if (r && r.subtype === 'can_use_tool' && this.policy) {
      const decision = projectPolicy.decide(this.policy(), { tool_name: r.tool_name, input: r.input, cwd: this.cwd });
      if (decision) return this.respond(m.request_id, decision.behavior === 'allow' ? { ...decision, updatedInput: r.input } : decision);
    }
    if (r && r.subtype === 'can_use_tool' && this.autoAllow && this.autoAllow(r)) return this.respond(m.request_id, { behavior: 'allow', updatedInput: r.input });
    const out = slim(m, this.stream);
    if (out) this.emit('message', out);
  }

  write(o) { if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(o) + '\n'); }
  user(text) { this.write({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }); }
  respond(requestId, response) { this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }); }

  // A control request of ours (interrupt, set_permission_mode); resolves with the reply.
  control(request, timeoutMs = 15000) {
    const rid = 'codeome-' + (++this.seq);
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.waiting.delete(rid); resolve({ error: 'No answer from Claude Code.' }); }, timeoutMs);
      this.waiting.set(rid, (r) => { clearTimeout(t); resolve(r); });
      this.write({ type: 'control_request', request_id: rid, request });
    });
  }

  stop() { if (this.proc && this.proc.exitCode === null) { try { this.proc.stdin.end(); } catch {} try { this.proc.kill('SIGTERM'); } catch {} } }
}

// ---------- saved conversations ----------
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || 'project';
const chatsDir = (project) => path.join(usage.home(), 'chats',
  safeName(path.basename(project)) + '-' + crypto.createHash('sha1').update(path.resolve(project)).digest('hex').slice(0, 10));
const validId = (id) => /^[0-9a-f-]{36}$/.test(id || '');

function saveChat(project, chat) {
  if (!project || !chat || !validId(chat.id)) return { error: 'Bad chat' };
  const d = chatsDir(project);
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, chat.id + '.json');
  fs.writeFileSync(p + '.tmp', JSON.stringify({ ...chat, project, updatedAt: Date.now() }));
  fs.renameSync(p + '.tmp', p);
  return { ok: true };
}

function listChats(project) {
  let names; try { names = fs.readdirSync(chatsDir(project)); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(chatsDir(project), n), 'utf8'));
      out.push({ id: c.id, title: c.title || 'Untitled chat', account: c.accountName || c.account, engine: engineOf(c.engine), role: c.role || '', started: !!c.started, updatedAt: c.updatedAt || 0,
        messages: (c.items || []).filter((x) => x.t === 'user').length });
    } catch {}
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function loadChat(project, id) {
  if (!validId(id)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(chatsDir(project), id + '.json'), 'utf8')); } catch { return null; }
}

function deleteChat(project, id) {
  if (!validId(id)) return { error: 'Bad chat' };
  try { fs.unlinkSync(path.join(chatsDir(project), id + '.json')); } catch {}
  return { ok: true };
}

function moveChat(id, from, to, changes = {}) {
  to = scratch.checkMove(from, to);
  if (!validId(id)) throw new Error('Bad chat');
  const record = loadChat(from, id);
  if (!record || record.id !== id || record.project !== from) throw new Error('Chat not found.');
  const source = path.join(chatsDir(from), id + '.json');
  const target = path.join(chatsDir(to), id + '.json');
  if (fs.existsSync(target)) throw new Error('Chat already exists in the target project.');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(target + '.tmp', JSON.stringify({ ...record, ...changes, project: to }));
    fs.renameSync(target + '.tmp', target);
    try { fs.unlinkSync(source); } catch (error) { fs.unlinkSync(target); throw error; }
  } finally { try { fs.unlinkSync(target + '.tmp'); } catch {} }
  return { ok: true };
}

// Claude Code keeps a conversation in its account's config folder: projects/<project folder>/<id>.jsonl, with the
// files of its subagents in <id>/ beside it. Copying both into another account's folder lets that account resume it.
function sessionFolder(accountDir, id) {
  const root = path.join(accountDir, 'projects');
  try { return fs.readdirSync(root).find((d) => fs.existsSync(path.join(root, d, id + '.jsonl'))) || null; }
  catch { return null; }
}

function moveSession(fromDir, toDir, id) {
  if (!validId(id)) throw new Error('Bad chat');
  const root = path.join(fromDir, 'projects');
  const folder = sessionFolder(fromDir, id);
  if (!folder) throw new Error('This conversation has no transcript in its account folder.');
  const dest = path.join(toDir, 'projects', folder);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(root, folder, id + '.jsonl'), path.join(dest, id + '.jsonl'));
  if (fs.existsSync(path.join(root, folder, id))) fs.cpSync(path.join(root, folder, id), path.join(dest, id), { recursive: true });
}

// Claude Code keys its project folder on cwd. Copy a started session so --resume works after promotion.
function copyProjectSession(accountDir, id, from, to) {
  if (!validId(id)) throw new Error('Bad chat');
  const keyed = (project) => {
    let real; try { real = fs.realpathSync(project); } catch { real = path.resolve(project); }
    return real.replace(/[^A-Za-z0-9]/g, '-');
  };
  const expected = keyed(from);
  const root = path.join(accountDir, 'projects');
  const source = path.join(root, expected);
  const dest = path.join(root, keyed(to));
  const transcript = path.join(source, id + '.jsonl');
  if (!fs.existsSync(transcript)) return { missing: true, created: [] };
  const destTranscript = path.join(dest, id + '.jsonl');
  const destAgents = path.join(dest, id);
  if (fs.existsSync(destTranscript) && fs.statSync(destTranscript).size !== fs.statSync(transcript).size)
    throw new Error('Session already exists in the target project.');
  fs.mkdirSync(dest, { recursive: true });
  const agents = path.join(source, id);
  const temp = destTranscript + '.tmp-' + crypto.randomUUID();
  const created = [];
  try {
    if (fs.existsSync(agents) && !fs.existsSync(destAgents)) {
      created.push(destAgents);
      fs.cpSync(agents, destAgents, { recursive: true });
    }
    if (!fs.existsSync(destTranscript)) {
      fs.copyFileSync(transcript, temp);
      fs.renameSync(temp, destTranscript);
      created.push(destTranscript);
    }
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    for (const p of created.reverse()) try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
    throw error;
  }
  return { missing: false, created };
}

module.exports = { Session, ENGINES, engineOf, systemPrompt, listPersonas, personaPrompt, codexPrompt, forumPrompt, linkedPrompt, hpcPrompt, secretsPrompt, buildArgs, withModel, withFlag, rateLimits, recordUsage, slim, isJobRunner, saveChat, listChats, loadChat, deleteChat, moveChat, moveSession, copyProjectSession, MODES };
