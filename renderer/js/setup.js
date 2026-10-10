// HPC setup: Codeome's own VPN tunnel, the ssh key, and installing missing tools.
// Settings → HPC shows these as a checklist; connecting to the HPC uses them too.
// Every step runs in a visible terminal, so password, passphrase and second-factor
// prompts work, and nothing is installed without asking first.
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
  let watch = null, connectWhenUp = false, back = null;
  const vpnTab = () => T().list.find((t) => t.spec.kind === 'vpn' && t.alive);
  U.vpnStarting = () => !U.vpnUp && !!vpnTab();

  // Starts the tunnel in a terminal (to sign in there) and watches for it to come up.
  // thenConnect: connect to the HPC once it is up; returnTo: run when it is (e.g. reopen Settings).
  U.startVpn = async ({ thenConnect = false, returnTo = null } = {}) => {
    const v = App.cfg.hpc.vpn;
    if (!v.server) {
      App.toast('Set the VPN server first.', { action: { label: 'Open Settings', run: () => App.views.settings.open('hpc') } });
      return;
    }
    if (U.vpnUp) { if (thenConnect) App.connectHpc(); return; }
    connectWhenUp = connectWhenUp || thenConnect;
    back = returnTo || back;
    const running = vpnTab();
    if (running) { App.views.settings.close(); T().showPanel(); T().activate(running.id); return; }
    const st = await U.refresh();
    const missing = ['openconnect', 'ocproxy'].filter((t) => !st.tools[t]);
    if (missing.length && !(await U.install(missing, "Codeome's VPN tunnel needs them."))) { connectWhenUp = false; back = null; return; }
    App.views.settings.close();
    T().open({ kind: 'vpn', title: 'VPN · ' + v.server, badge: 'VPN', global: true, cwd: '~',
      onExit: () => { stopWatch(); connectWhenUp = false; back = null; App.pollHpc(); } });
    App.toast(`Sign in to ${v.server} in the terminal below. The tunnel only carries Codeome's HPC connections.`, {
      ms: 9000, action: thenConnect ? { label: 'Connect without it', run: () => { connectWhenUp = false; App.connectHpc({ direct: true }); } } : null });
    startWatch();
    App.emit('vpn', U.vpnUp);
  };

  function startWatch() {
    stopWatch();
    watch = setInterval(async () => {
      const r = await codeome.hpc.vpn();
      if (!r.up) return;
      stopWatch();
      await App.pollHpc();
      App.toast('VPN tunnel is up.');
      const go = connectWhenUp, ret = back;
      connectWhenUp = false; back = null;
      if (go) App.connectHpc();
      else if (ret) ret();
    }, 1500);
  }
  function stopWatch() { clearInterval(watch); watch = null; }

  // Signs out of the VPN (Ctrl-C lets openconnect log the session off), then closes the tab.
  U.stopVpn = async () => {
    const t = vpnTab();
    if (!t) return;
    if (App.hpcConnected) await codeome.hpc.disconnect();
    codeome.pty.write(t.id, '\x03');
    setTimeout(() => { if (T().get(t.id)) T().close(t.id); App.pollHpc(); }, 2000);
    App.toast('VPN tunnel stopped.');
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
