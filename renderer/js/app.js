// Wiring: views, cluster strip, project folder, menus, startup.
(function () {
  const h = App.h;
  App.currentView = 'files';

  App.setView = (v) => {
    App.currentView = v;
    document.querySelectorAll('#rail button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
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
  let connecting = false;
  App.connectHpc = async () => {
    if (!App.cfg.hpc.host) return App.views.settings.open();
    if (App.hpcConnected) return;
    connecting = true; paint();
    // The login runs in a visible terminal so password / one-time-code prompts work.
    App.views.terminals.open({
      kind: 'hpc-login', title: 'Connect ' + App.cfg.hpc.host, badge: 'HPC',
      onExit: async () => { connecting = false; await App.pollHpc(); if (App.hpcConnected) { App.toast('Connected to ' + App.cfg.hpc.host + '.'); const t = App.views.terminals.list.find((x) => x.spec.kind === 'hpc-login' && !x.alive); if (t) setTimeout(() => App.views.terminals.close(t.id), 600); } else paint(); }
    });
  };
  App.disconnectHpc = async () => { await codeome.hpc.disconnect(); await App.pollHpc(); App.toast('Disconnected.'); };

  // ---------- long-term storage (SFTP) ----------
  // Same pattern as the HPC: a visible login opens a shared connection the file browser reuses.
  let storageConnecting = false;
  App.storageConnected = false;
  App.connectStorage = () => {
    if (!App.cfg.storage.host) return App.views.settings.open('storage');
    if (App.storageConnected || storageConnecting) return;
    storageConnecting = true;
    const name = App.views.files.title('storage');
    App.views.terminals.open({
      kind: 'storage-login', title: 'Connect ' + name, badge: 'SFTP',
      onExit: async () => {
        storageConnecting = false; await App.pollHpc();
        if (!App.storageConnected) return;
        App.toast('Connected to ' + name + '.');
        const t = App.views.terminals.list.find((x) => x.spec.kind === 'storage-login' && !x.alive);
        if (t) setTimeout(() => App.views.terminals.close(t.id), 600);
      }
    });
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

  function paint() {
    const v = document.getElementById('c-vpn'), hp = document.getElementById('c-hpc'), jb = document.getElementById('c-jobs');
    v.hidden = !vpn.known;
    v.className = 'c-seg ' + (vpn.up ? 'ok' : 'bad');
    v.title = vpn.up ? 'VPN reachable' : 'VPN not reachable — the cluster may be unreachable';
    hp.className = 'c-seg ' + (connecting ? 'busy' : App.hpcConnected ? 'ok' : (App.cfg.hpc.host ? 'bad' : ''));
    document.getElementById('c-hpc-label').textContent = !App.cfg.hpc.host ? 'Set up HPC' : (connecting ? 'Connecting…' : (App.hpcConnected ? App.cfg.hpc.host : 'Connect ' + App.cfg.hpc.host));
    jb.innerHTML = '';
    if (App.hpcConnected && jobs) {
      jb.append(h('span', h('b.r', String(jobs.running)), ' running'), ' ', h('span', h('b.p', String(jobs.pending)), ' waiting'));
      if (jobs.failed) jb.append(' ', h('span', h('b.f', String(jobs.failed)), ' failed'));
    }
  }

  function clusterMenu(el) {
    if (!App.cfg.hpc.host) return App.views.settings.open();
    if (!App.hpcConnected) return App.connectHpc();
    App.menuAt(el, [
      { label: 'Slurm jobs', key: '⌘3', run: () => App.setView('slurm') },
      { label: 'HPC terminal', key: '⇧⌘T', run: () => App.views.terminals.hpcShell() },
      ...App.cfg.agents.map((a) => ({ label: a.name + ' on the HPC', run: () => App.views.terminals.agentHpc(a) })),
      '-',
      { label: 'Disconnect', run: () => App.disconnectHpc() }
    ]);
  }

  // ---------- welcome ----------
  function renderWelcome() {
    const w = document.getElementById('welcome'); w.innerHTML = '';
    w.append(h('div.welcome-inner',
      h('h1', App.project ? App.basename(App.project) : 'Codeome'),
      h('p', App.project ? App.project : 'Open a project folder to start. Your files, the cluster, and your agents live side by side here.'),
      h('div.quick',
        h('button', { onclick: () => App.openProject() }, h('b', App.project ? 'Open another project' : 'Open folder'), h('span', App.project ? 'It gets its own card on the left; this one keeps running' : 'A local project with your R and Python code')),
        h('button', { onclick: () => App.views.editor.newFile() }, h('b', 'New file'), h('span', 'Script, notebook or report')),
        App.project ? h('button', { onclick: () => App.views.chat.ask('') }, h('b', 'Ask the agent'), h('span', 'Chats in tabs; they hand work to Codex and Claude specialists')) : null,
        h('button', { onclick: () => App.cfg.hpc.host ? (App.hpcConnected ? App.views.terminals.hpcShell() : App.connectHpc()) : App.views.settings.open() }, h('b', App.hpcConnected ? 'HPC terminal' : (App.cfg.hpc.host ? 'Connect to HPC' : 'Set up the HPC')), h('span', App.cfg.hpc.host || 'Your cluster login and VPN check')),
        h('button', { onclick: () => App.views.terminals.rConsole() }, h('b', 'R console'), h('span', App.project ? 'Starts in ' + App.basename(App.project) + '; ⌘↩ in R and Rmd files runs code there' : 'R and Rmd code runs here with ⌘↩')),
        h('button', { onclick: () => App.setView('slurm') }, h('b', 'Slurm jobs'), h('span', 'Queue, logs and new job scripts'))),
      App.cfg.recentFolders.some((d) => !App.views.projects.list.includes(d)) ? h('div', { style: { marginTop: '16px' } }, h('div.hint', 'Recent'), App.cfg.recentFolders.filter((d) => !App.views.projects.list.includes(d)).slice(0, 5).map((d) => h('div', h('a', { href: '#', style: { color: 'var(--accent)' }, onclick: (e) => { e.preventDefault(); App.openProject(d); } }, App.tildify(d))))) : null,
      h('div.keys',
        h('kbd', '⌘↩'), h('span', 'Run the current line, statement or selection: R code goes to the R console, the rest to the active terminal'),
        h('kbd', '⇧⌘↩'), h('span', 'Run the whole file (source it, for R); in Rmd and Quarto files, run the current chunk'),
        h('kbd', '⌥⌘R  ⌥⌘P'), h('span', 'Rmd: run all chunks · run the chunks above'),
        h('kbd', '⇧⌘V'), h('span', 'Preview or render the current file'),
        h('kbd', '⌘J'), h('span', 'Show or hide the terminal panel'),
        h('kbd', '⌘1–6'), h('span', 'Agent chat, Files, Slurm, Git, Publish, Python packages'),
        h('kbd', '⌃⇥'), h('span', 'Next project (⌃⇧⇥ previous)'))));
  }
  App.listen('hpc', renderWelcome);

  // ---------- sidebar resize ----------
  function initResize() {
    const rz = document.getElementById('sidebar-resizer');
    rz.addEventListener('mousedown', (e) => {
      const start = e.clientX, w = document.getElementById('sidebar').getBoundingClientRect().width;
      const move = (ev) => document.documentElement.style.setProperty('--side-w', Math.max(220, Math.min(760, w + ev.clientX - start)) + 'px');
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
    'view-publish': () => App.setView('publish'), 'view-pip': () => App.setView('pip'), 'view-agents': () => App.setView('agents'),
    'toggle-panel': () => App.views.terminals.togglePanel(), 'new-terminal': () => App.views.terminals.localShell(),
    'new-hpc-terminal': () => App.views.terminals.hpcShell(), 'r-console': () => App.views.terminals.rConsole(), preview: () => App.views.editor.previewCurrent()
  };

  App.start = async () => {
    App.cfg = await codeome.config.get();
    App.views.terminals.init();
    App.views.files.init(); App.views.slurm.init(); App.views.git.init(); App.views.publish.init(); App.views.pip.init(); App.views.agents.init();
    App.views.projects.init();
    App.views.usage.init();
    App.views.editor.initMonaco();
    App.applyTheme();
    initResize();
    document.querySelectorAll('#rail button').forEach((b) => { b.onclick = () => App.setView(b.dataset.view); });
    document.getElementById('settings-btn').onclick = () => App.views.settings.toggle();
    document.getElementById('project-btn').onclick = () => App.openProject();
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
      if (missing.length) App.toast(`${missing.join(' and ')} not found on this Mac's PATH. Install it or adjust the command in Settings.`);
    });
    await App.views.projects.restore();
    if (!App.project) App.views.files.go('local', App.cfg.localRoot || '~');
    await App.pollHpc();
    setInterval(() => { if (!document.hidden && !connecting) App.pollHpc(); }, 15000);
    if (!App.cfg.hpc.host) setTimeout(() => App.toast('Add your cluster login to connect to the HPC.', { action: { label: 'Open Settings', run: () => App.views.settings.open() } }), 800);
  };
})();
