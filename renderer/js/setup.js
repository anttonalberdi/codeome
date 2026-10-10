// HPC setup: Codeome's own VPN tunnel, the ssh key, and installing missing tools.
// Settings → HPC shows these as a checklist; connecting to the HPC uses them too.
// The tunnel signs in through dialogs; the other steps run in a visible terminal, so
// password and passphrase prompts work, and nothing is installed without asking first.
(function () {
  const h = App.h;
  const U = { status: null, vpnUp: false, loginTest: null, vpnTest: null };
  App.setup = U;
  const T = () => App.views.terminals;
  const and = (xs) => (xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]);

  U.tunnelOn = () => App.cfg.hpc.vpn.mode === 'tunnel';
  U.refresh = async () => { U.status = await codeome.setup.status(); App.emit('setup', U.status); return U.status; };
  async function redetect() { App.env = await codeome.env.detect(); App.emit('env', App.env); }

  // A setup step in a terminal over the workspace; resolves with its exit code.
  // Successful steps close their tab; failed ones stay open to show why.
  async function step(spec) {
    App.views.settings.close();
    let done;
    const ended = new Promise((r) => { done = r; });
    const t = await T().open({ cwd: '~', badge: 'Mac', ...spec, onExit: (code) => done(code) });
    if (!t.alive) done(-1);
    const code = await ended;
    if (code === 0) setTimeout(() => T().get(t.id) && T().close(t.id), 1500);
    return code;
  }

  // ---------- installing tools ----------
  // Ask, then install with Homebrew (installing Homebrew first if it is missing).
  U.install = async (tools, why) => {
    const ic = await codeome.setup.install(tools);
    if (!ic) { App.err(`Codeome cannot install ${and(tools)} by itself.`); return false; }
    const st = U.status || await U.refresh();
    const needBrew = ic.brew && !st.brew;
    const ok = await App.modal({
      title: `Install ${and(ic.labels)}?`,
      text: (why ? why + ' ' : '') + (needBrew ? 'Homebrew, the Mac package manager, is not installed, so Codeome first installs it (it asks for your Mac password), then runs:' : 'Codeome runs this in a terminal:'),
      body: h('pre.sp-code', (needBrew ? ic.brewInstall + '\n' : '') + ic.command),
      ok: 'Install'
    });
    if (!ok) return false;
    if (needBrew && await step({ kind: 'install', brew: true, title: 'Install Homebrew' }) !== 0) {
      App.err('Homebrew was not installed. The terminal shows why.');
      return false;
    }
    const code = await step({ kind: 'install', tools, title: 'Install ' + and(ic.labels) });
    await Promise.all([U.refresh(), redetect()]);
    if (code === 0) App.toast(`${and(ic.labels)} installed.`);
    else App.err(`Installing ${and(ic.labels)} failed. The terminal shows why.`);
    return code === 0;
  };

  // ---------- VPN tunnel ----------
  // It signs in without a terminal (main/vpn.js): Codeome asks in dialogs for what
  // is not saved, then shows that a sign-in waits for approval on the MFA device.
  let connectWhenUp = false, back = null, dialog = null, mfaTimer = null;
  U.tun = { phase: 'stopped' };
  const server = () => App.cfg.hpc.vpn.server;
  U.vpnStarting = () => !U.vpnUp && ['starting', 'prompt', 'waiting'].includes(U.tun.phase);

  // One sign-in dialog at a time; a new one (or the tunnel coming up) closes the last.
  function show(opts) {
    closeDialog();
    const d = {};
    dialog = d;
    return App.modal({ ...opts, closer: (c) => { d.close = c; } }).then((v) => { if (dialog === d) dialog = null; return v; });
  }
  function closeDialog() { const d = dialog; dialog = null; if (d && d.close) d.close(); }

  // thenConnect: connect to the HPC once it is up; returnTo: run when it is (e.g. reopen Settings).
  U.startVpn = async ({ thenConnect = false, returnTo = null } = {}) => {
    if (!server()) {
      App.toast('Set the VPN server first.', { action: { label: 'Open Settings', run: () => App.views.settings.open('hpc') } });
      return;
    }
    if (U.vpnUp) { if (thenConnect) App.connectHpc(); return; }
    connectWhenUp = connectWhenUp || thenConnect;
    back = returnTo || back;
    if (U.vpnStarting()) { onState(U.tun, true); return; }
    const st = await U.refresh();
    const missing = ['openconnect', 'ocproxy'].filter((t) => !st.tools[t]);
    if (missing.length && !(await U.install(missing, "Codeome's VPN tunnel needs them."))) { connectWhenUp = false; back = null; return; }
    const r = await codeome.vpn.start();
    if (r.error) { connectWhenUp = false; back = null; App.err(r.error); return; }
    App.toast(`Signing in to ${server()}…`);
  };

  // The dialog for one of openconnect's prompts; Cancel stops the sign-in.
  async function ask(pr) {
    const title = 'Sign in to ' + server();
    let r, value, save = false;
    if (pr.kind === 'username') {
      r = await show({ title, text: pr.error || 'Your VPN username.', ok: 'Continue',
        fields: [{ key: 'v', label: 'Username', placeholder: 'e.g. abc123' }, { key: 'remember', type: 'check', label: 'Remember it in Settings', value: true }] });
      if (r && r.remember && r.v.trim()) { App.cfg.hpc.vpn.user = r.v.trim(); App.saveConfig(); }
      value = r && r.v.trim();
    } else if (pr.kind === 'password') {
      const who = App.cfg.hpc.vpn.user;
      r = await show({ title, text: pr.error || (who ? `The VPN password for ${who}.` : 'Your VPN password.'), ok: 'Sign in',
        fields: [{ key: 'v', label: 'Password', type: 'password' },
          { key: 'save', type: 'check', label: pr.saved ? 'Replace the saved password once it works' : 'Save in the Keychain once it works', value: true }] });
      value = r && r.v; save = !!(r && r.save);
    } else if (pr.kind === 'group') {
      r = await show({ title, text: pr.error || 'Pick your group.', ok: 'Continue',
        fields: [{ key: 'v', label: 'Group', type: 'select', options: pr.options, value: pr.options[0] }] });
      value = r && r.v;
    } else {
      r = await show({ title: 'Second factor', text: pr.error || `${server()} asks for a second factor, for example a code from your authenticator app.`, ok: 'Continue',
        fields: [{ key: 'v', label: pr.label }] });
      value = r && r.v.trim();
    }
    if (r === undefined) return; // replaced by the next step
    if (r === null) { U.stopVpn({ quiet: true }); App.toast('VPN sign-in cancelled.'); return; }
    codeome.vpn.answer(pr.id, value || '', save);
  }

  // Shown after the password while the server may wait for an approval on the MFA device.
  async function mfa() {
    const r = await show({ title: 'Approve the sign-in',
      text: `Check your MFA device, for example the authenticator app on your phone, and approve the sign-in to ${server()}. Codeome connects as soon as you do.`,
      body: h('div.vpn-wait', h('span.spinner'), h('span', 'Waiting for the approval…')),
      ok: 'Hide', cancel: 'Cancel sign-in' });
    if (r === null) { U.stopVpn({ quiet: true }); App.toast('VPN sign-in cancelled.'); }
  }

  async function showLog() {
    const log = (await codeome.vpn.log()).trim();
    App.modal({ title: 'VPN sign-in log', body: h('pre.sp-code.vpn-log', log || 'Nothing logged.'), ok: 'Close', cancel: null });
  }
  U.showVpnLog = showLog;

  // again: show the current step's dialog again (Start pressed while signing in).
  function onState(s, again = false) {
    const prev = U.tun;
    U.tun = s;
    clearTimeout(mfaTimer);
    if (s.phase === 'prompt' && (again || !prev.prompt || prev.prompt.id !== s.prompt.id)) ask(s.prompt);
    else if (s.phase === 'waiting') {
      if (again) mfa();
      else if (prev.phase !== 'waiting') { closeDialog(); mfaTimer = setTimeout(() => { if (U.tun.phase === 'waiting') mfa(); }, 1500); }
    } else if (s.phase === 'up' && prev.phase !== 'up') {
      closeDialog();
      U.vpnUp = true;
      App.toast('VPN tunnel is up.');
      App.pollHpc();
      const go = connectWhenUp, ret = back;
      connectWhenUp = false; back = null;
      if (go) App.connectHpc();
      else if (ret) ret();
    } else if (s.phase === 'failed' && prev.phase !== 'failed') {
      closeDialog();
      U.vpnUp = false; connectWhenUp = false; back = null;
      App.toast('VPN: ' + s.reason, { error: true, action: { label: 'Show log', run: showLog } });
      App.pollHpc();
    } else if (s.phase === 'stopped') {
      closeDialog();
      U.vpnUp = false; connectWhenUp = false; back = null;
      App.pollHpc();
    }
    App.emit('vpn', U.vpnUp);
  }
  codeome.vpn.onState((s) => onState(s));
  codeome.vpn.state().then((s) => { if (s && s.phase !== 'stopped') onState(s); });

  // Signs out of the VPN (openconnect logs the session off).
  U.stopVpn = async ({ quiet = false } = {}) => {
    if (U.tun.phase === 'stopped' || U.tun.phase === 'failed') return;
    if (App.hpcConnected) await codeome.hpc.disconnect();
    await codeome.vpn.stop();
    if (!quiet) App.toast('VPN tunnel stopped.');
  };

  // Whether the HPC network answers: directly (campus, Cisco Secure Client) or through the tunnel.
  // ok | dns | refused | unreachable | other | notunnel | nohost, with the host and port it tried.
  const vpnKey = () => { const c = App.cfg.hpc; return [c.host, c.vpnCheckHost, c.vpn.mode, c.vpn.port].join('|'); };
  U.testVpn = async () => {
    const key = vpnKey();
    U.vpnTest = { result: 'busy', key };
    App.emit('vpn-test', U.vpnTest);
    U.vpnTest = { ...(await codeome.setup.testVpn()), key };
    App.emit('vpn-test', U.vpnTest);
    return U.vpnTest;
  };
  // A result is about one setup; changing the login, check host or tunnel starts over.
  App.listen('config', () => { if (U.vpnTest && U.vpnTest.key !== vpnKey()) U.vpnTest = null; });

  // ---------- ssh key ----------
  U.createKey = async () => {
    const st = U.status || await U.refresh();
    if (st.key.exists) return true;
    const code = await step({ kind: 'keygen', key: st.key.path, title: 'Create ssh key' });
    await U.refresh();
    if (code !== 0) App.err('No key was created. The terminal shows why.');
    return code === 0;
  };

  // Puts the public key on the HPC (one password login), then checks it works.
  U.copyKey = async () => {
    const st = U.status || await U.refresh();
    if (!App.cfg.hpc.host) return App.err('Enter your HPC login first.');
    if (!st.key.exists) return App.err('Create an ssh key first.');
    if (U.tunnelOn() && !U.vpnUp) {
      App.toast('Start the VPN tunnel first.', { action: { label: 'Start VPN', run: () => U.startVpn() } });
      return false;
    }
    const code = await step({ kind: 'hpc-copy-key', key: st.key.path, title: 'Copy key to ' + App.cfg.hpc.host, badge: 'HPC' });
    if (code !== 0) { App.err('The key was not copied. The terminal shows why.'); return false; }
    await U.testLogin();
    return true;
  };

  // A fresh login without prompts: ok | auth | hostkey | network | other.
  U.testLogin = async () => {
    const host = App.cfg.hpc.host;
    U.loginTest = { result: 'busy', host };
    App.emit('login-test', U.loginTest);
    U.loginTest = { ...(await codeome.setup.testLogin()), host };
    App.emit('login-test', U.loginTest);
    return U.loginTest;
  };
  // A result is about one login; changing it starts over.
  App.listen('config', () => { if (U.loginTest && U.loginTest.host !== App.cfg.hpc.host) U.loginTest = null; });

  // ---------- startup ----------
  // Offers to install what the HPC connection needs and is missing.
  U.check = async (env) => {
    const core = (env.installable || []).filter((t) => t === 'ssh' || t === 'rsync');
    if (core.length) {
      App.toast(`${and(core)} is missing; Codeome needs it to reach the HPC.`, { error: true, action: { label: 'Install', run: () => U.install(core) } });
    }
    if (!U.tunnelOn()) return;
    const st = await U.refresh();
    const missing = ['openconnect', 'ocproxy'].filter((t) => !st.tools[t]);
    if (missing.length) {
      App.toast(`Codeome's VPN tunnel needs ${and(missing)}, which ${missing.length > 1 ? 'are' : 'is'} not installed.`, { ms: 12000, action: { label: 'Install', run: () => U.install(missing) } });
    }
  };
})();
