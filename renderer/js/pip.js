// Python packages: list, install, upgrade and remove, on the Mac or on the HPC.
(function () {
  const h = App.h;
  const P = { where: 'local', pkgs: [], filter: '' };
  App.views.pip = P;
  let root, listEl, pyInput, whereSel;

  P.init = () => {
    root = document.querySelector('.view[data-view="pip"]');
    whereSel = h('select', { 'aria-label': 'Environment', onchange: () => { P.where = whereSel.value; pyInput.value = App.cfg.python[P.where === 'hpc' ? 'remote' : 'local']; P.load(); } },
      h('option', { value: 'local' }, 'This Mac'), h('option', { value: 'hpc' }, 'HPC'));
    pyInput = h('input', { type: 'text', value: App.cfg.python.local, spellcheck: 'false', 'aria-label': 'Python command', title: 'Python interpreter, e.g. python3, ~/miniforge3/envs/x/bin/python',
      onchange: () => { App.cfg.python[P.where === 'hpc' ? 'remote' : 'local'] = pyInput.value.trim(); App.saveConfig(); P.load(); } });
    const install = h('input', { type: 'text', placeholder: 'package name, e.g. pandas>=2', spellcheck: 'false', 'aria-label': 'Package to install',
      onkeydown: (e) => { if (e.key === 'Enter' && install.value.trim()) { run('install', `install --upgrade ${install.value.trim()}`); install.value = ''; } } });
    const filter = h('input', { type: 'text', placeholder: 'Filter installed', 'aria-label': 'Filter installed packages', oninput: () => { P.filter = filter.value.toLowerCase(); render(); } });
    listEl = h('div.flist');
    root.append(
      h('div.side-head', h('h2', 'Python packages'), App.iconBtn('refresh', 'Refresh', () => P.load())),
      h('div.pad.form', { style: { paddingTop: 0 } }, h('div.row', whereSel, pyInput), h('div.row', install, h('button.btn.small', { onclick: () => { if (install.value.trim()) { run('install', `install --upgrade ${install.value.trim()}`); install.value = ''; } } }, 'Install')), filter),
      listEl);
    App.listen('view', (v) => { if (v === 'pip' && !P.pkgs.length) P.load(); });
  };

  function run(title, args) {
    const cmd = `${pyInput.value.trim()} -m pip ${args}`;
    const onExit = () => P.load();
    if (P.where === 'hpc') { if (!App.requireHpc()) return; App.views.terminals.hpcTask('pip ' + title, cmd, '~'); setTimeout(P.load, 8000); }
    else App.views.terminals.open({ kind: 'task', title: 'pip ' + title, command: cmd, cwd: App.project || '~', badge: 'Mac', onExit });
    setTimeout(P.load, 15000);
  }

  P.load = async () => {
    if (P.where === 'hpc' && !App.hpcConnected) { listEl.innerHTML = ''; listEl.append(h('div.empty', 'Connect to the HPC to list its packages.')); return; }
    listEl.innerHTML = ''; listEl.append(h('div.empty', h('span.spinner'), ' Reading packages…'));
    const r = await codeome.pip.list({ where: P.where, python: pyInput.value.trim(), cwd: App.project });
    if (r.error) { listEl.innerHTML = ''; listEl.append(h('div.empty', r.error.split('\n').slice(-3).join('\n'))); return; }
    P.pkgs = r.packages; render();
  };

  function render() {
    listEl.innerHTML = '';
    const pk = P.pkgs.filter((p) => !P.filter || p.name.toLowerCase().includes(P.filter));
    if (!pk.length) { listEl.append(h('div.empty', P.filter ? 'No installed package matches.' : 'No packages found.')); return; }
    for (const p of pk) listEl.append(h('div.pkg', h('span', p.name), h('span.v', p.version),
      h('span.row', { style: { gap: '0' } },
        App.iconBtn('up', 'Upgrade', () => run('upgrade', `install --upgrade ${p.name}`)),
        App.iconBtn('trash', 'Uninstall', async () => { if (await App.confirm(`Uninstall ${p.name}?`, `Removes ${p.name} ${p.version} from ${P.where === 'hpc' ? 'the HPC' : 'this Mac'} environment.`, 'Uninstall', true)) run('uninstall', `uninstall -y ${p.name}`); }))));
  }
})();
