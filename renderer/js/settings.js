// Settings: a full page over the workspace, showing one section at a time. Changes save as you make them.
// Sections: HPC, long-term storage, Transfer (favourite folders), Agents (for all projects: the chat's model, the command-line agents and
// the global agents and skills; for the open project: its agents with their engine and model, and its skills),
// accounts and limits, Python, publishing tokens, your own secrets,
// appearance, and what was found on this Mac.
(function () {
  const h = App.h;
  const S = { isOpen: false };
  App.views.settings = S;
  let page, nav, main, savedEl, agentsHost, globalHost, setupHost, serverList, storageHost, accountsHost;
  let sections = {};
  let current = 'hpc'; // the section shown; reopening Settings returns to it

  const DEFAULT_DIR = { claude: '~/.claude', codex: '~/.codex' };

  // Claude Code takes an alias (latest of that family) or a full model ID.
  const CLAUDE_MODELS = [
    { value: 'opus', label: 'Opus (latest)' },
    { value: 'sonnet', label: 'Sonnet (latest)' },
    { value: 'haiku', label: 'Haiku (latest)' },
    { value: 'claude-fable-5-1', label: 'Fable 5.1' },
    { value: 'claude-opus-5-5', label: 'Opus 5.5' },
    { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { value: 'claude-haiku-5-5', label: 'Haiku 5.5' }
  ];
  const EFFORT_LABEL = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
  const efforts = (...levels) => [{ value: '', label: 'Default' }, ...levels.map((v) => ({ value: v, label: EFFORT_LABEL[v] }))];
  const CLAUDE_EFFORTS = efforts('low', 'medium', 'high', 'xhigh', 'max');
  const CODEX_EFFORTS = efforts('minimal', 'low', 'medium', 'high', 'xhigh');
  const ENGINES = [
    { value: 'claude', label: 'Claude' },
    { value: 'codex', label: 'Codex' },
    { value: 'cross', label: 'The other engine' }
  ];
  const ENGINE_NAME = { claude: 'Claude', codex: 'Codex', cross: 'the other engine' };
  const MODEL_RE = /^(?!-)[\w.:/[\]-]{1,80}$/;
  const SECTIONS = [
    ['projects', 'Projects'], ['hpc', 'HPC'], ['storage', 'Storage'], ['transfer', 'Transfer'], ['agents', 'Agents'], ['policy', 'Agent policy'], ['accounts', 'Accounts & limits'], ['r', 'R'], ['python', 'Python'],
    ['git', 'Git & GitHub'], ['publishing', 'Zenodo & PyPI'], ['secrets', 'Secrets'], ['appearance', 'Appearance'], ['mac', 'This Mac']
  ];
  const ALIAS = { github: 'git', zenodo: 'publishing', pypi: 'publishing', erda: 'storage', tokens: 'secrets' };

  // ---------- page ----------
  S.open = async (section) => {
    if (!page) build();
    S.isOpen = true;
    page.hidden = false;
    document.getElementById('app').classList.add('settings-open');
    const id = ALIAS[section] || section;
    if (id && SECTIONS.some(([s]) => s === id)) current = id;
    await show(current);
    nav.querySelector('button.on')?.focus();
  };

  S.close = () => {
    if (!page || page.hidden) return;
    page.hidden = true; S.isOpen = false;
    document.getElementById('app').classList.remove('settings-open');
    App.views.editor.layout();
  };
  S.toggle = (section) => (S.isOpen ? S.close() : S.open(section));

  function build() {
    nav = h('nav.sp-nav', { 'aria-label': 'Settings sections' },
      SECTIONS.map(([id, label]) => h('button', { 'data-id': id, onclick: () => show(id) }, label)));
    main = h('div.sp-main');
    savedEl = h('span.sp-saved', { 'aria-live': 'polite' });
    page = h('section#settings-page', { hidden: true, role: 'region', 'aria-label': 'Settings' },
    h('div.sp-side', h('div.sp-title', h('h1', 'Settings'), savedEl), nav,
      h('div.sp-side-foot', h('button.btn', { onclick: S.close }, 'Done'), h('span.hint', 'Esc'))),
    main);
    document.getElementById('app').append(page);
    // Escape closes the page unless a dialog, menu or popover is open on top of it.
    document.addEventListener('keydown', (e) => {
      if (!S.isOpen || e.key !== 'Escape' || e.defaultPrevented) return;
      if (!document.getElementById('overlay').hidden || !document.getElementById('menu-pop').hidden || App.pop) return;
      e.preventDefault(); S.close();
    });
    // Navigating elsewhere closes the page; switching projects refreshes the agents.
    App.listen('view', () => S.close());
    App.listen('project', () => { if (S.isOpen) { renderGlobal(); renderAgents(); if (current === 'secrets') show('secrets'); } });
    // The HPC checklist follows the connection, the tunnel and setup steps as they happen.
    for (const ev of ['setup', 'hpc', 'vpn', 'login', 'login-test', 'vpn-test']) App.listen(ev, () => { if (S.isOpen) renderSetup(); });
    App.listen('hpc', () => { if (S.isOpen && current === 'secrets') show('secrets'); });
    for (const ev of ['storage', 'login', 'config']) App.listen(ev, () => { if (S.isOpen) renderStorage(); });
    App.listen('config', () => { if (S.isOpen && current === 'transfer' && !favBusy) sections.transfer.replaceWith(transferSection()); });
    App.listen('config', () => { if (S.isOpen && current === 'policy') renderPolicyRows(); });
    for (const ev of ['usage', 'config']) App.listen(ev, () => { if (S.isOpen) renderAccounts(); });
    App.listen('env', () => { if (S.isOpen && current === 'mac') sections.mac.replaceWith(macSection()); });
  }

  function markNav(id) {
    nav.querySelectorAll('button').forEach((b) => {
      const on = b.dataset.id === id;
      b.classList.toggle('on', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }

  // Save after a change, then apply what needs applying.
  let saveTimer = null, pendingApply = {};
  function commit(apply = {}) {
    Object.assign(pendingApply, apply);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const a = pendingApply; pendingApply = {};
      await App.saveConfig();
      if (a.theme) App.applyTheme();
      if (a.font) {
        if (App.views.editor.editor) App.views.editor.editor.updateOptions({ fontSize: App.cfg.editor.fontSize });
        for (const t of App.views.terminals.list) t.term.options.fontSize = App.cfg.editor.fontSize;
      }
      if (a.host || a.storage) App.pollHpc();
      if (a.setup) App.setup.refresh();
      flash();
    }, 250);
  }
  function flash(text = 'Saved') {
    savedEl.textContent = text; savedEl.classList.add('on');
    clearTimeout(flash.t); flash.t = setTimeout(() => savedEl.classList.remove('on'), 1600);
  }

  // ---------- building blocks ----------
  const section = (id, title, intro, ...kids) => (sections[id] = h('section.sp-section', { 'data-id': id, 'aria-labelledby': 'sp-' + id },
    h('h2', { id: 'sp-' + id }, title), intro ? h('p.sp-intro', intro) : null, ...kids));
  const card = (title, ...kids) => h('div.sp-card', title ? h('div.sp-card-h', title) : null, ...kids);
  // A labelled row: text and hint on the left, the control on the right.
  const row = (label, control, hint) => h('div.sp-row', h('div.sp-label', h('label', label), hint ? h('div.hint', hint) : null), h('div.sp-ctl', control));

  // Inputs that write to the config when they change.
  function text(get, set, opts = {}) {
    return h('input', { type: opts.type || 'text', value: get() ?? '', placeholder: opts.placeholder || '', spellcheck: 'false', autocomplete: 'off', 'aria-label': opts.label || '',
      onchange: (e) => { set(e.target.value); commit(opts.apply); } });
  }
  function check(label, get, set, apply, title) {
    const i = h('input', { type: 'checkbox', checked: !!get(), onchange: (e) => { set(e.target.checked); commit(apply); } });
    return h('label.check', title ? { title } : {}, i, label);
  }
  function select(options, value, onchange, label) {
    const has = options.some((o) => o.value === value);
    return h('select', { 'aria-label': label || '', onchange: (e) => onchange(e.target.value, e.target) },
      has ? null : h('option', { value, selected: true }, value),
      options.map((o) => (o.group ? h('optgroup', { label: o.group }, o.options.map((x) => h('option', { value: x.value, selected: x.value === value }, x.label))) : h('option', { value: o.value, selected: o.value === value }, o.label))));
  }
  // A model picker with an "Other…" entry for any model ID.
  function modelSelect(options, value, save, label) {
    const opts = [...options, { value: '\u0000other', label: 'Other…' }];
    const sel = select(opts, value, async (v, el) => {
      if (v === '\u0000other') {
        const m = await App.prompt('Model', 'Model ID or alias', value || '', { placeholder: 'e.g. claude-opus-5-5' });
        if (!m || !MODEL_RE.test(m)) { el.value = value; if (m) App.err('Not a model name: ' + m); return; }
        v = m;
      }
      value = v;
      save(v);
    }, label);
    return sel;
  }

  function forumNumber(label, key, low, high, fallback) {
    const value = (App.cfg.forum || {})[key] ?? fallback;
    const message = h('span.hint', { role: 'alert' });
    const input = h('input', { type: 'number', min: String(low), max: String(high), step: '1', value: String(value), 'aria-label': label,
      oninput: (event) => {
        const n = Number(event.target.value);
        const valid = event.target.value !== '' && Number.isInteger(n) && n >= low && n <= high;
        message.textContent = valid ? '' : `Enter a whole number from ${low.toLocaleString()} to ${high.toLocaleString()}.`;
        event.target.setAttribute('aria-invalid', String(!valid));
      },
      onchange: (event) => {
        const n = Number(event.target.value);
        if (event.target.value === '' || !Number.isInteger(n) || n < low || n > high) return;
        App.cfg.forum = { ...(App.cfg.forum || {}), [key]: n };
        commit();
      } });
    return h('div.forum-setting-number', input, message);
  }

  // ---------- render ----------
  // Only the chosen section is built; the live parts (setup checklist, team) exist only while it shows.
  const BUILD = {
    hpc: hpcSection, storage: storageSection, transfer: transferSection, agents: agentsSection, policy: policySection, accounts: accountsSection, r: rSection,
    projects: projectsSection, python: pythonSection, git: gitSection, publishing: publishingSection, secrets: secretsSection, appearance: appearanceSection, mac: macSection
  };
  let showSeq = 0;
  async function show(id) {
    const seq = ++showSeq;
    current = id;
    markNav(id);
    agentsHost = globalHost = setupHost = serverList = storageHost = accountsHost = null;
    sections = {};
    if (id === 'policy' || id === 'agents' || id === 'secrets') main.replaceChildren(h('div.sp-content', h('p.sp-intro', { role: 'status' },
      id === 'policy' ? 'Loading agent policy…' : id === 'agents' ? 'Loading agent settings…' : 'Loading secrets…')));
    const el = await BUILD[id](App.cfg);
    if (seq !== showSeq || id !== current || !S.isOpen) return; // another section was picked while this one loaded
    if (id === 'git') { sections.git = el; gitRows = el.gitRows; }
    main.replaceChildren(h('div.sp-content', el));
    main.scrollTop = 0;
    if (id === 'agents') { renderGlobal(); renderAgents(); }
    if (id === 'hpc') { renderSetup(); App.setup.refresh(); }
    if (id === 'storage') renderStorage();
    if (id === 'accounts') { renderAccounts(); findFolders(); }
    if (id === 'git') recheckGitAccounts(el);
  }

  // ---------- HPC ----------
  const vpn = () => App.cfg.hpc.vpn;
  // Passwords go straight to the Keychain; the page only knows whether one is saved.
  function savedPassword(KEY, label, ask) {
    const SAVED = 'Saved — type a new one to replace';
    const status = h('span.pill', '…');
    const input = h('input', { type: 'password', placeholder: ask, autocomplete: 'off', 'aria-label': label });
    const clear = h('button.btn.small', { hidden: true, onclick: async () => { await codeome.secret.set(KEY, ''); paint(false); flash('Password removed'); } }, 'Remove');
    const save = h('button.btn.small', { onclick: async () => {
      if (!input.value) return;
      await codeome.secret.set(KEY, input.value);
      input.value = ''; paint(true); flash('Password saved');
    } }, 'Save');
    input.onkeydown = (e) => { if (e.key === 'Enter') save.click(); };
    function paint(has) {
      status.className = 'pill' + (has ? ' ok' : '');
      status.textContent = has ? 'saved' : 'not saved';
      input.placeholder = has ? SAVED : ask;
      clear.hidden = !has;
    }
    codeome.secret.has(KEY).then(paint);
    return h('div.row', input, save, clear, status);
  }
  function hpcSection(c) {
    const tunnel = c.hpc.vpn.mode === 'tunnel';
    setupHost = h('div');
    serverList = h('datalist#sp-vpn-servers');
    const redraw = () => { sections.hpc.replaceWith(hpcSection(App.cfg)); renderSetup(); };
    const mode = select([
      { value: 'system', label: 'Campus network, or a VPN for the whole Mac' },
      { value: 'tunnel', label: "Codeome's own VPN tunnel" }
    ], c.hpc.vpn.mode, (v) => { vpn().mode = v; commit({ host: true, setup: true }); redraw(); }, 'How Codeome reaches the HPC network');
    return section('hpc', 'HPC', 'How Codeome reaches your cluster. It uses your system ssh, so existing ssh logins, keys and jump hosts keep working.',
      card('Network',
        row('Reach the HPC through', mode, tunnel
          ? "Only Codeome's connections to the HPC go through the VPN; the rest of the Mac stays on its own network. Uses OpenConnect, which speaks Cisco's protocol. Off campus, use it instead of Cisco Secure Client, not alongside it."
          : "Codeome uses whatever network the Mac is on. Off campus, turn on Cisco Secure Client first, or choose Codeome's own VPN tunnel to sign in (username, password and MFA) from here."),
        ...(tunnel ? [
          row('VPN server', h('div', h('input', { type: 'text', value: vpn().server, list: 'sp-vpn-servers', placeholder: 'vpn.example.org', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'VPN server',
            onchange: (e) => { vpn().server = e.target.value.trim(); commit({ setup: true }); } }), serverList),
          'The server Cisco Secure Client connects to.'),
          row('Username', text(() => vpn().user, (v) => { vpn().user = v.trim(); }, { placeholder: 'Asked for when the tunnel starts', label: 'VPN username' }),
            'Optional. Without it, Codeome asks when the tunnel starts.'),
          row('Password', savedPassword('vpn:password', 'VPN password', 'Asked for when the tunnel starts'),
            'Optional. Kept in the macOS Keychain and used when the tunnel signs in; without it, Codeome asks. Then approve the sign-in on your MFA device.'),
          row('Local port', text(() => vpn().port, (v) => { const n = Math.round(Number(v)); vpn().port = n > 1023 && n < 65536 ? n : 11080; }, { type: 'number', apply: { host: true, setup: true }, label: 'Local port' }),
            'Where the tunnel listens on this Mac (127.0.0.1 only). Change it only if 11080 is taken.'),
          row('Extra options', text(() => vpn().args, (v) => { vpn().args = v.trim(); }, { placeholder: 'None', label: 'Extra openconnect options' }),
            'Passed to openconnect, e.g. --authgroup=NAME. Leave empty unless signing in needs it.')
        ] : [
          row('VPN check', text(() => App.cfg.hpc.vpnCheckHost, (v) => { App.cfg.hpc.vpnCheckHost = v.trim(); }, { placeholder: 'Your HPC login', apply: { host: true, setup: true }, label: 'VPN check host' }),
            'Optional: host or host:port, only reachable on the VPN; the title bar shows whether it answers. Not the VPN server itself, which is public. Empty: your HPC login is checked.')
        ])),
      card('Login',
        row('Name', text(() => (App.cfg.ui.panes.remote || {}).title || '', (v) => { const p = App.cfg.ui.panes.remote = App.cfg.ui.panes.remote || {}; if (v.trim() && v.trim() !== 'HPC') p.title = v.trim().slice(0, 40); else delete p.title; }, { placeholder: 'e.g. MyCluster', label: 'HPC name' }),
          'Shown in the title bar and on the HPC files pane. Empty: the title bar shows your login.'),
        row('Login', h('div.row', text(() => App.cfg.hpc.host, (v) => { App.cfg.hpc.host = v.trim(); }, { placeholder: 'myhpc  or  user@login.cluster.example.org', apply: { host: true, setup: true }, label: 'HPC login' }),
          h('button.btn.small', { onclick: async () => { if (await App.setup.loginWizard()) redraw(); } }, 'Set up…')),
          'New to this? Click Set up…: it asks for your cluster’s address and username. If ssh already knows your login, type its name, or user@host.'),
        row('Password', savedPassword('hpc:password', 'HPC password', 'Asked for when connecting'),
          'Optional. Kept in the macOS Keychain and used when connecting; without it, Codeome asks. A one-time code, if the HPC wants one, is asked for too. An ssh key on the HPC needs no password.'),
        row('Start folder', text(() => App.cfg.hpc.remoteRoot, (v) => { App.cfg.hpc.remoteRoot = v.trim() || '~'; }, { placeholder: '~ or /projects/mygroup', label: 'Start folder' })),
        row('Agent projects', text(() => App.cfg.hpc.agentRoot, (v) => { App.cfg.hpc.agentRoot = v.trim().replace(/(.)\/+$/, '$1'); }, { placeholder: '/projects/mygroup/scratch/me/projects', label: 'Folder for agent projects on the HPC' }),
          'Where the agents put the projects they run on the HPC, each in its own folder named after the project. Empty: they follow your CLAUDE.md, or ask. Applies to chats started from now on.')),
      setupHost,
      card('Sessions',
        row('Agent sessions', check('Keep agent sessions on the HPC running in tmux', () => App.cfg.hpc.useTmux, (v) => { App.cfg.hpc.useTmux = v; }),
          'They reattach after a disconnect.'),
        row('Refresh Slurm every', h('div.row', text(() => App.cfg.slurm.refreshSeconds, (v) => { App.cfg.slurm.refreshSeconds = Math.max(5, Number(v) || 20); }, { type: 'number', label: 'Seconds' }), h('span.hint', 'seconds')))));
  }

  // The setup checklist: each step with its state and the button that does it.
  const STATE = { ok: 'Done', todo: 'To do', warn: 'Needs attention', busy: 'In progress', off: 'Waiting on an earlier step' };
  function stepRow(state, title, detail, ...actions) {
    return h('div.su-row.su-' + state, h('i.su-dot', { role: 'img', 'aria-label': STATE[state], title: STATE[state] }),
      h('div.su-text', h('b', title), detail ? h('div.hint', detail) : null),
      h('div.su-act', ...actions.filter(Boolean)));
  }
  const btn = (label, run, primary) => h('button.btn.small' + (primary ? '.primary' : ''), { onclick: run }, label);
  const backHere = () => S.open('hpc');

  function renderSetup() {
    if (!setupHost) return;
    const st = App.setup.status;
    if (!st) { setupHost.replaceChildren(card('Setup', h('div.sp-empty', 'Checking…'))); return; }
    const c = App.cfg, U = App.setup, tunnel = U.tunnelOn();
    if (serverList) serverList.replaceChildren(...st.ciscoServers.map((s) => h('option', { value: s })));
    const rows = [];

    if (tunnel) {
      const missing = ['openconnect', 'ocproxy'].filter((t) => !st.tools[t]);
      rows.push(missing.length
        ? stepRow('todo', 'OpenConnect and ocproxy', `Not installed${st.brew ? '' : '; Homebrew is installed first'}. They run the tunnel without admin rights or changes to the Mac's network.`,
          btn('Install…', async () => { if (await U.install(missing, "Codeome's VPN tunnel needs them.")) backHere(); }, true))
        : stepRow('ok', 'OpenConnect and ocproxy', 'Installed.'));
      const tunnelRow = !vpn().server ? stepRow('off', 'VPN tunnel', 'Enter the VPN server above.')
        : U.vpnUp ? stepRow('ok', 'VPN tunnel', `Running on 127.0.0.1:${st.tunnel.port}. Only Codeome's HPC connections use it.`, btn('Stop', () => U.stopVpn()))
        : U.vpnStarting() ? stepRow('busy', 'VPN tunnel', U.tun.phase === 'waiting' ? 'Waiting for the sign-in to be approved on your MFA device.' : `Signing in to ${vpn().server}…`,
          btn('Cancel', () => U.stopVpn({ quiet: true })), btn(U.tun.phase === 'prompt' ? 'Continue…' : 'Show', () => U.startVpn()))
        : U.tun.phase === 'failed' ? stepRow('warn', 'VPN tunnel', U.tun.reason, btn('Log', () => U.showVpnLog()),
          missing.length ? null : btn('Start again', () => U.startVpn({ returnTo: backHere }), true))
        : stepRow(missing.length ? 'off' : 'todo', 'VPN tunnel', `Not running. Starting it signs in to ${vpn().server}; Codeome asks for anything not saved above.`,
          missing.length ? null : btn('Start', () => U.startVpn({ returnTo: backHere }), true));
      rows.push(tunnelRow);
    }
    rows.push(vpnRow(tunnel));

    const login = st.login;
    if (!c.hpc.host) rows.push(stepRow('todo', 'HPC login', 'Not set up yet.', btn('Set up login…', async () => { if (await U.loginWizard()) backHere(); }, true)));
    else if (!login || login.error) rows.push(stepRow('warn', 'HPC login', (login && login.error) || 'ssh could not read this login.'));
    else {
      const via = login.proxyJump ? 'ProxyJump ' + login.proxyJump : login.proxyCommand ? 'a ProxyCommand' : '';
      rows.push(stepRow(tunnel && via ? 'warn' : 'ok', 'HPC login', [`${login.user}@${login.hostname}${login.port && login.port !== 22 ? ':' + login.port : ''}`,
        tunnel && via ? `. Your ssh config reaches it through ${via}; Codeome's tunnel replaces that for its own connections.` : ''].join('')));
    }

    rows.push(st.key.exists
      ? stepRow('ok', 'ssh key on this Mac', App.tildify(st.key.path) || st.key.path)
      : stepRow('todo', 'ssh key on this Mac', `None yet. Creating one makes ${App.tildify(st.key.path) || st.key.path}; a passphrase is optional.`,
        btn('Create key', async () => { if (await U.createKey()) backHere(); }, true)));

    const t = U.loginTest;
    const test = btn(t ? 'Test again' : 'Test', () => U.testLogin());
    const copy = btn('Copy key to the HPC', async () => { if (await U.copyKey()) backHere(); });
    const ready = c.hpc.host && st.key.exists && !(tunnel && !U.vpnUp);
    let keyRow;
    if (!c.hpc.host || !st.key.exists) keyRow = stepRow('off', 'Key accepted by the HPC', 'Needs a login and a key.');
    else if (!t) keyRow = stepRow(ready ? 'todo' : 'off', 'Key accepted by the HPC', 'Not tested. The test signs in once without a password.', ready ? test : null, ready ? copy : null);
    else if (t.result === 'busy') keyRow = stepRow('busy', 'Key accepted by the HPC', 'Testing…');
    else if (t.result === 'ok') keyRow = stepRow('ok', 'Key accepted by the HPC', 'Signs in without a password.', test);
    else if (t.result === 'auth') keyRow = stepRow('warn', 'Key accepted by the HPC', "The HPC did not accept the key. Copy it there (you sign in with your password once). If the key has a passphrase, add it to the macOS keychain with: ssh-add --apple-use-keychain " + App.tildify(st.key.path), copy, test);
    else if (t.result === 'hostkey') keyRow = stepRow('warn', 'Key accepted by the HPC', "The HPC's fingerprint is new or has changed. Connect once to check and accept it.", btn('Connect', () => App.connectHpc()), test);
    else if (t.result === 'network') keyRow = stepRow('warn', 'Key accepted by the HPC', (tunnel && !U.vpnUp ? `Could not reach ${c.hpc.host}: the VPN tunnel is not running.`
      : `Could not reach ${c.hpc.host}${tunnel ? ' through the tunnel' : '. Off campus, turn on the VPN first'}. ${t.detail || ''}`), tunnel && !U.vpnUp ? btn('Start VPN', () => U.startVpn({ returnTo: backHere })) : null, test);
    else keyRow = stepRow('warn', 'Key accepted by the HPC', t.detail || 'The test login failed.', copy, test);
    rows.push(keyRow);

    rows.push(connectionRow({ target: 'hpc', host: c.hpc.host, connected: App.hpcConnected, connect: App.connectHpc, disconnect: App.disconnectHpc,
      uses: 'Files, Slurm, terminals and the R console use this connection.', asks: 'a password or code if the HPC wants one' }));

    setupHost.replaceChildren(h('div.sp-card',
      h('div.sp-card-h.row', h('span.grow', 'Setup'), h('button.btn.small.ghost', { onclick: () => App.setup.refresh() }, 'Check again')),
      h('div.su-list', rows)));
  }

  // The shared connection's step: connected, connecting (in the background, see login.js), failed, or not yet.
  function connectionRow({ target, host, connected, connect, disconnect, uses, asks }) {
    const lg = App.login.state[target];
    if (connected) return stepRow('ok', 'Connected', uses, btn('Disconnect', () => disconnect()));
    if (App.login.busy(target)) return stepRow('busy', 'Connected', lg.phase === 'prompt' ? `${host} is asking for something.` : `Connecting to ${host}…`,
      btn('Cancel', () => App.login.stop(target)), btn(lg.phase === 'prompt' ? 'Continue…' : 'Show', () => connect()));
    if (lg.phase === 'failed') return stepRow('warn', 'Connected', lg.reason, btn('Log', () => App.login.showLog(target)), btn('Connect again', () => connect(), true));
    return stepRow(host ? 'todo' : 'off', 'Connected', host ? `Opens one shared connection in the background; Codeome asks for ${asks}.` : 'Needs a host.',
      host ? btn('Connect', () => connect(), true) : null);
  }

  // Whether the HPC network answers: from this Mac (campus, Cisco Secure Client) or through the tunnel.
  function vpnRow(tunnel) {
    const U = App.setup, t = U.vpnTest, check = !tunnel && App.cfg.hpc.vpnCheckHost;
    const title = tunnel ? 'Tunnel reaches the HPC' : 'HPC network reachable';
    const test = btn(t ? 'Test again' : 'Test', () => U.testVpn(), !t);
    if (tunnel && !U.vpnUp) return stepRow('off', title, 'Needs the VPN tunnel running.');
    if (!t) return stepRow('todo', title, tunnel ? 'Not tested. The test opens a connection to the HPC through the tunnel.'
      : 'Not tested. The test checks that the HPC answers, which it does on campus or with the VPN on.', test);
    const at = `${t.host}:${t.port}`;
    // A public host (such as the VPN server) says nothing about whether the VPN is on.
    const wrongCheck = check ? ` If ${t.host} is the VPN server, clear the VPN check host above: the server is public, so it cannot tell.` : '';
    switch (t.result) {
      case 'busy': return stepRow('busy', title, 'Testing…');
      case 'ok': return stepRow('ok', title, `${at} answers${tunnel ? ' through the tunnel' : ''}.`, test);
      case 'nohost': return stepRow('off', title, 'Set up your HPC login below' + (tunnel ? '.' : ', or enter a VPN check host above.'));
      case 'notunnel': return stepRow('warn', title, 'The VPN tunnel is not running.', btn('Start VPN', () => U.startVpn({ returnTo: backHere })), test);
      case 'dns': return stepRow('warn', title, tunnel ? `The VPN does not know ${t.host}. Check the login below, or stop and start the tunnel.`
        : `This network does not know ${t.host}, so the VPN looks off. Turn on Cisco Secure Client (or switch to Codeome's own tunnel), then test again.`, test);
      case 'refused': return stepRow('warn', title, `${t.host} answers, but nothing listens on port ${t.port}.` + wrongCheck, test);
      case 'unreachable': return stepRow('warn', title, `${at} did not answer. ` + (tunnel ? 'The tunnel may have dropped: stop and start it.' : 'Turn on the VPN, then test again.') + wrongCheck, test);
      default: return stepRow('warn', title, (t.detail || `Could not reach ${at}.`) + wrongCheck, test);
    }
  }

  function storageSection(c) {
    const files = App.views.files;
    return section('storage', 'Storage', 'Long-term storage reached over SFTP, such as ERDA. It shows as the third section in Files. Servers that only allow SFTP (no shell) work.',
      card(null,
        row('Name', text(() => files.title('storage'), (v) => { const p = App.cfg.ui.panes.storage = App.cfg.ui.panes.storage || {}; if (v.trim() && v.trim() !== 'ERDA') p.title = v.trim().slice(0, 40); else delete p.title; }, { placeholder: 'ERDA', label: 'Storage name' }),
          'How the section is labelled. You can also right-click a section header in Files to rename it.'),
        row('Host', text(() => App.cfg.storage.host, (v) => { App.cfg.storage.host = v.trim(); }, { placeholder: 'io.erda.dk  or  a Host alias', apply: { storage: true }, label: 'Storage host' }),
          'The SFTP server, or a Host alias from ~/.ssh/config. For ERDA, set an SFTP password or key first under Setup → SFTP on erda.dk.'),
        row('Username', text(() => App.cfg.storage.user, (v) => { App.cfg.storage.user = v.trim(); }, { placeholder: 'e.g. you@example.org', apply: { storage: true }, label: 'Storage username' }),
          'For ERDA, the email address you sign in to erda.dk with. Empty: the one in the host or ~/.ssh/config.'),
        row('Password', savedPassword('storage:password', 'Storage password', 'Asked for when connecting'),
          'Optional. Kept in the macOS Keychain and used when connecting; without it, Codeome asks. For ERDA, the SFTP password set on erda.dk, not your KU password. A key needs no password.'),
        row('Start folder', text(() => App.cfg.storage.root, (v) => { App.cfg.storage.root = v.trim(); }, { placeholder: 'Login folder', label: 'Storage start folder' })),
        row('From the HPC', text(() => App.cfg.storage.hpcHost, (v) => { App.cfg.storage.hpcHost = v.trim(); }, { placeholder: 'Same as the login', label: 'Storage login from the HPC' }),
          'Copies between the HPC and the storage run sftp on the HPC, in a terminal there. Set this if the HPC knows the storage by another name.')),
      storageHost = h('div'));
  }
  function renderStorage() {
    if (!storageHost) return;
    const c = App.cfg.storage;
    const host = c.host ? (c.user ? `${c.user}@${c.host.slice(c.host.lastIndexOf('@') + 1)}` : c.host) : '';
    storageHost.replaceChildren(h('div.sp-card', h('div.sp-card-h', 'Connection'), h('div.su-list',
      connectionRow({ target: 'storage', host, connected: App.storageConnected, connect: App.connectStorage, disconnect: App.disconnectStorage,
        uses: `Files and copies to and from ${App.views.files.title('storage')} use this connection.`, asks: 'a password if the server wants one' }))));
  }

  // Favourite folders of the Transfer view, one card per host. Each pane there stars the folder it shows.
  let favBusy = false;
  function transferSection() {
    const X = App.views.transfer, files = App.views.files;
    const redraw = () => { favBusy = false; sections.transfer.replaceWith(transferSection()); flash(); };
    const card1 = (host, hint) => {
      const list = (App.cfg.transferFavs = App.cfg.transferFavs || {})[host] || [];
      const add = async (dir) => { dir = (dir || '').trim().replace(/(.)\/+$/, '$1'); if (!dir) return; favBusy = true; X.addFav(host, dir); redraw(); };
      const input = h('input', { type: 'text', placeholder: hint, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Add a favourite folder on ' + files.title(host),
        onkeydown: (e) => { if (e.key === 'Enter') add(input.value); } });
      return card(files.title(host),
        ...(list.length ? list.map((d, i) => h('div.sp-row', h('div.sp-label', h('label', d)),
          h('div.sp-ctl', h('div.row',
            h('button.btn.small', { disabled: i === 0, 'aria-label': 'Move up', onclick: () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; App.saveConfig(); redraw(); } }, '↑'),
            h('button.btn.small', { disabled: i === list.length - 1, 'aria-label': 'Move down', onclick: () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; App.saveConfig(); redraw(); } }, '↓'),
            h('button.btn.small', { onclick: () => { favBusy = true; X.removeFav(host, d); redraw(); } }, 'Remove')))))
          : [h('div.sp-empty', 'No favourites yet.')]),
        h('div.sp-row', h('div.sp-label', h('label', 'Add a folder')),
          h('div.sp-ctl', h('div.row', input, h('button.btn.small', { onclick: () => add(input.value) }, 'Add'),
            host === 'local' ? h('button.btn.small', { onclick: async () => { const d = await codeome.dialog.folder({ defaultPath: App.project || '~' }); if (d) add(d); } }, 'Choose…') : null))));
    };
    return section('transfer', 'Transfer', 'Favourite folders for the panes of the Transfer view. In a pane, click the star to favourite the folder it shows, or the list next to it to jump to a favourite; right-click a folder and choose Add to favourites.',
      card1('local', '/Users/you/data  or  ~/data'), card1('remote', '/projects/mygroup/scratch/me'), card1('storage', '/home/data'));
  }

  function rSection(c) {
    return section('r', 'R', 'The R console that ⌘↩ sends R code to, from R scripts and from chunks in R Markdown and Quarto documents.',
      card(null,
        row('On this Mac', text(() => App.cfg.r.local, (v) => { App.cfg.r.local = v.trim() || 'R --no-save --quiet'; }, { label: 'R command on this Mac' }),
          'Starts in the project folder, so .Rprofile and renv load as in RStudio.'),
        row('On the HPC', text(() => App.cfg.r.remote, (v) => { App.cfg.r.remote = v.trim() || 'R --no-save --quiet'; }, { placeholder: 'module load R && R --no-save --quiet', label: 'R command on the HPC' }),
          'Runs in a login shell. Load modules or a conda environment here if R needs them.'),
        row('Plots', h('div.form',
          check('Show plots from R consoles in Plots (⌘7)', () => App.cfg.plots.capture !== false, (v) => { App.cfg.plots.capture = v; }),
          check('Switch to Plots when a plot is drawn', () => App.cfg.plots.show !== false, (v) => { App.cfg.plots.show = v; })),
          'R consoles started from here draw off-screen, so plots open in Codeome instead of a separate window. For R started some other way, right-click its terminal tab → Show R plots in Codeome.')));
  }

  // ---------- agent policy ----------
  let policyItems = [], policyRowsHost = null;
  function renderPolicyRows() {
    if (!policyRowsHost) return;
    policyRowsHost.replaceChildren(...policyItems.map((item) => {
      const stored = (App.cfg.policyDefaults || {})[item.key];
      const value = item.options.some((option) => option.value === stored) ? stored : item.default;
      return h('div.sp-row', { 'data-policy-key': item.key },
        h('div.sp-label', h('label', item.label), h('div.hint', item.help)),
        h('div.sp-ctl', App.policyControl(item, value, (picked) => {
          App.cfg.policyDefaults = App.cfg.policyDefaults || {};
          if (picked === item.default) delete App.cfg.policyDefaults[item.key];
          else App.cfg.policyDefaults[item.key] = picked;
          renderPolicyRows();
          commit();
        })));
    }));
  }

  async function policySection() {
    let items;
    try {
      items = await codeome.policy.defaults();
      if (!Array.isArray(items)) throw new Error('Invalid policy definitions.');
    } catch (error) {
      policyRowsHost = null;
      return section('policy', 'Agent policy', 'Defaults for all projects',
        card(null, h('div.sp-empty', { role: 'alert' }, 'Could not load agent policy: ' + (error.message || String(error)),
          h('br'), h('button.btn.small', { type: 'button', onclick: () => show('policy') }, 'Retry'))));
    }
    policyItems = items;
    policyRowsHost = h('div');
    renderPolicyRows();
    return section('policy', 'Agent policy', 'Defaults for all projects. These apply to every project unless the project overrides them in Project settings.',
      card('Defaults for all projects', policyRowsHost));
  }

  // ---------- agents ----------
  async function agentsSection(c) {
    let catalogError = '';
    try {
      const models = await codeome.agents.models();
      codexCatalog = models.codex || { models: [] };
    } catch (error) {
      codexCatalog = { models: [] };
      catalogError = error.message || String(error);
    }
    const chatCmd = (c.agents.find((a) => /^claude(\s|$)/.test(a.cmd)) || { cmd: 'claude' }).cmd;
    const chatOptions = App.agentDefaultOptions((codexCatalog && codexCatalog.models) || []);
    return section('agents', 'Agents', 'The agent chat, the specialists it hands work to, the skills they follow, and the command-line agents offered as terminal sessions. Some are set once for all projects; the rest belong to the open project.',
      scopeHead('All projects', 'Kept on this Mac, outside any project.'),
      card('Agent chat (orchestrator)',
        row('AI', h('span.pill.ok', 'Claude Code'), `Runs "${chatCmd}" — the first Claude command below.`),
        row('Claude model', modelSelect(chatOptions.model, (App.cfg.chat || {}).model || '',
          (v) => { App.cfg.chat = { ...(App.cfg.chat || {}), model: v, modelPicked: true }; commit(); }, 'Chat model'),
          'Default for all projects. Projects can override this in Project settings. Chats already open keep their model until they restart.'),
        row('Claude effort', select(chatOptions.effort, (App.cfg.chat || {}).effort || '', (v) => { App.cfg.chat = { ...(App.cfg.chat || {}), effort: v }; commit(); }, 'Chat effort'),
          'Default for all projects. Projects can override this in Project settings. Higher effort is slower and uses more of the limits.'),
        row('Codex chats', h('div.ag-two',
          modelSelect(chatOptions.codexModel, (App.cfg.chat || {}).codexModel || '',
            (v) => { App.cfg.chat = { ...(App.cfg.chat || {}), codexModel: v }; commit(); }, 'Codex chat model'),
          select(chatOptions.codexEffort, (App.cfg.chat || {}).codexEffort || '', (v) => { App.cfg.chat = { ...(App.cfg.chat || {}), codexEffort: v }; commit(); }, 'Codex chat effort')),
          'Default for all projects. Projects can override this in Project settings.'),
        row('Default permission mode', select(chatOptions.mode, (App.cfg.chat || {}).mode || '',
          (v) => { App.cfg.chat = { ...(App.cfg.chat || {}), mode: v }; commit(); }, 'Default permission mode'),
          'As last used follows the permission mode selected in the chat. Projects can override this in Project settings.'),
        row('Default engine', select(chatOptions.engine, (App.cfg.chat || {}).engine || '',
          (v) => { App.cfg.chat = { ...(App.cfg.chat || {}), engine: v }; commit(); }, 'Default engine'),
          'Claude is used unless a project overrides this in Project settings.'),
        catalogError ? h('div.sp-foot', { role: 'alert' }, 'Could not load Codex model choices: ' + catalogError) : null,
        row('Suggested replies', check('Offer clickable answers under a question', () => (App.cfg.chat || {}).suggest !== false,
          (v) => { App.cfg.chat = { ...(App.cfg.chat || {}), suggest: v }; }),
          'When the agent ends a message with a question that lists no options, a small Haiku call reads that one message and proposes a few short answers. It costs a few hundred tokens per question.'),
        row('Suggest a new chat at', h('div.row', text(() => (App.cfg.chat || {}).contextWarnAt ?? 70, (v) => { App.cfg.chat = { ...(App.cfg.chat || {}), contextWarnAt: Math.min(95, Math.max(20, Number(v) || 70)) }; }, { type: 'number', label: 'Percent' }), h('span.hint', '% of the context window')),
          'Each chat shows how full its context window is. Past this mark the meter turns amber and the chat says so once.')),
      card('Commits',
        row('Claude co-author', check('Remove the Claude co-author trailer', () => !(App.cfg.claude && App.cfg.claude.noCoAuthor === false),
          (v) => { App.cfg.claude = { ...(App.cfg.claude || {}), noCoAuthor: v }; }),
          'Claude Code sessions started by Codeome (chats and terminals on this Mac) add no "Co-Authored-By: Claude" trailer to commits and no "Generated with Claude Code" line to pull requests. Applies to sessions started from now on.')),
      card('Forum',
        row('Auto-allow by default', forumNumber('Auto-allow by default', 'defaultBudget', 0, 20, 0),
          'How many raised hands are let through without asking, per message. 0 means you approve every turn.'),
        row('Summarise after', forumNumber('Summarise after tokens', 'summaryTokens', 1000, 50000, 6000),
          'Older messages are folded into a summary once the discussion passes this size.'),
        row('Raise-hand checks', h('div.ag-two',
          modelSelect(CLAUDE_MODELS.some((model) => model.value === 'haiku') ? CLAUDE_MODELS : [{ value: 'haiku', label: 'Haiku (default)' }, ...CLAUDE_MODELS],
            (App.cfg.forum || {}).checkModel || 'haiku', (v) => { App.cfg.forum = { ...(App.cfg.forum || {}), checkModel: v }; commit(); }, 'Claude raise-hand check model'),
          modelSelect([{ value: '', label: 'Codex default' }, ...((codexCatalog && codexCatalog.models) || []).map((m) => ({ value: m.id, label: m.label }))],
            (App.cfg.forum || {}).codexCheckModel || '', (v) => { App.cfg.forum = { ...(App.cfg.forum || {}), codexCheckModel: v }; commit(); }, 'Codex raise-hand check model')),
          'Claude and Codex models used to decide whether each seat has something to add.'),
        h('div.sp-foot.hint', 'Changes apply to forums opened from now on.')),
      card('Command-line agents', cliAgents(),
        h('div.sp-foot.hint', 'Offered as sessions in terminals and on the HPC. The agent chat runs the first Claude command.')),
      globalHost = h('div'),
      agentsHost = h('div'));
  }

  // The Agents section has two scopes, each under its own heading: all projects, and the open one.
  const scopeHead = (title, hint) => h('div.sp-scope', h('h3', title), h('span.hint', hint));
  // A file as the page names it: relative inside the project, ~/… elsewhere.
  const fileLabel = (p) => (App.project && p.startsWith(App.project + '/') ? p.slice(App.project.length + 1) : App.tildify(p));

  function cliAgents() {
    const box = h('div.cli-list');
    const draw = () => {
      box.innerHTML = '';
      App.cfg.agents.forEach((a, i) => {
        box.append(h('div.cli-row',
          h('input', { type: 'text', value: a.name, 'aria-label': 'Name', placeholder: 'Name', onchange: (e) => { const v = e.target.value.trim(); if (v) { App.cfg.agents[i].name = v; commit(); } else e.target.value = App.cfg.agents[i].name; } }),
          h('input.mono', { type: 'text', value: a.cmd, 'aria-label': 'Command', placeholder: 'claude --model opus', spellcheck: 'false', onchange: (e) => { const v = e.target.value.trim(); if (v) { App.cfg.agents[i].cmd = v; commit(); } else e.target.value = App.cfg.agents[i].cmd; } }),
          h('button.icon-btn.small', { title: 'Remove', 'aria-label': 'Remove ' + a.name, disabled: App.cfg.agents.length < 2, onclick: () => { App.cfg.agents.splice(i, 1); commit(); draw(); }, html: App.icons.trash })));
      });
      box.append(h('div.row', h('button.btn.small', { onclick: () => { App.cfg.agents.push({ name: 'Claude (Sonnet)', cmd: 'claude --model sonnet' }); commit(); draw(); box.querySelector('.cli-row:last-of-type input')?.select(); } }, '+ Add agent')));
    };
    draw();
    return box;
  }

  // The project's agents: kit roles and its own, each with an engine, a model and an effort level.
  let codexCatalog = null;
  async function renderAgents() {
    if (!agentsHost) return;
    const project = App.project;
    const host = agentsHost;
    if (!project || App.isIdeas(project)) { host.replaceChildren(scopeHead('This project', 'No project is open.'), card('Team', h('div.sp-empty', 'Open a project to see its agents and skills.'))); return; }
    host.replaceChildren(scopeHead(`This project · ${App.basename(project)}`, 'Kept in its .claude/ folder, and shared with collaborators when committed.'), card('Team', h('div.sp-empty', 'Loading agents…')));
    let res, kit, models, sk;
    try { [res, kit, models, sk] = await Promise.all([codeome.agents.list(project), codeome.kit.status(project), codeome.agents.models(), codeome.skills.list(project)]); }
    catch (e) { if (project === App.project && host === agentsHost) host.replaceChildren(scopeHead(`This project · ${App.basename(project)}`, ''), card('Team', h('div.sp-empty', e.message || String(e)))); return; }
    if (project !== App.project || host !== agentsHost) return;
    codexCatalog = models.codex || { models: [] };
    const list = res.agents || [];
    const name = App.basename(project);
    const head = h('div.sp-card-h.row',
      h('span.grow', `Team in ${name}`),
      kit.installed ? h('button.btn.small.ghost', { onclick: () => openFile(App.join(project, '.claude/skills/orchestrate/routing.md')) }, 'Routing') : null,
      kit.installed ? h('button.btn.small.ghost', { onclick: () => App.views.agents.install().then(renderAgents) }, kit.outdated ? `Update kit to ${kit.latest}…` : 'Role groups…') : null,
      h('button.btn.small', { onclick: () => S.newAgent('project') }, '+ New agent'));
    const body = [];
    if (res.error) body.push(h('div.sp-empty', res.error));
    if (!kit.installed) {
      body.push(h('div.sp-banner', h('div.grow', h('b', 'No agent kit here. '), `Install it to give the chat ${kit.roles ? kit.roles.length : 15} specialist roles and the Codex job runner. Until then, Codex is not used.`),
        h('button.btn.small.primary', { onclick: () => App.views.agents.install().then(renderAgents) }, 'Install…')));
    } else if (kit.outdated) {
      body.push(h('div.sp-banner', h('div.grow', `Agent kit ${kit.latest} is available (this project has ${kit.version}). The update is needed for Codex models chosen here to take effect.`),
        h('button.btn.small.primary', { onclick: () => App.views.agents.install().then(renderAgents) }, 'Update…')));
    }
    if (!list.length && !res.error) body.push(h('div.sp-empty', 'No agents in .claude/agents/ yet.'));
    else if (list.length) {
      body.push(h('div.ag-table', { role: 'table', 'aria-label': 'Agents' },
        h('div.ag-row.ag-headrow', { role: 'row' }, ['Agent', 'AI', 'Model', 'Effort', 'Access', ''].map((x) => h('span', { role: 'columnheader' }, x))),
        list.map((a) => agentRow(project, a))));
      body.push(h('div.sp-foot.hint', 'The AI is the default the chat routes each role to (routing.md); it can still override per task. Claude models and effort go in the agent file; Codex ones in .codeome/agents.json. Edits to the files are kept on kit updates.'));
    }
    host.replaceChildren(scopeHead(`This project · ${name}`, 'Kept in its .claude/ folder, and shared with collaborators when committed.'), h('div.sp-card', head, ...body),
      skillsCard(`Skills in ${name}`, sk, () => newSkill(App.join(project, '.claude')),
        'Commands are typed in the chat; playbooks are read when a task needs them. Kit skills follow the role groups chosen above. Edits to the files are kept on kit updates.'));
  }

  // The agents and skills in the Claude account's folder, which every project gets.
  async function renderGlobal() {
    if (!globalHost) return;
    const project = App.project;
    const host = globalHost;
    host.replaceChildren(card('Agents for all projects', h('div.sp-empty', 'Loading agents…')));
    let g, general, sync;
    try { sync = await codeome.general.sync(); [g, general] = await Promise.all([codeome.global.list(project), codeome.general.agents()]); }
    catch (e) { if (project === App.project && host === globalHost) host.replaceChildren(card('Agents for all projects', h('div.sp-empty', e.message || String(e)))); return; }
    if (project !== App.project || host !== globalHost) return;
    const dir = g.dir ? App.tildify(g.dir) : 'the Claude account folder';
    const generalByName = new Map((Array.isArray(general) ? general : []).map((a) => [a.name, a]));
    const skipped = new Set(sync.skipped || []);
    const list = [...(g.agents || []), ...(Array.isArray(general) ? general.filter((a) => !(g.agents || []).some((x) => x.name === a.name)) : [])];
    const body = [];
    if (g.error) body.push(h('div.sp-empty', g.error));
    if (general.error) body.push(h('div.sp-empty', general.error));
    if (sync.error) body.push(h('div.sp-empty', sync.error));
    if (!list.length) body.push(h('div.sp-empty', `No agents in ${dir}/agents/ yet.`));
    else body.push(h('div.ag-table', { role: 'table', 'aria-label': 'Global agents' },
      h('div.ag-row.ag-global.ag-headrow', { role: 'row' }, ['Agent', 'AI / Model', 'Effort', 'Access', ''].map((x) => h('span', { role: 'columnheader' }, x))),
      list.map((a) => globalAgentRow(project, a, generalByName.get(a.name), skipped.has(App.join(g.dir, `agents/${a.name}.md`)), g.account))));
    body.push(h('div.sp-foot.hint', `Account agents live in ${dir}/agents/; general agents live in Codeome's folder and are mirrored into Claude accounts. A project agent with the same name is used instead in that project.`
      + (g.accounts > 1 ? ` Each Claude account has its own folder: these are the ones of the active account, ${g.account}.` : '')));
    host.replaceChildren(
      h('div.sp-card', h('div.sp-card-h.row', h('span.grow', 'Agents for all projects'), h('button.btn.small', { onclick: () => S.newAgent('general') }, '+ New agent')), ...body),
      g.error ? null : skillsCard('Global skills', g, () => newSkill(g.dir), `In ${dir}/skills/. Available in every project. A global skill is used instead of a project skill with the same name.`, `No skills in ${dir}/skills/ yet.`));
  }

  function globalAgentRow(project, a, general, notMirrored, account) {
    const el = h('div.ag-row.ag-global', { role: 'row' });
    const save = async (patch) => {
      const r = await codeome.global.setAgent(project, a.name, patch);
      if (r.error) { App.err(r.error); return renderGlobal(); }
      Object.assign(a, r.agent);
      el.replaceWith(globalAgentRow(project, a, general, notMirrored, account));
      flash();
    };
    el.append(
      h('div.ag-name', { role: 'cell' },
        h('div.row', h('b', a.name), h('span.pill.global', general ? 'general' : 'global'),
          general && notMirrored ? h('span.pill.warn', `not mirrored: a different file with this name exists in ${account}`) : null,
          a.replacedByProject ? h('span.pill.warn', { title: `${App.basename(project)} has its own ${a.name}, which is used there instead` }, 'replaced in this project') : null),
        (general ? general.description : a.description) ? h('div.ag-desc', { title: general ? general.description : a.description }, general ? general.description : a.description) : null),
      h('div', { role: 'cell' }, general ? h('span.hint', ENGINE_NAME[general.engine] || general.engine) : modelSelect([{ value: '', label: 'Same as the chat' }, ...CLAUDE_MODELS], a.claudeModel, (v) => save({ claudeModel: v }), `Claude model for ${a.name}`)),
      h('div', { role: 'cell' }, general ? null : select(CLAUDE_EFFORTS, a.claudeEffort, (v) => save({ claudeEffort: v }), `Claude effort for ${a.name}`)),
      h('div', { role: 'cell' }, general ? null : h('span.ag-access.' + (a.access === 'writes' ? 'w' : 'r'), a.access)),
      h('div', { role: 'cell' }, h('button.btn.small', { title: `Edit ${fileLabel(general ? general.path : a.path)}`, onclick: () => openFile(general ? general.path : a.path) }, 'Edit .md')));
    return el;
  }

  // A scope's skills: commands typed in the chat, and playbooks a role or the chat reads when a task calls for one.
  function skillsCard(title, res, create, foot, empty) {
    const list = res.skills || [];
    const head = h('div.sp-card-h.row', h('span.grow', title), h('button.btn.small', { onclick: create }, '+ New skill'));
    const body = [];
    if (res.error) body.push(h('div.sp-empty', res.error));
    else if (!list.length) body.push(h('div.sp-empty', empty || 'No skills in .claude/skills/ yet.'));
    else {
      body.push(h('div', { role: 'list', 'aria-label': title }, list.map((k) => h('div.sk-row', { role: 'listitem' },
        h('div.ag-name',
          h('div.row', h('b', (k.command ? '/' : '') + k.name), 'kit' in k ? (k.kit ? h('span.pill', k.group || 'kit') : h('span.pill.own', 'own')) : h('span.pill.global', 'global'),
            h('span.pill', { title: k.command ? 'Type it in the chat' + (k.hint ? `: /${k.name} ${k.hint}` : '') : 'Read by the chat or a role when a task calls for it' }, k.command ? 'command' : 'playbook'),
            k.edited ? h('span.pill.warn', { title: 'Edited here; kit updates leave the edited files alone' }, 'edited') : null,
            k.replacedByGlobal ? h('span.pill.warn', { title: `A global skill is also called ${k.name}; Claude Code uses the global one` }, 'replaced by global') : null,
            k.replacesProject ? h('span.pill.warn', { title: `${App.basename(App.project)} has its own ${k.name}; Claude Code uses this global one` }, 'replaces this project\'s') : null),
          k.description ? h('div.ag-desc', { title: k.description }, k.description) : null),
        h('div.sk-files', k.files.slice(1).map((f) => h('button.sk-file' + (f.edited ? '.edited' : ''), { title: `Edit ${fileLabel(f.path)}` + (f.edited ? ' (edited here)' : ''), onclick: () => openFile(f.path) }, f.name.replace(/\.md$/, '')))),
        h('div', h('button.btn.small', { title: `Edit ${fileLabel(k.path)}`, onclick: () => openFile(k.path) }, 'Edit .md'))))));
      body.push(h('div.sp-foot.hint', foot));
    }
    return h('div.sp-card', head, ...body);
  }

  function agentRow(project, a) {
    const el = h('div.ag-row', { role: 'row' });
    const save = async (patch) => {
      const r = await codeome.agents.set(project, a.name, patch);
      if (r.error) { App.err(r.error); return renderAgents(); }
      Object.assign(a, r.agent);
      el.replaceWith(agentRow(project, a));
      flash();
      App.views.agents.refresh(true);
    };
    const claude = (label) => modelSelect([{ value: '', label: 'Same as the chat' }, ...CLAUDE_MODELS], a.claudeModel, (v) => save({ claudeModel: v }), label || `Claude model for ${a.name}`);
    const codexOpts = [{ value: '', label: codexCatalog.default ? `Codex default (${codexCatalog.default})` : 'Codex default' }, ...codexCatalog.models.map((m) => ({ value: m.id, label: m.label }))];
    const codex = (label) => modelSelect(codexOpts, a.codexModel, (v) => save({ codexModel: v }), label || `Codex model for ${a.name}`);
    const claudeEffort = () => select(CLAUDE_EFFORTS, a.claudeEffort, (v) => save({ claudeEffort: v }), `Claude effort for ${a.name}`);
    const codexEffort = () => select(CODEX_EFFORTS, a.codexEffort, (v) => save({ codexEffort: v }), `Codex effort for ${a.name}`);
    const effort = a.engine === 'codex' ? codexEffort() : a.engine === 'cross' ? h('div.ag-two', claudeEffort(), codexEffort()) : claudeEffort();
    let model;
    if (a.engine === 'codex') model = codex();
    else if (a.engine === 'cross') model = h('div.ag-two', h('label', h('span', 'Claude'), claude(`Claude model for ${a.name}`)), h('label', h('span', 'Codex'), codex(`Codex model for ${a.name}`)));
    else model = claude();
    const changed = a.kit && a.engine !== a.defaultEngine;
    el.append(
      h('div.ag-name', { role: 'cell' },
        h('div.row', h('b', a.name), a.kit ? h('span.pill', a.group || 'kit') : h('span.pill.own', 'own'), a.edited ? h('span.pill.warn', { title: 'Edited here; kit updates leave it alone' }, 'edited') : null,
          a.replacesGlobal ? h('span.pill', { title: `A global agent is also called ${a.name}; in this project this one is used` }, 'replaces global') : null),
        a.description ? h('div.ag-desc', { title: a.description }, a.description) : null),
      h('div', { role: 'cell' }, select(ENGINES, a.engine, (v) => save({ engine: v }), `AI for ${a.name}`),
        changed ? h('div.ag-def', `kit default: ${ENGINE_NAME[a.defaultEngine]}`) : null),
      h('div', { role: 'cell' }, model),
      h('div', { role: 'cell' }, effort),
      h('div', { role: 'cell' }, h('span.ag-access.' + (a.access === 'writes' ? 'w' : 'r'), a.access)),
      h('div.ag-actions', { role: 'cell' },
        h('button.btn.small', { title: `Edit ${a.file}`, onclick: () => openFile(a.path) }, 'Edit .md'),
        h('button.btn.small', { onclick: () => expandAgent(project, a) }, 'Expand scope…')));
    return el;
  }

  function openFile(p) { S.close(); App.views.editor.openFile(p); }

  // The shared modal closes on submit, so agent dialogs use its markup while keeping IPC errors visible.
  function agentDialog(title, body, ok, submit) {
    const overlay = document.getElementById('overlay');
    const previous = document.activeElement;
    const error = h('div.agent-dialog-error', { role: 'alert' });
    const save = h('button.btn.primary', { type: 'submit' }, ok);
    const form = h('form.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('header', h('h2', title)), h('div.body', body, error),
      h('footer', h('button.btn', { type: 'button', onclick: () => { if (!busy) close(); } }, 'Cancel'), save));
    let busy = false;
    const close = () => {
      overlay.hidden = true; overlay.replaceChildren(); overlay.onclick = null;
      document.removeEventListener('keydown', onKey, true);
      if (previous && previous.isConnected) previous.focus();
    };
    const showError = (message) => { error.textContent = message; };
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); if (!busy) close(); }
      if (event.key !== 'Tab') return;
      const focusable = [...form.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')];
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;
      busy = true; save.disabled = true; showError('');
      try { await submit({ close, showError, save }); }
      catch (e) { showError(e.message || String(e)); }
      finally { busy = false; save.disabled = false; }
    });
    overlay.replaceChildren(form); overlay.hidden = false;
    overlay.onclick = (event) => { if (event.target === overlay && !busy) close(); };
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => form.querySelector('input,select,textarea,button')?.focus(), 0);
  }

  S.newAgent = (initialScope) => {
    const project = App.project;
    const name = h('input', { type: 'text', placeholder: 'e.g. stats-reviewer', spellcheck: 'false', autocomplete: 'off', 'aria-describedby': 'agent-name-error' });
    const nameError = h('span#agent-name-error.agent-field-error', { role: 'alert' });
    const description = h('input', { type: 'text', placeholder: 'When should the chat use this agent?', 'aria-describedby': 'agent-description-error' });
    const descriptionError = h('span#agent-description-error.agent-field-error', { role: 'alert' });
    const engine = h('select', h('option', { value: 'claude' }, 'Claude'), h('option', { value: 'codex' }, 'Codex'));
    const tools = h('select', h('option', { value: 'read-only' }, 'Read-only'), h('option', { value: 'edits' }, 'Can edit files'), h('option', { value: 'shell' }, 'Can edit and run shell'));
    const scope = h('select', project && !App.isIdeas(project) ? h('option', { value: 'project' }, 'This project') : null, h('option', { value: 'general' }, 'General: all projects'));
    scope.value = initialScope === 'general' || !project || App.isIdeas(project) ? 'general' : 'project';
    const generalHint = h('div.hint', "Saved to Codeome's general folder and mirrored into each Claude account.");
    generalHint.hidden = scope.value !== 'general';
    scope.addEventListener('change', () => { generalHint.hidden = scope.value !== 'general'; });
    const instructions = h('textarea', { rows: 5, placeholder: 'Optional instructions for this agent' });
    name.addEventListener('input', () => { nameError.textContent = name.value && !/^[a-z][a-z0-9-]{1,40}$/.test(name.value.trim()) ? 'Use 2–41 lowercase letters, digits or hyphens; start with a letter.' : ''; name.setAttribute('aria-invalid', String(!!nameError.textContent)); });
    description.addEventListener('input', () => { descriptionError.textContent = ''; description.setAttribute('aria-invalid', 'false'); });
    agentDialog('New agent', h('fieldset',
      h('label.field', h('span', 'Name'), name, nameError),
      h('label.field', h('span', 'Use when'), description, descriptionError),
      h('label.field', h('span', 'Engine'), engine),
      h('label.field', h('span', 'Tool access'), tools),
      h('label.field', h('span', 'Scope'), scope, generalHint),
      h('label.field', h('span', 'Instructions (optional)'), instructions)), 'Create', async ({ close, showError }) => {
      const slug = name.value.trim(), useWhen = description.value.trim();
      if (!/^[a-z][a-z0-9-]{1,40}$/.test(slug)) { nameError.textContent = 'Use 2–41 lowercase letters, digits or hyphens; start with a letter.'; name.setAttribute('aria-invalid', 'true'); name.focus(); return; }
      if (!useWhen) { descriptionError.textContent = 'Describe when to use this agent.'; description.setAttribute('aria-invalid', 'true'); description.focus(); return; }
      const result = await codeome.agents.create({ scope: scope.value, project, name: slug, description: useWhen, engine: engine.value, tools: tools.value, body: instructions.value.trim() });
      if (result.error) { showError(result.error); return; }
      close();
      App.toast(`${slug} created ${scope.value === 'general' ? 'for all projects' : `in ${App.basename(project)}`}.`);
      if (result.mirror && result.mirror.error) App.err(`Mirroring to Claude accounts failed: ${result.mirror.error}`);
      App.emit('local-changed');
      if (S.isOpen && current === 'agents') { renderGlobal(); renderAgents(); }
    });
  };

  function expandAgent(project, agent) {
    const others = [...new Set([...App.views.projects.list, ...App.views.projects.linksOf(project)])].filter((dir) => dir !== project);
    const all = h('input', { type: 'checkbox' });
    const targets = others.map((dir) => ({ dir, box: h('input', { type: 'checkbox', checked: App.views.projects.linksOf(project).includes(dir) }) }));
    const results = h('div.agent-scope-results', { role: 'status', 'aria-live': 'polite' });
    const body = h('fieldset', h('legend', 'Add this agent to'),
      h('label.check', all, 'All projects (general)'),
      targets.length ? targets.map(({ dir, box }) => h('label.check', { title: App.tildify(dir) }, box, App.basename(dir))) : h('div.hint', 'No other projects are known.'));
    let finished = false;
    agentDialog(`Expand scope · ${agent.name}`, h('div', body, results), 'Add', async ({ close, showError, save }) => {
      if (finished) { close(); return; }
      const selected = targets.filter(({ box }) => box.checked).map(({ dir }) => dir);
      if (!all.checked && !selected.length) { showError('Choose at least one destination.'); return; }
      const result = await codeome.agents.promote({ project, name: agent.name, toGeneral: all.checked, toProjects: selected });
      if (result.error) { showError(result.error); return; }
      const line = (label, status) => h('div.agent-scope-result', h('span', label),
        h('span' + (status && status.error ? '.agent-field-error' : '.hint'), status === 'created' ? 'created' : status === 'exists' ? 'already exists' : status && status.error ? `error: ${status.error}` : 'No result'));
      results.replaceChildren(
        all.checked ? line('All projects (general)', result.general) : null,
        selected.map((dir) => line(App.basename(dir), (result.projects || {})[dir])));
      finished = true; save.textContent = 'Done';
      App.emit('local-changed');
      if (S.isOpen && current === 'agents') { renderGlobal(); renderAgents(); }
    });
  }

  async function newSkill(base) {
    const global = !App.project || !base.startsWith(App.project + '/');
    const name = await App.prompt(global ? 'New global skill' : 'New skill', 'Name (lowercase, dashes)', '', { placeholder: 'e.g. lab-report', ok: 'Create' });
    if (!name) return;
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) return App.err('Use lowercase letters, digits and dashes.');
    const dir = App.join(base, `skills/${name}`);
    const p = App.join(dir, 'SKILL.md');
    const exists = await codeome.local.read(p);
    if (!exists.error) return App.err(`${name} already exists.`);
    await codeome.local.mkdir(dir);
    const r = await codeome.local.write(p, `---\nname: ${name}\ndescription: What this skill does and when to use it. Say "Use when the user types /${name}" for a command.\n---\n\n# ${name}\n\nRequest: $ARGUMENTS\n\nDescribe the steps to follow.\n`);
    if (r.error) return App.err(r.error);
    App.emit('local-changed');
    openFile(p);
  }

  // ---------- accounts ----------
  // One card per account: its email address, whether signing in has confirmed it, and its usage.
  const ACCT_ENGINES = [['claude', 'Claude'], ['codex', 'Codex']];

  function accountsSection() {
    accountsHost = h('div');
    return section('accounts', 'Accounts & limits', 'An account is an email address, confirmed by signing in once. Every confirmed account stays signed in, so Codex jobs and new chats move from the active account to another one without asking when it nears its limit.',
      accountsHost,
      card('Limits',
        row('Hold back new jobs at', h('div.row', text(() => App.cfg.usage.stopAt, (v) => { App.cfg.usage.stopAt = Math.min(100, Math.max(50, Number(v) || 90)); }, { type: 'number', label: 'Percent' }), h('span.hint', '% of the 5-hour or weekly limit')),
          'Codex jobs move to an account with headroom; Claude subagents pause; new chats start on the Claude account with the most headroom.')));
  }

  // The configured accounts with what is known about each (the readings can lag the list).
  function accountsOf(engine) {
    const snap = App.views.usage.accounts(engine);
    return App.cfg.accounts[engine].list.map((a) => snap.find((x) => x.name === a.name && (x.dir || '') === (a.dir || '')) || { name: a.name, dir: a.dir, signedIn: null, windows: {} });
  }

  function renderAccounts() {
    if (!accountsHost) return;
    const U = App.views.usage;
    const all = ACCT_ENGINES.flatMap(([engine]) => accountsOf(engine).map((a) => ({ engine, a })));
    const out = all.filter((x) => x.a.signedOut);
    const ready = all.filter((x) => U.ready(x.a)).length;
    const kids = [];
    if (all.length > 2 || out.length) kids.push(h('div.sp-banner.acct-banner',
      h('span.grow', ready === all.length ? `All ${all.length} accounts are signed in and ready.` : out.length ? `${ready} of ${all.length} accounts are ready.` : 'Asking who is signed in…'),
      out.length ? btn(out.length > 1 ? `Sign in to the other ${out.length}…` : 'Sign in…', () => U.signInAll(out), true) : null,
      btn('Check again', async (e) => { const b = e.currentTarget; b.disabled = true; b.textContent = 'Checking…'; await codeome.usage.refresh(); renderAccounts(); })));
    for (const [engine, label] of ACCT_ENGINES) {
      const list = accountsOf(engine);
      const active = App.cfg.accounts[engine].active;
      kids.push(h('div.acct-head', h('h3', `${label} accounts`), h('span.hint', `${list.filter(U.ready).length} of ${list.length} ready`)),
        h('div.acct-grid',
          list.map((a) => accountCard(engine, label, a, list, a.name === active)),
          (U.found[engine] || []).filter((f) => !list.some((a) => App.tildify(a.dir) === f.dir || a.name.toLowerCase() === f.email.toLowerCase())).map((f) => h('button.acct-add', { onclick: () => U.addAccount(engine, f).then(findFolders) },
            h('b', 'Add ' + f.email), h('span', 'Already signed in on this Mac'))),
          h('button.acct-add', { onclick: () => U.addAccount(engine) }, h('b', `Add a ${label} account…`), h('span', 'Its email address, then one sign-in'))));
    }
    accountsHost.replaceChildren(...kids);
  }

  function accountCard(engine, label, a, list, isActive) {
    const U = App.views.usage;
    const named = U.isEmail(a.name);
    const out = !!a.signedOut;
    const twin = a.email && !a.mismatch ? list.find((x) => x !== a && !x.mismatch && x.email === a.email) : null;
    const state = a.mismatch ? h('span.pill.warn', 'other sign-in') : a.signedIn === false ? h('span.pill.warn', 'not signed in')
      : a.signedIn ? h('span.pill.ok', { title: named ? 'The sign-in confirmed this address' : null }, named ? 'confirmed' : 'signed in') : h('span.pill', 'checking…');
    const who = a.mismatch ? `Signed in as ${a.email}. Not used until it is signed in as ${a.name}.`
      : a.signedIn === false ? 'Sign in to confirm this address and use the account.'
        : a.signedIn ? (named ? null : a.email) : (a.error || 'Asking who is signed in…');
    const setActive = () => App.views.usage.setActive(engine, a.name).then((r) => { if (r && !r.error) { renderAccounts(); flash(); } });
    return h('div.acct-card' + (isActive ? '.active' : '') + (out ? '.out' : ''), { role: 'group', 'aria-label': `${label} account ${a.name}` },
      h('div.acct-top', h('b', { title: `${a.name} · kept in ${App.tildify(a.dir) || DEFAULT_DIR[engine]}` }, a.name),
        a.signedOut ? null : U.plan(a) ? h('span.pill.plan', { title: `${label} subscription` }, U.plan(a)) : a.signedIn ? h('span.pill.plan', { title: `${label} did not say which subscription this is` }, 'Plan unknown') : null,
        h('span.grow'), isActive ? h('span.pill.own', { title: 'New work starts here while it has headroom' }, 'active') : null, state),
      who ? h('div.acct-who', who) : null,
      twin ? h('div.acct-warn', `Same sign-in as ${twin.name}, so they share one limit. Sign in again with another ${label} login.`) : null,
      out ? null : U.lines(engine, a),
      h('div.acct-acts',
        out ? btn(named ? `Sign in as ${U.short(a.name)}…` : 'Sign in…', () => U.signInAll([{ engine, a }]), true) : null,
        a.mismatch && !list.some((x) => x !== a && x.name.toLowerCase() === a.email.toLowerCase()) ? btn(`Use ${a.email} instead`, () => useSignedIn(engine, a)) : null,
        isActive || out ? null : btn('Make active', setActive),
        out ? null : h('button.btn.small.ghost', { onclick: () => U.signInAll([{ engine, a }]) }, a.signedIn ? 'Sign in again…' : 'Sign in…'),
        h('span.grow'),
        list.length > 1 ? h('button.btn.small.ghost.danger', { onclick: () => removeAccount(engine, label, a) }, 'Remove') : null));
  }

  // The account becomes the address its folder is signed in with.
  async function useSignedIn(engine, a) {
    if (!App.views.usage.rename(engine, a.name, a.email)) return;
    await App.saveConfig(); flash();
  }

  async function removeAccount(engine, label, a) {
    if (!await App.confirm(`Remove ${label} account ${a.name}?`, `Codeome stops using it. Its sign-in stays on this Mac, so adding ${App.views.usage.isEmail(a.name) ? a.name : 'it'} again needs no new sign-in. Chats started on it can no longer continue there.`, 'Remove', true)) return;
    const accts = App.cfg.accounts[engine];
    accts.list = accts.list.filter((x) => x.name !== a.name);
    if (accts.active === a.name) accts.active = accts.list[0].name;
    await App.saveConfig(); flash();
    findFolders();
  }

  // Sign-ins already on this Mac that are no account yet (asked from the CLIs, so it takes a moment).
  async function findFolders() {
    await App.views.usage.findFound();
    renderAccounts();
  }

  function projectsSection() {
    const input = text(() => App.cfg.projectsDir, (v) => { App.cfg.projectsDir = v.trim(); }, { placeholder: '~/Codeome', label: 'Default project folder' });
    return section('projects', 'Projects', null,
      card(null,
        row('Default project folder', h('div.row', input, btn('Choose…', async () => {
          const d = await codeome.dialog.folder({ defaultPath: App.cfg.projectsDir || App.cfg.localRoot });
          if (d) { App.cfg.projectsDir = d; input.value = d; commit(); }
        })), 'A project cloned from a git URL gets a new folder here. Empty uses ~/Codeome.')));
  }

  function pythonSection(c) {
    return section('python', 'Python', null,
      card(null,
        row('On this Mac', text(() => App.cfg.python.local, (v) => { App.cfg.python.local = v.trim() || 'python3'; }, { label: 'Python on this Mac' })),
        row('On the HPC', text(() => App.cfg.python.remote, (v) => { App.cfg.python.remote = v.trim() || 'python3'; }, { label: 'Python on the HPC' }))));
  }

  // ---------- GitHub accounts ----------
  let gitRows = [];

  function gitAccountRow(a) {
    const name = h('b', a.login || 'Unknown login');
    const status = h('span.pill');
    const scopes = h('div.acct-who');
    const workflow = h('div.acct-warn');
    const checked = h('div.hint');
    const paint = (updated) => {
      a = updated;
      name.textContent = a.login || 'Unknown login';
      const states = { valid: ['ok', 'valid'], 'missing-scopes': ['warn', 'missing scopes: repo'], invalid: ['warn', 'invalid token'], error: ['warn', 'could not check'] };
      const [kind, label] = states[a.status] || ['', 'not checked'];
      status.className = 'pill' + (kind ? ' ' + kind : '');
      status.textContent = label;
      scopes.textContent = Array.isArray(a.scopes) ? 'Scopes: ' + (a.scopes.join(', ') || 'none') : a.status === 'valid' ? 'Fine-grained token: scopes are not listed' : '';
      scopes.hidden = !scopes.textContent;
      workflow.textContent = Array.isArray(a.scopes) && !a.scopes.includes('workflow') ? 'Pushing workflow files needs the workflow scope.' : '';
      workflow.hidden = !workflow.textContent;
      const when = a.checkedAt && Date.parse(a.checkedAt);
      checked.textContent = when ? 'checked ' + App.fmtAgo(when) : a.checkedAt ? 'checked ' + a.checkedAt : 'not checked yet';
      checked.title = a.checkedAt || '';
    };
    const el = h('div.acct-card', { role: 'listitem' },
      h('div.acct-top', name, h('span.grow'), status),
      h('div.acct-who', h('code', a.host)),
      scopes, workflow, checked,
      h('div.acct-acts',
        h('button.btn.small', { onclick: async () => {
          const r = await codeome.gitAccounts.validate(a.id);
          if (r.error) return App.err(r.error);
          paint(r.data); flash('Checked');
        } }, 'Validate'),
        h('span.grow'),
        h('button.btn.small.ghost.danger', { onclick: async () => {
          if (!await App.confirm(`Remove ${a.login || 'GitHub account'}?`, 'Its token is deleted from this Mac. Projects bound to it fall back to the default login.', 'Remove', true)) return;
          const r = await codeome.gitAccounts.remove(a.id);
          if (r.error) return App.err(r.error);
          await redrawGitSection(); flash('Account removed');
        } }, 'Remove')));
    paint(a);
    return { el, id: a.id, paint };
  }

  async function redrawGitSection() {
    const old = sections.git;
    if (current !== 'git' || !S.isOpen || !old) return;
    const fresh = await gitSection();
    if (current === 'git' && S.isOpen && old.isConnected && sections.git === old) {
      old.replaceWith(fresh);
      sections.git = fresh;
      gitRows = fresh.gitRows;
      recheckGitAccounts(fresh);
    }
  }

  async function recheckGitAccounts(el) {
    for (const row of gitRows) {
      if (current !== 'git' || !S.isOpen || sections.git !== el) return;
      const r = await codeome.gitAccounts.validate(row.id);
      if (current !== 'git' || !S.isOpen || sections.git !== el) return;
      if (r.error) App.err(r.error); else row.paint(r.data);
    }
  }

  async function gitSection() {
    const intro = 'GitHub accounts for your projects. A token is validated with GitHub, encrypted with the macOS Keychain and never shown again. Bind an account to a project in the Git view. Use a classic token with repo (and workflow to push workflow files), or a fine-grained token with Contents and Pull requests access.';
    const r = await codeome.gitAccounts.list();
    const rows = r.error ? [] : r.data.accounts.map(gitAccountRow);
    const provider = select([{ value: 'github', label: 'GitHub' }], 'github', () => {}, 'Provider');
    const host = h('input.mono', { type: 'text', value: 'github.com', placeholder: 'github.com or ghe.example.org', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'GitHub host' });
    const token = h('input', { type: 'password', placeholder: 'Paste token', autocomplete: 'off', 'aria-label': 'GitHub token' });
    const save = h('button.btn.small.primary', { onclick: async () => {
      if (!token.value.trim()) return token.focus();
      save.disabled = true;
      const pending = codeome.gitAccounts.add(provider.value, host.value.trim() || 'github.com', token.value.trim());
      token.value = '';
      const result = await pending;
      save.disabled = false;
      if (result.error) return App.err(result.error);
      await redrawGitSection(); flash('Account added');
      if (result.data.warnings?.includes('workflow')) App.toast('Pushing workflow files needs the workflow scope.');
    } }, 'Save');
    token.onkeydown = (e) => { if (e.key === 'Enter') save.click(); };
    const el = h('section.sp-section', { 'data-id': 'git', 'aria-labelledby': 'sp-git' },
      h('h2', { id: 'sp-git' }, 'Git & GitHub'), h('p.sp-intro', intro),
      h('div.acct-grid', { role: 'list', 'aria-label': 'GitHub accounts' }, r.error ? h('div.sp-empty', r.error) : rows.length ? rows.map((row) => row.el) : h('div.sp-empty', 'No GitHub accounts yet.')),
      card('Add account',
        h('div.sec-add', provider, host, h('div.row', token, save)),
        h('div.sp-foot.row', h('button.btn.small', { onclick: async () => {
          const result = await codeome.gitAccounts.importGh(host.value.trim() || 'github.com');
          if (result.error) return App.err(result.error);
          await redrawGitSection(); flash('Account imported');
          if (result.data.warnings?.includes('workflow')) App.toast('Pushing workflow files needs the workflow scope.');
        } }, 'Import from gh'), h('span.hint', 'Use the token from the gh CLI sign-in on this Mac.'))));
    el.gitRows = rows;
    return el;
  }

  // Tokens go straight to the Keychain; the page only knows whether one is saved.
  async function publishingSection() {
    const keys = [
      ['zenodo:prod', 'Zenodo token', 'zenodo.org → Applications → Personal access tokens (deposit:write, deposit:actions).'],
      ['zenodo:sandbox', 'Zenodo sandbox token', null],
      ['pypi:pypi', 'PyPI API token', null],
      ['pypi:testpypi', 'TestPyPI API token', null]
    ];
    const has = await Promise.all(keys.map(([k]) => codeome.secret.has(k)));
    return section('publishing', 'Zenodo & PyPI', 'Tokens are encrypted with the macOS Keychain and never shown again.',
      card(null, keys.map(([k, label, hint], i) => {
        const status = h('span.pill' + (has[i] ? '.ok' : ''), has[i] ? 'saved' : 'not set');
        const input = h('input', { type: 'password', placeholder: has[i] ? 'Saved — paste a new one to replace' : 'Paste token', autocomplete: 'off', 'aria-label': label });
        const saveBtn = h('button.btn.small', { onclick: async () => {
          if (!input.value.trim()) return;
          await codeome.secret.set(k, input.value.trim());
          input.value = ''; input.placeholder = 'Saved — paste a new one to replace';
          status.className = 'pill ok'; status.textContent = 'saved'; flash('Token saved');
        } }, 'Save');
        input.onkeydown = (e) => { if (e.key === 'Enter') saveBtn.click(); };
        return row(label, h('div.row', input, saveBtn, status), hint);
      })));
  }

  // ---------- secrets ----------
  // Your own tokens and keys, each named as the environment variable it becomes. Values go
  // straight to the Keychain; the page knows the names and where each is used, never a value.
  async function secretsSection() {
    const list = () => (App.cfg.secrets = App.cfg.secrets || []);
    const redraw = async () => { if (current === 'secrets') sections.secrets.replaceWith(await secretsSection()); };
    const project = App.project;
    const [has, hpc] = await Promise.all([
      codeome.secrets.has(list().map((s) => s.name)).catch((e) => ({ error: e.message || String(e) })),
      project ? codeome.secrets.hpcStatus(project).catch((e) => ({ error: e.message || String(e) })) : Promise.resolve(null)
    ]);
    if (has.error) {
      App.err(has.error);
      return section('secrets', 'Secrets', null, card(null, h('div.sp-empty', has.error)));
    }
    if (hpc?.error) App.err(hpc.error);

    // Which projects a secret is open to: every one, or the ones ticked.
    const scopeLabel = (s) => (!Array.isArray(s.projects) ? 'All projects' : !s.projects.length ? 'No projects' : s.projects.length === 1 ? App.basename(s.projects[0]) : `${s.projects.length} projects`);
    async function pickProjects(s) {
      const dirs = [...new Set([...App.views.projects.list, ...(App.cfg.openProjects || []), ...(App.cfg.recentFolders || []), ...(s.projects || [])])].filter((d) => !App.isIdeas(d));
      const r = await App.modal({ title: `Projects for ${s.name}`, ok: 'Save',
        text: 'Ticked projects can use this secret in the enabled Terminals and Agents scopes and can sync it to the HPC when HPC is enabled. "All projects" also allows local terminals outside a project.',
        fields: [{ key: 'all', type: 'check', label: 'All projects', value: !Array.isArray(s.projects) },
          { legend: 'Only these' },
          ...dirs.map((d, j) => ({ key: 'p' + j, type: 'check', label: `${App.basename(d)}  ·  ${App.tildify(d)}`, value: (s.projects || []).includes(d) }))] });
      if (!r) return;
      if (r.all) delete s.projects; else s.projects = dirs.filter((_d, j) => r['p' + j]);
      await App.saveConfig(); flash(); redraw();
    }

    // Saving swaps App.cfg for the copy the main process returns, so a row's handlers look their secret up again by name.
    const live = (s) => list().find((x) => x.name === s.name) || s;
    const rows = list().map((s, i) => h('div.sec-row', { role: 'listitem' },
      h('div.ag-name',
        h('div.row', h('b.sec-name', s.name), has[i] ? null : h('span.pill.warn', { title: 'Its value is missing from the Keychain. Use Replace… to enter it again.' }, 'no value')),
        h('input.sec-note', { type: 'text', value: s.note || '', placeholder: 'Add a note: what it is for, when it expires', 'aria-label': `Note for ${s.name}`,
          onchange: (e) => { live(s).note = e.target.value.trim().slice(0, 200); commit(); } })),
      h('div.sec-use',
        check('Terminals', () => live(s).terminals, (v) => { live(s).terminals = v; }),
        check('Agents', () => live(s).agents, (v) => { live(s).agents = v; }),
        check('HPC', () => live(s).hpc, (v) => { live(s).hpc = v; if (hpc?.connected) hpcStatus.textContent = `HPC selection changed. Sync to update ${hpc.path}.`; }, undefined, 'The value is stored in plaintext (mode 0600) in the HPC home when synced.'),
        h('button.btn.small.sec-scope', { title: Array.isArray(s.projects) ? s.projects.map((d) => App.tildify(d)).join('\n') || 'Set in no project' : 'Set in every project', 'aria-label': `Projects for ${s.name}: ${scopeLabel(s)}`, onclick: () => pickProjects(live(s)) }, scopeLabel(s))),
      h('div.sec-acts',
        h('button.btn.small', { disabled: !has[i], onclick: async () => {
          const r = await codeome.secrets.copy(s.name);
          if (r.error) return App.err(r.error);
          flash(`Copied for ${r.seconds} s`);
        } }, 'Copy'),
        h('button.btn.small', { onclick: async () => {
          const r = await App.modal({ title: `Replace ${s.name}`, text: 'The new value takes the place of the saved one.', ok: 'Replace', fields: [{ key: 'v', label: 'New value', type: 'password', placeholder: 'Paste token' }] });
          if (!r || !r.v.trim()) return;
          const res = await codeome.secrets.set(s.name, r.v.trim());
          if (res.error) return App.err(res.error);
          flash('Secret replaced'); redraw();
        } }, 'Replace…'),
        h('button.icon-btn.small', { title: 'Remove', 'aria-label': 'Remove ' + s.name, html: App.icons.trash, onclick: async () => {
          if (!await App.confirm(`Remove ${s.name}?`, 'Its value is deleted from this Mac. Terminals and chats already running keep it until they close.', 'Remove', true)) return;
          await codeome.secrets.remove(s.name);
          App.cfg.secrets = list().filter((x) => x.name !== s.name);
          await App.saveConfig(); flash('Secret removed'); redraw();
        } }))));

    const name = h('input.mono', { type: 'text', placeholder: 'GITHUB_TOKEN', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Name' });
    const value = h('input', { type: 'password', placeholder: 'Paste token', autocomplete: 'off', 'aria-label': 'Value' });
    const add = h('button.btn.small.primary', { onclick: async () => {
      const n = name.value.trim(), v = value.value.trim();
      if (!n) return name.focus();
      if (!v) return value.focus();
      if (list().some((x) => x.name === n)) return App.err(`${n} is already saved. Use Replace… to change its value.`);
      const res = await codeome.secrets.set(n, v);
      if (res.error) return App.err(res.error);
      list().push({ name: n, note: '', terminals: false, agents: false });
      await App.saveConfig(); flash('Secret saved'); redraw();
    } }, 'Save');
    name.onkeydown = (e) => { if (e.key === 'Enter') value.focus(); };
    value.onkeydown = (e) => { if (e.key === 'Enter') add.click(); };

    const skipped = hpc?.skipped?.length ? ` Skipped: ${hpc.skipped.join(', ')}.` : '';
    const hpcMessage = !project ? 'Open a project to sync its HPC secrets.'
      : hpc?.error ? 'Could not check HPC status.'
      : !hpc?.connected ? 'HPC not connected'
      : hpc.names.length ? `Ready to sync ${hpc.names.join(', ')} to ${hpc.path}.${skipped}`
      : `No HPC secrets ready for this project. Sync removes ${hpc.path} if it exists.${skipped}`;
    const hpcStatus = h('span.hint.sec-hpc-status', { role: 'status', 'aria-live': 'polite' }, hpcMessage);
    const sync = h('button.btn.small', { disabled: !project || !hpc?.connected, onclick: async () => {
      sync.disabled = true;
      hpcStatus.textContent = 'Syncing to HPC…';
      try {
        await App.saveConfig();
        const result = await codeome.secrets.sync(project);
        if (result.error) { hpcStatus.textContent = result.error; return App.err(result.error); }
        hpcStatus.textContent = result.removed ? `Removed ${hpc.path} from the HPC.`
          : `Synced ${result.names.join(', ')} to ${hpc.path}.`;
        if (result.skipped.length) hpcStatus.textContent += ` Skipped: ${result.skipped.join(', ')}.`;
        flash(result.removed ? 'HPC secrets removed' : 'HPC secrets synced');
      } catch (e) {
        const message = e.message || String(e);
        hpcStatus.textContent = message;
        App.err(message);
      } finally { sync.disabled = false; }
    } }, 'Sync to HPC');

    return section('secrets', 'Secrets', 'Access tokens, API keys and passwords of your own, encrypted with the macOS Keychain. A value is never shown again: copy it, or have Codeome set it as an environment variable.',
      card('Saved secrets',
        rows.length ? h('div', { role: 'list', 'aria-label': 'Saved secrets' }, rows) : h('div.sp-empty', 'None yet. Add one below.'),
        h('div.sec-add', name, value, add),
        h('div.sp-foot.row.wrap', sync, hpcStatus),
        h('div.sp-foot.hint', 'The name is the environment variable. Terminals: set in terminals, tasks and the R console started on this Mac. Agents: set in the agent chat and agent sessions on this Mac, so the agent can read and use it. HPC: syncs selected secrets to a private file in the HPC home, where they are stored in plaintext (mode 0600). All three are off for a new secret. The project button limits where each enabled scope applies. Copy puts the value on the clipboard for 30 seconds.')));
  }

  function appearanceSection(c) {
    return section('appearance', 'Appearance', null,
      card(null,
        row('Theme', select([{ value: 'auto', label: 'Match macOS' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], c.editor.theme,
          (v) => { App.cfg.editor.theme = v; commit({ theme: true }); }, 'Theme')),
        row('Editor & terminal font size', text(() => App.cfg.editor.fontSize, (v) => { App.cfg.editor.fontSize = Math.min(24, Math.max(10, Number(v) || 13)); }, { type: 'number', apply: { font: true }, label: 'Font size' }))));
  }

  function macSection() {
    const tools = Object.entries(App.env.tools || {});
    const installable = App.env.installable || [];
    const recipes = App.env.recipes || {};
    const install = async (list) => { if (await App.setup.install(list)) S.open('mac'); };
    const versions = h('div.su-list');
    const showVersions = (r) => {
      if (!r) return versions.replaceChildren(h('span.hint', 'Could not check for new versions.'));
      const rows = ['codeome', 'claude', 'codex'].filter((e) => r.installed[e] !== undefined).map((e) => {
        const label = { codeome: 'Codeome', codex: 'Codex', claude: 'Claude Code' }[e];
        const up = r.updates.find((u) => u.engine === e);
        return up ? stepRow('todo', label, `${up.installed} installed; ${up.latest} is available.`,
          up.url ? btn('View release', () => codeome.shell.open(up.url)) : btn('Update…', () => App.setup.updateClis([up]).then((ok) => ok && S.open('mac'))))
          : stepRow('ok', label, r.installed[e] ? `${r.installed[e]}${r.error ? '' : ', up to date'}` : 'Installed');
      });
      if (r.error) rows.push(h('span.hint', 'Lookup failed: ' + r.error));
      versions.replaceChildren(...rows);
    };
    App.setup.checkClis().then(showVersions);
    return section('mac', 'This Mac', 'Command-line tools Codeome looked for on your login shell\'s PATH.',
      card(null, versions, h('div.sp-foot.row', h('span.grow.hint', 'Codeome, Claude Code and Codex are looked up for new versions about once a week.'),
        btn('Check for updates', async (e) => { const b = e.currentTarget; b.disabled = true; b.textContent = 'Checking…'; showVersions(await App.setup.checkClis({ force: true })); b.disabled = false; b.textContent = 'Check for updates'; })),
        h('div.sp-tools', tools.length ? tools.map(([t, ok]) => h('span.pill' + (ok ? '.ok' : '.warn'), (ok ? '' : 'missing: ') + t)) : h('span.hint', 'Still checking…')),
        installable.length ? h('div.su-list', installable.map((t) => stepRow('todo', recipes[t].label, `Not installed. Used for: ${recipes[t].why}.`, btn('Install…', () => install([t])))),
          installable.length > 1 ? h('div.sp-foot.row', h('span.grow.hint', 'Installs with Homebrew, after asking.'), btn('Install all…', () => install(installable))) : null) : null));
  }
})();
