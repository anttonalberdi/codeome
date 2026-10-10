// Bottom panel: local shells, HPC shells, tasks, and Claude Code / Codex sessions on
// the HPC (agents on this Mac run in the Agent chat).
// Each session belongs to a project; switching projects hides the others' sessions
// but leaves them running.
(function () {
  const h = App.h;
  const T = { list: [], active: null, seq: 0, lastActive: {} };
  App.views.terminals = T;
  const host = () => document.getElementById('term-host');
  const tabsEl = () => document.getElementById('term-tabs');

  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function theme() {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light' || document.documentElement.dataset.theme === 'dark';
    return {
      background: cssVar('--surface-2'), foreground: cssVar('--text'), cursor: cssVar('--accent'), cursorAccent: cssVar('--surface-2'),
      selectionBackground: cssVar('--sel'),
      ...(dark ? {
        black: '#1a1f26', red: '#ec8478', green: '#9cc59f', yellow: '#e0b45a', blue: '#7fa8d8', magenta: '#c49bd6', cyan: '#6cc4bb', white: '#d9dee5',
        brightBlack: '#5c6676', brightRed: '#f4a196', brightGreen: '#b8dbb9', brightYellow: '#efcb80', brightBlue: '#a0c2ea', brightMagenta: '#d8b8e6', brightCyan: '#94dad3', brightWhite: '#ffffff'
      } : {
        black: '#1f2630', red: '#c2493c', green: '#3e7a4a', yellow: '#94680f', blue: '#2f5f9e', magenta: '#8a4fa3', cyan: '#2f8a83', white: '#c3c9d1',
        brightBlack: '#677283', brightRed: '#d9604f', brightGreen: '#4f9a5d', brightYellow: '#b07d1e', brightBlue: '#3e73bd', brightMagenta: '#a465bf', brightCyan: '#3aa198', brightWhite: '#ffffff'
      })
    };
  }

  // spec: {kind, title, command, cwd, session, badge, secretEnv, engine, account, project}
  T.open = async function (spec) {
    App.views.terminals.showPanel();
    const id = 't' + (++T.seq);
    const el = h('div.term', { hidden: true });
    host().append(el);
    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, ui-monospace, monospace', fontSize: App.cfg.editor.fontSize || 13, lineHeight: 1.15,
      cursorBlink: true, allowProposedApi: true, macOptionIsMeta: true, scrollback: 20000, theme: theme()
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(el);
    // Cmd+K clears, Cmd+C copies when there's a selection (xterm handles the rest).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.metaKey && e.key === 'k') { term.clear(); return false; }
      if (e.type === 'keydown' && e.metaKey && e.key === 'c' && term.hasSelection()) { navigator.clipboard.writeText(term.getSelection()); return false; }
      return true;
    });
    const t = { id, spec, term, fit, el, title: spec.title, alive: true, project: spec.project !== undefined ? spec.project : App.project };
    // R consoles report when R first shows its prompt, so code isn't typed into a starting shell.
    if (spec.lang === 'r') t.ready = new Promise((res) => { t.onReady = res; setTimeout(res, 20000); });
    T.list.push(t);
    term.onData((d) => codeome.pty.write(id, d));
    term.onResize(({ cols, rows }) => codeome.pty.resize(id, cols, rows));
    new ResizeObserver(() => { if (!el.hidden) { try { fit.fit(); } catch {} } }).observe(el);
    T.activate(id);
    try { fit.fit(); } catch {}
    // Callbacks stay here; only data crosses to the main process.
    const wire = Object.fromEntries(Object.entries(spec).filter(([, v]) => typeof v !== 'function'));
    const r = await codeome.pty.spawn({ id, ...wire, cols: term.cols, rows: term.rows });
    if (r.error) { term.write('\r\n\x1b[31m' + r.error.replace(/\n/g, '\r\n') + '\x1b[0m\r\n'); t.alive = false; renderTabs(); }
    else if (r.account && r.account.name) {
      t.account = r.account.name;
      const label = spec.engine === 'claude' ? 'Claude' : 'Codex';
      if (r.account.blocked) App.toast(`Every ${label} account is near its usage limit. Started on ${r.account.name} anyway.`, { error: true });
      else if (r.account.switched) App.toast(`${label} account ${r.account.from} is near its limit — started on ${r.account.name}.`);
      renderTabs();
    }
    return t;
  };

  T.activate = function (id, { focus = true } = {}) {
    T.active = id;
    for (const t of T.list) t.el.hidden = t.id !== id;
    renderTabs();
    const t = T.get(id);
    if (t) T.lastActive[t.project] = id;
    if (t) setTimeout(() => { try { t.fit.fit(); } catch {} if (focus) t.term.focus(); }, 0);
    document.querySelector('.term-empty')?.remove();
  };
  T.get = (id) => T.list.find((t) => t.id === id);
  T.current = () => T.get(T.active);

  T.close = function (id) {
    const t = T.get(id); if (!t) return;
    codeome.pty.kill(id); t.term.dispose(); t.el.remove();
    T.list = T.list.filter((x) => x !== t);
    if (T.lastActive[t.project] === id) delete T.lastActive[t.project];
    if (T.active === id) { const last = T.visible().pop(); if (last) T.activate(last.id); else { T.active = null; renderTabs(); showEmpty(); } }
    else renderTabs();
  };
  T.visible = () => T.list.filter((t) => t.project === App.project);
  T.closeProject = (project) => { for (const t of T.list.filter((x) => x.project === project)) T.close(t.id); };

  // Show the project's own sessions, back on the one last used there.
  App.listen('project', (project) => {
    const vis = T.list.filter((t) => t.project === project);
    const last = vis.find((t) => t.id === T.lastActive[project]) || vis[vis.length - 1];
    if (last) T.activate(last.id);
    else { T.active = null; for (const t of T.list) t.el.hidden = true; renderTabs(); showEmpty(); }
  });

  T.send = function (text) {
    const t = T.current();
    if (!t) { App.toast('Open a terminal first (⌘T).'); return false; }
    // Bracketed paste for multi-line chunks so R/Python REPLs accept them whole.
    const multi = text.includes('\n');
    codeome.pty.write(t.id, multi ? '\x1b[200~' + text + '\x1b[201~\r' : text + '\r');
    return true;
  };

  function showEmpty() {
    if (host().querySelector('.term-empty')) return;
    host().append(h('div.term-empty', h('div', 'No terminals. ', h('button.btn.small', { onclick: (e) => T.newMenu(e.currentTarget) }, 'New terminal'))));
  }

  function renderTabs() {
    const el = tabsEl(); el.innerHTML = '';
    App.emit('sessions');
    const rt = T.rFor();
    for (const t of T.visible()) {
      el.append(h('div.tab' + (t.id === T.active ? '.active' : ''), {
        onclick: () => T.activate(t.id), title: (t.spec.cwd || '') + (t === rt ? '\nReceives R code from the editor (⌘↩)' : ''),
        onauxclick: (e) => { if (e.button === 1) T.close(t.id); },
        oncontextmenu: (e) => { e.preventDefault(); App.menu(e.clientX, e.clientY, tabMenu(t)); } },
        h('i.live' + (t.alive ? '' : '.dead')),
        t.spec.badge ? h('span.badge' + (t.spec.badge === 'HPC' ? '.hpc' : t.spec.badge === 'R' ? '.r' : ''), t.spec.badge) : null,
        t === rt && t.spec.badge !== 'R' ? h('span.badge.r', { title: 'Receives R code' }, 'R') : null,
        h('span.t', t.title),
        t.account && App.cfg.accounts[t.spec.engine] && App.cfg.accounts[t.spec.engine].list.length > 1 ? h('span.acct', t.account) : null,
        h('button.x', { title: 'Close', onclick: (e) => { e.stopPropagation(); T.close(t.id); } }, h('span', '×'))));
    }
  }

  function tabMenu(t) {
    const rt = T.rFor(t.project);
    return [
      t.alive && t.spec.kind !== 'hpc-login' && t.spec.kind !== 'storage-login' ? { label: t === rt ? 'Receives R code ✓' : 'Send R code here', disabled: t === rt, run: () => { T.rTarget[t.project] = t.id; renderTabs(); } } : null,
      t.spec.lang === 'r' ? { label: 'Restart R', run: () => { T.close(t.id); T.rConsole({ remote: isHpc(t), cwd: t.spec.cwd }); } } : null,
      { label: 'Close', run: () => T.close(t.id) }
    ];
  }

  codeome.pty.onData(({ id, data }) => {
    const t = T.get(id); if (!t) return;
    t.term.write(data);
    if (t.onReady && /(^|\n)> $/.test(data.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))) { t.onReady(); t.onReady = null; }
  });
  codeome.pty.onExit(({ id, code }) => {
    const t = T.get(id); if (!t) return;
    t.alive = false; renderTabs();
    t.term.write(`\r\n\x1b[2m[session ended${code ? ' with code ' + code : ''}]\x1b[0m\r\n`);
    if (t.spec.onExit) t.spec.onExit(code);
  });

  // ---------- launchers ----------
  T.localShell = (cwd) => T.open({ kind: 'shell', title: App.basename(cwd || App.project || '~') || 'zsh', cwd: cwd || App.project || '~', badge: 'Mac' });
  T.hpcShell = (cwd) => { if (!App.requireHpc()) return; return T.open({ kind: 'hpc-shell', title: App.basename(cwd || App.remoteDir || '~'), cwd: cwd || App.remoteDir || '~', badge: 'HPC' }); };
  T.agentHpc = (agent, cwd) => {
    if (!App.requireHpc()) return;
    const dir = cwd || App.remoteDir || '~';
    const session = 'codeome-' + App.safeName(agent.name) + '-' + App.safeName(App.basename(dir) || 'home');
    return T.open({ kind: 'agent-hpc', title: agent.name, command: agent.cmd, cwd: dir, session, badge: 'HPC' });
  };
  T.task = (title, command, cwd, extra = {}) => T.open({ kind: 'task', title, command, cwd: cwd || App.project || '~', badge: 'Mac', ...extra });
  T.hpcTask = (title, command, cwd) => { if (!App.requireHpc()) return; return T.open({ kind: 'hpc-task', title, command, cwd: cwd || App.remoteDir || '~', badge: 'HPC' }); };

  // ---------- R console ----------
  // Each project has one terminal that R code from the editor goes to: an R console
  // started here, or any terminal picked with "Send R code here" (say, R inside an
  // interactive job on the HPC). It ends with R, so a dead tab is never sent code.
  T.rTarget = {};
  const isHpc = (t) => /^(hpc|agent-hpc)/.test(t.spec.kind);
  T.rFor = (project = App.project) => { const t = T.get(T.rTarget[project]); return t && t.alive ? t : null; };
  T.rConsole = async ({ remote = false, cwd } = {}) => {
    if (remote && !App.requireHpc()) return null;
    const dir = cwd || (remote ? App.remoteDir || '~' : App.project || '~');
    const command = (remote ? App.cfg.r.remote : App.cfg.r.local) || 'R --no-save --quiet';
    const t = await T.open({ kind: remote ? 'hpc-console' : 'console', lang: 'r', title: 'R · ' + (App.basename(dir) || '~'), command, cwd: dir, badge: remote ? 'HPC' : 'R' });
    if (t && t.alive) { T.rTarget[t.project] = t.id; renderTabs(); }
    return t;
  };

  // The project's R console, started (here or on the HPC) if there is none, shown and ready.
  async function rReady({ remote = false, cwd } = {}) {
    let t = T.rFor();
    if (!t) { t = await T.rConsole({ remote, cwd }); if (!t || !t.alive) return null; }
    if (t.ready) await t.ready;
    T.showPanel();
    if (T.active !== t.id) T.activate(t.id, { focus: false });
    return t;
  }
  const sourceLine = (file) => `source(${JSON.stringify(file)}, echo = TRUE, max.deparse.length = Inf, keep.source = TRUE, spaced = FALSE)\r`;

  T.sendR = async (code, where) => {
    const t = await rReady(where); if (!t) return false;
    code = code.replace(/\r/g, '').replace(/\s+$/, '');
    if (!code) return true;
    // R's readline ignores bracketed paste, and typing much ahead overruns the terminal's
    // input queue while R is busy: short code is typed, longer code is sourced from a file.
    if (code.length <= 400 && code.split('\n').length <= 12) { codeome.pty.write(t.id, code.replace(/\n/g, '\r') + '\r'); return true; }
    const file = await rFile(t, code + '\n');
    if (!file) { App.err('Could not write the code to a temporary file.'); return false; }
    codeome.pty.write(t.id, sourceLine(file));
    return true;
  };
  // Runs a whole R script in the console, echoed, like RStudio's Source.
  T.sourceR = async (path, where) => { const t = await rReady(where); if (t) codeome.pty.write(t.id, sourceLine(path)); return !!t; };
  async function rFile(t, code) {
    const name = 'run-' + t.id + '.R';
    if (isHpc(t)) {
      await codeome.remote.mkdir('.cache/codeome');
      const r = await codeome.remote.write('.cache/codeome/' + name, code);
      return r.error ? null : '~/.cache/codeome/' + name;
    }
    if (!App.env.tmp) return null;
    await codeome.local.mkdir(App.env.tmp);
    const p = App.env.tmp + '/' + name;
    const r = await codeome.local.write(p, code);
    return r.error ? null : p;
  }

  T.newMenu = (anchor) => {
    // Agents on this Mac live in the Agent chat (⌘1); the CLIs on the HPC stay here.
    const items = [
      { header: 'On this Mac' + (App.project ? ' · ' + App.basename(App.project) : '') },
      { label: 'Terminal', key: '⌘T', run: () => T.localShell() },
      { label: 'R console', run: () => T.rConsole() },
      { label: 'Agent chat', key: '⌘1', run: () => App.views.chat.ask('') },
      '-',
      { header: 'On the HPC' + (App.remoteDir ? ' · ' + App.basename(App.remoteDir) : '') },
      { label: 'Terminal', key: '⇧⌘T', run: () => T.hpcShell() },
      { label: 'R console', run: () => T.rConsole({ remote: true }) },
      ...App.cfg.agents.map((a) => ({ label: a.name + (App.cfg.hpc.useTmux ? ' (persistent)' : ''), run: () => T.agentHpc(a) }))
    ];
    if (anchor) App.menuAt(anchor, items); else App.menu(innerWidth / 2 - 110, innerHeight / 2 - 120, items);
  };

  // ---------- panel show/hide/resize ----------
  T.showPanel = () => { document.getElementById('panel').classList.remove('collapsed'); };
  T.togglePanel = () => {
    const p = document.getElementById('panel');
    p.classList.toggle('collapsed');
    if (!p.classList.contains('collapsed')) { const t = T.current(); if (t) setTimeout(() => { t.fit.fit(); t.term.focus(); }); else showEmpty(); }
  };
  T.retheme = () => { for (const t of T.list) t.term.options.theme = theme(); };

  T.init = () => {
    document.getElementById('term-new').onclick = (e) => T.newMenu(e.currentTarget);
    document.getElementById('term-hide').onclick = () => T.togglePanel();
    document.querySelector('#panel .panel-bar').addEventListener('dblclick', (e) => { if (e.target.closest('.panel-bar') && !e.target.closest('.tab,button')) T.togglePanel(); });
    showEmpty();
    // Drag to resize the panel.
    const rz = document.getElementById('panel-resizer');
    rz.addEventListener('mousedown', (e) => {
      const startY = e.clientY, panel = document.getElementById('panel'), startH = panel.getBoundingClientRect().height;
      panel.classList.remove('collapsed');
      const move = (ev) => { const nh = Math.max(120, Math.min(innerHeight - 200, startH - (ev.clientY - startY))); document.documentElement.style.setProperty('--panel-h', nh + 'px'); };
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); const t = T.current(); if (t) t.fit.fit(); App.views.editor.layout(); };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', T.retheme);
  };
})();
