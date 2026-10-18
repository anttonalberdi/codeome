// The agent chat on Codex: one `codex app-server` process per conversation, driven over its
// JSON-RPC protocol (one JSON object per line on stdin/stdout, no "jsonrpc" field). It plays
// the part of chat.Session, so the chat panel needs no changes: what Codex reports is turned
// into the stream-json messages Claude Code would have sent. Plain Node (no Electron).
//
//   out: initialize, initialized, thread/start | thread/resume, turn/start, turn/interrupt,
//        account/rateLimits/read
//   in:  turn/started, item/started|completed (agentMessage, commandExecution, fileChange,
//        mcpToolCall, webSearch, ...), item/agentMessage/delta, thread/tokenUsage/updated,
//        account/rateLimits/updated, turn/completed, error
//   in (requests we answer): item/commandExecution/requestApproval, item/fileChange/requestApproval,
//        item/permissions/requestApproval, item/tool/requestUserInput, mcpServer/elicitation/request
//   Codex                          → the panel
//   turn/started                   → system/init {session_id: thread id, model}
//   agentMessage (+ deltas)        → assistant text (+ text_delta)
//   commandExecution               → tool_use Bash {command}, then a tool_result
//   fileChange                     → tool_use Edit/Write {file_path} per file, then tool_results
//   mcpToolCall, webSearch, ...    → tool_use named after the tool, then a tool_result
//   *Approval, requestUserInput    → control_request can_use_tool (AskUserQuestion for questions)
//   turn/completed                 → result;  tokenUsage → the session's Meter (stats.js)
//
// Codex keeps its own thread ids, so the chat's id is mapped to the thread's in
// ~/.codeome/codex-threads/<id>.json, which is how a resumed chat finds its thread again.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const usage = require('./usage');
const { Meter } = require('./stats');
const projectPolicy = require('./policy');

