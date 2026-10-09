// Agents view: install the agent kit into the project, start an orchestrator
// session, and follow the specialist jobs (Claude subagents and Codex runs).
(function () {
  const h = App.h;
  const A = { kit: null, jobs: [], sel: null };
  App.views.agents = A;
  let root, kitEl, usageEl, taskEl, listEl, timer, tick = 0;

  const MODES = [
    { value: 'orchestrate', label: 'Plan and build (two approval gates)', placeholder: 'e.g. Add a --threads option to the binning rule and pass it to MetaBAT2' },
    { value: 'delegate', label: 'Delegate one job', placeholder: 'e.g. codex debugger: tests/test_parsers.py::test_sacct fails since the last change' },
    { value: 'cross-review', label: 'Cross-review current changes', placeholder: 'optional: claude | codex, base ref' },
    { value: 'resume', label: 'Resume a plan (e.g. on another account)', placeholder: 'optional: plan file — defaults to the newest in .codeome/plans/' }
  ];
  const ENGINE = { claude: 'Claude', codex: 'Codex' };
  const isLive = (j) => j.status === 'running';

  A.init = () => {
    root = document.querySelector('.view[data-view="agents"]');
    kitEl = h('div');
    usageEl = h('div');
    taskEl = h('div');
    listEl = h('div.jobs');
    root.append(
      h('div.side-head', h('h2', 'Agents'), App.iconBtn('refresh', 'Refresh', () => A.refresh(true))),
      kitEl, usageEl, taskEl,
      h('div.side-head', h('h2', 'Jobs'), App.iconBtn('trash', 'Clear finished jobs', () => A.clear())),
      listEl);
    App.listen('project', () => { A.kit = null; A.jobs = []; A.refresh(true); });
    App.listen('view', (v) => { if (v === 'agents') A.refresh(true); });
    App.listen('usage', () => { if (App.project) { usageEl.innerHTML = ''; renderUsage(); } });
    // Poll quickly while something runs or the view is open, slowly otherwise.
    timer = setInterval(() => {
      if (document.hidden || !App.project) return;
      tick++;
      if (A.jobs.some(isLive) || App.currentView === 'agents' || tick % 5 === 0) A.refresh();
    }, 3000);
    render();
  };

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
      render();
    } finally { busy = false; }
  };

  function render() {
    if (!root) return;
    paintRail();
    kitEl.innerHTML = ''; usageEl.innerHTML = ''; taskEl.innerHTML = ''; listEl.innerHTML = '';
    if (!App.project) { kitEl.append(h('div.empty', 'Open a project folder to install the agent kit and run agent jobs.')); return; }
    renderKit();
    renderUsage();
    renderTask();
    renderJobs();
  }

  function paintRail() {
    const b = document.querySelector('#rail button[data-view="agents"]');
    if (b) { const n = A.jobs.filter(isLive).length; b.classList.toggle('busy', n > 0); b.title = 'Agents (⌘6)' + (n ? ` — ${n} running` : ''); }
  }

  // ---------- kit ----------
  function renderKit() {
    const k = A.kit;
    if (!k) return kitEl.append(h('div.pad.hint', 'Checking the agent kit…'));
    if (k.error) return kitEl.append(h('div.pad.hint', k.error));
    const codexMissing = App.env.tools && App.env.tools.codex === false;
    if (!k.installed) {
      kitEl.append(h('div.card',
        h('h3', 'Agent kit not installed'),
        h('div.sub', `${k.roles.length} specialist roles for Claude Code and Codex, plus /orchestrate, /delegate and /cross-review. Written to .claude/ and .codeome/ in this project.`),
        h('div.row', { style: { marginTop: '8px' } }, h('button.btn.small.primary', { onclick: () => A.install() }, 'Install…'))));
      return;
    }
    const groups = (k.installedGroups || []).map((g) => (k.groups[g] || {}).label || g).join(', ');
    const nRoles = k.roles.filter((r) => (k.installedGroups || []).includes(r.group)).length;
    kitEl.append(h('div.card',
      h('div.row', h('h3.grow', 'Agent kit ' + k.version), k.outdated ? h('span.pill.warn', 'update ' + k.latest) : h('span.pill.ok', 'up to date')),
      h('div.sub', `${nRoles} roles · ${groups}`),
      k.modified.length ? h('div.sub', `${k.modified.length} file${k.modified.length > 1 ? 's' : ''} edited here — kept on update`) : null,
      k.missing.length ? h('div.sub', `${k.missing.length} file${k.missing.length > 1 ? 's' : ''} missing — reinstall to restore`) : null,
      codexMissing ? h('div.sub', { style: { color: 'var(--pend)' } }, 'Codex not found on this Mac — Codex roles will fall back to Claude.') : null,
      h('div.row', { style: { marginTop: '8px' } },
        h('button.btn.small' + (k.outdated || k.missing.length ? '.primary' : ''), { onclick: () => A.install() }, k.outdated ? 'Update…' : 'Roles…'),
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
  };

  // ---------- usage ----------
  // A notice when an active account is close to (or past) the point where jobs wait.
  function renderUsage() {
    const U = App.views.usage;
    if (!U || !U.snap || !A.kit || !A.kit.installed) return;
    for (const [engine, label] of [['claude', 'Claude'], ['codex', 'Codex']]) {
      const a = U.active(engine), lv = U.level(a);
      if (lv == null || lv < U.stopAt() - 15) continue;
      const past = lv >= U.stopAt();
      const spare = U.accounts(engine).filter((x) => x !== a && (U.level(x) == null || U.level(x) < U.stopAt()));
      const what = engine === 'claude'
        ? (past ? 'New Claude subagents are paused, and new orchestrators start on another account.' : `Claude subagents pause at ${U.stopAt()}%.`)
        : (past ? (spare.length ? `Codex jobs now run on ${spare[0].name}.` : 'New Codex jobs are held back.') : `Codex jobs move to another account at ${U.stopAt()}%.`);
      usageEl.append(h('div.card.usage-note' + (past ? '.bad' : '.warn'),
        h('div', h('b', `${label} · ${a.name}`), ` at ${U.worst(a)}. ${what}`),
        engine === 'claude' && past && spare.length ? h('div.row', { style: { marginTop: '6px' } },
          spare.slice(0, 2).map((x) => h('button.btn.small.primary', { onclick: () => A.start('', 'resume', x.name) }, `Resume plan on ${x.name}`))) : null,
        !spare.length ? h('div.sub', U.accounts(engine).length > 1 ? 'No other account has headroom.' : h('a', { href: '#', onclick: (e) => { e.preventDefault(); U.addAccount(engine); } }, `Add another ${label} account…`)) : null));
    }
  }

  // ---------- task ----------
  let mode = 'orchestrate', draft = '', account = 'auto';
  function renderTask() {
    if (!A.kit || !A.kit.installed) return;
    const m = MODES.find((x) => x.value === mode);
    const sel = h('select', { 'aria-label': 'What to run', onchange: (e) => { mode = e.target.value; render(); } }, MODES.map((x) => h('option', { value: x.value, selected: x.value === mode }, x.label)));
    const ta = h('textarea', { rows: 3, placeholder: m.placeholder, 'aria-label': 'Task', oninput: (e) => { draft = e.target.value; } }, draft);
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); A.start(); } });
    const accts = App.cfg.accounts.claude.list;
    const U = App.views.usage;
    const acctSel = accts.length > 1 ? h('select', { 'aria-label': 'Claude account for the orchestrator', style: { width: 'auto' }, onchange: (e) => { account = e.target.value; } },
      h('option', { value: 'auto', selected: account === 'auto' }, 'Account: auto'),
      accts.map((a) => { const lv = U && U.level(U.accounts('claude').find((x) => x.name === a.name)); return h('option', { value: a.name, selected: account === a.name }, a.name + (lv != null ? ` (${Math.round(lv)}%)` : '')); })) : null;
    taskEl.append(h('div.pad.agent-task', sel, ta,
      h('div.row', acctSel, h('span.hint.grow', 'Opens a Claude Code session in the panel'), h('button.btn.small.primary', { onclick: () => A.start() }, 'Start'))));
  }

  // acct: a Claude account name, or 'auto' (the active one while it has headroom).
  A.start = (text, how, acct) => {
    if (!App.project) return App.toast('Open a project folder first.');
    how = how || mode;
    const task = (text != null ? text : draft).trim();
    if (!['cross-review', 'resume'].includes(how) && !task) return App.toast('Describe the task first.');
    const claude = (App.cfg.agents.find((a) => /^claude(\s|$)/.test(a.cmd)) || { cmd: 'claude' }).cmd;
    // Resuming runs /orchestrate on the plan, typically from a fresh account.
    const prompt = how === 'resume' ? '/orchestrate resume' + (task ? ' ' + task : '') : '/' + how + (task ? ' ' + task : '');
    const title = { orchestrate: 'Orchestrator', delegate: 'Delegate', 'cross-review': 'Cross-review', resume: 'Orchestrator (resumed)' }[how];
    App.views.terminals.open({ kind: 'agent-local', title, command: claude + ' ' + App.shq(prompt), cwd: App.project, badge: 'Mac', engine: 'claude', account: acct || account });
    if (text == null) { draft = ''; render(); }
  };

  // ---------- jobs ----------
  function renderJobs() {
    const live = A.jobs.filter(isLive), done = A.jobs.filter((j) => !isLive(j));
    if (!A.jobs.length) {
      listEl.append(h('div.empty', A.kit && A.kit.installed ? 'No agent jobs yet. Specialist jobs started by the orchestrator appear here.' : 'Install the kit to record agent jobs.'));
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
      j.worktree ? { label: 'Show worktree in Files', run: () => { App.setView('files'); App.views.files.go('local', j.worktree); } } : null,
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
