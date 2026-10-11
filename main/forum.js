// A moderated forum coordinates several existing Claude and Codex chat sessions.
// Each seat keeps a session for spoken turns, while short one-shot calls decide
// whether it has something new to say and compress older transcript messages.
// The user owns the floor: raised hands wait unless the forum has an auto budget.
// Only one spoken or write turn runs at once; approved turns wait in a FIFO queue.
// Ordinary turns run in plan mode, and a writer receives edit permission only for
// its approved turn before returning to plan mode.
// Sessions share the stream-json message, result, turn, and exit event surface.
// Partial text is forwarded as a delta; only final assistant text is persisted.
// Check calls can be cancelled whenever the discussion moves to a new message.
// Snapshots contain only JSON data; live sessions and checks are recreated later.
// Document attachments are loaded synchronously from paths chosen by the moderator.
// Snapshots keep document identity, then reload local text when restored.
// No Electron state or disk persistence is needed by this coordinator.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { oneShot } = require('./oneshot');

const DEFAULTS = { defaultBudget: 0, summaryTokens: 6000, recentMessages: 8, checkTimeoutMs: 30000 };
const MAX_DOC_BYTES = 200000;
const MAX_POINTER_BYTES = 65536;
const MAX_PROMPT = 60000;
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const emptyUsage = () => ({ turns: 0, input: 0, output: 0, cacheRead: 0, costUsd: 0, checks: 0, checkTokens: 0 });
const num = (value) => Number(value) || 0;
const confirmedMode = (result) => { if (!result || result.error) throw new Error(String(result?.error || 'Permission mode was not confirmed.')); };
const controlResult = (session, request) => { try { return Promise.resolve(session.control(request)); } catch (error) { return Promise.reject(error); } };

function documentFile(file, kind) {
  const real = fs.realpathSync(file);
  const ext = path.extname(real).toLowerCase();
  if (kind === 'gdoc' ? ext !== '.gdoc' : !['.md', '.markdown', '.txt'].includes(ext)) throw new Error('Unsupported document type');
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new Error('Document must be a regular file.');
  if (stat.size > (kind === 'gdoc' ? MAX_POINTER_BYTES : MAX_DOC_BYTES))
    throw new Error(kind === 'gdoc' ? 'Google Doc pointer exceeds 65,536 bytes.' : 'Document exceeds 200,000 bytes.');
  return { real, stat };
}

function promptMessages(items, limit = MAX_PROMPT - 10000) {
  const lines = [];
  let size = 0;
  for (const item of [...items].reverse()) {
    const line = `${item.name}: ${String(item.text || '').slice(0, 4000)}`;
    if (size + line.length > limit) break;
    lines.unshift(line); size += line.length + 1;
  }
  return lines.join('\n');
}

