// Settings dialog.
(function () {
  const h = App.h;
  const S = {};
  App.views.settings = S;

  S.open = async () => {
    const c = App.cfg;
    const [zp, zs, pp, pt] = await Promise.all(['zenodo:prod', 'zenodo:sandbox', 'pypi:pypi', 'pypi:testpypi'].map((k) => codeome.secret.has(k)));
    const saved = (b) => b ? 'Saved in Keychain — leave empty to keep' : '';
    const tools = Object.entries(App.env.tools || {}).map(([t, ok]) => h('span.pill' + (ok ? '.ok' : '.warn'), { style: { marginRight: '4px' } }, (ok ? '' : 'missing: ') + t));
    const v = await App.modal({
      title: 'Settings', ok: 'Save',
      body: h('div', h('div.hint', 'Detected on this Mac: '), h('div', { style: { marginTop: '4px', lineHeight: 2 } }, tools)),
      fields: [
        { legend: 'HPC' },
        { key: 'host', label: 'Login', value: c.hpc.host, placeholder: 'myhpc  or  user@login.cluster.example.org', hint: 'Use a Host alias from ~/.ssh/config if you have one; keys, ProxyJump and the rest apply as in your terminal.' },
        { key: 'remoteRoot', label: 'Start folder', value: c.hpc.remoteRoot, placeholder: '~ or /projects/mygroup' },
        { key: 'vpnCheckHost', label: 'VPN check (optional)', value: c.hpc.vpnCheckHost, placeholder: 'login.cluster.example.org', hint: 'A host only reachable on the VPN; the title bar shows whether it answers.' },
        { key: 'useTmux', label: 'Keep agent sessions on the HPC running in tmux (reattach after disconnects)', type: 'check', value: c.hpc.useTmux },
        { key: 'refresh', label: 'Refresh Slurm every (seconds)', type: 'number', value: c.slurm.refreshSeconds },
        { legend: 'Agents' },
        { key: 'agents', label: 'Coding agents', type: 'textarea', rows: 3, value: c.agents.map((a) => `${a.name} = ${a.cmd}`).join('\n'), hint: 'One per line: Name = command. Example: Claude (Opus) = claude --model opus' },
        { legend: 'Python' },
        { key: 'pyLocal', label: 'Python on this Mac', value: c.python.local },
        { key: 'pyRemote', label: 'Python on the HPC', value: c.python.remote },
        { legend: 'Zenodo' },
        { key: 'zProd', label: 'Zenodo token', type: 'password', placeholder: saved(zp), hint: 'zenodo.org → Applications → Personal access tokens (deposit:write, deposit:actions).' },
        { key: 'zSandbox', label: 'Zenodo sandbox token', type: 'password', placeholder: saved(zs) },
        { legend: 'PyPI' },
        { key: 'pypi', label: 'PyPI API token', type: 'password', placeholder: saved(pp) },
        { key: 'testpypi', label: 'TestPyPI API token', type: 'password', placeholder: saved(pt) },
        { legend: 'Appearance' },
        { key: 'theme', label: 'Theme', type: 'select', value: c.editor.theme, options: [{ value: 'auto', label: 'Match macOS' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] },
        { key: 'fontSize', label: 'Editor & terminal font size', type: 'number', value: c.editor.fontSize }
      ]
    });
    if (!v) return;
    const hostChanged = v.host.trim() !== c.hpc.host;
    c.hpc.host = v.host.trim(); c.hpc.remoteRoot = v.remoteRoot.trim() || '~'; c.hpc.vpnCheckHost = v.vpnCheckHost.trim(); c.hpc.useTmux = v.useTmux;
    c.slurm.refreshSeconds = Math.max(5, Number(v.refresh) || 20);
    const agents = v.agents.split('\n').map((l) => l.split('=')).filter((p) => p.length >= 2).map(([n, ...cmd]) => ({ name: n.trim(), cmd: cmd.join('=').trim() })).filter((a) => a.name && a.cmd);
    if (agents.length) c.agents = agents;
    c.python.local = v.pyLocal.trim() || 'python3'; c.python.remote = v.pyRemote.trim() || 'python3';
    c.editor.theme = v.theme; c.editor.fontSize = Math.min(24, Math.max(10, Number(v.fontSize) || 13));
    if (v.zProd) await codeome.secret.set('zenodo:prod', v.zProd.trim());
    if (v.zSandbox) await codeome.secret.set('zenodo:sandbox', v.zSandbox.trim());
    if (v.pypi) await codeome.secret.set('pypi:pypi', v.pypi.trim());
    if (v.testpypi) await codeome.secret.set('pypi:testpypi', v.testpypi.trim());
    await App.saveConfig();
    App.applyTheme();
    if (App.views.editor.editor) App.views.editor.editor.updateOptions({ fontSize: c.editor.fontSize });
    for (const t of App.views.terminals.list) t.term.options.fontSize = c.editor.fontSize;
    App.toast('Settings saved.');
    if (hostChanged) App.pollHpc();
  };
})();
