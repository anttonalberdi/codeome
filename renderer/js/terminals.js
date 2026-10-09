// Bottom panel: local shells, HPC shells, and Claude Code / Codex sessions.
(function () {
  const h = App.h;
  const T = { list: [], active: null, seq: 0 };
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

  // spec: {kind, title, command, cwd, session, badge, secretEnv}
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
    const t = { id, spec, term, fit, el, title: spec.title, alive: true };
    T.list.push(t);
    term.onData((d) => codeome.pty.write(id, d));
    term.onResize(({ cols, rows }) => codeome.pty.resize(id, cols, rows));
    new ResizeObserver(() => { if (!el.hidden) { try { fit.fit(); } catch {} } }).observe(el);
    T.activate(id);
    try { fit.fit(); } catch {}
    const r = await codeome.pty.spawn({ id, ...spec, cols: term.cols, rows: term.rows });
    if (r.error) { term.write('\r\n\x1b[31m' + r.error.replace(/\n/g, '\r\n') + '\x1b[0m\r\n'); t.alive = false; renderTabs(); }
    return t;
  };

  T.activate = function (id) {
    T.active = id;
    for (const t of T.list) t.el.hidden = t.id !== id;
    renderTabs();
    const t = T.get(id);
    if (t) setTimeout(() => { try { t.fit.fit(); } catch {} t.term.focus(); }, 0);
    document.querySelector('.term-empty')?.remove();
  };
  T.get = (id) => T.list.find((t) => t.id === id);
  T.current = () => T.get(T.active);

  T.close = function (id) {
    const t = T.get(id); if (!t) return;
    codeome.pty.kill(id); t.term.dispose(); t.el.remove();
    T.list = T.list.filter((x) => x !== t);
    if (T.active === id) { const last = T.list[T.list.length - 1]; if (last) T.activate(last.id); else { T.active = null; renderTabs(); showEmpty(); } }
    else renderTabs();
  };

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
    host().append(h('div.term-empty', h('div', 'No sessions. ', h('button.btn.small', { onclick: (e) => T.newMenu(e.currentTarget) }, 'New session'))));
  }

  function renderTabs() {
    const el = tabsEl(); el.innerHTML = '';
    for (const t of T.list) {
      el.append(h('div.tab' + (t.id === T.active ? '.active' : ''), { onclick: () => T.activate(t.id), title: t.spec.cwd || '', onauxclick: (e) => { if (e.button === 1) T.close(t.id); } },
        h('i.live' + (t.alive ? '' : '.dead')),
        t.spec.badge ? h('span.badge' + (t.spec.badge === 'HPC' ? '.hpc' : ''), t.spec.badge) : null,
        h('span.t', t.title),
        h('button.x', { title: 'Close', onclick: (e) => { e.stopPropagation(); T.close(t.id); } }, h('span', '×'))));
    }
  }

  codeome.pty.onData(({ id, data }) => { const t = T.get(id); if (t) t.term.write(data); });
  codeome.pty.onExit(({ id, code }) => {
    const t = T.get(id); if (!t) return;
    t.alive = false; renderTabs();
    t.term.write(`\r\n\x1b[2m[session ended${code ? ' with code ' + code : ''}]\x1b[0m\r\n`);
    if (t.spec.onExit) t.spec.onExit(code);
  });

  // ---------- launchers ----------
  T.localShell = (cwd) => T.open({ kind: 'shell', title: App.basename(cwd || App.project || '~') || 'zsh', cwd: cwd || App.project || '~', badge: 'Mac' });
  T.hpcShell = (cwd) => { if (!App.requireHpc()) return; return T.open({ kind: 'hpc-shell', title: App.basename(cwd || App.remoteDir || '~'), cwd: cwd || App.remoteDir || '~', badge: 'HPC' }); };
  T.agentLocal = (agent, cwd) => T.open({ kind: 'agent-local', title: agent.name, command: agent.cmd, cwd: cwd || App.project || '~', badge: 'Mac' });
  T.agentHpc = (agent, cwd) => {
    if (!App.requireHpc()) return;
    const dir = cwd || App.remoteDir || '~';
    const session = 'codeome-' + App.safeName(agent.name) + '-' + App.safeName(App.basename(dir) || 'home');
    return T.open({ kind: 'agent-hpc', title: agent.name, command: agent.cmd, cwd: dir, session, badge: 'HPC' });
  };
  T.task = (title, command, cwd, extra = {}) => T.open({ kind: 'task', title, command, cwd: cwd || App.project || '~', badge: 'Mac', ...extra });
  T.hpcTask = (title, command, cwd) => { if (!App.requireHpc()) return; return T.open({ kind: 'hpc-task', title, command, cwd: cwd || App.remoteDir || '~', badge: 'HPC' }); };

  T.newMenu = (anchor) => {
    const items = [
      { header: 'On this Mac' + (App.project ? ' · ' + App.basename(App.project) : '') },
      { label: 'Terminal', key: '⌘T', run: () => T.localShell() },
      ...App.cfg.agents.map((a) => ({ label: a.name, run: () => T.agentLocal(a) })),
      '-',
      { header: 'On the HPC' + (App.remoteDir ? ' · ' + App.basename(App.remoteDir) : '') },
      { label: 'Terminal', key: '⇧⌘T', run: () => T.hpcShell() },
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
