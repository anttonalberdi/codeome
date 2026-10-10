// Opening the shared HPC and storage connections without a terminal (main/login.js).
// With an ssh key it connects on its own; a password, a key's passphrase, a one-time
// code or a new host's fingerprint is asked for in a dialog, like the VPN tunnel's
// sign-in. The terminal panel stays free for work; a failed login can be retried there.
(function () {
  const h = App.h;
  const L = { state: { hpc: { phase: 'stopped' }, storage: { phase: 'stopped' } } };
  const timers = {};
  const owner = (t) => 'login:' + t;
  const name = (t) => (t === 'storage' ? App.views.files.title('storage') : App.cfg.hpc.host);
  L.busy = (t) => ['starting', 'prompt', 'waiting'].includes(L.state[t].phase);

  // Starts connecting, or shows the current step again if it already is.
  L.start = async (t) => {
    if (L.busy(t)) { onState({ target: t, ...L.state[t] }, true); return; }
    const r = await codeome.login.start(t);
    if (r.error) App.err(r.error);
  };
  L.stop = (t) => codeome.login.stop(t);
  const cancel = (t) => { L.stop(t); App.toast('Connecting cancelled.'); };

  // The dialog for one of ssh's prompts; Cancel stops connecting.
  async function ask(t, pr) {
    const title = 'Connect to ' + name(t);
    let r, value, save = false;
    if (pr.kind === 'password') {
      const fields = [{ key: 'v', label: 'Password', type: 'password' },
        { key: 'save', type: 'check', label: pr.saved ? 'Replace the saved password once it works' : 'Save in the Keychain once it works', value: true }];
      r = await App.signIn(owner(t), { title, text: pr.error || `Your password on ${name(t)}.`, ok: 'Connect', fields });
      value = r && r.v; save = !!(r && r.save);
    } else if (pr.kind === 'passphrase') {
      const key = App.tildify(pr.key) || pr.key;
      r = await App.signIn(owner(t), { title, text: pr.error || `The passphrase of your ssh key ${key}.`, ok: 'Connect',
        fields: [{ key: 'v', label: 'Passphrase', type: 'password', hint: 'To stop being asked, add it to the macOS keychain: ssh-add --apple-use-keychain ' + key }] });
      value = r && r.v;
    } else if (pr.kind === 'hostkey') {
      r = await App.signIn(owner(t), { title: `Trust ${name(t)}?`,
        text: `This Mac has not connected to ${name(t)} before. Check that the fingerprint matches the one your HPC publishes, then trust it.`,
        body: h('pre.sp-code.vpn-log', pr.detail || ''), ok: 'Trust and connect' });
      value = 'yes';
    } else {
      r = await App.signIn(owner(t), { title: 'Second factor', text: pr.error || `${name(t)} asks for a second factor, for example a code from your authenticator app.`, ok: 'Continue',
        fields: [{ key: 'v', label: pr.label }] });
      value = r && r.v.trim();
    }
    if (r === undefined) return; // replaced by the next step
    if (r === null) return cancel(t);
    codeome.login.answer(t, pr.id, value || '', save);
  }

  // Shown when ssh takes a while after a prompt, e.g. waiting for an MFA approval.
  async function waiting(t) {
    const r = await App.signIn(owner(t), { title: 'Connecting to ' + name(t),
      text: 'If your HPC sends a sign-in request to your MFA device, for example the authenticator app on your phone, approve it. Codeome connects as soon as you do.',
      body: h('div.vpn-wait', h('span.spinner'), h('span', 'Waiting for ' + name(t) + '…')), ok: 'Hide', cancel: 'Cancel' });
    if (r === null) cancel(t);
  }

  // The old way, for prompts Codeome does not understand: ssh in a terminal tab.
  function inTerminal(t) {
    const kind = t + '-login';
    App.views.terminals.open({ kind, title: 'Connect ' + name(t), badge: t === 'hpc' ? 'HPC' : 'SFTP',
      onExit: async () => {
        await App.pollHpc();
        if (!(t === 'hpc' ? App.hpcConnected : App.storageConnected)) return;
        App.toast('Connected to ' + name(t) + '.');
        const x = App.views.terminals.list.find((y) => y.spec.kind === kind && !y.alive);
        if (x) setTimeout(() => App.views.terminals.close(x.id), 600);
      } });
  }

  L.showLog = async (t) => {
    const log = (await codeome.login.log(t)).trim();
    const r = await App.modal({ title: 'Connection log · ' + name(t), body: h('pre.sp-code.vpn-log', log || 'Nothing logged.'), ok: 'Try in a terminal', cancel: 'Close' });
    if (r) inTerminal(t);
  };

  // again: show the current step's dialog again (Connect pressed while connecting).
  function onState(s, again = false) {
    const t = s.target, prev = L.state[t];
    if (!prev) return;
    L.state[t] = s;
    clearTimeout(timers[t]);
    if (s.phase === 'prompt' && (again || !prev.prompt || prev.prompt.id !== s.prompt.id)) ask(t, s.prompt);
    else if (s.phase === 'waiting' || s.phase === 'starting') {
      if (again) waiting(t);
      else if (prev.phase === 'prompt' || (s.phase === 'waiting' && prev.phase !== 'waiting')) {
        App.closeSignIn(owner(t));
        timers[t] = setTimeout(() => { if (L.state[t].phase === 'waiting') waiting(t); }, 3000);
      }
    } else if (s.phase === 'up' && prev.phase !== 'up') {
      App.closeSignIn(owner(t));
      App.toast('Connected to ' + name(t) + '.');
      App.pollHpc();
    } else if (s.phase === 'failed' && prev.phase !== 'failed') {
      App.closeSignIn(owner(t));
      App.toast(`Could not connect to ${name(t)}: ${s.reason}`, { error: true, action: { label: 'Details', run: () => L.showLog(t) } });
      App.pollHpc();
    } else if (s.phase === 'stopped') {
      App.closeSignIn(owner(t));
      App.pollHpc();
    }
    App.emit('login', t);
  }
  codeome.login.onState((s) => onState(s));
  for (const t of ['hpc', 'storage']) codeome.login.state(t).then((s) => { if (s && s.phase !== 'stopped') onState(s); });

  App.login = L;
})();
