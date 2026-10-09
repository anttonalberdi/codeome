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
//
// Conversations are saved (as the chat panel shows them) in ~/.codeome/chats/<project>/.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const usage = require('./usage');

const PROMPT = path.join(__dirname, '..', 'kit', 'chat.md');
const MODES = ['default', 'acceptEdits', 'auto', 'plan'];
// System messages the panel has no use for.
const QUIET = new Set(['hook_started', 'hook_response', 'hook_progress', 'thinking_tokens', 'status']);

// The orchestrator's instructions, with the part for projects with or without the kit.
function systemPrompt(kitInstalled, text = fs.readFileSync(PROMPT, 'utf8')) {
  return text
    .replace(/<!-- if kit -->([\s\S]*?)<!-- else -->([\s\S]*?)<!-- end -->/g, (_m, yes, no) => (kitInstalled ? yes : no))
    .replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// extra: words after the CLI name in the configured command (e.g. --model opus).
function buildArgs({ id, resume, mode, kitInstalled, extra = [] }) {
  const args = [...extra, '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--append-system-prompt', systemPrompt(kitInstalled)];
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
  constructor({ id, cwd, shell, bin, args, env, autoAllow }) {
    super();
    Object.assign(this, { id, cwd, shell, bin, args, env, autoAllow });
    this.seq = 0; this.waiting = new Map(); this.stderr = ''; this.stream = {};
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
    const r = m.type === 'control_request' && m.request;
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
      out.push({ id: c.id, title: c.title || 'Untitled chat', account: c.account, started: !!c.started, updatedAt: c.updatedAt || 0 });
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

module.exports = { Session, systemPrompt, buildArgs, rateLimits, recordUsage, slim, isJobRunner, saveChat, listChats, loadChat, deleteChat, MODES };