function parseRaise(text) {
  let line = String(text || '').split(/\r?\n/).find((part) => part.trim()) || '';
  line = line.trim().replace(/^[\s>*#_`"'~-]+|[\s*_`"']+$/g, '').trim();
  if (/^pass[.!]?$/i.test(line)) return { raise: false };
  const match = line.match(/^raise(?:\s*[:\-]\s*|\s+)(.+)$/i);
  if (!match) return { raise: false };
  const reason = match[1].trim().replace(/^[`"']+|[`"']+$/g, '').trim().slice(0, 200);
  return reason ? { raise: true, reason } : { raise: false };
}

class Forum extends EventEmitter {
  constructor({ id, project, title, seats = [], makeSession, check, settings = {}, now = Date.now }) {
    super();
    this.id = id; this.project = project; this.title = title;
    this.seats = seats.map((seat) => ({ ...seat, muted: !!seat.muted, seenUpTo: seat.seenUpTo || 0 }));
    this.makeSession = makeSession;
    this.settings = { ...DEFAULTS, ...settings };
    this.now = now;
    this.check = check || ((seat, prompt, signal) => oneShot(seat.engine, {
      prompt, signal, bin: seat.bin, dir: seat.dir || (seat.account && seat.account.dir),
      model: seat.model, effort: seat.effort, timeoutMs: this.settings.checkTimeoutMs
    }));
    this.transcript = []; this.summary = ''; this.summarizedUpTo = null; this.doc = null;
    this.hands = []; this.queue = []; this.sessions = new Map(); this.blocked = new Map(); this.controllers = new Set();
    this.active = null; this.round = 0; this.sequence = 0; this.disposed = false;
    this.budgetLimit = Math.max(0, num(this.settings.defaultBudget));
    this.budget = this.budgetLimit;
    this.totals = Object.fromEntries(this.seats.map((seat) => [seat.id, emptyUsage()]));
  }

  emitEvent(type, fields = {}) { this.emit('event', { type, ...fields }); }
  seat(id) { return this.seats.find((seat) => seat.id === id); }
  seatState(seat, state) { this.emitEvent('seat', { seatId: seat.id, state: seat.muted ? 'muted' : state }); }
  next(prefix) { return `${prefix}${++this.sequence}`; }
  add(speaker, kind, text, draft = null) {
    const item = { id: draft ? draft.id : this.next('m'), at: draft ? draft.at : this.now(), speaker, kind, text: String(text || '') };
    this.transcript.push(item);
    this.emitEvent('message', { item });
    return item;
  }
  removeHands() {
    for (const hand of this.hands.splice(0)) this.emitEvent('hand-removed', { handId: hand.id, hand });
  }
  abortChecks() {
    this.round++;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
  setDoc(doc) { this.doc = doc ? { ...doc } : null; return this.doc; }
  docEvent(fields = {}) {
    const doc = this.doc && { ...this.doc };
    if (doc && doc.text !== undefined) { doc.textHead = String(doc.text).slice(0, 1500); delete doc.text; }
    this.emitEvent('doc', { doc, ...fields });
  }
  // Synchronous: the selected path is resolved and validated before replacing the attachment.
  attachDoc(file) {
    const ext = path.extname(file).toLowerCase();
    if (!['.md', '.markdown', '.txt', '.gdoc'].includes(ext)) throw new Error('Unsupported document type');
    const { real, stat } = documentFile(file, ext === '.gdoc' ? 'gdoc' : 'md');
    let doc;
    if (ext === '.gdoc') {
      let pointer;
      try { pointer = JSON.parse(fs.readFileSync(real, 'utf8')); }
      catch { throw new Error('Could not read Google Doc pointer.'); }
      const docId = String(pointer.doc_id || '');
      if (!/^[\w-]{1,200}$/.test(docId)) throw new Error('Google Doc pointer holds no document id.');
      doc = { kind: 'gdoc', path: real, docId };
    } else {
      doc = { kind: 'md', path: real, text: fs.readFileSync(real, 'utf8'), mtimeMs: stat.mtimeMs };
    }
    this.setDoc(doc);
    this.docEvent();
    return this.doc;
  }
  detachDoc() { this.setDoc(null); this.docEvent(); return null; }
  refreshDoc(emit = true) {
    if (!this.doc) return this.doc;
    if (this.doc.kind === 'gdoc') {
      try {
        const { real } = documentFile(this.doc.path, 'gdoc');
        const pointer = JSON.parse(fs.readFileSync(real, 'utf8'));
        if (pointer.doc_id !== this.doc.docId) throw new Error('Google Doc pointer changed.');
      } catch (error) {
        this.emitEvent('error', { error: `Could not refresh document: ${error.message || error}` });
        this.setDoc(null);
        if (emit) this.docEvent();
      }
      return this.doc;
    }
    try {
      const { real, stat } = documentFile(this.doc.path, 'md');
      if (this.doc.text !== undefined && stat.mtimeMs === this.doc.mtimeMs) return this.doc;
      this.doc = { ...this.doc, path: real, text: fs.readFileSync(real, 'utf8'), mtimeMs: stat.mtimeMs };
      if (emit) this.docEvent();
    } catch (error) {
      this.emitEvent('error', { error: `Could not refresh document: ${error.message || error}` });
    }
    return this.doc;
  }
  setBudget(n) {
    this.budgetLimit = Math.max(0, Math.floor(num(n)));
    this.budget = this.budgetLimit;
    this.emitEvent('budget', { budget: this.budget, limit: this.budgetLimit });
    this.autoAllow();
    return this.budget;
  }
  usage() { return Object.fromEntries(Object.entries(this.totals).map(([id, total]) => [id, { ...total }])); }

  checkUsage(seat, usage = {}) {
    const total = this.totals[seat.id];
    const input = num(usage.input_tokens ?? usage.inputTokens ?? usage.input);
    const output = num(usage.output_tokens ?? usage.outputTokens ?? usage.output);
    const cache = num(usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? usage.cachedInputTokens ?? usage.cacheRead);
    total.checkTokens += input + output + cache;
    total.costUsd += num(usage.total_cost_usd ?? usage.costUsd);
    this.emitEvent('usage', { usage: this.usage() });
  }
  async runCheck(seat, prompt, signal) {
    this.totals[seat.id].checks++;
    this.emitEvent('usage', { usage: this.usage() });
    const result = await this.check(seat, prompt, signal);
    this.checkUsage(seat, result && result.usage);
    return result || {};
  }
  onTurn(seat, turn = {}) {
    const total = this.totals[seat.id];
    total.turns++;
    for (const key of ['input', 'output', 'cacheRead', 'costUsd']) total[key] += num(turn[key]);
    this.emitEvent('usage', { usage: this.usage() });
  }

  docContext(seat, { full = false } = {}) {
    const doc = this.doc;
    if (!doc) return '';
    if (doc.kind === 'gdoc') {
      if (seat.engine === 'codex') return `A shared Google Doc is attached (id ${doc.docId}) but you cannot read it; rely on what is said in the forum.`;
      return full
        ? `A shared Google Doc is attached (id ${doc.docId}). Read it with the Google Docs connector tools when you need its content; never write the .gdoc pointer file.`
        : `A shared Google Doc is attached (id ${doc.docId}).`;
    }
    const text = String(doc.text || '');
    const limit = full ? 20000 : 1500;
    return `Document (${doc.path}):\n${text.slice(0, limit)}${text.length > limit ? '\n[truncated]' : ''}`;
  }
  context(items, seat, full = false) {
    const parts = [];
    if (this.summary) parts.push(`Summary so far:\n${this.summary.slice(0, 10000)}`);
    const doc = this.docContext(seat, { full });
    const room = MAX_PROMPT - parts.join('\n\n').length - doc.length - 3000;
    const messages = promptMessages(items.map((item) => ({ name: String(this.seat(item.speaker)?.name || item.speaker).slice(0, 80), text: item.text })), room);
    if (messages) parts.push('Messages:\n' + messages);
    if (doc) parts.push(doc);
    return parts.join('\n\n');
  }
  raisePrompt(seat) {
    const recent = this.transcript.filter((item) => !item.summarized).slice(-this.settings.recentMessages);
    return [`You are ${String(seat.name).slice(0, 80)} in a moderated forum.`, seat.persona ? `Persona: ${String(seat.persona).slice(0, 500)}` : '', this.context(recent, seat),
      'Reply with exactly one line: `pass` or `raise: <reason in at most 12 words>`. Do not write your answer, only why you want to speak. Raise only if you have something new to add that others have not said.'].filter(Boolean).join('\n\n');
  }
  speakPrompt(seat) {
    this.refreshDoc();
    const others = this.seats.filter((other) => other.id !== seat.id).map((other) => String(other.name).slice(0, 80)).join(', ');
    const unseen = this.transcript.filter((item, index) => index >= seat.seenUpTo && !item.summarized && item.speaker !== seat.id);
    return [`You are ${String(seat.name).slice(0, 80)} in a moderated forum with ${others}. Messages are labelled with speaker names. Reply as yourself in at most ~200 words unless asked for more; do not edit files.`,
      seat.persona ? `Persona: ${String(seat.persona).slice(0, 500)}` : '', this.context(unseen, seat, true)].filter(Boolean).join('\n\n');
  }

  async summarize(round) {
    const unsummarized = this.transcript.filter((item) => !item.summarized);
    if (unsummarized.reduce((n, item) => n + item.text.length, 0) / 4 <= this.settings.summaryTokens) return;
    const covered = unsummarized.slice(0, -this.settings.recentMessages);
    if (!covered.length) return;
    const seat = this.seats.find((one) => !one.muted && one.engine === 'claude') || this.seats.find((one) => !one.muted);
    if (!seat) return;
    const controller = new AbortController(); controller.seatId = seat.id; this.controllers.add(controller);
    const selected = [];
    let size = 0;
    for (const item of covered) {
      const line = `${String(this.seat(item.speaker)?.name || item.speaker).slice(0, 80)}: ${String(item.text || '').slice(0, 4000)}`;
      if (size + line.length > MAX_PROMPT - 12000) break;
      selected.push(item); size += line.length + 1;
    }
    if (!selected.length) return;
    const prompt = ['Summarise this discussion so far in <=250 words: positions, agreements, open questions',
      this.summary ? `Previous summary:\n${this.summary.slice(0, 10000)}` : '',
      selected.map((item) => `${String(this.seat(item.speaker)?.name || item.speaker).slice(0, 80)}: ${String(item.text || '').slice(0, 4000)}`).join('\n')].filter(Boolean).join('\n\n');
    try {
      const result = await this.runCheck(seat, prompt, controller.signal);
      if (round !== this.round || controller.signal.aborted || !String(result.text || '').trim()) return;
      this.summary = String(result.text).trim();
      for (const item of selected) item.summarized = true;
      this.summarizedUpTo = selected.at(-1).id;
      this.emitEvent('summary', { summary: this.summary, summarizedUpTo: this.summarizedUpTo });
    } catch (error) {
      if (!controller.signal.aborted) this.emitEvent('error', { error: String(error.message || error), seatId: seat.id });
    } finally { this.controllers.delete(controller); }
  }

  async raiseRound() {
    this.refreshDoc();
    this.abortChecks(); this.removeHands();
    const round = this.round;
    await this.summarize(round);
    if (round !== this.round || this.disposed) return;
    const latest = this.transcript.at(-1);
    const eligible = this.seats.filter((seat) => !seat.muted && (!latest || latest.speaker !== seat.id));
    await Promise.all(eligible.map(async (seat) => {
      const controller = new AbortController(); controller.seatId = seat.id; this.controllers.add(controller);
      this.seatState(seat, 'checking');
      try {
        const result = await this.runCheck(seat, this.raisePrompt(seat), controller.signal);
        if (controller.signal.aborted || round !== this.round || seat.muted) return;
        const parsed = parseRaise(result.text);
        if (!parsed.raise) return;
        const old = this.hands.find((hand) => hand.seatId === seat.id);
        if (old) this.dismiss(old.id);
        const hand = { id: this.next('h'), seatId: seat.id, reason: parsed.reason, msgId: latest && latest.id };
        this.hands.push(hand);
        this.emitEvent('hand', { hand });
        this.autoAllow();
      } catch (error) {
        if (!controller.signal.aborted) this.emitEvent('error', { error: String(error.message || error), seatId: seat.id });
      } finally {
        this.controllers.delete(controller);
        if (round === this.round && !seat.muted && (!this.active || this.active.seatId !== seat.id)) this.seatState(seat, 'idle');
      }
    }));
  }
  post(text) {
    if (this.disposed) return Promise.resolve();
    this.add('user', 'message', text);
    this.budget = this.budgetLimit;
    this.emitEvent('budget', { budget: this.budget, limit: this.budgetLimit });
    return this.raiseRound();
  }
  takeHand(handId) {
    const index = this.hands.findIndex((hand) => hand.id === handId);
    if (index < 0) return null;
    const [hand] = this.hands.splice(index, 1);
    this.emitEvent('hand-removed', { handId: hand.id, hand });
    return hand;
  }
  dismiss(handId) { return !!this.takeHand(handId); }
  allow(handId) {
    const hand = this.takeHand(handId);
    if (!hand) return false;
    const seat = this.seat(hand.seatId);
    if (!seat || seat.muted) return false;
    this.queue.push({ kind: 'speak', seatId: seat.id });
    this.drain();
    return true;
  }
  autoAllow() {
    while (this.budget > 0 && this.hands.length) {
      this.budget--;
      this.emitEvent('budget', { budget: this.budget, limit: this.budgetLimit });
      this.allow(this.hands[0].id);
    }
  }
  mute(seatId, muted) {
    const seat = this.seat(seatId);
    if (!seat) return false;
    seat.muted = !!muted;
    if (seat.muted) {
      this.queue = this.queue.filter((job) => job.seatId !== seatId);
      for (const hand of [...this.hands]) if (hand.seatId === seatId) this.takeHand(hand.id);
      for (const controller of this.controllers) if (controller.seatId === seatId) controller.abort();
      if (this.active && this.active.seatId === seatId) this.cancelActive();
    }
    this.seatState(seat, 'idle');
    return true;
  }
  canWrite(seat, doc) {
    if (!doc) return 'No document is attached.';
    if (doc.kind === 'gdoc' && seat.engine !== 'claude') return 'Codex cannot edit Google Docs; ask a Claude seat.';
    return true;
  }
  writePrompt(job, seat) {
    this.refreshDoc();
    const allowed = this.canWrite(seat, this.doc);
    if (allowed !== true) throw new Error(String(allowed));
    const target = this.doc.kind === 'gdoc' ? this.doc.docId : this.doc.path;
    const unseen = this.transcript.filter((item, index) => index >= seat.seenUpTo && !item.summarized && item.speaker !== seat.id);
    return [this.context(unseen, seat, true), `The moderator asked you to edit the shared document ${target}: ${job.instruction}\nEdit only that document; do not touch other files. Reply with a one-line summary of what you changed.`].filter(Boolean).join('\n\n');
  }
  grantWrite(seatId, instruction) {
    const seat = this.seat(seatId);
    if (!seat || seat.muted) return false;
    const allowed = this.canWrite(seat, this.doc);
    if (allowed !== true) { this.emitEvent('error', { seatId, error: String(allowed) }); return false; }
    this.queue.push({ kind: 'write', seatId, instruction: String(instruction || '') });
    this.drain();
    return true;
  }

  permission(seat, job, request) {
    const tool = request && request.tool_name;
    const input = request && request.input;
    const deny = (message = 'Forum participants are read-only unless the moderator grants an edit.') => ({ behavior: 'deny', message });
    if (tool === 'AskUserQuestion' || tool === 'requestUserInput') return deny('Ask the moderator in the forum instead.');
    if (!job || !job.started || !request || request.subtype !== 'can_use_tool' || !input || typeof input !== 'object') return deny();
    if (READ_TOOLS.has(tool)) return { behavior: 'allow', updatedInput: input };
    if (tool === 'mcp__claude_ai_Google_Docs__read_doc' || tool === 'mcp__claude_ai_Google_Docs__update_doc') {
      const doc = this.doc;
      const ids = [];
      const collect = (value, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > 4) return;
        for (const [key, part] of Object.entries(value)) {
          if (['doc_id', 'document_id', 'documentId', 'docId', 'id'].includes(key)) ids.push(part);
          else collect(part, depth + 1);
        }
      };
      collect(input);
      if (doc && doc.kind === 'gdoc' && seat.engine === 'claude' && ids.every((id) => id === doc.docId)
        && (tool.endsWith('__read_doc') || job.kind === 'write')) return { behavior: 'allow', updatedInput: input };
      return deny();
    }
    if (job.kind === 'write' && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool) && this.doc?.kind === 'md') {
      const file = input.file_path ?? input.filePath ?? input.notebook_path ?? input.path;
      if (typeof file === 'string' && file && !file.includes(',')) {
        try {
          const real = fs.realpathSync(path.isAbsolute(file) ? file : path.resolve(this.project, file));
          if (real === this.doc.path) return { behavior: 'allow', updatedInput: input };
        } catch {}
      }
    }
    return deny();
  }
  answerPermission(seat, session, message, job) {
    const request = message.request;
    const reply = this.permission(seat, job, request);
    try { session.respond(message.request_id, reply); }
    catch (error) { this.emitEvent('error', { seatId: seat.id, error: String(error.message || error) }); }
    if (reply.behavior === 'deny') {
      const tool = String(request?.tool_name || 'unknown tool');
      if (!job || !job.denied.has(tool)) {
        if (job) job.denied.add(tool);
        this.add('system', 'note', `${seat.name}: ${tool} denied. ${reply.message}`);
      }
    }
  }
  invalidateSession(seat, session, reason) {
    if (this.sessions.get(seat.id) !== session) return;
    this.sessions.delete(seat.id);
    this.blocked.delete(seat.id);
    try { session.stop(); } catch {}
    this.add('system', 'note', `${seat.name}'s session was stopped: ${reason}`);
    this.seatState(seat, 'idle');
    void this.drain();
  }
  releaseBlocked(seatId, session) {
    const blocked = this.blocked.get(seatId);
    if (blocked && blocked.session === session && blocked.result && blocked.plan) {
      this.blocked.delete(seatId);
      void this.drain();
    }
  }

  async sessionFor(seat) {
    if (this.sessions.has(seat.id)) return this.sessions.get(seat.id);
    const session = this.makeSession(seat);
    this.sessions.set(seat.id, session);
    session.on('message', (message) => this.onMessage(seat, session, message));
    session.on('turn', (turn) => { if (this.sessions.get(seat.id) === session) this.onTurn(seat, turn); });
    session.on('exit', (exit) => this.onExit(seat, session, exit));
    try {
      session.start();
      const result = await Promise.resolve(session.control({ subtype: 'set_permission_mode', mode: 'plan' }));
      confirmedMode(result);
    } catch (error) {
      this.invalidateSession(seat, session, String(error.message || error));
      throw error;
    }
    return session;
  }
  async drain() {
    if (this.active || this.disposed) return;
    const index = this.queue.findIndex((queued) => !this.blocked.has(queued.seatId));
    if (index < 0) { if (!this.queue.length) this.emitEvent('state', { state: 'idle' }); return; }
    const [job] = this.queue.splice(index, 1);
    const seat = this.seat(job.seatId);
    if (!seat || seat.muted) return this.drain();
    this.active = job;
    this.seatState(seat, job.kind === 'write' ? 'writing' : 'speaking');
    this.emitEvent('state', { state: job.kind });
    try {
      const session = await this.sessionFor(seat);
      if (this.active !== job) return;
      job.session = session; job.parts = []; job.denied = new Set();
      job.draft = { id: this.next('m'), at: this.now(), speaker: seat.id,
        kind: job.kind === 'write' ? 'write' : 'message', text: '' };
      if (job.kind === 'write') {
        const result = await Promise.resolve(session.control({ subtype: 'set_permission_mode', mode: 'acceptEdits' }));
        confirmedMode(result);
        if (this.active !== job) return;
        const prompt = this.writePrompt(job, seat);
        job.sentUpTo = this.transcript.length;
        job.started = true;
        session.user(prompt);
      } else {
        const prompt = this.speakPrompt(seat);
        job.sentUpTo = this.transcript.length;
        job.started = true;
        session.user(prompt);
      }
    } catch (error) {
      if (this.active !== job) return;
      this.emitEvent('error', { seatId: seat.id, error: String(error.message || error) });
      if (job.kind === 'write') {
        this.add('system', 'write', String(error.message || error));
        if (job.session) { this.invalidateSession(seat, job.session, 'edit permission was not confirmed'); job.session = null; }
      }
      this.finishJob(job);
    }
  }
  onMessage(seat, session, message) {
    if (this.sessions.get(seat.id) !== session) return;
    const blocked = this.blocked.get(seat.id);
    if (blocked && blocked.session === session) {
      if (message.type === 'control_request') this.answerPermission(seat, session, message, blocked);
      if (message.type === 'result') { blocked.result = true; this.releaseBlocked(seat.id, session); }
      return;
    }
    const job = this.active;
    if (message.type === 'control_request') {
      this.answerPermission(seat, session, message, job && !job.finished && job.seatId === seat.id && job.session === session ? job : null);
      return;
    }
    if (!job || job.finished || job.seatId !== seat.id || job.session !== session) return;
    if (message.type === 'text_delta') {
      job.draft.text += message.text || '';
      this.emitEvent('message', { item: { ...job.draft }, delta: message.text || '' });
    }
    if (message.type === 'assistant' && !message.parent_tool_use_id) {
      const blocks = message.message && message.message.content || [];
      job.parts.push(...blocks.filter((block) => block.type === 'text' && block.text).map((block) => block.text));
    }
    if (message.type !== 'result') return;
    job.finished = true;
    const text = job.parts.join('\n\n');
    const failed = message.is_error || (message.subtype && message.subtype !== 'success');
    if (job.kind === 'write') {
      this.add(seat.id, 'write', text || message.result || 'Write turn finished.', job.draft);
      seat.seenUpTo = job.sentUpTo;
      if (!failed) {
        if (this.doc && this.doc.kind === 'md') { this.refreshDoc(false); this.docEvent(); }
        else if (this.doc && this.doc.kind === 'gdoc') this.docEvent({ changed: true, kind: 'gdoc' });
      }
    } else {
      if (failed || !text.trim()) {
        this.emitEvent('message-cancelled', { id: job.draft.id });
        this.add('system', 'note', `${seat.name} could not finish the turn${message.result ? `: ${message.result}` : '.'}`);
      } else this.add(seat.id, 'message', text, job.draft);
      seat.seenUpTo = job.sentUpTo;
    }
    this.finishJob(job);
    if (job.kind === 'speak' && !failed && text.trim()) void this.raiseRound();
  }
  finishJob(job) {
    if (this.active !== job) return;
    const seat = this.seat(job.seatId);
    if (job.kind === 'write' && job.session) {
      job.finished = true;
      controlResult(job.session, { subtype: 'set_permission_mode', mode: 'plan' })
        .then(confirmedMode)
        .catch((error) => this.invalidateSession(seat, job.session, String(error.message || error)))
        .finally(() => {
          if (this.active !== job) return;
          this.active = null;
          this.seatState(seat, 'idle');
          void this.drain();
        });
      return;
    }
    this.active = null;
    this.seatState(seat, 'idle');
    void this.drain();
  }
  onExit(seat, session, exit) {
    if (this.sessions.get(seat.id) !== session) return;
    this.sessions.delete(seat.id);
    this.blocked.delete(seat.id);
    const job = this.active;
    if (job && job.seatId === seat.id) {
      if (job.draft && !job.finished) this.emitEvent('message-cancelled', { id: job.draft.id });
      if (!job.finished) this.add('system', 'note', `${seat.name} left before finishing the turn${exit && exit.stderr ? `: ${exit.stderr}` : '.'}`);
      this.active = null;
      this.seatState(seat, 'idle');
    }
    void this.drain();
  }
  cancelActive() {
    const job = this.active;
    if (!job) return;
    const turnFinished = !!job.finished;
    this.active = null;
    job.finished = true;
    if (job.draft) this.emitEvent('message-cancelled', { id: job.draft.id });
    const seat = this.seat(job.seatId);
    const session = job.session || this.sessions.get(job.seatId);
    if (session) {
      if (!job.started) this.invalidateSession(seat, session, 'turn cancelled before it started');
      else {
        const blocked = { session, result: turnFinished, plan: job.kind !== 'write', denied: job.denied || new Set() };
        this.blocked.set(seat.id, blocked);
        controlResult(session, { subtype: 'interrupt' })
          .then((result) => { if (result && result.error) throw new Error(String(result.error)); })
          .catch((error) => this.invalidateSession(seat, session, String(error.message || error)));
        if (job.kind === 'write') controlResult(session, { subtype: 'set_permission_mode', mode: 'plan' })
          .then((result) => {
            confirmedMode(result);
            blocked.plan = true; this.releaseBlocked(seat.id, session);
          })
          .catch((error) => this.invalidateSession(seat, session, String(error.message || error)));
      }
    }
    this.seatState(seat, 'idle');
    void this.drain();
  }
  stop() {
    this.abortChecks(); this.removeHands(); this.queue = [];
    this.budget = 0;
    this.emitEvent('budget', { budget: 0, limit: this.budgetLimit });
    this.cancelActive();
    this.emitEvent('state', { state: 'idle' });
  }
  snapshot() {
    return JSON.parse(JSON.stringify({ id: this.id, project: this.project, title: this.title,
      transcript: this.transcript, summary: this.summary, summarizedUpTo: this.summarizedUpTo,
      hands: this.hands, seats: this.seats, budget: this.budget, budgetLimit: this.budgetLimit,
      usage: this.totals, doc: this.doc && (this.doc.kind === 'md'
        ? { kind: 'md', path: this.doc.path, mtimeMs: this.doc.mtimeMs }
        : { kind: 'gdoc', path: this.doc.path, docId: this.doc.docId }), sequence: this.sequence }));
  }
  restore(data) {
    this.stop();
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
    this.id = data.id; this.project = data.project; this.title = data.title;
    this.transcript = (data.transcript || []).map((item) => ({ ...item }));
    this.summary = data.summary || ''; this.summarizedUpTo = data.summarizedUpTo || null;
    this.seats = (data.seats || []).map((seat) => ({ ...seat }));
    this.budgetLimit = Math.max(0, num(data.budgetLimit ?? this.settings.defaultBudget));
    this.budget = Math.max(0, Math.min(this.budgetLimit, num(data.budget)));
    this.totals = Object.fromEntries(this.seats.map((seat) => [seat.id, { ...emptyUsage(), ...(data.usage && data.usage[seat.id]) }]));
    this.doc = data.doc ? { ...data.doc } : null; this.sequence = num(data.sequence);
    if (this.doc) {
      try {
        if (this.doc.kind === 'md') {
          documentFile(this.doc.path, 'md');
          this.refreshDoc();
        } else if (this.doc.kind === 'gdoc') {
          const { real } = documentFile(this.doc.path, 'gdoc');
          const pointer = JSON.parse(fs.readFileSync(real, 'utf8'));
          if (!pointer.doc_id || pointer.doc_id !== this.doc.docId) throw new Error('Google Doc pointer changed.');
          this.doc.path = real;
        } else throw new Error('Unsupported document type');
      } catch (error) {
        this.emitEvent('error', { error: `Could not restore document: ${error.message || error}` });
        this.doc = null;
      }
    }
    this.hands = [];
    return this;
  }
  dispose() {
    if (this.disposed) return;
    this.stop(); this.disposed = true;
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
    this.blocked.clear();
  }
}

module.exports = { Forum, parseRaise };
