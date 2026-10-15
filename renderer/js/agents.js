// Agent view: the chat with the orchestrator (chat.js) and, behind a toggle, the list
// of specialist jobs (Claude subagents and Codex runs) with their briefs, logs and
// results. Also installs the agent kit into the project.
(function () {
  const h = App.h;
  const A = { kit: null, jobs: [], sel: null, pane: 'chat' };
  App.views.agents = A;
  let root, titleEl, tabsEl, kitEl, kitCardEl, usageEl, chatEl, forumEl, jobsEl, listEl, newChatBtn, historyBtn, timer, tick = 0;

  const ENGINE = { claude: 'Claude', codex: 'Codex' };
  const isLive = (j) => j.status === 'running';

  A.init = () => {
    root = document.querySelector('.view[data-view="agents"]');
    root.classList.add('agent-view');
    titleEl = h('div.agent-title');
    tabsEl = h('div.seg', { role: 'tablist', 'aria-label': 'Agent panes' });
    kitEl = h('div');
    usageEl = h('div');
    chatEl = h('div.chat');
    forumEl = h('div', { hidden: true });
    listEl = h('div.jobs');
    kitCardEl = h('div');
    jobsEl = h('div.agent-jobs', { hidden: true }, kitCardEl,
      h('div.side-head', h('h2', 'Specialist jobs'), App.iconBtn('refresh', 'Refresh', () => A.refresh(true)), App.iconBtn('trash', 'Clear finished jobs', () => A.clear())),
      listEl);
    newChatBtn = App.iconBtn('plus', 'New agent', () => App.views.settings.newAgent(), '.agent-new');
    historyBtn = App.iconBtn('history', 'Chat history', (e) => App.views.chat.openHistory(e.currentTarget));
    root.append(
      h('div.side-head.agent-head', titleEl, tabsEl,
        newChatBtn, historyBtn,
        App.iconBtn('dots', 'More', (e) => moreMenu(e.currentTarget))),
      kitEl, usageEl, chatEl, forumEl, jobsEl);
    App.views.chat.mount(chatEl);
    App.views.forum.mount(forumEl);
    App.listen('project', () => { A.kit = null; A.jobs = []; A.refresh(true); });
    App.listen('view', (v) => { if (v === 'agents') { A.refresh(true); if (A.pane === 'chat') setTimeout(() => chatEl.querySelector('textarea')?.focus(), 0); if (A.pane === 'forum') App.views.forum.show(); } });
    App.listen('usage', () => { if (App.project) { usageEl.innerHTML = ''; renderUsage(); } });
    App.listen('chat', () => paintHead());
    App.listen('chat-state', () => paintRail());
    App.listen('forum-unread', () => paintHead());
    // Poll quickly while something runs or the view is open, slowly otherwise.
    timer = setInterval(() => {
      if (document.hidden || !App.project) return;
      tick++;
      if (A.jobs.some(isLive) || App.currentView === 'agents' || tick % 5 === 0) A.refresh();
    }, 3000);
    render();
  };

  A.show = (pane) => {
    if (!['chat', 'forum', 'jobs'].includes(pane)) return;
    if (A.pane === 'forum' && pane !== 'forum') App.views.forum.hide();
    A.pane = pane;
    chatEl.hidden = pane !== 'chat';
    forumEl.hidden = pane !== 'forum';
    jobsEl.hidden = pane !== 'jobs';
    kitEl.hidden = pane === 'forum';
    usageEl.hidden = pane === 'forum';
    newChatBtn.hidden = pane !== 'chat';
    historyBtn.hidden = pane !== 'chat';
    paintHead();
    if (pane === 'chat') App.views.chat.markSeen();
    if (pane === 'forum') App.views.forum.show();
    if (pane === 'jobs') A.refresh();
    App.views.projects.rememberView(true);
  };

  // A job card just appeared in the chat: look for its record shortly.
  let soon = null;
  A.refreshSoon = () => { clearTimeout(soon); soon = setTimeout(() => A.refresh(), 1500); };

  function paintHead() {
    titleEl.innerHTML = '';
    titleEl.append(h('h2', 'Agent'));
    const n = A.jobs.filter(isLive).length;
    tabsEl.innerHTML = '';
    for (const [k, label] of [['chat', 'Chat'], ['forum', 'Forum'], ['jobs', 'Jobs' + (n ? ` · ${n}` : '')]]) {
      tabsEl.append(h('button' + (A.pane === k ? '.on' : ''), { role: 'tab', 'aria-selected': String(A.pane === k), onclick: () => A.show(k) },
        label, k === 'forum' && App.views.forum.unread ? h('span.forum-unread', { 'aria-label': 'Unread forum activity' }) : null));
    }
  }

  async function moreMenu(anchor) {
    const C = App.views.chat;
    const past = await C.history();
    const k = A.kit;
    App.menuAt(anchor, [
      { label: 'New chat', key: '⇧⌘N', run: () => C.newChat() },
      past.length ? { header: 'Reopen a recent chat' } : null,
      ...past.map((c) => ({ label: (c.title || 'Untitled chat').slice(0, 48), key: App.fmtAgo(c.updatedAt), run: () => C.open(c.id) })),
      { label: 'Chat history…', run: () => C.openHistory(anchor) },
      '-',
      { label: 'Continue this chat in a terminal', disabled: !C.current() || !C.current().started, run: () => C.toTerminal() },
      { label: 'Forum', run: () => A.show('forum') },
      { label: 'Specialist jobs', run: () => A.show('jobs') },
      { label: 'Session statistics', run: () => App.views.stats.open() },
      { label: 'Agents & models…', run: () => App.views.settings.open('agents') },
      '-',
      k && k.installed ? { label: k.outdated ? 'Update the agent kit…' : 'Agent kit roles…', run: () => A.install() } : { label: 'Install the agent kit…', run: () => A.install() },
      k && k.installed ? { label: 'Edit routing', run: () => App.views.editor.openFile(App.join(App.project, '.claude/skills/orchestrate/routing.md')) } : null
    ]);
  }

  let busy = false;
  A.refresh = async (withKit) => {
    if (busy || !App.project) { render(); return; }
    busy = true;
    try {
      const project = App.project;
      const [jobs, kit] = await Promise.all([codeome.jobs.list(project), withKit || !A.kit ? codeome.kit.status(project) : A.kit]);
      if (project !== App.project) return;
      // A Codex job just ended: its account's usage moved.
      const ended = A.jobs.some((j) => j.engine === 'codex' && isLive(j) && !jobs.some((x) => x.id === j.id && isLive(x)));
      if (ended) codeome.usage.refresh();
      A.jobs = jobs; A.kit = kit;
      App.views.chat.syncJobs(project, jobs);
      render();
    } finally { busy = false; }
  };

  function render() {
    if (!root) return;
    paintRail();
    paintHead();
    kitEl.innerHTML = ''; usageEl.innerHTML = ''; listEl.innerHTML = '';
    if (!App.project) return;
    renderKit();
    renderUsage();
    renderJobs();
  }

  function paintRail() {
    const b = document.querySelector('#rail button[data-view="agents"]');
    if (!b) return;
    const n = A.jobs.filter(isLive).length, s = App.views.chat.stats(App.project);
    b.classList.toggle('busy', n > 0 || s.working > 0);
    b.classList.toggle('needs', s.waiting > 0);
    b.classList.toggle('ready', !s.waiting && !s.working && !n && s.unread > 0);
    b.title = 'Agent (⌘1)' + (s.waiting ? ` — ${s.waiting} waiting for you` : '') + (s.working ? ` — ${s.working} working` : '') + (n ? ` — ${n} job${n > 1 ? 's' : ''} running` : '') + (s.unread ? ` — ${s.unread} repl${s.unread > 1 ? 'ies' : 'y'} ready` : '');
  }

  // ---------- kit ----------
  // Above the chat: a banner only when the kit needs something. In the jobs pane: the details.
  function renderKit() {
    const k = A.kit;
    kitCardEl.innerHTML = '';
    if (!k) return;
    if (k.error) return kitEl.append(h('div.pad.hint', k.error));
    const codexMissing = App.env.tools && App.env.tools.codex === false;
    if (!k.installed) {
      kitEl.append(h('div.banner',
        h('div.grow', h('b', 'Working solo. '), 'Install the agent kit so the agent can hand work to Codex and specialist Claude roles.'),
        h('button.btn.small.primary', { onclick: () => A.install() }, 'Install…')));
      kitCardEl.append(h('div.empty', `No agent kit in this project. It adds ${k.roles.length} specialist roles, the Codex job runner and job records to .claude/ and .codeome/.`));
      return;
    }
    if (k.outdated || k.missing.length) {
      kitEl.append(h('div.banner',
        h('div.grow', k.outdated ? `Agent kit ${k.latest} is available (this project has ${k.version}).` : `${k.missing.length} agent kit file${k.missing.length > 1 ? 's are' : ' is'} missing.`),
        h('button.btn.small.primary', { onclick: () => A.install() }, k.outdated ? 'Update…' : 'Repair…')));
    }
    const groups = (k.installedGroups || []).map((g) => (k.groups[g] || {}).label || g).join(', ');
    const nRoles = k.roles.filter((r) => (k.installedGroups || []).includes(r.group)).length;
    kitCardEl.append(h('div.card',
      h('div.row', h('h3.grow', 'Agent kit ' + k.version), k.outdated ? h('span.pill.warn', 'update ' + k.latest) : h('span.pill.ok', 'up to date')),
      h('div.sub', `${nRoles} roles · ${groups}`),
      k.modified.length ? h('div.sub', `${k.modified.length} file${k.modified.length > 1 ? 's' : ''} edited here — kept on update`) : null,
      codexMissing ? h('div.sub', { style: { color: 'var(--pend)' } }, 'Codex not found on this Mac — Codex roles will fall back to Claude.') : null,
      h('div.row', { style: { marginTop: '8px' } },
        h('button.btn.small', { onclick: () => A.install() }, k.outdated ? 'Update…' : 'Roles…'),
        h('button.btn.small.ghost', { onclick: () => App.views.editor.openFile(App.join(App.project, '.claude/skills/orchestrate/routing.md')) }, 'Routing'))));
  }

  A.install = async () => {
    const k = A.kit || await codeome.kit.status(App.project);
    const current = k.installed ? k.installedGroups : Object.keys(k.groups);
    const fields = [{ legend: 'Role groups' }];
    for (const [g, info] of Object.entries(k.groups)) {
      fields.push({ key: g, type: 'check', label: `${info.label}${info.required ? ' (always)' : ''} — ${info.description}`, value: info.required || current.includes(g) });
    }
    const v = await App.modal({
      title: k.installed ? 'Agent kit roles' : 'Install the agent kit',
      text: `Into ${App.basename(App.project)}: roles in .claude/agents/, skills in .claude/skills/, the job runner in .codeome/bin/, and hooks in .claude/settings.json so Claude subagent jobs appear here. Files you have edited are left alone.`,
      ok: k.installed ? 'Apply' : 'Install', fields
    });
    if (!v) return;
    const groups = Object.keys(k.groups).filter((g) => v[g] || k.groups[g].required);
    const r = await codeome.kit.install(App.project, groups);
    if (r.error) return App.err(r.error);
    const parts = [`${r.written.length} written`, r.removed.length ? `${r.removed.length} removed` : null, r.skipped.length ? `${r.skipped.length} kept as you edited them` : null].filter(Boolean);
    App.toast('Agent kit: ' + parts.join(', ') + '.');
    if (r.warning) App.err(r.warning);
    if (r.skipped.length || r.kept.length) {
      App.modal({ title: 'Files left as they are', cancel: null, ok: 'OK',
        text: 'These files differ from the kit — edited here, or present before the kit — so Codeome did not touch them. Delete one and reinstall to get the kit version.',
        body: h('pre.logbox', { style: { maxHeight: '240px' } }, [...r.skipped, ...r.kept].join('\n')) });
    }
    App.emit('local-changed');
    A.refresh(true);
    const c = App.views.chat.current();
    if (!k.installed && c && c.started) App.toast('Start a new chat so the agent can use the team.', { action: { label: 'New chat', run: () => App.views.chat.newChat() } });
  };

  // ---------- usage ----------
  // A notice when an active account is close to (or past) the point where jobs wait.
  // A dismissed notice stays away until the account or its state (near, past) changes.
  const dismissed = {};
  function renderUsage() {
    const U = App.views.usage;
    if (!U || !U.snap || !A.kit || !A.kit.installed) return;
    for (const [engine, label] of [['claude', 'Claude'], ['codex', 'Codex']]) {
      const a = U.active(engine), lv = U.level(a);
      if (lv == null || lv < U.stopAt() - 15) { delete dismissed[engine]; continue; }
      const past = lv >= U.stopAt();
      const key = a.name + (past ? '|past' : '|near');
      if (dismissed[engine] === key) continue;
      const spare = U.accounts(engine).filter((x) => x !== a && !x.signedOut && (U.level(x) == null || U.level(x) < U.stopAt()));
      const what = engine === 'claude'
        ? (past ? 'New Claude subagents are paused, and new chats start on another account.' : `Claude subagents pause at ${U.stopAt()}%.`)
        : (past ? (spare.length ? `Codex jobs now run on ${spare[0].name}.` : 'New Codex jobs are held back.') : `Codex jobs move to another account at ${U.stopAt()}%.`);
      usageEl.append(h('div.card.usage-note' + (past ? '.bad' : '.warn'),
        h('button.icon-btn.small.dismiss', { title: 'Dismiss', 'aria-label': 'Dismiss', html: App.icons.close, onclick: () => { dismissed[engine] = key; usageEl.innerHTML = ''; renderUsage(); } }),
        h('div', h('b', `${label} · ${a.name}`), ` at ${U.worst(a)}. ${what}`),
        engine === 'claude' && past && spare.length ? h('div.row', { style: { marginTop: '6px' } },
          spare.slice(0, 2).map((x) => h('button.btn.small.primary', { title: 'A new chat on this account picks up the newest plan where it stopped', onclick: () => App.views.chat.newChat({ account: x.name, send: '/orchestrate resume' }) }, `Resume plan on ${x.name}`))) : null,
        !spare.length ? h('div.sub', U.accounts(engine).length > 1 ? 'No other account has headroom.' : h('a', { href: '#', onclick: (e) => { e.preventDefault(); U.addAccount(engine); } }, `Add another ${label} account…`)) : null));
    }
  }

  // ---------- jobs ----------
  function renderJobs() {
    const live = A.jobs.filter(isLive), done = A.jobs.filter((j) => !isLive(j));
    if (!A.jobs.length) {
      listEl.append(h('div.empty', A.kit && A.kit.installed ? 'No jobs yet. Work the agent hands to Codex or Claude specialists appears here and as cards in the chat.' : 'Install the agent kit to record jobs.'));
      return;
    }
    group('Running', live);
    group('Finished', done.slice(0, 60));
  }

  function group(label, jobs) {
    if (!jobs.length) return;
    listEl.append(h('div.group-label', h('span', label), h('span', String(jobs.length))));
    for (const j of jobs) {
      listEl.append(h('div.job' + (A.sel === j.id ? '.sel' : ''), {
        tabindex: '0', onclick: () => A.openJob(j), onkeydown: (e) => { if (e.key === 'Enter') A.openJob(j); },
        oncontextmenu: (e) => { e.preventDefault(); App.menu(e.clientX, e.clientY, jobMenu(j)); }
      },
      h('span.nm', j.title || j.role), h('span.state.' + j.status, j.status),
      h('div.meta', h('span.pill' + (j.engine === 'codex' ? '.codex' : '.ok'), ENGINE[j.engine] || j.engine), h('span', j.role), h('span', elapsed(j)),
        j.account && App.cfg.accounts.codex.list.length > 1 ? h('span', j.account) : null, j.limitHit ? h('span.state.failed', 'usage limit') : null,
        j.worktree ? h('span', 'worktree') : null, !isLive(j) && j.endedAt ? h('span', App.fmtAgo(Date.parse(j.endedAt))) : null)));
    }
  }

  function elapsed(j) {
    const a = Date.parse(j.startedAt), b = j.endedAt ? Date.parse(j.endedAt) : Date.now();
    if (isNaN(a)) return '';
    const s = Math.max(0, Math.round((b - a) / 1000));
    return s < 60 ? s + ' s' : s < 3600 ? Math.floor(s / 60) + ' min' : Math.floor(s / 3600) + ' h ' + Math.floor(s % 3600 / 60) + ' min';
  }

  function jobMenu(j) {
    return [
      { label: 'Show result', run: () => A.openJob(j) },
      { label: 'Copy job ID', run: () => navigator.clipboard.writeText(j.id) },
      j.session && j.engine === 'codex' ? { label: 'Copy Codex session ID', run: () => navigator.clipboard.writeText(j.session) } : null,
      j.worktree ? { label: 'Show worktree in Files', run: () => App.views.files.show('local', j.worktree) } : null,
      j.transcript ? { label: 'Open transcript', run: () => App.views.editor.openFile(j.transcript.replace(/^~/, App.env.home || '~')) } : null,
      isLive(j) && j.engine === 'codex' ? '-' : null,
      isLive(j) && j.engine === 'codex' ? { label: 'Cancel job…', danger: true, run: () => A.cancel(j) } : null
    ];
  }

  A.cancel = async (j) => {
    if (!(await App.confirm('Cancel this Codex job?', `"${j.title}" (${j.role}) will be stopped. The orchestrator sees it as cancelled.`, 'Cancel job', true))) return;
    const r = await codeome.jobs.cancel(App.project, j.id);
    if (r.error) return App.err(r.error);
    App.toast('Cancelling ' + j.role + ' job.');
    setTimeout(() => A.refresh(), 800);
  };

  A.clear = async () => {
    const n = A.jobs.filter((j) => !isLive(j)).length;
    if (!n) return App.toast('No finished jobs to clear.');
    if (!(await App.confirm(`Clear ${n} finished job${n > 1 ? 's' : ''}?`, 'Deletes their briefs, logs and results from .codeome/jobs/. Worktrees and branches are left in place.', 'Clear', true))) return;
    const r = await codeome.jobs.clear(App.project);
    App.toast(`Cleared ${r.removed} job${r.removed === 1 ? '' : 's'}.`);
    A.refresh();
  };

  // ---------- job tab ----------
  A.openJob = (j) => {
    A.sel = j.id; render();
    const project = App.project;
    App.views.editor.openCustom({
      key: 'agent-job:' + j.id, title: `${j.role} · ${ENGINE[j.engine] || j.engine}`, badge: 'Agent',
      render: async (el, tab) => {
        const pre = h('pre.logbox', 'Loading…');
        const parts = [h('option', { value: 'result' }, 'Result'), h('option', { value: 'brief' }, 'Brief')];
        if (j.engine === 'codex') parts.push(h('option', { value: 'log' }, 'Log'));
        const which = h('select', { style: { width: 'auto' }, 'aria-label': 'Show' }, parts);
        const state = h('span.state');
        const info = h('span.path');
        const follow = h('input', { type: 'checkbox', checked: true });
        const cancelBtn = h('button.btn.small.danger', { onclick: () => A.cancel(cur()) }, 'Cancel job');
        el.append(h('div.toolbar', which, state, info, h('label.check', follow, 'Follow'), h('button.btn.small', { onclick: () => load() }, 'Refresh'), cancelBtn), pre);
        const cur = () => A.jobs.find((x) => x.id === j.id) || j;
        async function load() {
          const job = cur();
          state.className = 'state ' + job.status; state.textContent = job.status;
          info.textContent = [job.title, elapsed(job), job.branch ? 'branch ' + job.branch : null, job.session && job.engine === 'codex' ? 'session ' + job.session : null].filter(Boolean).join(' · ');
          cancelBtn.hidden = !(isLive(job) && job.engine === 'codex');
          // While a Codex job runs there is no result yet: show its log.
          if (which.value === 'result' && isLive(job) && job.engine === 'codex' && pre.dataset.auto !== 'off') { which.value = 'log'; pre.dataset.auto = 'off'; }
          const r = await codeome.jobs.read(project, j.id, which.value);
          const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
          pre.textContent = r.error || (r.missing || !r.content ? (isLive(job) ? '(nothing yet — the job is still running)' : '(none recorded)') : r.content);
          if (which.value === 'log' && follow.checked && (atBottom || pre.dataset.first !== '1')) pre.scrollTop = pre.scrollHeight;
          pre.dataset.first = '1';
        }
        which.onchange = () => { pre.dataset.auto = 'off'; pre.dataset.first = ''; load(); };
        await load();
        let wasLive = isLive(cur());
        tab.timer = setInterval(() => {
          if (App.views.editor.active !== tab.id) return;
          const live = isLive(cur());
          if ((live && follow.checked) || wasLive !== live) { if (wasLive && !live && which.value === 'log') which.value = 'result'; wasLive = live; load(); }
        }, 3000);
        tab.onClose = () => clearInterval(tab.timer);
      }
    });
  };
})();