// Claude Code's permission modes, as the nearest Codex approval and sandbox policy.
const POLICIES = {
  default: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
  acceptEdits: { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
  auto: { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review' },
  plan: { approvalPolicy: 'on-request', sandbox: 'read-only' }
};
const SANDBOX = { 'workspace-write': 'workspaceWrite', 'read-only': 'readOnly', 'danger-full-access': 'dangerFullAccess' };

const threadFile = (id) => path.join(usage.home(), 'codex-threads', String(id).replace(/[^A-Za-z0-9._-]/g, '_') + '.json');
function savedThread(id) { try { return JSON.parse(fs.readFileSync(threadFile(id), 'utf8')).threadId || null; } catch { return null; } }
function saveThread(id, threadId) {
  try {
    fs.mkdirSync(path.dirname(threadFile(id)), { recursive: true });
    fs.writeFileSync(threadFile(id), JSON.stringify({ threadId, at: Date.now() }));
  } catch {}
}

// Codex runs commands as `/bin/zsh -lc '<command>'`; the panel and autoAllow want the command.
function bare(command) {
  const m = String(command || '').match(/^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+([\s\S]+)$/);
  if (!m) return String(command || '');
  const s = m[1].trim();
  if (s.length > 1 && s[0] === "'" && s.endsWith("'")) return s.slice(1, -1).replace(/'\\''/g, "'");
  if (s.length > 1 && s[0] === '"' && s.endsWith('"')) return s.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  return s;
}

// account/rateLimits snapshot → the status line's rate_limits shape (see chat.rateLimits).
function rateLimits(snap) {
  if (!snap) return null;
  const out = {};
  const one = (w) => (w && w.usedPercent != null ? { used_percentage: w.usedPercent, resets_at: w.resetsAt || null } : null);
  for (const [i, w] of [snap.primary, snap.secondary].entries()) {
    const r = one(w);
    if (!r) continue;
    const mins = w.windowDurationMins;
    const key = mins ? (mins <= 360 ? 'five_hour' : 'seven_day') : i === 0 ? 'five_hour' : 'seven_day';
    if (!out[key]) out[key] = r;
  }
  return Object.keys(out).length ? out : null;
}

const text = (s) => (typeof s === 'string' ? s : s == null ? '' : JSON.stringify(s));
function mcpText(r) {
  if (!r) return '';
  const c = Array.isArray(r.content) ? r.content.map((x) => (x && x.type === 'text' ? x.text : text(x))).join('\n') : '';
  return c || (r.structuredContent != null ? JSON.stringify(r.structuredContent) : '');
}

class CodexSession extends EventEmitter {
  // Same as chat.Session; args are options for codex placed before `app-server` (e.g. -c key=value).
  // Also: instructions (developer instructions, set when the thread starts), resume (true: the
  // thread this chat id had; or a thread id), threadId, model, effort, mode (a Claude permission
  // mode), addDirs (more folders the agent may write in).
  constructor({ id, cwd, shell, bin, args = [], env, autoAllow, meter, instructions = '', resume = false, threadId = null, model = '', effort = '', mode = 'default', addDirs = [], policy }) {
    super();
    Object.assign(this, { id, cwd, shell, bin, args, env, autoAllow, instructions, model, effort, addDirs, projectPolicy: policy });
    this.resume = resume;
    this.threadId = threadId || (typeof resume === 'string' ? resume : null);
    this.mode = POLICIES[mode] ? mode : 'default';
    this.policy = POLICIES[mode] || POLICIES.default;
    this.meter = new Meter(meter);
    this.stderr = ''; this.seq = 0; this.calls = new Map(); this.asked = new Map(); this.items = new Map();
    this.queue = []; this.ready = false; this.turnId = null; this.active = false; this.ended = false;
    this.fail = null; this.tally = { input: 0, output: 0, cached: 0 }; this.total = null; this.window = 0; this.model_ = model || null;
  }

  start() {
    this.proc = spawn(this.shell, ['-l', '-c', 'exec "$0" "$@"', this.bin, ...this.args, 'app-server'], { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line[0] !== '{') continue; // login-shell chatter
        let m; try { m = JSON.parse(line); } catch { continue; }
        try { this.incoming(m); } catch (e) { this.stderr += '\n' + (e && e.stack || e); }
      }
    });
    this.proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    this.proc.stdin.on('error', () => {});
    this.proc.on('error', (e) => { this.stderr += String(e.message || e); });
    this.proc.on('close', (code, signal) => {
      this.ended = true;
      for (const w of this.calls.values()) w({ error: { message: 'The session ended.' } });
      this.calls.clear();
      this.emit('exit', { code, signal, stderr: this.stderr.trim() });
    });
    this.boot().catch((e) => { this.stderr += '\n' + (e && e.message || e); this.stop(); });
  }

  // ---------- JSON-RPC ----------
  write(o) { if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(o) + '\n'); }
  call(method, params, timeoutMs = 0) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      let t = null;
      if (timeoutMs) t = setTimeout(() => { this.calls.delete(id); reject(new Error(`No answer from Codex to ${method}.`)); }, timeoutMs);
      this.calls.set(id, (m) => { clearTimeout(t); m.error ? reject(new Error(m.error.message || 'Request failed')) : resolve(m.result || {}); });
      this.write({ method, id, params });
    });
  }

  async boot() {
    await this.call('initialize', { clientInfo: { name: 'codeome', title: 'Codeome', version: '1' }, capabilities: { experimentalApi: true } }, 60000);
    this.write({ method: 'initialized' });
    const base = { cwd: this.cwd, developerInstructions: this.instructions || null, model: this.model || null, ...this.policy };
    let res = null;
    const wanted = this.threadId || (this.resume === true ? savedThread(this.id) : null);
    if (wanted) {
      try { res = await this.call('thread/resume', { ...base, threadId: wanted }, 60000); } catch (e) { this.stderr += `\nCould not resume thread ${wanted}: ${e.message}`; }
    }
    if (!res) res = await this.call('thread/start', base, 60000);
    const t = res.thread || {};
    this.threadId = t.id || wanted;
    this.model_ = res.model || t.model || this.model_;
    saveThread(this.id, this.threadId);
    this.ready = true;
    this.call('account/rateLimits/read', {}, 20000).then((r) => { const rl = rateLimits(r.rateLimits); if (rl) this.emit('rateLimits', rl); }).catch(() => {});
    this.pump();
  }

  incoming(m) {
    if (m.id !== undefined && m.method) return this.serverRequest(m);
    if (m.id !== undefined) { const w = this.calls.get(m.id); if (w) { this.calls.delete(m.id); w(m); } return; }
    if (m.method) this.notification(m.method, m.params || {});
  }

  // ---------- turns ----------
  user(content) {
    this.queue.push(content);
    this.pump();
  }

  pump() {
    if (!this.ready || this.active || !this.queue.length || this.ended) return;
    const t = this.queue.shift();
    const p = this.policy;
    const sb = SANDBOX[p.sandbox];
    const params = {
      threadId: this.threadId, input: [{ type: 'text', text: t, text_elements: [] }], approvalPolicy: p.approvalPolicy,
      sandboxPolicy: sb === 'workspaceWrite' ? { type: sb, ...(this.addDirs.length ? { writableRoots: [this.cwd, ...this.addDirs] } : {}) } : { type: sb },
      ...(p.approvalsReviewer ? { approvalsReviewer: p.approvalsReviewer } : {}),
      ...(this.model ? { model: this.model } : {}), ...(this.effort ? { effort: this.effort } : {})
    };
    this.active = true; this.fail = null; this.tally = { input: 0, output: 0, cached: 0 };
    this.call('turn/start', params, 60000).then((r) => { if (r.turn && r.turn.id && !this.turnId) this.turnId = r.turn.id; }).catch((e) => {
      this.finish({ status: 'failed', error: { message: e.message } });
    });
  }

  finish(turn) {
    const failed = turn.status === 'failed';
    const msg = (turn.error && turn.error.message) || (this.fail && this.fail.message) || '';
    this.active = false; this.turnId = null;
    const mu = this.total ? { [this.model_ || 'codex']: {
      inputTokens: Math.max(0, this.total.inputTokens - this.total.cachedInputTokens - (this.total.cacheWriteInputTokens || 0)), outputTokens: this.total.outputTokens,
      cacheReadInputTokens: this.total.cachedInputTokens, cacheCreationInputTokens: this.total.cacheWriteInputTokens || 0, contextWindow: this.window } } : undefined;
    this.handle({
      type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed, result: failed ? msg || 'The turn failed.' : '',
      ...(turn.status === 'interrupted' ? { interrupted: true } : {}),
      session_id: this.threadId, duration_ms: turn.durationMs || 0, modelUsage: mu,
      usage: { input_tokens: Math.max(0, this.tally.input - this.tally.cached), output_tokens: this.tally.output, cache_read_input_tokens: this.tally.cached }
    });
    this.items.clear();
    this.pump();
  }

  // ---------- notifications ----------
  notification(method, p) {
    switch (method) {
      case 'turn/started':
        this.turnId = (p.turn && p.turn.id) || this.turnId; this.active = true;
        this.handle({ type: 'system', subtype: 'init', session_id: this.threadId, model: this.model_ });
        break;
      case 'turn/completed': this.finish(p.turn || {}); break;
      case 'error':
        if (p.willRetry) break;
        this.fail = p.error || { message: 'Codex reported an error.' };
        break;
      case 'item/agentMessage/delta':
        this.emit('message', { type: 'text_delta', msgId: p.itemId, index: 0, text: p.delta || '' });
        break;
      case 'item/started': this.item(p.item, false); break;
      case 'item/completed': this.item(p.item, true); break;
      case 'thread/compacted': this.handle({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: this.meter.context } }); break;
      case 'thread/tokenUsage/updated': this.tokens(p.tokenUsage); break;
      case 'account/rateLimits/updated': { const rl = rateLimits(p.rateLimits); if (rl) this.emit('rateLimits', rl); break; }
      case 'serverRequest/resolved': {
        const k = 'codex-' + p.requestId;
        if (this.asked.delete(k)) this.emit('message', { type: 'control_cancel_request', request_id: k });
        break;
      }
    }
  }

  tokens(u) {
    if (!u) return;
    const last = u.last || {};
    if (u.total) this.total = u.total;
    if (u.modelContextWindow) { this.window = u.modelContextWindow; this.meter.window = u.modelContextWindow; }
    this.tally.input += last.inputTokens || 0; this.tally.output += last.outputTokens || 0; this.tally.cached += last.cachedInputTokens || 0;
    // What the last request held: the meter reads this the way it reads a Claude reply's usage.
    const c = this.meter.feed({ type: 'assistant', message: { content: [], usage: {
      input_tokens: Math.max(0, (last.inputTokens || 0) - (last.cachedInputTokens || 0)), cache_read_input_tokens: last.cachedInputTokens || 0, output_tokens: last.outputTokens || 0 } } });
    if (c && c.context) this.emit('message', { type: 'context', ...c.context });
  }

  // The tool a Codex item stands for: [name, input], or null for items the panel has no use for.
  toolOf(it) {
    switch (it.type) {
      case 'commandExecution': return [{ name: 'Bash', input: { command: bare(it.command) } }];
      case 'fileChange': return (it.changes || []).map((c, i) => ({ id: `${it.id}:${i}`, name: c.kind && c.kind.type === 'add' ? 'Write' : 'Edit', input: { file_path: c.path } }));
      case 'mcpToolCall': return [{ name: it.tool, input: it.arguments && typeof it.arguments === 'object' ? it.arguments : {} }];
      case 'dynamicToolCall': return [{ name: it.tool, input: it.arguments && typeof it.arguments === 'object' ? it.arguments : {} }];
      case 'webSearch': return [{ name: 'WebSearch', input: { query: it.query || '' } }];
      case 'imageView': return [{ name: 'Read', input: { file_path: text(it.path) } }];
      default: return null;
    }
  }

  resultOf(it) {
    const done = it.status !== 'inProgress';
    switch (it.type) {
      case 'commandExecution': {
        if (it.status === 'declined') return { content: 'The user declined to run this command.', is_error: true };
        const out = text(it.aggregatedOutput);
        const bad = it.status === 'failed' || (it.exitCode != null && it.exitCode !== 0);
        return { content: bad && it.exitCode != null ? `${out}${out && !out.endsWith('\n') ? '\n' : ''}Exit code ${it.exitCode}` : out, is_error: bad };
      }
      case 'fileChange': return it.status === 'declined' || it.status === 'failed'
        ? { content: it.status === 'declined' ? 'The user declined these changes.' : 'The changes could not be applied.', is_error: true }
        : { content: 'Applied.', is_error: false };
      case 'mcpToolCall': return it.status === 'failed' || it.error
        ? { content: text(it.error && (it.error.message || it.error)) || mcpText(it.result) || 'The tool call failed.', is_error: true }
        : { content: mcpText(it.result), is_error: false };
      case 'dynamicToolCall': return { content: (it.contentItems || []).map((x) => x.text || '').join('\n'), is_error: it.success === false };
      case 'webSearch': return { content: (it.results || []).map((r) => text(r)).join('\n'), is_error: false };
      default: return { content: '', is_error: !done };
    }
  }

  item(it, complete) {
    if (!it || !it.id) return;
    if (it.type === 'agentMessage') {
      if (complete && it.text) this.handle({ type: 'assistant', message: { id: it.id, role: 'assistant', content: [{ type: 'text', text: it.text }] } });
      return;
    }
    if (it.type === 'plan') {
      if (complete && it.text) this.handle({ type: 'assistant', message: { id: it.id, role: 'assistant', content: [{ type: 'text', text: it.text }] } });
      return;
    }
    if (it.type === 'contextCompaction') return;
    const tools = this.toolOf(it);
    if (!tools) return;
    let st = this.items.get(it.id);
    if (!st) {
      st = { tools: tools.map((t, i) => ({ id: t.id || it.id, ...t })), done: false };
      this.items.set(it.id, st);
      // One assistant message per tool call, as Claude Code sends them.
      for (const t of st.tools) this.handle({ type: 'assistant', message: { id: 'codex-' + t.id, role: 'assistant', content: [{ type: 'tool_use', id: t.id, name: t.name, input: t.input }] } });
    }
    if (!complete || st.done) return;
    st.done = true;
    const r = this.resultOf(it);
    for (const t of st.tools) this.handle({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: t.id, content: r.content, is_error: r.is_error }] } });
  }

  // ---------- approvals and questions (requests from Codex) ----------
  serverRequest(m) {
    const p = m.params || {};
    const key = 'codex-' + m.id;
    const reply = (result) => this.write({ id: m.id, result });
    const ask = (kind, request, extra = {}) => {
      this.asked.set(key, { rpc: m.id, kind, params: p, ...extra });
      // Auto mode is Claude's "approve without asking": Codex's own reviewer still escalates some
      // requests to the client, so the host allows commands, edits and access requests here.
      if (this.mode === 'auto' && (kind === 'command' || kind === 'file' || kind === 'permissions')) {
        const decision = this.projectPolicy && projectPolicy.decide(this.projectPolicy(), { tool_name: request.tool_name, input: request.input, cwd: this.cwd });
        return this.respond(key, decision || { behavior: 'allow', updatedInput: request.input });
      }
      this.handle({ type: 'control_request', request_id: key, request: { subtype: 'can_use_tool', tool_use_id: p.itemId, ...request } });
    };
    switch (m.method) {
      case 'item/commandExecution/requestApproval':
        return ask('command', { tool_name: 'Bash', input: { command: bare(p.command), ...(p.reason ? { description: p.reason } : {}) }, decision_reason: p.reason || undefined,
          permission_suggestions: [{ type: 'session' }] });
      case 'item/fileChange/requestApproval': {
        const st = this.items.get(p.itemId);
        const t = st && st.tools[0];
        const files = st ? st.tools.map((x) => x.input.file_path) : [];
        return ask('file', { tool_name: t ? t.name : 'Edit', input: { file_path: files.join(', ') || p.grantRoot || '', files, grantRoot: p.grantRoot }, decision_reason: p.reason || undefined, permission_suggestions: [{ type: 'session' }] });
      }
      case 'item/permissions/requestApproval':
        return ask('permissions', { tool_name: 'Permissions', input: { description: p.reason || 'Codex asks for more access.' }, decision_reason: p.reason || undefined });
      case 'mcpServer/elicitation/request':
        return ask('elicitation', { tool_name: 'mcp__' + (p.serverName || 'server'), input: { description: p.message || '' } });
      case 'item/tool/requestUserInput': {
        const qs = p.questions || [];
        return ask('question', { tool_name: 'AskUserQuestion', input: { questions: qs.map((q) => ({ question: q.question, header: q.header, multiSelect: false,
          options: (q.options || []).map((o) => ({ label: o.label, description: o.description })) })) } }, { questions: qs });
      }
      case 'item/tool/call': return reply({ contentItems: [{ type: 'inputText', text: 'This client has no dynamic tools.' }], success: false });
      default: this.write({ id: m.id, error: { code: -32601, message: 'Not supported by Codeome: ' + m.method } });
    }
  }

  // The panel's answer to a can_use_tool request.
  respond(requestId, response = {}) {
    const a = this.asked.get(requestId);
    if (!a) return;
    this.asked.delete(requestId);
    const allow = response.behavior === 'allow';
    const always = allow && Array.isArray(response.updatedPermissions) && response.updatedPermissions.length > 0;
    let result;
    switch (a.kind) {
      case 'command': case 'file': result = { decision: allow ? (always ? 'acceptForSession' : 'accept') : 'decline' }; break;
      case 'permissions': result = allow ? { permissions: a.params.permissions || {}, scope: always ? 'session' : 'turn' } : { permissions: {} }; break;
      case 'elicitation': result = { action: allow ? 'accept' : 'decline', content: null }; break;
      case 'question': {
        const said = (response.updatedInput && response.updatedInput.answers) || {};
        if (!allow) { result = { answers: {} }; break; }
        result = { answers: Object.fromEntries(a.questions.map((q) => [q.id, { answers: [text(said[q.question])].filter(Boolean) }])) };
        break;
      }
    }
    this.write({ id: a.rpc, result });
  }

  // Our own control requests: interrupt, set_permission_mode (applies from the next turn).
  async control(request = {}, timeoutMs = 15000) {
    if (request.subtype === 'interrupt') {
      if (this.queue.length) this.queue = [];
      if (!this.active || !this.threadId) return {};
      try { await this.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }, timeoutMs); return {}; } catch (e) { return { error: e.message }; }
    }
    if (request.subtype === 'set_permission_mode') {
      const p = POLICIES[request.mode];
      if (!p) return { error: `Codex has no equivalent of the permission mode "${request.mode}".` };
      this.policy = p;
      this.mode = request.mode;
      return {};
    }
    return { error: `Codex chats do not support ${request.subtype || 'this request'}.` };
  }

  // Every message that goes to the panel passes here, as in chat.Session.handle.
  handle(m) {
    const u = this.meter.feed(m);
    if (u && u.context) this.emit('message', { type: 'context', ...u.context });
    if (u && u.turn) { this.emit('turn', u.turn); this.emit('message', { type: 'turn_usage', ...u.turn }); }
    const r = m.type === 'control_request' && m.request;
    if (r && r.subtype === 'can_use_tool' && this.projectPolicy) {
      const decision = projectPolicy.decide(this.projectPolicy(), { tool_name: r.tool_name, input: r.input, cwd: this.cwd });
      if (decision) return this.respond(m.request_id, decision.behavior === 'allow' ? { ...decision, updatedInput: r.input } : decision);
    }
    if (r && r.subtype === 'can_use_tool' && this.autoAllow && this.autoAllow(r)) return this.respond(m.request_id, { behavior: 'allow', updatedInput: r.input });
    this.emit('message', m);
  }

  stop() { if (this.proc && this.proc.exitCode === null) { try { this.proc.stdin.end(); } catch {} try { this.proc.kill('SIGTERM'); } catch {} } }
}

module.exports = { CodexSession, POLICIES, bare, rateLimits, savedThread };
