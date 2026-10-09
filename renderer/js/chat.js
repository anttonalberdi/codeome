// Agent chat: one conversation per project with the orchestrator, a headless Claude
// Code session (main/chat.js). It answers directly or hands work to Claude subagents
// and Codex jobs, which appear here as cards. Permission prompts and AskUserQuestion
// (the approval gates) appear as buttons. Conversations keep running while another
// project is shown.
(function () {
  const h = App.h;
  const C = { byProject: {}, byId: {} };
  App.views.chat = C;
  const dom = new WeakMap(); // item → element
  let logEl, ta, modeSel, acctEl, sendBtn, stopBtn, stateEl;

  const MODES = [
    { value: 'default', label: 'Ask before changes' },
    { value: 'acceptEdits', label: 'Accept edits' },
    { value: 'auto', label: 'Auto' },
    { value: 'plan', label: 'Plan only' }
  ];
  const EXAMPLES = ['How is this project organised?', 'Find out why the tests fail and fix it', 'Review my uncommitted changes'];
  const ENGINE = { claude: 'Claude', codex: 'Codex' };
  const store = { get: (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    const x = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  }

  // ---------- conversations ----------
  function blank(project, opts = {}) {
    const chat = { id: uuid(), project, title: '', account: opts.account || 'auto', accountName: null, mode: store.get('codeome.chat.mode', 'default'),
      started: false, items: [], createdAt: Date.now() };
    return live(chat);
  }
  // Runtime-only state, rebuilt for a saved conversation.
  function live(chat) {
    Object.assign(chat, { running: false, busy: false, stream: {}, tools: {}, requests: {} });
    for (const it of chat.items) {
      if (it.id) chat.tools[it.id] = it;
      if ((it.t === 'perm' || it.t === 'ask') && !it.decided && !it.answers) it.expired = true;
      if (it.t === 'tool' && !it.done) it.done = true;
      if (it.t === 'text') it.live = false;
    }
    C.byId[chat.id] = chat;
    return chat;
  }
  const cur = () => C.byProject[App.project] || null;
  C.current = cur;
  C.isBusy = (project) => { const c = C.byProject[project]; return !!(c && c.busy); };
  C.title = () => { const c = cur(); return c && c.title; };

  async function restore(project) {
    const list = await codeome.chat.list(project);
    const saved = list[0] && await codeome.chat.load(project, list[0].id);
    return saved && saved.items ? live(saved) : blank(project);
  }

  let saveTimers = {};
  function save(chat, now) {
    if (!chat.started && !chat.items.length) return;
    clearTimeout(saveTimers[chat.id]);
    const run = () => {
      const items = chat.items.map((it) => (it.result && it.result.length > 4000 ? { ...it, result: it.result.slice(0, 4000) + '\n…' } : it));
      codeome.chat.save(chat.project, { id: chat.id, title: chat.title, account: chat.account, accountName: chat.accountName, mode: chat.mode, started: chat.started, createdAt: chat.createdAt, items });
    };
    if (now) run(); else saveTimers[chat.id] = setTimeout(run, 800);
  }

  C.newChat = async (opts = {}) => {
    const project = App.project;
    if (!project) return App.toast('Open a project folder first.');
    const old = C.byProject[project];
    if (old && old.busy && !(await App.confirm('Start a new chat?', 'The agent is still working in this one. It will be stopped; specialist jobs it started keep running.', 'New chat', true))) return;
    if (old && old.running) { old.stopping = true; codeome.chat.stop(old.id); }
    C.byProject[project] = blank(project, opts);
    paint();
    App.emit('chat');
    if (opts.send) C.send(opts.send); else focus();
  };

  C.open = async (id) => {
    const project = App.project;
    const c = C.byId[id] || await codeome.chat.load(project, id).then((s) => s && live(s));
    if (!c) return App.err('That conversation could not be loaded.');
    const old = C.byProject[project];
    if (old && old !== c && old.running && !old.busy) { old.stopping = true; codeome.chat.stop(old.id); }
    C.byProject[project] = c;
    paint();
    App.emit('chat');
  };

  C.history = async () => {
    if (!App.project) return [];
    const list = await codeome.chat.list(App.project);
    const c = cur();
    return list.filter((x) => !c || x.id !== c.id).slice(0, 10);
  };

  C.remove = async (id) => { await codeome.chat.delete(App.project, id); };

  // Put text in the composer (from the editor or file browser) and focus it.
  C.ask = (text) => {
    App.setView('agents');
    App.views.agents.show('chat');
    if (ta) { ta.value = (ta.value ? ta.value.replace(/\s*$/, '\n') : '') + text; autosize(); }
    focus();
  };
  function focus() { setTimeout(() => { if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }, 0); }

  C.closeProject = (project) => {
    const c = C.byProject[project];
    if (c && c.running) { c.stopping = true; codeome.chat.stop(c.id); }
    delete C.byProject[project];
  };

  // ---------- sending ----------
  C.send = async (text) => {
    const chat = cur();
    text = String(text || '').trim();
    if (!chat || !text) return;
    if (!chat.title) chat.title = text.replace(/\s+/g, ' ').slice(0, 80);
    push(chat, { t: 'user', text });
    App.emit('chat');
    if (!chat.running && !(await start(chat))) return;
    chat.busy = true; paintState();
    const r = await codeome.chat.send(chat.id, text);
    if (r.error) { note(chat, r.error, 'error'); chat.busy = false; paintState(); }
    chat.started = true;
    save(chat, true);
  };

  async function start(chat) {
    // A conversation lives in its account's config folder, so it resumes there.
    const r = await codeome.chat.start({ id: chat.id, project: chat.project, account: chat.started ? chat.accountName || chat.account : chat.account, resume: chat.started, mode: chat.mode });
    if (r.error) { note(chat, r.error, 'error'); return false; }
    chat.running = true;
    const a = r.account;
    if (a && a.name) {
      chat.accountName = a.name;
      if (a.blocked) App.toast(`Every Claude account is near its usage limit. The chat runs on ${a.name} anyway.`, { error: true });
      else if (a.switched) App.toast(`Claude account ${a.from} is near its limit, so this chat runs on ${a.name}.`);
    }
    paintState();
    App.emit('sessions');
    return true;
  }

  C.stop = async () => {
    const chat = cur();
    if (!chat || !chat.running) return;
    const r = await codeome.chat.control(chat.id, { subtype: 'interrupt' });
    if (r.error) App.err(r.error);
    expire(chat);
  };

  function setMode(v) {
    const chat = cur();
    store.set('codeome.chat.mode', v);
    if (!chat) return;
    chat.mode = v;
    if (chat.running) codeome.chat.control(chat.id, { subtype: 'set_permission_mode', mode: v }).then((r) => { if (r.error) App.err(r.error); });
    save(chat);
  }

  // Continue the same conversation in a Claude Code terminal session.
  C.toTerminal = async () => {
    const chat = cur();
    if (!chat || !chat.started) return App.toast('Send a message first.');
    if (chat.busy && !(await App.confirm('Move this chat to a terminal?', 'The agent is still working. It will be stopped here and the conversation reopened in a terminal.', 'Move', true))) return;
    if (chat.running) { chat.stopping = true; await codeome.chat.stop(chat.id); }
    const cmd = (App.cfg.agents.find((a) => /^claude(\s|$)/.test(a.cmd)) || { cmd: 'claude' }).cmd;
    App.views.terminals.open({ kind: 'agent-local', title: 'Agent chat', command: cmd + ' --resume ' + chat.id, cwd: chat.project, badge: 'Mac', engine: 'claude', account: chat.accountName || 'auto' });
    note(chat, 'Continued in a terminal. Messages sent there are not shown here, but the agent remembers them.', 'info');
    save(chat);
  };

  // ---------- events from the session ----------
  codeome.chat.onEvent(({ id, msg }) => { const chat = C.byId[id]; if (chat) handle(chat, msg); });
  codeome.chat.onExit(({ id, code, signal, stderr }) => {
    const chat = C.byId[id];
    if (!chat) return;
    chat.running = false; chat.busy = false; chat.stream = {};
    for (const it of chat.items) if (it.t === 'text' && it.live) { it.live = false; update(chat, it); }
    expire(chat);
    if (!chat.stopping && (code || signal)) {
      const tail = (stderr || '').split('\n').filter(Boolean).slice(-4).join('\n');
      note(chat, `The agent session ended unexpectedly${code ? ' (exit code ' + code + ')' : ''}. Send a message to continue.` + (tail ? '\n' + tail : ''), 'error');
    }
    chat.stopping = false;
    paintState(); App.emit('sessions'); save(chat);
  });

  function handle(chat, m) {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') { chat.busy = true; chat.model = m.model; paintState(); }
        else if (m.subtype === 'task_notification') taskEnded(chat, m.tool_use_id, m.status);
        else if (m.subtype === 'compact_boundary') note(chat, 'Earlier messages were summarised to free up context.', 'info');
        break;
      case 'text_delta': delta(chat, m); break;
      case 'assistant': assistant(chat, m); break;
      case 'user': results(chat, m); break;
      case 'control_request': request(chat, m); break;
      case 'control_cancel_request': {
        const req = chat.requests[m.request_id];
        if (req) { req.item.expired = true; delete chat.requests[m.request_id]; update(chat, req.item); }
        break;
      }
      case 'result':
        chat.busy = false; chat.stream = {};
        for (const it of chat.items) if (it.t === 'text' && it.live) { it.live = false; update(chat, it); }
        if (m.subtype && m.subtype !== 'success') note(chat, m.subtype === 'error_max_turns' ? 'The agent stopped: it reached its turn limit.' : 'The agent stopped with an error' + (m.result ? ': ' + m.result : '.'), 'error');
        else if (m.is_error && m.result) note(chat, m.result, 'error');
        paintState(); App.emit('sessions'); save(chat);
        if (document.hidden || App.currentView !== 'agents' || chat.project !== App.project) attention(chat, 'The agent finished.');
        break;
    }
  }

  // Partial text, one live item per content block until the full block arrives.
  function delta(chat, m) {
    const key = m.msgId + ':' + m.index;
    let it = chat.stream[key];
    if (!it) { it = { t: 'text', text: '', live: true, msgId: m.msgId }; chat.stream[key] = it; push(chat, it); }
    it.text += m.text;
    update(chat, it);
  }

  function assistant(chat, m) {
    chat.busy = true;
    const parent = m.parent_tool_use_id;
    const msg = m.message || {};
    for (const b of msg.content || []) {
      if (parent) { activity(chat, parent, b); continue; }
      if (b.type === 'text' && b.text) finalText(chat, msg.id, b.text);
      else if (b.type === 'tool_use') toolUse(chat, b);
    }
    paintState();
  }

  function finalText(chat, msgId, text) {
    const key = Object.keys(chat.stream).find((k) => chat.stream[k].msgId === msgId);
    if (key) { const it = chat.stream[key]; delete chat.stream[key]; it.text = text; it.live = false; update(chat, it); }
    else push(chat, { t: 'text', text });
  }

  // A subagent's own steps: shown as the latest activity on its card.
  function activity(chat, parent, b) {
    const card = chat.tools[parent];
    if (!card || card.t !== 'job' || b.type !== 'tool_use') return;
    card.activity = summary(b.name, b.input || {}, chat.project).join(' ');
    card.steps = (card.steps || 0) + 1;
    update(chat, card);
  }

  // Specialist jobs: Claude subagents (Agent/Task tool) and Codex runs via codeome-agent.
  function jobFrom(b) {
    const i = b.input || {};
    if (b.name === 'Agent' || b.name === 'Task') return { engine: 'claude', role: i.subagent_type || 'general-purpose', title: i.description || i.subagent_type || 'Subagent' };
    if (b.name === 'Bash' && /codeome-agent["']?\s+codex\b/.test(i.command || '')) {
      const c = i.command;
      const arg = (k) => { const m = c.match(new RegExp('--' + k + '\\s+(?:"([^"]*)"|\'([^\']*)\'|(\\S+))')); return m ? m[1] || m[2] || m[3] : null; };
      return { engine: 'codex', role: arg('role') || 'codex', title: arg('title') || arg('role') || 'Codex job', resume: arg('resume'), background: !!i.run_in_background };
    }
    return null;
  }

  // Questions and plan approvals show as their own cards (see request()).
  const OWN_CARD = new Set(['AskUserQuestion', 'ExitPlanMode']);

  function toolUse(chat, b) {
    if (OWN_CARD.has(b.name)) return;
    const job = jobFrom(b);
    let it;
    if (job) it = { t: 'job', id: b.id, ...job, status: 'running', startedAt: Date.now() };
    else if (b.name === 'TodoWrite') {
      const old = chat.items.find((x) => x.t === 'todo');
      if (old) remove(chat, old);
      it = { t: 'todo', id: b.id, todos: ((b.input || {}).todos || []).map((x) => ({ content: x.content, status: x.status, activeForm: x.activeForm })) };
    } else it = { t: 'tool', id: b.id, name: b.name, input: slimInput(b.input || {}), done: false };
    chat.tools[b.id] = it;
    push(chat, it);
    App.views.agents.refreshSoon();
  }

  // Keep what the one-line summary needs, not file contents.
  function slimInput(i) {
    const o = {};
    for (const k of ['command', 'description', 'file_path', 'notebook_path', 'path', 'pattern', 'glob', 'url', 'query', 'skill', 'args', 'subject', 'plan']) {
      if (typeof i[k] === 'string') o[k] = i[k].length > 600 ? i[k].slice(0, 600) + '…' : i[k];
    }
    return o;
  }

  const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x.type === 'text' ? x.text : '')).join('\n') : '');

  function results(chat, m) {
    if (m.parent_tool_use_id) return;
    const content = m.message && m.message.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b.type !== 'tool_result') continue;
      const it = chat.tools[b.tool_use_id];
      if (!it) continue;
      const text = textOf(b.content);
      if (it.t === 'tool') { it.done = true; it.error = !!b.is_error; it.result = text.slice(0, 8000); }
      else if (it.t === 'job') {
        if (/job NOT started \(usage limit\)|Codeome: Claude account/.test(text)) { it.status = 'held'; it.result = text.slice(0, 2000); }
        else if (/Command running in background/.test(text)) it.background = true;
        else { it.status = b.is_error ? 'failed' : 'done'; it.endedAt = Date.now(); it.result = text.slice(0, 8000); }
      } else continue;
      update(chat, it);
    }
  }

  function taskEnded(chat, toolUseId, status) {
    const it = chat.tools[toolUseId];
    if (!it) return;
    if (it.t === 'job' && it.status === 'running') { it.status = status === 'completed' ? 'done' : status === 'killed' ? 'cancelled' : 'failed'; it.endedAt = Date.now(); }
    if (it.t === 'tool') it.done = true;
    update(chat, it);
    App.views.agents.refreshSoon();
  }

  // Job records (.codeome/jobs) carry the authoritative status and the log; link each card to one.
  C.syncJobs = (project, jobs) => {
    const chat = C.byProject[project];
    if (!chat) return;
    const claimed = new Set(chat.items.filter((x) => x.t === 'job' && x.jobId).map((x) => x.jobId));
    for (const it of chat.items) {
      if (it.t !== 'job') continue;
      let j = it.jobId && jobs.find((x) => x.id === it.jobId);
      if (!j && !it.jobId) {
        j = jobs.find((x) => !claimed.has(x.id) && x.engine === it.engine && (
          (x.toolUseId && x.toolUseId === it.id) ||
          (!x.toolUseId && x.title === it.title && Date.parse(x.startedAt) >= it.startedAt - 10000)));
        if (j) { it.jobId = j.id; claimed.add(j.id); }
      }
      if (j) {
        const status = j.limitHit ? 'held' : j.status;
        if (status !== it.status && status !== 'stale') { it.status = status; if (status !== 'running') it.endedAt = Date.parse(j.endedAt) || Date.now(); }
        it.account = j.account;
      }
      if (it.status === 'running' || j) update(chat, it);
    }
  };

  // ---------- permission prompts and questions ----------
  function request(chat, m) {
    const r = m.request || {};
    if (r.subtype !== 'can_use_tool') return;
    const it = r.tool_name === 'AskUserQuestion'
      ? { t: 'ask', requestId: m.request_id, questions: (r.input || {}).questions || [] }
      : { t: 'perm', requestId: m.request_id, tool: r.tool_name, title: r.title || null, reason: r.decision_reason || null, input: slimInput(r.input || {}), suggestions: r.permission_suggestions || null };
    chat.requests[m.request_id] = { input: r.input || {}, item: it };
    push(chat, it);
    attention(chat, it.t === 'ask' ? 'The agent has a question.' : `The agent asks to use ${r.tool_name}.`);
  }

  async function decide(chat, it, decision, feedback) {
    const req = chat.requests[it.requestId];
    if (!req) return;
    delete chat.requests[it.requestId]; // one answer per request, however fast the clicks
    const resp = decision === 'deny'
      ? { behavior: 'deny', message: feedback || 'The user declined this.' }
      : { behavior: 'allow', updatedInput: req.input, ...(decision === 'always' && it.suggestions ? { updatedPermissions: it.suggestions } : {}) };
    const r = await codeome.chat.respond(chat.id, it.requestId, resp);
    if (r.error) { chat.requests[it.requestId] = req; return App.err(r.error); }
    it.decided = decision;
    update(chat, it); save(chat);
  }

  async function answer(chat, it, answers) {
    const req = chat.requests[it.requestId];
    if (!req) return;
    delete chat.requests[it.requestId];
    const r = await codeome.chat.respond(chat.id, it.requestId, { behavior: 'allow', updatedInput: { ...req.input, answers } });
    if (r.error) { chat.requests[it.requestId] = req; return App.err(r.error); }
    it.answers = answers;
    update(chat, it); save(chat);
  }

  function expire(chat) {
    for (const id of Object.keys(chat.requests)) { const it = chat.requests[id].item; it.expired = true; update(chat, it); }
    chat.requests = {};
  }

  function attention(chat, text) {
    if (!document.hidden && App.currentView === 'agents' && chat.project === App.project) return;
    App.toast(`${App.basename(chat.project)}: ${text}`, { action: { label: 'Show', run: () => { App.views.projects.switchTo(chat.project).then(() => { App.setView('agents'); App.views.agents.show('chat'); }); } } });
  }

  // ---------- items ----------
  function push(chat, it) {
    chat.items.push(it);
    if (chat === cur() && logEl) { const stick = atBottom(); logEl.querySelector('.chat-empty')?.remove(); logEl.append(render(chat, it)); if (stick) scrollEnd(); }
  }
  function note(chat, text, kind) { push(chat, { t: 'note', text, kind }); }
  function remove(chat, it) { chat.items = chat.items.filter((x) => x !== it); const el = dom.get(it); if (el) el.remove(); }

  let raf = new Set(), rafId = 0;
  function update(chat, it) {
    if (chat !== cur() || !dom.get(it)) return;
    raf.add(it);
    if (!rafId) rafId = requestAnimationFrame(() => {
      rafId = 0;
      const stick = atBottom();
      const c = cur();
      for (const x of raf) { const old = dom.get(x); if (old && old.isConnected) old.replaceWith(render(c, x)); }
      raf.clear();
      if (stick) scrollEnd();
    });
  }

  const atBottom = () => logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 40;
  const scrollEnd = () => { logEl.scrollTop = logEl.scrollHeight; };

  const rel = (p, project) => (p && project && p.startsWith(project + '/') ? p.slice(project.length + 1) : App.tildify(p || ''));
  function summary(name, i, project) {
    switch (name) {
      case 'Read': return ['Read', rel(i.file_path, project)];
      case 'Edit': case 'MultiEdit': return ['Edit', rel(i.file_path, project)];
      case 'Write': return ['Write', rel(i.file_path, project)];
      case 'NotebookEdit': return ['Edit', rel(i.notebook_path, project)];
      case 'Bash': return ['Run', i.description || i.command || ''];
      case 'Grep': return ['Search', i.pattern || ''];
      case 'Glob': return ['Find', i.pattern || ''];
      case 'WebFetch': return ['Fetch', i.url || ''];
      case 'WebSearch': return ['Web search', i.query || ''];
      case 'Skill': return ['Skill', (i.skill || '') + (i.args ? ' ' + i.args : '')];
      case 'ExitPlanMode': return ['Plan', 'ready for review'];
      default: return [name.replace(/^mcp__[^_]+__/, ''), i.description || i.path || i.query || i.url || ''];
    }
  }

  function elapsed(it) {
    const s = Math.max(0, Math.round(((it.endedAt || Date.now()) - it.startedAt) / 1000));
    return s < 60 ? s + ' s' : s < 3600 ? Math.floor(s / 60) + ' min' : Math.floor(s / 3600) + ' h ' + Math.floor(s % 3600 / 60) + ' min';
  }

  const STATUS = { running: 'running', done: 'done', failed: 'failed', cancelled: 'cancelled', lost: 'lost', held: 'usage limit', stale: 'stale' };

  function render(chat, it) {
    let el;
    switch (it.t) {
      case 'user': el = h('div.msg.user', it.text); break;
      case 'text': el = h('div.msg.md' + (it.live ? '.live' : ''), { html: App.md(it.text) }); break;
      case 'note': el = h('div.note.' + (it.kind || 'info'), it.text); break;
      case 'tool': {
        const [verb, what] = summary(it.name, it.input || {}, chat.project);
        el = h('div.tool' + (it.done ? '' : '.run') + (it.error ? '.err' : '') + (it.open ? '.open' : ''),
          h('button.tool-line', { 'aria-expanded': String(!!it.open), onclick: () => { it.open = !it.open; update(chat, it); } },
            h('i.tdot'), h('span.tv', verb), h('span.tw', what)),
          it.open ? h('pre.tool-out', it.result || (it.done ? '(no output)' : 'Running…')) : null);
        break;
      }
      case 'todo':
        el = h('div.todo', h('div.todo-h', 'Plan'), it.todos.map((x) => h('div.todo-i.' + x.status, h('span.tk', x.status === 'completed' ? '✓' : x.status === 'in_progress' ? '▸' : '○'), h('span', x.status === 'in_progress' && x.activeForm ? x.activeForm : x.content))));
        break;
      case 'job': {
        const live = it.status === 'running';
        el = h('div.jobcard.' + it.status, { tabindex: '0', role: 'button', title: it.jobId ? 'Open the brief, log and result' : 'Waiting for the job record',
          onclick: () => openJob(it), onkeydown: (e) => { if (e.key === 'Enter') openJob(it); } },
          h('div.jc-top', h('span.pill' + (it.engine === 'codex' ? '.codex' : '.ok'), ENGINE[it.engine]), h('span.jc-role', it.role), h('span.grow'),
            h('span.state.' + (it.status === 'held' ? 'failed' : it.status), live ? h('span.spinner') : null, ' ', STATUS[it.status] || it.status), h('span.jc-time', elapsed(it))),
          h('div.jc-title', it.title),
          it.activity && live ? h('div.jc-act', it.activity) : null,
          !live && it.account && App.cfg.accounts[it.engine] && App.cfg.accounts[it.engine].list.length > 1 ? h('div.jc-act', 'on ' + it.account) : null);
        break;
      }
      case 'perm': el = permCard(chat, it); break;
      case 'ask': el = askCard(chat, it); break;
      default: el = h('div');
    }
    dom.set(it, el);
    return el;
  }

  function openJob(it) {
    const j = it.jobId && App.views.agents.jobs.find((x) => x.id === it.jobId);
    if (j) return App.views.agents.openJob(j);
    if (it.result) return App.views.editor.openCustom({ key: 'chat-job:' + it.id, title: `${it.role} · ${ENGINE[it.engine]}`, badge: 'Agent', render: (el) => el.append(h('pre.logbox', it.result)) });
    App.toast(App.views.agents.kit && App.views.agents.kit.installed ? 'The job record has not appeared yet.' : 'Install the agent kit to record job logs.');
  }

  function permCard(chat, it) {
    const i = it.input || {};
    const done = it.decided || it.expired;
    let detail;
    if (it.tool === 'ExitPlanMode' && i.plan) detail = h('div.msg.md.plan', { html: App.md(i.plan) });
    else if (it.tool === 'Bash') detail = h('pre.perm-cmd', i.command || '');
    else if (i.file_path || i.notebook_path) detail = h('div.perm-path', rel(i.file_path || i.notebook_path, chat.project));
    else { const s = summary(it.tool, i, chat.project)[1]; detail = s ? h('div.perm-path', s) : null; }
    const title = it.tool === 'ExitPlanMode' ? 'Approve this plan?' : it.title || `Allow ${it.tool}?`;
    const status = it.decided === 'deny' ? 'Declined' : it.decided === 'always' ? 'Allowed from now on' : it.decided ? 'Allowed' : it.expired ? 'No longer waiting' : null;
    return h('div.ask-card' + (done ? '.done' : ''),
      h('div.ask-h', title), it.reason && !done ? h('div.sub', it.reason) : null, detail,
      done ? h('div.ask-done', status) : h('div.row.wrap.ask-btns',
        h('button.btn.small.primary', { onclick: () => decide(chat, it, 'allow') }, it.tool === 'ExitPlanMode' ? 'Approve' : 'Allow'),
        it.suggestions && it.suggestions.length && it.tool !== 'ExitPlanMode' ? h('button.btn.small', { onclick: () => decide(chat, it, 'always') }, 'Always allow') : null,
        h('button.btn.small', { onclick: () => decide(chat, it, 'deny', it.tool === 'ExitPlanMode' ? 'The user wants to keep planning. Wait for their feedback.' : null) }, it.tool === 'ExitPlanMode' ? 'Keep planning' : 'Deny')));
  }

  function askCard(chat, it) {
    const done = it.answers || it.expired;
    const picks = it.questions.map(() => new Set());
    const others = it.questions.map(() => null);
    const single = it.questions.length === 1 && !it.questions[0].multiSelect;
    const collect = () => {
      const out = {};
      it.questions.forEach((q, k) => {
        const vals = [...picks[k]];
        const o = others[k] && others[k].value.trim();
        if (o) vals.push(o);
        out[q.question] = vals.join(', ');
      });
      return out;
    };
    const submitBtn = single ? null : h('button.btn.small.primary', { onclick: () => {
      const a = collect();
      if (Object.values(a).some((v) => !v)) return App.toast('Answer every question first.');
      answer(chat, it, a);
    } }, 'Submit');
    return h('div.ask-card' + (done ? '.done' : ''),
      it.questions.map((q, k) => h('div.ask-q',
        q.header ? h('span.pill', q.header) : null,
        h('div.ask-h', q.question),
        done ? h('div.ask-done', it.answers ? (it.answers[q.question] || '—') : 'No longer waiting') : h('div.ask-opts',
          q.options.map((o) => {
            const b = h('button.ask-opt', { title: o.description || '', 'aria-pressed': 'false', onclick: () => {
              if (single) return answer(chat, it, { [q.question]: o.label });
              if (!q.multiSelect) { picks[k].clear(); b.parentNode.querySelectorAll('.ask-opt').forEach((x) => x.setAttribute('aria-pressed', 'false')); }
              if (picks[k].has(o.label)) picks[k].delete(o.label); else picks[k].add(o.label);
              b.setAttribute('aria-pressed', String(picks[k].has(o.label)));
            } }, h('b', o.label), o.description ? h('span', o.description) : null);
            return b;
          }),
          (others[k] = h('input', { type: 'text', placeholder: 'Other…', 'aria-label': 'Other answer', onkeydown: (e) => {
            if (e.key === 'Enter' && single && e.target.value.trim()) answer(chat, it, { [q.question]: e.target.value.trim() });
            else if (e.key === 'Enter' && submitBtn) submitBtn.click();
          } }))))),
      done || single ? null : h('div.row.ask-btns', submitBtn));
  }

  // ---------- view ----------
  C.mount = (host) => {
    logEl = h('div.chat-log', { 'aria-live': 'polite', onclick: onLinkClick });
    ta = h('textarea.chat-input', { rows: 1, placeholder: 'Ask, or describe a task…', 'aria-label': 'Message the agent', oninput: autosize, onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    } });
    modeSel = h('select.chat-mode', { 'aria-label': 'What the agent may do without asking', title: 'What the agent may do without asking', onchange: (e) => setMode(e.target.value) },
      MODES.map((m) => h('option', { value: m.value }, m.label)));
    acctEl = h('span.chat-acct');
    stateEl = h('span.chat-state.grow');
    stopBtn = h('button.btn.small', { onclick: () => C.stop(), hidden: true }, 'Stop');
    sendBtn = h('button.btn.small.primary', { onclick: submit }, 'Send');
    host.append(logEl, h('div.chat-compose', ta, h('div.row.chat-bar', modeSel, acctEl, stateEl, stopBtn, sendBtn)));
    App.listen('project', async (p) => {
      if (p && !C.byProject[p]) C.byProject[p] = await restore(p);
      if (p === App.project) { paint(); App.emit('chat'); }
    });
    App.listen('usage', () => paintState());
    App.listen('config', () => paintState());
    setInterval(() => { const c = cur(); if (c && logEl.isConnected) for (const it of c.items) if (it.t === 'job' && it.status === 'running') update(c, it); }, 5000);
    paint();
  };

  function submit() {
    const v = ta.value;
    if (!v.trim()) return;
    if (!App.project) return App.toast('Open a project folder first.');
    ta.value = ''; autosize();
    C.send(v);
  }
  function autosize() { ta.style.height = 'auto'; ta.style.height = Math.min(220, ta.scrollHeight + 2) + 'px'; }

  async function onLinkClick(e) {
    const a = e.target.closest('a[data-path]');
    if (!a) return;
    e.preventDefault();
    const chat = cur();
    const m = a.dataset.path.match(/^(.*?)(?:#L(\d+)(?:-L?\d+)?|:(\d+))?$/);
    let p = decodeURI(m[1]);
    if (!p.startsWith('/') && !p.startsWith('~')) p = App.join(chat ? chat.project : App.project, p);
    const line = Number(m[2] || m[3]) || 0;
    const t = await App.views.editor.openFile(p.replace(/^~/, App.env.home || '~'));
    const ed = App.views.editor.editor;
    if (t && line && ed) setTimeout(() => { ed.revealLineInCenter(line); ed.setPosition({ lineNumber: line, column: 1 }); ed.focus(); }, 30);
  }

  function paint() {
    if (!logEl) return;
    logEl.innerHTML = '';
    const chat = cur();
    if (!App.project) { logEl.append(h('div.chat-empty', h('p', 'Open a project folder to talk to the agent.'))); paintState(); return; }
    if (!chat || !chat.items.length) {
      logEl.append(h('div.chat-empty',
        h('h3', 'What should we work on?'),
        h('p', `Ask about ${App.basename(App.project)} or describe a task. The agent answers directly, or plans the work, checks with you, and hands it to Codex and Claude specialists.`),
        h('div.chat-examples', EXAMPLES.map((x) => h('button', { onclick: () => { ta.value = x; autosize(); focus(); } }, x)))));
    } else for (const it of chat.items) logEl.append(render(chat, it));
    paintState();
    scrollEnd();
  }

  function paintState() {
    if (!stateEl) return;
    const chat = cur();
    if (chat) modeSel.value = chat.mode;
    modeSel.disabled = !chat;
    const accts = App.cfg.accounts.claude.list;
    acctEl.innerHTML = '';
    if (chat && accts.length > 1) {
      if (chat.started || chat.running) acctEl.append(h('span.hint', { title: 'This conversation stays on the account it started on' }, chat.accountName || chat.account));
      else {
        const U = App.views.usage;
        acctEl.append(h('select', { 'aria-label': 'Claude account for this chat', onchange: (e) => { chat.account = e.target.value; } },
          h('option', { value: 'auto', selected: chat.account === 'auto' }, 'Account: auto'),
          accts.map((a) => { const lv = U && U.level(U.accounts('claude').find((x) => x.name === a.name)); return h('option', { value: a.name, selected: chat.account === a.name }, a.name + (lv != null ? ` (${Math.round(lv)}%)` : '')); })));
      }
    }
    stateEl.innerHTML = '';
    const waiting = chat && Object.keys(chat.requests).length;
    if (chat && chat.busy) stateEl.append(waiting ? h('span.hint', 'Waiting for you') : h('span.hint', h('span.spinner'), ' Working…'));
    stopBtn.hidden = !(chat && chat.busy);
    App.emit('chat-state');
  }
})();
