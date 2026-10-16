// Agent chat: conversations with the orchestrator, a headless Claude Code session
// (main/chat.js), shown as tabs; each tab is its own session. It answers directly or
// hands work to Claude subagents and Codex jobs, which appear here as cards. Permission
// prompts and AskUserQuestion (the approval gates) appear as buttons. Conversations keep
// running while another tab or project is shown.
(function () {
  const h = App.h;
  const C = { byProject: {}, byId: {} }; // byProject[dir] = { tabs: [chat], active: chat }
  App.views.chat = C;
  const dom = new WeakMap(); // item → element
  let logEl, ta, attEl, sugEl, modeSel, acctEl, ctxEl, sendBtn, stopBtn, stateEl, tabsEl, sumEl, noticeEl;

  const MODES = [
    { value: 'default', label: 'Ask before changes' },
    { value: 'acceptEdits', label: 'Accept edits' },
    { value: 'auto', label: 'Auto' },
    { value: 'plan', label: 'Plan only' }
  ];
  const EXAMPLES = ['How is this project organised?', 'Find out why the tests fail and fix it', 'Review my uncommitted changes'];
  const ENGINE = { claude: 'Claude', codex: 'Codex' };
  const DEFAULT_PLACEHOLDER = 'Ask, or describe a task…';
  let personas = [], personaPromise;
  const personaFor = (chat) => chat && personas.find((persona) => persona.id === chat.role);
  const personaName = (id) => (personas.find((persona) => persona.id === id) || {}).name || id;
  function loadPersonas() {
    if (!personaPromise) personaPromise = codeome.chat.personas().catch(() => []).then((list) => {
      personas = Array.isArray(list) ? list : [];
      if (!personas.length) personaPromise = null; // retry on the next paint rather than caching a failure
      if (cur() && !cur().items.length) paint(); else { paintTabs(); paintState(); }
      return personas;
    });
    return personaPromise;
  }
  // Google Docs, Sheets and Slides go through Claude's connectors, which a Codex chat doesn't have.
  const GDOC_RE = /\.(gdoc|gsheet|gslides)\b/i;
  const engineOf = (chat) => (chat && chat.engine === 'codex' ? 'codex' : 'claude');
  const store = { get: (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    const x = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  }

  // ---------- conversations ----------
  function blank(project, opts = {}) {
    const chat = { id: uuid(), project, title: '', engine: opts.engine === 'codex' ? 'codex' : 'claude', role: '', account: opts.account || 'auto', accountName: null, mode: store.get('codeome.chat.mode', 'default'),
      started: false, items: [], createdAt: Date.now() };
    return live(chat);
  }
  // Runtime-only state, rebuilt for a saved conversation.
  function live(chat) {
    if (typeof chat.role !== 'string') chat.role = '';
    Object.assign(chat, { running: false, busy: false, stream: {}, tools: {}, requests: {}, attach: [] });
    for (const it of chat.items) {
      if (it.id) chat.tools[it.id] = it;
      if ((it.t === 'perm' || it.t === 'ask') && !it.decided && !it.answers) it.expired = true;
      if (it.t === 'tool' && !it.done) it.done = true;
      if (it.t === 'text') it.live = false;
    }
    C.byId[chat.id] = chat;
    return chat;
  }
  const cur = () => { const t = C.byProject[App.project]; return t ? t.active : null; };
  const tabsOf = (project) => (C.byProject[project] ? C.byProject[project].tabs : []);
  C.current = cur;
  C.isBusy = (project) => tabsOf(project).some((c) => c.busy);
  C.title = () => { const c = cur(); return c && c.title; };
  const waiting = (c) => Object.keys(c.requests).length > 0;
  const runningJobs = (c) => c.items.filter((x) => x.t === 'job' && x.status === 'running');

  // What the tabs, the summary line and the project cards show.
  C.stats = (project) => {
    const s = { sessions: 0, live: 0, working: 0, waiting: 0, unread: 0, subagents: 0, codex: 0 };
    for (const c of tabsOf(project)) {
      s.sessions++;
      if (c.running) s.live++;
      if (waiting(c)) s.waiting++; else if (c.busy) s.working++;
      if (c.unread) s.unread++;
      for (const j of runningJobs(c)) if (j.engine === 'codex') s.codex++; else s.subagents++;
    }
    return s;
  };

  // Tabs reopen from last time; without any, the newest conversation.
  async function restore(project) {
    const saved = (App.cfg.chatTabs || {})[project] || {};
    let ids = (saved.open || []).filter(Boolean);
    if (!ids.length) { const list = await codeome.chat.list(project); if (list[0]) ids = [list[0].id]; }
    const tabs = [];
    for (const id of ids) {
      const c = C.byId[id] || await codeome.chat.load(project, id).then((x) => (x && x.items ? live(x) : null));
      if (c) tabs.push(c);
    }
    if (!tabs.length) tabs.push(blank(project));
    return { tabs, active: tabs.find((c) => c.id === saved.active) || tabs[0] };
  }

  let persistTimer = null;
  function persistTabs(project) {
    const t = C.byProject[project];
    if (!t) return;
    const open = t.tabs.filter((c) => c.started || c.items.length).map((c) => c.id);
    const entry = { open, active: t.active && open.includes(t.active.id) ? t.active.id : null };
    App.cfg.chatTabs = App.cfg.chatTabs || {};
    if (JSON.stringify(App.cfg.chatTabs[project]) === JSON.stringify(entry)) return;
    App.cfg.chatTabs[project] = entry;
    clearTimeout(persistTimer); persistTimer = setTimeout(() => App.saveConfig(), 500);
  }

  let saveTimers = {};
  function save(chat, now) {
    if (!chat.started && !chat.items.length) return;
    clearTimeout(saveTimers[chat.id]);
    const run = () => {
      const items = chat.items.map((it) => (it.result && it.result.length > 4000 ? { ...it, result: it.result.slice(0, 4000) + '\n…' } : it));
      codeome.chat.save(chat.project, { id: chat.id, title: chat.title, engine: engineOf(chat), role: chat.role || '', account: chat.account, accountName: chat.accountName, mode: chat.mode, started: chat.started, createdAt: chat.createdAt, usage: chat.usage, items });
    };
    if (now) run(); else saveTimers[chat.id] = setTimeout(run, 800);
  }

  // A new tab; an unused blank tab is reused rather than piling up.
  C.newChat = async (opts = {}) => {
    const project = App.project;
    if (!project) return App.toast('Open a project folder first.');
    const t = C.byProject[project] || (C.byProject[project] = { tabs: [], active: null });
    let chat = t.tabs.find((c) => !c.started && !c.items.length && !c.running);
    if (chat) { chat.role = ''; if (opts.engine) { chat.engine = opts.engine === 'codex' ? 'codex' : 'claude'; chat.account = 'auto'; } if (opts.account) chat.account = opts.account; }
    else { chat = blank(project, opts); t.tabs.push(chat); }
    C.activate(chat);
    if (opts.send) C.send(opts.send); else focus();
  };

  // Open a saved conversation in a tab (or show its tab).
  C.open = async (id) => {
    const project = App.project;
    const t = C.byProject[project];
    if (!t) return;
    let c = t.tabs.find((x) => x.id === id);
    if (!c) {
      c = C.byId[id] || await codeome.chat.load(project, id).then((s) => (s && s.items ? live(s) : null));
      if (!c) return App.err('That conversation could not be loaded.');
      t.tabs.push(c);
    }
    C.activate(c);
  };

  C.activate = (chat) => {
    const t = C.byProject[chat.project];
    if (!t) return;
    const old = t.active;
    if (old && ta && chat.project === App.project && old !== chat) old.draft = ta.value;
    t.active = chat;
    if (chat.project !== App.project) return persistTabs(chat.project);
    if (ta && old !== chat) { ta.value = chat.draft || ''; autosize(); }
    paint();
    App.emit('chat');
    persistTabs(chat.project);
  };

  // Close a tab; the conversation stays in Recent chats.
  C.closeTab = async (chat) => {
    const t = C.byProject[chat.project];
    if (!t) return;
    if (chat.busy && !(await App.confirm('Close this chat?', 'The agent is still working in it. It will be stopped; specialist jobs it started keep running. You can reopen the conversation from Recent chats.', 'Close chat', true))) return;
    if (chat.running) { chat.stopping = true; codeome.chat.stop(chat.id); }
    const i = t.tabs.indexOf(chat);
    if (i < 0) return;
    t.tabs.splice(i, 1);
    save(chat, true);
    if (!t.tabs.length) t.tabs.push(blank(chat.project));
    if (t.active === chat) { t.active = null; C.activate(t.tabs[Math.min(i, t.tabs.length - 1)]); }
    else { paintTabs(); persistTabs(chat.project); App.emit('chat-state'); }
  };

  async function renameTab(chat) {
    const v = await App.prompt('Rename chat', 'Name', chat.title || '');
    if (v == null) return;
    chat.title = v.slice(0, 80);
    save(chat, true); paintTabs(); App.emit('chat');
  }

  C.cycle = (step) => {
    const t = C.byProject[App.project];
    if (!t || t.tabs.length < 2) return;
    const i = t.tabs.indexOf(t.active);
    C.activate(t.tabs[(i + step + t.tabs.length) % t.tabs.length]);
  };

  C.history = async () => {
    if (!App.project) return [];
    const list = await codeome.chat.list(App.project);
    const open = new Set(tabsOf(App.project).map((c) => c.id));
    return list.filter((x) => !open.has(x.id)).slice(0, 10);
  };

  C.remove = async (id) => { await codeome.chat.delete(App.project, id); };

  // ---------- history ----------
  // Every saved conversation of the project, newest first, behind the clock button in the
  // Agent header. Picking one opens it in a tab; one that is not open can be deleted.
  const DAY = 86400000;
  function dayGroup(ms) {
    const d = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / DAY + 0.5);
    return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : d < 7 ? 'This week' : d < 30 ? 'This month' : 'Older';
  }

  C.openHistory = async (anchor) => {
    if (App.pop && App.pop.hist) return App.closePopover();
    const project = App.project;
    if (!project) return App.toast('Open a project folder first.');
    let list = await codeome.chat.list(project), q = '', arming = null;
    await loadPersonas();
    if (project !== App.project) return;
    const multi = App.cfg.accounts.claude.list.length + App.cfg.accounts.codex.list.length > 2;
    const listEl = h('div.hist-list'), countEl = h('span.hint');
    const pick = (c) => { App.closePopover(); if (project === App.project) C.open(c.id); };
    const shown = () => list.filter((c) => !q || c.title.toLowerCase().includes(q));
    const draw = () => {
      const open = new Set(tabsOf(project).map((c) => c.id)), rows = shown();
      countEl.textContent = list.length ? `${list.length} chat${list.length > 1 ? 's' : ''}` : '';
      listEl.innerHTML = '';
      if (!rows.length) return listEl.append(h('div.empty', list.length ? 'No chat matches.' : 'No saved chats in this project yet. A chat is saved with its first message.'));
      let group = null;
      for (const c of rows) {
        const g = dayGroup(c.updatedAt);
        if (g !== group) { group = g; listEl.append(h('div.hist-day', g)); }
        const live = C.byId[c.id], title = (live && open.has(c.id) && live.title) || c.title;
        const sub = [c.engine === 'codex' ? 'Codex' : null, c.role ? personaName(c.role) : null, App.fmtAgo(c.updatedAt), c.messages ? `${c.messages} message${c.messages > 1 ? 's' : ''}` : null, multi && c.account && c.account !== 'auto' ? c.account : null].filter(Boolean).join(' · ');
        listEl.append(h('div.hist-row',
          h('button.hist-open', { title, onclick: () => pick(c) }, h('span.hist-t', title), h('span.hist-s', sub)),
          open.has(c.id) ? h('span.pill.ok', 'open')
            : arming === c.id ? h('button.btn.small.danger', { onclick: async () => { await codeome.chat.delete(project, c.id); delete C.byId[c.id]; list = list.filter((x) => x !== c); arming = null; draw(); } }, 'Delete')
              : h('button.icon-btn.small', { title: 'Delete this chat', 'aria-label': 'Delete ' + title, onclick: () => { arming = c.id; draw(); listEl.querySelector('.btn.danger')?.focus(); }, html: App.icons.trash })));
      }
    };
    const search = h('input', { type: 'text', placeholder: 'Search chats', 'aria-label': 'Search chats',
      oninput: (e) => { q = e.target.value.trim().toLowerCase(); arming = null; draw(); },
      onkeydown: (e) => { if (e.key === 'Enter' && shown()[0]) pick(shown()[0]); } });
    draw();
    App.popover(anchor, h('div.u-pop.hist',
      h('div.u-pop-head', h('h3', 'Chat history'), countEl),
      h('div.hist-search', search), listEl,
      h('div.u-pop-foot', h('button.btn.small', { onclick: () => { App.closePopover(); C.newChat(); } }, 'New chat'), h('span.grow'),
        h('button.btn.small.ghost', { onclick: () => { App.closePopover(); C.openFullHistory(); } }, 'Show full history'))), 'Chat history').hist = true;
  };

  // A page (tab) with a link to every saved chat of the project, grouped by day.
  C.openFullHistory = () => {
    const project = App.project;
    if (!project) return App.toast('Open a project folder first.');
    let reload = () => {};
    return App.views.editor.openCustom({
      key: 'chat-history', title: 'Chat history', badge: 'Agent', onActivate: () => reload(),
      render: (el) => {
        let q = '';
        const body = h('div.stats-page.hist-page');
        let list = [];
        const draw = () => {
          body.innerHTML = '';
          const rows = list.filter((c) => !q || c.title.toLowerCase().includes(q));
          if (!rows.length) return body.append(h('div.empty', list.length ? 'No chat matches.' : 'No saved chats in this project yet. A chat is saved with its first message.'));
          let group = null, box = null;
          for (const c of rows) {
            const g = dayGroup(c.updatedAt);
            if (g !== group) { group = g; body.append(h('h3', g), box = h('div.hist-links')); }
            const sub = [c.engine === 'codex' ? 'Codex' : null, c.role ? personaName(c.role) : null, App.fmtAgo(c.updatedAt), c.messages ? `${c.messages} message${c.messages > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ');
            box.append(h('button.hist-open', { title: c.title, onclick: () => { if (project === App.project) C.open(c.id); } }, h('span.hist-t', c.title), h('span.hist-s', sub)));
          }
        };
        reload = async () => { await loadPersonas(); list = await codeome.chat.list(project); draw(); };
        el.append(h('div.toolbar.st-bar',
          h('span.hint.grow', 'Every saved chat of this project, newest first'),
          h('input', { type: 'text', placeholder: 'Search chats', 'aria-label': 'Search chats', oninput: (e) => { q = e.target.value.trim().toLowerCase(); draw(); } }),
          h('button.btn.small', { onclick: () => reload() }, 'Refresh')), body);
        reload();
      }
    });
  };

  // Put text in the composer (from the editor or file browser) and focus it.
  C.ask = (text) => {
    App.setView('agents');
    App.views.agents.show('chat');
    if (ta) { ta.value = (ta.value ? ta.value.replace(/\s*$/, '\n') : '') + text; autosize(); }
    paintNotice();
    focus();
  };
  function focus() { setTimeout(() => { if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }, 0); }

  C.closeProject = (project) => {
    for (const c of tabsOf(project)) if (c.running) { c.stopping = true; codeome.chat.stop(c.id); }
    delete C.byProject[project];
  };

  // ---------- sending ----------
  // files: paths attached to the message. The agent gets them as a list under the text
  // and reads the ones it needs.
  const withFiles = (text, files) => (files.length ? (text ? text + '\n\n' : '') + 'Attached files:\n' + files.map((f) => '- ' + f).join('\n') : text);

  C.send = async (text, files = []) => {
    const chat = cur();
    text = String(text || '').trim();
    if (!chat || (!text && !files.length)) return;
    if (!chat.title) chat.title = (text || files.map(App.basename).join(', ')).replace(/\s+/g, ' ').slice(0, 80);
    push(chat, files.length ? { t: 'user', text, files } : { t: 'user', text });
    clearSuggest(chat);
    App.emit('chat');
    if (!chat.running && !(await start(chat))) return;
    chat.busy = true; chat.busySince = Date.now(); paintState();
    const r = await codeome.chat.send(chat.id, withFiles(text, files));
    if (r.error) { note(chat, r.error, 'error'); chat.busy = false; paintState(); }
    chat.started = true;
    save(chat, true);
    persistTabs(chat.project);
  };

  async function start(chat) {
    if (!(await App.setup.ensureCli(engineOf(chat)))) { note(chat, `${ENGINE[engineOf(chat)]} is not installed on this Mac, so this chat cannot start.`, 'error'); return false; }
    // A conversation lives in its account's config folder, so it resumes there.
    const r = await codeome.chat.start({ id: chat.id, project: chat.project, engine: engineOf(chat), role: chat.role || '', account: chat.started ? chat.accountName || chat.account : chat.account, resume: chat.started, mode: chat.mode,
      meter: chat.usage ? { context: chat.usage.context, run: chat.usage.run } : null });
    if (r.error) { note(chat, r.error, 'error'); return false; }
    chat.running = true;
    const a = r.account;
    if (a && a.name) {
      chat.accountName = a.name;
      const E = ENGINE[engineOf(chat)];
      if (a.blocked) App.toast(`Every ${E} account is near its usage limit. The chat runs on ${a.name} anyway.`, { error: true });
      else if (a.switched) App.toast(`${E} account ${a.from} is near its limit, so this chat runs on ${a.name}.`);
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

  function accountMenu(chat, anchor) {
    const U = App.views.usage, r = anchor.getBoundingClientRect(), eng = engineOf(chat);
    const on = chat.accountName || chat.account;
    App.menu(r.left, r.bottom + 4, [{ header: ENGINE[eng] + ' account for this chat' }, ...App.cfg.accounts[eng].list.map((a) => {
      const u = U && U.accounts(eng).find((x) => x.name === a.name), lv = U && U.level(u);
      return { label: (a.name === on ? '✓ ' : '') + a.name + (lv != null ? ` (${Math.round(lv)}%)` : ''), disabled: a.name === on || !!(u && !U.ready(u)), run: () => switchAccount(chat, a.name) };
    })]);
  }

  // A started conversation moves with its transcript; the next message resumes it on the new account.
  async function switchAccount(chat, name) {
    const from = chat.accountName || chat.account;
    // Work cut short by a limit or an error, or stopped by this switch, carries on under the new account.
    const halted = chat.busy || chat.outcome === 'error';
    if (chat.busy && !(await App.confirm('Switch this chat to ' + name + '?', 'The agent is still working. It will be stopped, and the conversation continues on ' + name + '.', 'Switch', true))) return;
    if (chat.running) { chat.stopping = true; await codeome.chat.stop(chat.id); for (let i = 0; chat.running && i < 50; i++) await new Promise((res) => setTimeout(res, 100)); }
    if (chat.running) { chat.stopping = false; return App.err('The session did not stop, so the account was not changed.'); }
    const r = await codeome.chat.move({ id: chat.id, engine: engineOf(chat), from, to: name });
    if (r.error) return App.err(r.error);
    chat.account = chat.accountName = name;
    note(chat, `This chat now runs on ${name}.`);
    save(chat); paintState(); App.emit('sessions');
    if (halted && chat.started && cur() === chat) {
      chat.outcome = '';
      C.send('The previous account was switched to ' + name + ' and your work was halted. Please pick up exactly where you left off and continue with the task.');
    }
  }

  function setMode(v) {
    const chat = cur();
    store.set('codeome.chat.mode', v);
    if (!chat) return;
    chat.mode = v;
    if (chat.running) codeome.chat.control(chat.id, { subtype: 'set_permission_mode', mode: v }).then((r) => { if (r.error && engineOf(chat) === 'claude') App.err(r.error); });
    save(chat);
  }

  // Continue the same conversation in a Claude Code terminal session.
  C.toTerminal = async () => {
    if (App.isIdeas()) return;
    const chat = cur();
    if (!chat || !chat.started) return App.toast('Send a message first.');
    if (engineOf(chat) === 'codex') return App.toast('Codex chats can\'t continue in a terminal yet.');
    if (chat.busy && !(await App.confirm('Move this chat to a terminal?', 'The agent is still working. It will be stopped here and the conversation reopened in a terminal.', 'Move', true))) return;
    if (chat.running) { chat.stopping = true; await codeome.chat.stop(chat.id); }
    let cmd = (App.cfg.agents.find((a) => /^claude(\s|$)/.test(a.cmd)) || { cmd: 'claude' }).cmd;
    const { model, effort } = App.cfg.chat || {};
    if (model) cmd = cmd.replace(/\s--model(=|\s+)\S+/, '') + ' --model ' + model;
    if (effort) cmd = cmd.replace(/\s--effort(=|\s+)\S+/, '') + ' --effort ' + effort;
    App.views.terminals.open({ kind: 'agent-local', title: 'Agent chat', command: cmd + ' --resume ' + chat.id + App.views.projects.linksOf(chat.project).map((d) => ' --add-dir ' + App.shq(d)).join(''), cwd: chat.project, badge: 'Mac', engine: 'claude', account: chat.accountName || 'auto' });
    note(chat, 'Continued in a terminal. Messages sent there are not shown here, but the agent remembers them.', 'info');
    save(chat);
  };

  // ---------- events from the session ----------
  codeome.chat.onEvent(({ id, msg }) => { const chat = C.byId[id]; if (chat) handle(chat, msg); });
  codeome.chat.onExit(({ id, code, signal, stderr }) => {
    const chat = C.byId[id];
    if (!chat) return;
    chat.running = false; chat.busy = false; chat.busySince = 0; chat.stream = {};
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
        if (m.subtype === 'init') { chat.busy = true; chat.busySince ||= Date.now(); chat.model = m.model; paintState(); }
        else if (m.subtype === 'task_notification') taskEnded(chat, m.tool_use_id, m.status);
        else if (m.subtype === 'compact_boundary') note(chat, 'Earlier messages were summarised to free up context.', 'info');
        break;
      case 'text_delta': delta(chat, m); break;
      case 'context': contextMoved(chat, m); break;
      case 'turn_usage': turnUsed(chat, m); break;
      case 'assistant': assistant(chat, m); break;
      case 'user': results(chat, m); break;
      case 'control_request': request(chat, m); break;
      case 'control_cancel_request': {
        const req = chat.requests[m.request_id];
        if (req) { req.item.expired = true; delete chat.requests[m.request_id]; update(chat, req.item); }
        break;
      }
      case 'result': {
        chat.busy = false; chat.busySince = 0; chat.stream = {};
        for (const it of chat.items) if (it.t === 'text' && it.live) { it.live = false; update(chat, it); }
        const failed = (m.subtype && m.subtype !== 'success') || (m.is_error && m.result);
        if (m.subtype && m.subtype !== 'success') note(chat, m.subtype === 'error_max_turns' ? 'The agent stopped: it reached its turn limit.' : 'The agent stopped with an error' + (m.result ? ': ' + m.result : '.'), 'error');
        else if (m.is_error && m.result) note(chat, m.result, 'error');
        chat.outcome = failed ? 'error' : 'done';
        chat.finishedAt = Date.now();
        chat.unread = !seen(chat);
        paintState(); App.emit('sessions'); save(chat);
        attention(chat, failed ? 'The agent stopped with an error.' : 'The agent finished.');
        if (!failed) suggestReplies(chat);
        break;
      }
    }
  }

  // ---------- token use ----------
  // What the session's meter (main/stats.js) reports: how full the context window is, and
  // what each turn used. The totals are kept with the conversation.
  const USED = ['input', 'output', 'cacheRead', 'cacheWrite'];
  const warnAt = () => Math.min(95, Math.max(20, Number((App.cfg.chat || {}).contextWarnAt) || 70));
  const ctxPct = (chat) => { const u = chat && chat.usage; return u && u.window && u.context ? Math.min(100, u.context / u.window * 100) : null; };
  const ctxTone = (p) => (p == null ? 'none' : p >= Math.min(97, warnAt() + 15) ? 'bad' : p >= warnAt() ? 'warn' : 'ok');
  const meterOf = (chat) => chat.usage || (chat.usage = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, context: 0, window: 0, peak: 0, compactions: 0 });

  function contextMoved(chat, m) {
    const u = meterOf(chat);
    u.context = m.used;
    if (m.window) u.window = m.window;
    u.peak = Math.max(u.peak, m.used);
    if (chat === cur()) paintCtx();
  }

  function turnUsed(chat, t) {
    const u = meterOf(chat);
    u.turns++;
    for (const k of [...USED, 'costUsd', 'compactions']) u[k] += t[k] || 0;
    Object.assign(u, { context: t.context, window: t.window || u.window, peak: Math.max(u.peak, t.peak || 0), run: t.run });
    // What this turn used is kept on its last reply, for the chat's overview.
    const last = chat.items.findLast((x) => x.t === 'text');
    if (last && !last.tok) last.tok = { in: t.input || 0, out: t.output || 0, cr: t.cacheRead || 0, cw: t.cacheWrite || 0 };
    // Said once each time the chat passes the mark (again after it was summarised and refilled).
    const p = ctxPct(chat);
    if (p != null && p >= warnAt() && !u.warned) {
      u.warned = true;
      push(chat, { t: 'note', kind: 'info', newChat: true, text: `This chat has filled ${Math.round(p)}% of its context window (${App.fmtTokens(u.context)} of ${App.fmtTokens(u.window)} tokens). Every turn sends all of it again, so turns here use more of your limits than in a new chat, and once it is full the earlier messages are summarised. For the next task, start a new chat.` });
    } else if (p != null && p < warnAt()) u.warned = false;
    if (chat === cur()) paintCtx();
  }

  // The context meter beside the account: a bar and a percentage, with the session's totals behind it.
  function paintCtx() {
    if (!ctxEl) return;
    const chat = cur(), u = chat && chat.usage;
    ctxEl.hidden = !(u && u.context);
    if (ctxEl.hidden) return;
    const p = ctxPct(chat);
    const tip = p == null ? `${App.fmtTokens(u.context)} tokens in this chat's context` : `Context window ${Math.round(p)}% full (${App.fmtTokens(u.context)} of ${App.fmtTokens(u.window)} tokens)`;
    ctxEl.className = 'chat-ctx ' + ctxTone(p);
    ctxEl.title = tip; ctxEl.setAttribute('aria-label', tip);
    ctxEl.innerHTML = '';
    ctxEl.append(h('span.u-bar', h('i', { style: { width: (p || 0) + '%' } })), h('span.u-v', p == null ? App.fmtTokens(u.context) : Math.round(p) + '%'));
    if (App.pop && App.pop.ctx === chat) App.pop.set(ctxPop(chat));
  }

  function openCtx() {
    const chat = cur();
    if (!chat || !chat.usage) return;
    if (App.pop && App.pop.ctx === chat) return App.closePopover();
    App.popover(ctxEl, ctxPop(chat), 'Token use of this chat').ctx = chat;
  }

  function ctxPop(chat) {
    const u = chat.usage, p = ctxPct(chat), tone = ctxTone(p);
    const all = USED.reduce((n, k) => n + u[k], 0);
    const row = (k, v, title) => h('div.cx-row', { title }, h('span', k), h('b', v));
    const advice = p == null ? 'How large the context window is shows after the first reply.'
      : tone === 'bad' ? 'Nearly full. Claude Code will soon summarise the earlier messages to make room, and details get lost. Start a new chat for the next task.'
        : tone === 'warn' ? 'Getting full. Every turn sends the whole conversation again, so turns here use more of your limits than in a new chat.'
          : 'Plenty of room.';
    return h('div.u-pop',
      h('div.u-pop-head', h('h3', 'This chat')),
      h('div.u-acc',
        h('div.u-line.' + tone, h('span.u-k', 'Context'), h('span.u-bar', h('i', { style: { width: (p || 0) + '%' } })), h('span.u-v', p == null ? '–' : Math.round(p) + '%'),
          h('span.u-r', App.fmtTokens(u.context) + (u.window ? ' of ' + App.fmtTokens(u.window) : '') + ' tokens')),
        h('div.sub', advice)),
      u.turns ? h('div.u-acc',
        row('Turns', String(u.turns)),
        row('Tokens processed', App.fmtTokens(all), `New input ${App.fmtTokens(u.input)} · written to the cache ${App.fmtTokens(u.cacheWrite)} · read from the cache ${App.fmtTokens(u.cacheRead)} · replies ${App.fmtTokens(u.output)}. Subagents are counted; Codex jobs are not.`),
        row('Of which replies', App.fmtTokens(u.output)),
        u.costUsd ? row('At API prices', App.fmtUsd(u.costUsd), 'What these tokens cost at API list prices. On a subscription nothing is charged; the figure weighs cached and new tokens the way your limits do.') : null,
        u.compactions ? row('Summarised to make room', u.compactions === 1 ? 'once' : u.compactions + ' times') : null,
        chat.model ? row('Model', chat.model) : null) : null,
      h('div.u-pop-foot',
        h('button.btn.small', { onclick: () => { App.closePopover(); C.newChat(); } }, 'New chat'),
        h('span.grow'),
        h('button.btn.small.ghost', { onclick: () => { App.closePopover(); App.views.stats.open(); } }, 'Statistics')));
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
    chat.busy = true; chat.busySince ||= Date.now();
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

  // A specialist that ends after the turn is over (or while the user is elsewhere) leaves
  // the chat flagged as having news, so the project card can say so.
  function jobFinished(chat) {
    if (chat.busy || seen(chat) || chat.unread) return;
    chat.unread = true;
    paintState(); App.emit('sessions'); save(chat);
  }

  function taskEnded(chat, toolUseId, status) {
    const it = chat.tools[toolUseId];
    if (!it) return;
    if (it.t === 'job' && it.status === 'running') { jobFinished(chat); it.status = status === 'completed' ? 'done' : status === 'killed' ? 'cancelled' : 'failed'; it.endedAt = Date.now(); }
    if (it.t === 'tool') it.done = true;
    update(chat, it);
    App.views.agents.refreshSoon();
  }

  // Job records (.codeome/jobs) carry the authoritative status and the log; link each card to one.
  C.syncJobs = (project, jobs) => {
    const chats = tabsOf(project);
    const claimed = new Set(chats.flatMap((c) => c.items.filter((x) => x.t === 'job' && x.jobId).map((x) => x.jobId)));
    for (const chat of chats) for (const it of chat.items) {
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
        if (status !== it.status && status !== 'stale') { if (it.status === 'running' && status !== 'running' && status !== 'held') jobFinished(chat); it.status = status; if (status !== 'running') it.endedAt = Date.parse(j.endedAt) || Date.now(); }
        it.account = j.account;
      }
      if (it.status === 'running' || j) update(chat, it);
    }
    scheduleTabs();
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

  // Plain text with file paths turned into links the log's click handler opens in the editor.
  function linkPaths(text) {
    const re = /(?:~\/|\.{0,2}\/)?(?:[\w.@-]+\/)+[\w.@-]+\.\w{1,8}(?::\d+)?/g;
    const out = []; let at = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > at) out.push(text.slice(at, m.index));
      out.push(h('a', { href: '#', 'data-path': m[0] }, m[0]));
      at = m.index + m[0].length;
    }
    if (at < text.length) out.push(text.slice(at));
    return out;
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

  // Is this chat on screen right now?
  const seen = (chat) => !document.hidden && App.currentView === 'agents' && App.views.agents.pane === 'chat' && chat.project === App.project && chat === cur();

  function attention(chat, text) {
    if (seen(chat)) return;
    const where = App.basename(chat.project) + (tabsOf(chat.project).length > 1 ? ' · ' + (chat.title || 'New chat').slice(0, 40) : '');
    App.toast(`${where}: ${text}`, { action: { label: 'Show', run: () => C.reveal(chat) } });
  }

  C.reveal = async (chat) => {
    await App.views.projects.switchTo(chat.project);
    App.setView('agents'); App.views.agents.show('chat');
    C.activate(chat);
  };

  C.markSeen = () => markSeen();
  function markSeen() {
    const c = cur();
    if (c && c.unread && seen(c)) { c.unread = false; paintTabs(); App.emit('chat-state'); }
  }

  // ---------- items ----------
  function push(chat, it) {
    if (!it.at) it.at = Date.now();
    chat.items.push(it);
    if (chat === cur() && logEl) { const stick = atBottom(); logEl.querySelector('.chat-empty')?.remove(); logEl.append(render(chat, it)); paintThinking(); if (stick) scrollEnd(); }
  }

  // ---------- "is thinking" line ----------
  // Shown at the end of the log from the moment a message is sent until the turn ends, so a
  // quiet agent is never mistaken for a stuck one. The timer counts the whole turn.
  let thinkEl = null;
  const clock = (s) => (s < 3600 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : Math.floor(s / 3600) + ':' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'));
  function paintThinking() {
    if (!logEl) return;
    const chat = cur();
    const on = chat && chat.busy && !Object.keys(chat.requests).length && !chat.items.some((x) => x.t === 'text' && x.live);
    if (!on) { if (thinkEl) thinkEl.remove(); return; }
    if (!chat.busySince) chat.busySince = Date.now();
    const secs = Math.max(0, Math.floor((Date.now() - chat.busySince) / 1000));
    if (!thinkEl) thinkEl = h('div.thinking', { role: 'status' });
    const stick = atBottom();
    thinkEl.innerHTML = '';
    thinkEl.append(h('span.spinner'), h('span', ` ${ENGINE[engineOf(chat)]} is thinking…`), h('span.think-t', clock(secs)));
    if (logEl.lastChild !== thinkEl) { logEl.append(thinkEl); if (stick) scrollEnd(); }
  }
  const stamp = (at) => (at ? h('span.stamp', { title: new Date(at).toLocaleString() }, new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : null);
  function note(chat, text, kind) { push(chat, { t: 'note', text, kind }); }
  function remove(chat, it) { chat.items = chat.items.filter((x) => x !== it); const el = dom.get(it); if (el) el.remove(); }

  let raf = new Set(), rafId = 0;
  function update(chat, it) {
    if (it.t === 'job') scheduleTabs();
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
      case 'user': el = h('div.msg.user', it.text, it.files ? h('div.msg-files', it.files.map((f) => h('span.fchip', { title: App.tildify(f) }, h('span', App.basename(f))))) : null); break;
      case 'text': el = h('div.msg.md' + (it.live ? '.live' : ''), { html: App.md(it.text) }); break;
      case 'note': el = h('div.note.' + (it.kind || 'info'), it.text, it.newChat ? [' ', h('button.btn.small', { onclick: () => C.newChat() }, 'New chat')] : null); break;
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
    if ((it.t === 'user' || it.t === 'text') && it.at) el.prepend(stamp(it.at));
    dom.set(it, el);
    return el;
  }

  function openJob(it) {
    const j = it.jobId && App.views.agents.jobs.find((x) => x.id === it.jobId);
    if (j) return App.views.agents.openJob(j);
    if (it.result) return App.views.editor.openCustom({ key: 'chat-job:' + it.id, title: `${it.role} · ${ENGINE[it.engine]}`, badge: 'Agent', render: (el) => el.append(h('pre.logbox', it.result)) });
    App.toast(App.views.agents.kit && App.views.agents.kit.installed ? 'The job record has not appeared yet.' : 'Install the agent kit to record job logs.');
  }
  C.openJob = openJob;
  C.overview = (chat) => App.views.overview.open(chat);

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
        h('div.ask-h', linkPaths(q.question)),
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
    ta = h('textarea.chat-input', { rows: 1, placeholder: DEFAULT_PLACEHOLDER, 'aria-label': 'Message the agent', oninput: autosize, onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    } });
    modeSel = h('select.chat-mode', { 'aria-label': 'What the agent may do without asking', title: 'What the agent may do without asking', onchange: (e) => setMode(e.target.value) },
      MODES.map((m) => h('option', { value: m.value }, m.label)));
    attEl = h('div.chat-attach');
    sugEl = h('div.chat-suggest', { hidden: true, role: 'group', 'aria-label': 'Suggested replies' });
    const attachBtn = h('button.icon-btn', { title: 'Attach files', 'aria-label': 'Attach files', onclick: attach, html: App.icons.plus });
    const quickBtn = h('button.icon-btn', { title: 'Saved messages', 'aria-label': 'Saved messages', 'aria-haspopup': 'menu', onclick: () => App.menuAt(quickBtn, quickMenu(), true), html: App.icons.bolt });
    acctEl = h('span.chat-acct');
    ctxEl = h('button.chat-ctx', { hidden: true, 'aria-haspopup': 'dialog', onclick: openCtx });
    stateEl = h('span.chat-state.grow');
    stopBtn = h('button.btn.small', { onclick: () => C.stop(), hidden: true }, 'Stop');
    sendBtn = h('button.btn.small.primary', { onclick: submit }, 'Send');
    tabsEl = h('div.chat-tabs', { role: 'tablist', 'aria-label': 'Chats' });
    sumEl = h('div.chat-sum', { 'aria-live': 'polite' });
    noticeEl = h('div.chat-notice', { role: 'status', hidden: true });
    host.append(h('div.chat-tabbar', tabsEl, h('button.chat-tab-new', { title: 'New chat (each tab is its own agent session)', 'aria-label': 'New chat', onclick: () => C.newChat(), html: App.icons.plus })),
      sumEl, logEl, noticeEl, h('div.chat-compose', sugEl, attEl, h('div.chat-row', attachBtn, ta, quickBtn), h('div.row.chat-bar', modeSel, acctEl, ctxEl, stateEl, h('span.chat-go', stopBtn, sendBtn))));
    enableDrop(host.querySelector('.chat-compose'));
    const restoring = {};
    App.listen('project', async (p) => {
      if (p && !C.byProject[p]) {
        const r = await (restoring[p] = restoring[p] || restore(p));
        delete restoring[p];
        if (!C.byProject[p]) C.byProject[p] = r;
      }
      if (p === App.project) {
        if (ta) { ta.value = (cur() && cur().draft) || ''; autosize(); }
        paint(); App.emit('chat');
      }
    });
    App.listen('tab', () => paintNotice());
    App.listen('sessions', () => paintNotice());
    App.listen('usage', () => paintState());
    App.listen('config', () => paintState());
    App.listen('view', () => markSeen());
    document.addEventListener('visibilitychange', markSeen);
    window.addEventListener('focus', markSeen);
    ta.addEventListener('input', () => { const c = cur(); if (c) { c.draft = ta.value; paintNotice(); } });
    // The section's width changed: refit the message box and stay at the newest message.
    let pinned = true;
    logEl.addEventListener('scroll', () => { pinned = atBottom(); });
    new ResizeObserver(() => { if (!host.clientWidth) return; autosize(); if (pinned) scrollEnd(); }).observe(host);
    setInterval(paintThinking, 1000);
    setInterval(() => { const c = cur(); if (c && logEl.isConnected) for (const it of c.items) if (it.t === 'job' && it.status === 'running') update(c, it); }, 5000);
    paint();
    loadPersonas();
  };

  function submit() {
    const v = ta.value, chat = cur();
    const files = chat ? chat.attach : [];
    if (!v.trim() && !files.length) return;
    if (!App.project) return App.toast('Open a project folder first.');
    ta.value = ''; autosize();
    if (chat) { chat.draft = ''; chat.attach = []; paintAttach(); }
    C.send(v, files);
  }

  // ---------- attachments ----------
  async function attach() {
    const chat = cur();
    if (!chat) return App.toast('Open a project folder first.');
    const files = await codeome.dialog.files({ defaultPath: chat.project });
    for (const f of files) if (!chat.attach.includes(f)) chat.attach.push(f);
    if (chat === cur()) paintAttach();
    focus();
  }

  // Dropping files (from Finder, or from the local Files section) onto the message box attaches them.
  function enableDrop(box) {
    const droppable = (dt) => dt && (dt.types.includes('Files') || dt.types.includes('codeome/local'));
    box.addEventListener('dragover', (e) => {
      if (!droppable(e.dataTransfer)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; box.classList.add('dropping');
    });
    box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('dropping'); });
    box.addEventListener('drop', (e) => {
      box.classList.remove('dropping');
      if (!droppable(e.dataTransfer)) return;
      e.preventDefault();
      const chat = cur();
      if (!chat) return App.toast('Open a project folder first.');
      const paths = [...e.dataTransfer.files].map((f) => codeome.pathForFile(f)).filter(Boolean);
      if (!paths.length && e.dataTransfer.types.includes('codeome/local')) {
        try { paths.push(JSON.parse(e.dataTransfer.getData('codeome/local')).path); } catch { /* ignore */ }
      }
      for (const f of paths) if (f && !chat.attach.includes(f)) chat.attach.push(f);
      paintAttach(); focus();
    });
  }

  function paintAttach() {
    if (!attEl) return;
    const chat = cur();
    attEl.innerHTML = '';
    for (const f of chat ? chat.attach : []) {
      attEl.append(h('span.fchip', { title: App.tildify(f) }, h('span', App.basename(f)),
        h('button', { title: 'Remove', 'aria-label': 'Remove ' + App.basename(f), onclick: () => { chat.attach = chat.attach.filter((x) => x !== f); paintAttach(); } }, '×')));
    }
  }

  // ---------- suggested replies ----------
  // When a turn ends on a question that lists no options, a small model proposes a few
  // short answers (main/suggest.js, which also skips messages that list their own).
  // They sit above the message box until the user sends anything or the agent moves on.
  function clearSuggest(chat) { if (chat.suggest) { chat.suggest = null; if (chat === cur()) paintSuggest(); } }

  async function suggestReplies(chat) {
    if ((App.cfg.chat || {}).suggest === false || Object.keys(chat.requests).length) return;
    const last = chat.items[chat.items.length - 1];
    if (!last || last.t !== 'text' || !last.text) return;
    if (!/\?[\s*_`"')\]]*$/.test(last.text.trimEnd().split('\n').pop())) return;
    const r = await codeome.chat.suggest(last.text, chat.accountName || chat.account).catch(() => []);
    // Still the newest message, and nothing sent or running since.
    if (!Array.isArray(r) || !r.length || chat.busy || chat.items[chat.items.length - 1] !== last) return;
    chat.suggest = r;
    if (chat === cur()) paintSuggest();
  }

  function paintSuggest() {
    if (!sugEl) return;
    const chat = cur(), list = chat && !chat.busy && chat.suggest;
    sugEl.hidden = !list;
    sugEl.replaceChildren();
    if (!list) return;
    for (const t of list) sugEl.append(h('button.chat-sug', { title: 'Send this reply', onclick: () => sendQuick(t) }, t));
  }

  // ---------- saved messages ----------
  // Messages sent often (Settings: chat.quick). Picking one sends it at once, with any
  // attached files; what is typed in the message box stays there.
  const quick = () => (App.cfg.chat && App.cfg.chat.quick) || [];
  function setQuick(list) { App.cfg.chat = { ...(App.cfg.chat || {}), quick: list }; return App.saveConfig(); }

  function quickMenu() {
    const typed = ta.value.trim();
    const short = (s) => { s = s.replace(/\s+/g, ' '); return s.length > 60 ? s.slice(0, 59) + '…' : s; };
    return [
      { header: quick().length ? 'Send a saved message' : 'No saved messages yet' },
      ...quick().map((m) => ({ label: short(m), run: () => sendQuick(m) })),
      '-',
      { label: 'Save the typed message', disabled: !typed || quick().includes(typed), run: () => setQuick([...quick(), typed]).then(() => App.toast('Saved.')) },
      { label: 'Edit saved messages…', run: editQuick }
    ];
  }

  function sendQuick(text) {
    const chat = cur();
    if (!chat) return App.toast('Open a project folder first.');
    const files = chat.attach;
    chat.attach = []; paintAttach();
    C.send(text, files);
  }

  async function editQuick() {
    const r = await App.modal({ title: 'Saved messages', text: 'One message per line. They are listed under the button to the right of the message box, and picking one sends it.', ok: 'Save',
      fields: [{ key: 'v', label: 'Messages', type: 'textarea', rows: 8, value: quick().join('\n'), placeholder: 'Commit, push and deploy' }] });
    if (!r) return;
    await setQuick([...new Set(r.v.split('\n').map((x) => x.trim()).filter(Boolean))]);
  }
  function autosize() { ta.style.height = 'auto'; ta.style.height = Math.min(220, ta.scrollHeight + 2) + 'px'; }

  async function onLinkClick(e) {
    const a = e.target.closest('a[data-path]');
    if (!a) return;
    e.preventDefault();
    const chat = cur();
    const m = a.dataset.path.match(/^(.*?)(?:#L(\d+)(?:-L?\d+)?|:(\d+))?$/);
    let p = decodeURI(m[1]);
    if (!p.startsWith('/') && !p.startsWith('~')) {
      const root = chat ? chat.project : App.project;
      const direct = App.join(root, p);
      // A bare name is often a file in a subfolder: look for it when it is not at the root.
      const here = await codeome.local.read(direct);
      if (here && here.error) {
        const found = await codeome.local.find(root, p);
        if (found && found.length) p = found[0];
        else p = direct;
      } else p = direct;
    }
    const line = Number(m[2] || m[3]) || 0;
    const t = await App.views.editor.openFile(p.replace(/^~/, App.env.home || '~'));
    const ed = App.views.editor.editor;
    if (t && line && ed) setTimeout(() => { ed.revealLineInCenter(line); ed.setPosition({ lineNumber: line, column: 1 }); ed.focus(); }, 30);
  }

  function paint() {
    if (!logEl) return;
    logEl.innerHTML = '';
    const chat = cur();
    if (chat && chat.unread && seen(chat)) chat.unread = false;
    if (!App.project) { logEl.append(h('div.chat-empty', h('p', 'Open a project folder to talk to the agent.'))); paintAttach(); paintState(); return; }
    if (!chat || !chat.items.length) {
      const selectable = chat && !chat.started && !chat.running;
      const selected = personaFor(chat);
      const examples = selected ? selected.examples : (!chat || !chat.role ? EXAMPLES : []);
      logEl.append(h('div.chat-empty',
        h('h3', 'What should we work on?'),
        h('p', App.isIdeas() ? 'Ideas: chat and forum with no project. Open a project folder when an idea is ready.' : personas.length && selectable ? `Pick a specialist, or just type to talk to the default agent about ${App.basename(App.project)}.` : `Ask about ${App.basename(App.project)} or describe a task. The agent answers directly, or plans the work, checks with you, and hands it to Codex and Claude specialists.`),
        !App.isIdeas() && selectable && personas.length ? h('div.chat-personas', personas.map((persona, index) => h('button.chat-persona', {
          'aria-pressed': String(chat.role === persona.id), onclick: () => {
            if (chat.started || chat.running || chat.items.length) return;
            chat.role = chat.role === persona.id ? '' : persona.id;
            if (chat.role && persona.engine && chat.engine !== persona.engine) { chat.engine = persona.engine; chat.account = 'auto'; }
            paint();
            logEl.querySelectorAll('.chat-persona')[index]?.focus();
          }
        }, h('span.chat-persona-text', h('strong.chat-persona-name', persona.name), h('span.chat-persona-desc', persona.description)),
        persona.engine ? h('span.chat-persona-engine', ENGINE[persona.engine]) : null))) : null,
        !App.isIdeas() && examples && examples.length ? h('div.chat-examples', examples.map((x) => h('button', { onclick: () => { ta.value = x; autosize(); focus(); } }, x))) : null));
    } else for (const it of chat.items) logEl.append(render(chat, it));
    paintAttach();
    paintState();
    scrollEnd();
  }

  // In a Codex chat: said when the user is looking at, or writing about, a Google document.
  function paintNotice() {
    if (!noticeEl) return;
    const chat = cur(), E = App.views.editor, tab = E && E.cur && E.cur();
    const lastUser = chat && [...chat.items].reverse().find((x) => x.t === 'user');
    const on = !!chat && engineOf(chat) === 'codex' && App.project === chat.project
      && ((tab && E.isGdoc && tab.kind !== 'file' && String(tab.key || '').startsWith('gdoc:')) || GDOC_RE.test((ta && ta.value) || '') || !!(lastUser && GDOC_RE.test(lastUser.text || '')));
    noticeEl.hidden = !on;
    if (!on) return noticeEl.replaceChildren();
    if (noticeEl.firstChild) return;
    noticeEl.append(h('span', 'Codex can\'t edit Google Docs, Sheets or Slides. Start a Claude chat to edit this document.'),
      h('button.btn.small', { onclick: () => C.newChat({ engine: 'claude' }) }, 'New Claude chat'));
  }

  function paintState() {
    if (!stateEl) return;
    paintSuggest();
    const chat = cur();
    if (chat) modeSel.value = chat.mode;
    modeSel.disabled = !chat;
    const persona = personaFor(chat);
    ta.placeholder = persona ? persona.placeholder : DEFAULT_PLACEHOLDER;
    const eng = engineOf(chat), accts = App.cfg.accounts[eng].list;
    acctEl.innerHTML = '';
    if (chat) {
      // The engine is chosen with the first message and stays.
      if (chat.started || chat.running || chat.items.length) acctEl.append(h('span.pill' + (eng === 'codex' ? '.codex' : '.ok'), { title: ENGINE[eng] + ' chat' }, ENGINE[eng]));
      else acctEl.append(h('select', { 'aria-label': 'AI for this chat', disabled: !!(persona && persona.engine), onchange: (e) => { chat.engine = e.target.value; chat.account = 'auto'; paintState(); } },
        Object.entries(ENGINE).map(([k, v]) => h('option', { value: k, selected: eng === k }, v))));
      if (chat.role && (chat.started || chat.running || chat.items.length)) acctEl.append(h('span.pill.chat-persona-pill', { title: personaName(chat.role) }, personaName(chat.role)));
    }
    if (chat && accts.length > 1) {
      if (chat.started || chat.running) {
        acctEl.append(eng === 'codex'
          ? h('span.hint', { title: 'Codex chats can\'t change account yet' }, chat.accountName || chat.account)
          : h('button.chat-acct-btn', { title: 'Switch this chat to another Claude account', 'aria-haspopup': 'menu', onclick: (e) => accountMenu(chat, e.currentTarget) }, chat.accountName || chat.account));
      } else {
        const U = App.views.usage;
        acctEl.append(h('select', { 'aria-label': ENGINE[eng] + ' account for this chat', onchange: (e) => { chat.account = e.target.value; } },
          h('option', { value: 'auto', selected: chat.account === 'auto' }, 'Account: auto'),
          accts.map((a) => { const lv = U && U.level(U.accounts(eng).find((x) => x.name === a.name)); return h('option', { value: a.name, selected: chat.account === a.name }, a.name + (lv != null ? ` (${Math.round(lv)}%)` : '')); })));
      }
    }
    paintNotice();
    stateEl.innerHTML = '';
    paintThinking();
    const waiting = chat && Object.keys(chat.requests).length;
    if (chat && chat.busy) stateEl.append(waiting ? h('span.hint', 'Waiting for you') : h('span.hint', h('span.spinner'), ' Working…'));
    stopBtn.hidden = !(chat && chat.busy);
    paintCtx();
    paintTabs();
    App.emit('chat-state');
  }

  // ---------- tabs ----------
  // Each tab shows whether its agent is working, waiting for you, or has a reply you
  // have not seen yet, plus the specialists it has running.
  function tabState(c) {
    if (waiting(c)) return ['waiting', 'Waiting for you'];
    if (c.busy) return ['working', 'Working'];
    if (c.unread) return c.outcome === 'error' ? ['error', 'Stopped with an error — not seen yet'] : ['done', 'Reply ready — not seen yet'];
    if (c.outcome === 'error') return ['error-seen', 'Last turn ended with an error'];
    if (c.running) return ['idle', 'Finished; session open'];
    return ['off', c.started ? 'Session closed (resumes when you send a message)' : 'New chat'];
  }

  let tabsRaf = 0;
  function scheduleTabs() { if (!tabsRaf) tabsRaf = requestAnimationFrame(() => { tabsRaf = 0; paintTabs(); App.emit('chat-state'); }); }

  function paintTabs() {
    if (!tabsEl) return;
    const t = C.byProject[App.project];
    const focused = tabsEl.contains(document.activeElement);
    tabsEl.innerHTML = '';
    sumEl.innerHTML = '';
    if (!t) return;
    for (const c of t.tabs) {
      const [st, label] = tabState(c);
      const jobs = runningJobs(c);
      const active = c === t.active;
      const title = c.title || 'New chat';
      const tip = [title, label, ctxPct(c) != null ? `context ${Math.round(ctxPct(c))}% full` : null, jobs.length ? `${jobs.length} specialist${jobs.length > 1 ? 's' : ''} running` : null, engineOf(c) === 'codex' ? 'Codex' : null, c.role ? personaName(c.role) : null, c.accountName && App.cfg.accounts[engineOf(c)].list.length > 1 ? 'on ' + c.accountName : null].filter(Boolean).join(' · ');
      const el = h('div.ctab.' + st + (active ? '.active' : ''), {
        role: 'tab', 'aria-selected': String(active), tabindex: active ? '0' : '-1', title: tip, 'aria-label': tip,
        onclick: () => C.activate(c),
        onauxclick: (e) => { if (e.button === 1) C.closeTab(c); },
        oncontextmenu: (e) => { e.preventDefault(); App.menu(e.clientX, e.clientY, tabMenu(c)); },
        onkeydown: (e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); C.cycle(e.key === 'ArrowRight' ? 1 : -1); setTimeout(() => tabsEl.querySelector('.ctab.active')?.focus()); }
          else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); C.closeTab(c); }
        }
      },
      st === 'working' ? h('span.spinner.cdot') : h('i.cdot'),
      engineOf(c) === 'codex' ? h('span.ceng', 'Codex') : null,
      c.role ? h('span.ceng.persona', { title: personaName(c.role) }, personaName(c.role)) : null,
      h('span.ct', title),
      jobs.length ? h('span.cjobs', { title: `${jobs.length} specialist${jobs.length > 1 ? 's' : ''} running` }, String(jobs.length)) : null,
      h('button.cx', { title: 'Close chat', 'aria-label': 'Close ' + title, tabindex: '-1', onclick: (e) => { e.stopPropagation(); C.closeTab(c); } }, '×'));
      tabsEl.append(el);
    }
    const a = tabsEl.querySelector('.ctab.active');
    if (a) { if (focused) a.focus(); a.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
    paintSummary(t);
  }

  // One line under the tabs: sessions, who is working, who needs you, specialists, unseen replies.
  function paintSummary(t) {
    const s = C.stats(App.project);
    const first = (f) => t.tabs.find(f);
    const part = (cls, n, one, many, go) => (n ? h(go ? 'button.cs.' + cls : 'span.cs.' + cls, go ? { onclick: () => C.activate(go), title: 'Show it' } : {}, h('b', String(n)), ' ', n > 1 ? many : one) : null);
    sumEl.append(...[
      h('span.cs', { title: `${s.live} of ${s.sessions} with an agent session open` }, h('b', String(s.sessions)), s.sessions > 1 ? ' chats' : ' chat'),
      part('working', s.working, 'working', 'working', s.working === 1 ? first((c) => c.busy && !waiting(c) && c !== t.active) : null),
      part('waiting', s.waiting, 'needs you', 'need you', first((c) => waiting(c) && c !== t.active)),
      part('done', s.unread, 'reply ready', 'replies ready', first((c) => c.unread && c !== t.active)),
      part('jobs', s.subagents, 'subagent', 'subagents', null),
      part('jobs', s.codex, 'Codex job', 'Codex jobs', null)].filter(Boolean));
  }

  function tabMenu(c) {
    const t = C.byProject[c.project];
    return [
      { label: 'Rename…', run: () => renameTab(c) },
      { label: 'New chat', run: () => C.newChat() },
      '-',
      App.isIdeas(c.project) ? null : { label: 'Continue in a terminal', disabled: !c.started, run: () => { C.activate(c); C.toTerminal(); } },
      { label: 'Overview', disabled: !c.items.length, run: () => C.overview(c) },
      '-',
      { label: 'Close chat', run: () => C.closeTab(c) },
      { label: 'Close other chats', disabled: t.tabs.length < 2, run: async () => { for (const x of t.tabs.slice()) if (x !== c) await C.closeTab(x); } }
    ];
  }
})();
