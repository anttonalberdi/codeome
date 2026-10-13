// Wiring: views, cluster strip, project folder, menus, startup.
(function () {
  const h = App.h;
  App.currentView = 'files';

  App.setView = (v) => {
    App.currentView = v;
    document.querySelectorAll('#rail button[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    document.querySelectorAll('#sidebar .view').forEach((s) => { s.hidden = s.dataset.view !== v; });
    App.emit('view', v);
  };

  App.applyTheme = () => {
    const t = App.cfg.editor.theme;
    if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    App.views.editor.applyTheme(); App.views.terminals.retheme();
  };

  // ---------- project ----------
  // Opens the folder as a project card in the left column (or switches to it).
  App.openProject = (dir) => App.views.projects.open(dir);
  App.listen('project', () => renderWelcome());

  // ---------- HPC connection & cluster strip ----------
  // The shared connection opens in the background (login.js); prompts come as dialogs.
  // direct: skip Codeome's VPN tunnel this once (on campus, or with Cisco Secure Client on).
  App.connectHpc = async ({ direct = false } = {}) => {
    if (!App.cfg.hpc.host) return App.views.settings.open('hpc');
    if (App.hpcConnected) return;
    if (!direct && !App.login.busy('hpc') && App.setup.tunnelOn() && !App.setup.vpnUp) return App.setup.startVpn({ thenConnect: true });
    App.login.start('hpc');
  };
  App.disconnectHpc = async () => { await codeome.hpc.disconnect(); await App.pollHpc(); App.toast('Disconnected.'); };

  // ---------- long-term storage (SFTP) ----------
  // Same pattern as the HPC: a background login opens a shared connection the file browser reuses.
  App.storageConnected = false;
  App.connectStorage = () => {
    if (!App.cfg.storage.host) return App.views.settings.open('storage');
    if (App.storageConnected) return;
    App.login.start('storage');
  };
  App.disconnectStorage = async () => { await codeome.storage.disconnect(); await App.pollHpc(); App.toast('Disconnected from ' + App.views.files.title('storage') + '.'); };
  App.requireStorage = () => {
    const name = App.views.files.title('storage');
    if (!App.cfg.storage.host) { App.toast(`Set up ${name} in Settings first.`, { action: { label: 'Open Settings', run: () => App.views.settings.open('storage') } }); return false; }
    if (!App.storageConnected) { App.toast(`Not connected to ${name}.`, { action: { label: 'Connect', run: () => App.connectStorage() } }); return false; }
    return true;
  };

  let vpn = { known: false }, jobs = null;
  App.pollHpc = async () => {
    const [st, v, so] = await Promise.all([codeome.hpc.status(), codeome.hpc.vpn(), App.cfg.storage.host ? codeome.storage.status() : { connected: false }]);
    vpn = v;
    const tunnelUp = !!(v.tunnel && v.up);
    if (App.setup.vpnUp !== tunnelUp) { App.setup.vpnUp = tunnelUp; App.emit('vpn', tunnelUp); }
    const was = App.hpcConnected;
    App.hpcConnected = st.connected;
    if (was !== st.connected) App.emit('hpc', st.connected);
    const wasStorage = App.storageConnected;
    App.storageConnected = so.connected;
    if (wasStorage !== so.connected) App.emit('storage', so.connected);
    if (!st.connected) jobs = null;
    paint();
  };
  App.listen('jobs', (j) => { jobs = j; paint(); });
  App.listen('vpn', () => paint());
  App.listen('login', () => paint());
  App.listen('config', () => paint());

  function paint() {
    const v = document.getElementById('c-vpn'), hp = document.getElementById('c-hpc'), jb = document.getElementById('c-jobs');
    v.hidden = !vpn.known;
    v.className = 'c-seg ' + (App.setup.vpnStarting() ? 'busy' : vpn.up ? 'ok' : 'bad');
    v.title = vpn.tunnel
      ? (vpn.up ? "Codeome's VPN tunnel is running" : App.setup.vpnStarting() ? "Codeome's VPN tunnel is signing in" : "Codeome's VPN tunnel is not running")
      : (vpn.up ? 'VPN reachable' : 'VPN not reachable — the cluster may be unreachable');
    const connecting = App.login.busy('hpc');
    hp.className = 'c-seg ' + (connecting ? 'busy' : App.hpcConnected ? 'ok' : (App.cfg.hpc.host ? 'bad' : ''));
    document.getElementById('c-hpc-label').textContent = !App.cfg.hpc.host ? 'Set up HPC' : (connecting ? 'Connecting…' : (App.hpcConnected ? App.hpcName() : 'Connect ' + App.hpcName()));
    hp.title = App.cfg.hpc.host;
    jb.innerHTML = '';
    if (App.hpcConnected && jobs) {
      jb.append(h('span', h('b.r', String(jobs.running)), ' running'), ' ', h('span', h('b.p', String(jobs.pending)), ' waiting'));
      if (jobs.failed) jb.append(' ', h('span', h('b.f', String(jobs.failed)), ' failed'));
    }
  }

  function clusterMenu(el) {
    if (!App.cfg.hpc.host) return App.views.settings.open('hpc');
    const tunnel = App.setup.tunnelOn() && (App.setup.vpnUp || App.setup.vpnStarting());
    if (!App.hpcConnected && !tunnel) return App.connectHpc();
    App.menuAt(el, [
      ...(App.hpcConnected ? [
        { label: 'Slurm jobs', key: '⌘3', run: () => App.setView('slurm') },
        { label: 'HPC terminal', key: '⇧⌘T', run: () => App.views.terminals.hpcShell() },
        ...App.cfg.agents.map((a) => ({ label: a.name + ' on the HPC', run: () => App.views.terminals.agentHpc(a) })),
        '-',
        { label: 'Disconnect', run: () => App.disconnectHpc() }
      ] : App.login.busy('hpc') ? [
        { label: 'Connecting to ' + App.hpcName() + '…', run: () => App.connectHpc() },
        { label: 'Cancel connecting', run: () => App.login.stop('hpc') }
      ] : [{ label: 'Connect to ' + App.hpcName(), run: () => App.connectHpc() }]),
      ...(tunnel ? [{ label: 'Stop the VPN tunnel', run: () => App.setup.stopVpn() }] : []),
      '-',
      { label: 'HPC settings…', run: () => App.views.settings.open('hpc') }
    ]);
  }

  // ---------- welcome ----------
  // One free-form page per project, kept in the settings and saved as you type.
  function scratchpad(dir) {
    let timer = null;
    const ta = h('textarea.scratchpad', {
      value: (App.cfg.scratchpads || {})[dir] || '', spellcheck: 'false',
      placeholder: 'Scratchpad: notes, reminders, what to ask the agents next…',
      oninput: () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          App.cfg.scratchpads = { ...(App.cfg.scratchpads || {}), [dir]: ta.value };
          if (!ta.value) delete App.cfg.scratchpads[dir];
          App.saveConfig();
        }, 600);
      }
    });
    return h('div.scratch', ta);
  }

  function renderWelcome() {
    const w = document.getElementById('welcome'); w.innerHTML = '';
    w.append(h('div.welcome-inner',
      h('h1', App.project ? App.basename(App.project) : 'Codeome'),
      h('p', App.project ? App.project : 'Open a project folder to start. Your files, the cluster, and your agents live side by side here.'),
      App.project ? scratchpad(App.project) : h('div.quick', h('button', { onclick: () => App.openProject() }, h('b', 'Open folder'), h('span', 'A local project with your R and Python code'))),
      App.cfg.recentFolders.some((d) => !App.views.projects.list.includes(d)) ? h('div', { style: { marginTop: '16px' } }, h('div.hint', 'Recent'), App.cfg.recentFolders.filter((d) => !App.views.projects.list.includes(d)).slice(0, 5).map((d) => h('div', h('a', { href: '#', style: { color: 'var(--accent)' }, onclick: (e) => { e.preventDefault(); App.openProject(d); } }, App.tildify(d))))) : null));
  }
  App.listen('hpc', renderWelcome);

  // ---------- sidebar resize ----------
  function initResize() {
    const rz = document.getElementById('sidebar-resizer'), app = document.getElementById('app');
    const mainBand = document.getElementById('main-band'), sideBand = document.getElementById('side-band');
    const MIN = 220, MAX = 760, SNAP = 70;   // dragging this far past either limit folds that side away
    const setW = (px) => document.documentElement.style.setProperty('--side-w', px + 'px');
    // state: 'both' (normal), 'main' (editor and terminal folded away), 'side' (sidebar folded away)
    const show = (state) => {
      app.classList.toggle('main-collapsed', state === 'main'); mainBand.hidden = state !== 'main';
      app.classList.toggle('side-collapsed', state === 'side'); sideBand.hidden = state !== 'side';
      App.views.editor.layout();
    };
    const state = () => app.classList.contains('main-collapsed') ? 'main' : app.classList.contains('side-collapsed') ? 'side' : 'both';
    mainBand.addEventListener('click', () => { setW(420); show('both'); });
    sideBand.addEventListener('click', () => { setW(300); show('both'); });
    // Picking a view in the rail while the sidebar is folded away opens it again.
    document.getElementById('rail').addEventListener('click', () => { if (state() === 'side') { setW(300); show('both'); } }, true);
    rz.addEventListener('mousedown', (e) => {
      const start = e.clientX, s0 = state();
      const w = s0 === 'main' ? MAX : s0 === 'side' ? MIN : document.getElementById('sidebar').getBoundingClientRect().width;
      const move = (ev) => {
        const raw = w + ev.clientX - start;
        if (raw > MAX + SNAP) return show('main');
        if (raw < MIN - SNAP) return show('side');
        setW(Math.max(MIN, Math.min(MAX, raw)));
        show('both');
      };
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); App.views.editor.layout(); };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    });
  }

  // ---------- menu commands ----------
  const commands = {
    'open-folder': () => App.openProject(), 'close-project': () => App.project && App.views.projects.close(App.project),
    'next-project': () => App.views.projects.cycle(1), 'prev-project': () => App.views.projects.cycle(-1), 'new-file': () => App.views.editor.newFile(), save: () => App.views.editor.save(),
    'close-tab': () => { const t = App.views.editor.cur(); if (t) App.views.editor.close(t.id); },
    settings: () => App.views.settings.toggle(),
    'view-files': () => App.setView('files'), 'view-slurm': () => App.setView('slurm'), 'view-git': () => App.setView('git'),
    'new-chat': () => { App.setView('agents'); App.views.agents.show('chat'); App.views.chat.newChat(); },
    'next-chat': () => { App.setView('agents'); App.views.agents.show('chat'); App.views.chat.cycle(1); },
    'prev-chat': () => { App.setView('agents'); App.views.agents.show('chat'); App.views.chat.cycle(-1); },
    transfer: () => App.views.transfer.open(),
    'view-publish': () => App.setView('publish'), 'view-packages': () => App.setView('packages'), 'view-plots': () => App.setView('plots'), 'view-agents': () => App.setView('agents'),
    'toggle-panel': () => App.views.terminals.togglePanel(), 'new-terminal': () => App.views.terminals.localShell(),
    'new-hpc-terminal': () => App.views.terminals.hpcShell(), 'r-console': () => App.views.terminals.rConsole(), preview: () => App.views.editor.previewCurrent()
  };

  App.start = async () => {
    App.cfg = await codeome.config.get();
    codeome.version().then((v) => { document.getElementById('app-version').textContent = 'v' + v; });
    // Clicking the version looks for a newer Codeome (and Claude Code / Codex) on GitHub right away.
    const ver = document.getElementById('app-version');
    ver.title = 'Check for updates';
    ver.addEventListener('click', async () => {
      if (ver.classList.contains('busy')) return;
      ver.classList.add('busy'); App.toast('Checking GitHub for updates…');
      const r = await App.setup.checkClis({ force: true });
      ver.classList.remove('busy');
      if (!r || r.error) return App.err('Could not check for updates' + (r && r.error ? ': ' + r.error : '.'));
      const me = r.updates.find((u) => u.engine === 'codeome'), clis = r.updates.filter((u) => u.command);
      if (me) App.toast(`Codeome ${me.latest} is available. You have ${me.installed}.`, { ms: 20000, action: { label: 'View release', run: () => codeome.shell.open(me.url) } });
      else App.toast(`Codeome ${r.installed.codeome} is up to date.`);
      if (clis.length) App.toast(`${clis.map((u) => `${u.label} ${u.latest}`).join(' and ')} available.`, { ms: 20000, action: { label: 'Update…', run: () => App.setup.updateClis(clis) } });
    });
    App.views.terminals.init();
    App.views.transfer.init(); App.views.files.init(); App.views.slurm.init(); App.views.git.init(); App.views.publish.init(); App.views.packages.init(); App.views.plots.init(); App.views.agents.init();
    App.views.projects.init();
    App.views.usage.init();
    App.views.editor.initMonaco();
    App.applyTheme();
    initResize();
    // Rail buttons switch the sidebar; the Transfer one opens its tab instead.
    document.querySelectorAll('#rail button').forEach((b) => { b.onclick = () => (b.dataset.view ? App.setView(b.dataset.view) : commands[b.dataset.action]()); });
    document.getElementById('settings-btn').onclick = () => App.views.settings.toggle();
    const cl = document.getElementById('cluster');
    cl.onclick = () => clusterMenu(cl);
    cl.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); clusterMenu(cl); } };
    codeome.onMenu((c) => commands[c] && commands[c]());
    App.views.editor.activate(null);
    paint();
    renderWelcome();
    codeome.env.detect().then((env) => {
      App.env = env;
      App.views.projects.render(); renderWelcome();
      if (!env.ptyOk) App.err('Terminals need a one-time rebuild. In the Codeome folder run: npm run rebuild\n\n' + env.ptyError.split('\n')[0]);
      const missing = App.cfg.agents.filter((a) => env.tools[a.cmd.split(' ')[0]] === false).map((a) => a.name);
      const getable = ['claude', 'codex'].filter((t) => env.installable.includes(t));
      if (missing.length) App.toast(`${missing.join(' and ')} not found on this Mac's PATH. Install it or adjust the command in Settings.`,
        getable.length ? { action: { label: 'Install', run: () => App.setup.install(getable) } } : undefined);
      App.setup.check(env);
      // Newer agent CLIs are suggested about once a week (the lookup itself is rate-limited in main).
      setTimeout(() => App.setup.checkClis({ suggest: true }), 8000);
      setInterval(() => App.setup.checkClis({ suggest: true }), 6 * 3600 * 1000);
    });
    await App.views.projects.restore();
    if (!App.project) App.views.files.go('local', App.cfg.localRoot || '~');
    await App.pollHpc();
    setInterval(() => { if (!document.hidden && !App.login.busy('hpc')) App.pollHpc(); }, 15000);
    if (!App.cfg.hpc.host) setTimeout(() => App.toast('Set up your HPC connection, VPN included, in Settings.', { action: { label: 'Open Settings', run: () => App.views.settings.open('hpc') } }), 800);
  };
})();
