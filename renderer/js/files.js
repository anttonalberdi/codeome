// Files view: the Mac project folder above, the HPC below, transfers at the bottom.
// Drag between the two panes (or use the context menu) to copy with rsync.
(function () {
  const h = App.h;
  const F = { local: { dir: null, entries: [], sel: null }, remote: { dir: null, entries: [], sel: null }, transfers: new Map() };
  App.views.files = F;
  let root;

  F.init = () => {
    root = document.querySelector('.view[data-view="files"]');
    root.innerHTML = '';
    F.localPane = pane('local');
    F.remotePane = pane('remote');
    F.txEl = h('div.transfers', { hidden: true });
    root.append(F.localPane.el, F.remotePane.el, F.txEl);
    codeome.transfer.onProgress(onProgress);
    codeome.transfer.onDone(onDone);
    App.listen('local-changed', () => F.refresh('local'));
    App.listen('remote-changed', () => F.refresh('remote'));
    App.listen('hpc', (connected) => { if (connected && !F.remote.dir) F.go('remote', App.cfg.hpc.remoteRoot || '~'); else renderRemoteState(); });
    App.listen('project', (dir) => F.go('local', dir));
    renderRemoteState();
  };

  function pane(side) {
    const isRemote = side === 'remote';
    const pathInput = h('input', { type: 'text', spellcheck: 'false', 'aria-label': isRemote ? 'HPC folder' : 'Local folder',
      onkeydown: (e) => { if (e.key === 'Enter') F.go(side, pathInput.value.trim()); } });
    const list = h('div.flist', { tabindex: '0', role: 'listbox', 'aria-label': isRemote ? 'HPC files' : 'Local files' });
    const title = h('h2', isRemote ? 'HPC' : 'This Mac');
    const head = h('div.side-head', title,
      App.iconBtn('up', 'Parent folder', () => F.go(side, App.dirname(F[side].dir || '/'))),
      App.iconBtn('home', isRemote ? 'HPC start folder' : 'Project folder', () => F.go(side, isRemote ? (App.cfg.hpc.remoteRoot || '~') : (App.project || '~'))),
      App.iconBtn('refresh', 'Refresh', () => F.refresh(side)),
      App.iconBtn('dots', 'More', (e) => App.menuAt(e.currentTarget, folderMenu(side))));
    const el = h('div.side-section.split-pane', head, h('div.pathbar', pathInput), list);

    // Drop target: dragging from the other pane triggers a transfer into this folder (or onto a sub-folder).
    list.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('codeome/' + (isRemote ? 'local' : 'remote')) && !(isRemote && e.dataTransfer.types.includes('Files'))) return;
      e.preventDefault(); list.classList.add('dropping');
    });
    list.addEventListener('dragleave', (e) => { if (!list.contains(e.relatedTarget)) list.classList.remove('dropping'); });
    list.addEventListener('drop', (e) => {
      list.classList.remove('dropping'); e.preventDefault();
      const target = e.target.closest('.fitem.dir');
      const dest = target ? App.join(F[side].dir, target.dataset.name) : F[side].dir;
      const payload = e.dataTransfer.getData('codeome/' + (isRemote ? 'local' : 'remote'));
      if (payload) { const item = JSON.parse(payload); F.transfer(isRemote ? 'up' : 'down', item.path, dest); return; }
      // Files dragged in from Finder go straight to the HPC.
      if (isRemote) for (const f of e.dataTransfer.files) { const fp = codeome.pathForFile(f); if (fp) F.transfer('up', fp, dest); }
    });
    list.addEventListener('keydown', (e) => keyNav(side, e));
    return { el, list, pathInput, title };
  }

  function keyNav(side, e) {
    const s = F[side]; const items = s.entries; if (!items.length) return;
    let i = items.findIndex((x) => x.name === s.sel);
    if (e.key === 'ArrowDown') i = Math.min(items.length - 1, i + 1);
    else if (e.key === 'ArrowUp') i = Math.max(0, i - 1);
    else if (e.key === 'Enter' && i >= 0) return openEntry(side, items[i]);
    else if (e.key === 'Backspace' && e.metaKey) return F.go(side, App.dirname(s.dir));
    else return;
    e.preventDefault(); s.sel = items[i].name; render(side);
    side === 'local' ? F.localPane.list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' }) : F.remotePane.list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }

  F.go = async (side, dir) => {
    if (!dir) return;
    const p = side === 'local' ? F.localPane : F.remotePane;
    if (side === 'remote' && !App.hpcConnected) { renderRemoteState(); return; }
    p.list.innerHTML = '';
    p.list.append(h('div.empty', h('span.spinner'), ' Loading…'));
    const r = side === 'local' ? await codeome.local.list(dir) : await codeome.remote.list(dir);
    if (r.error) { p.list.innerHTML = ''; p.list.append(h('div.empty', r.error)); return; }
    F[side].dir = r.cwd; F[side].entries = r.entries.filter((x) => App.cfg.showHidden || !x.name.startsWith('.'));
    F[side].sel = null;
    if (side === 'remote') App.remoteDir = r.cwd;
    p.pathInput.value = r.cwd;
    render(side);
  };
  F.refresh = (side) => F[side].dir && F.go(side, F[side].dir);

  function renderRemoteState() {
    const p = F.remotePane; if (!p) return;
    if (App.hpcConnected) return;
    p.list.innerHTML = '';
    if (!App.cfg.hpc.host) p.list.append(h('div.empty', 'Add your cluster login in Settings to browse HPC files.', h('br'), h('button.btn.small', { onclick: () => App.views.settings.open() }, 'Open Settings')));
    else p.list.append(h('div.empty', `Not connected to ${App.cfg.hpc.host}. Make sure the VPN is on, then connect.`, h('br'), h('button.btn.small.primary', { onclick: () => App.connectHpc() }, 'Connect')));
  }

  function render(side) {
    const s = F[side]; const p = side === 'local' ? F.localPane : F.remotePane;
    p.list.innerHTML = '';
    if (!s.entries.length) { p.list.append(h('div.empty', 'This folder is empty.')); return; }
    for (const e of s.entries) {
      const full = App.join(s.dir, e.name);
      const row = h('div.fitem' + (e.dir ? '.dir' : '') + (s.sel === e.name ? '.sel' : ''), {
        draggable: 'true', role: 'option', 'aria-selected': s.sel === e.name ? 'true' : 'false', 'data-name': e.name,
        title: `${e.name}\n${e.dir ? 'Folder' : App.fmtSize(e.size)} · modified ${App.fmtAgo(e.mtime)}`,
        onclick: () => { s.sel = e.name; render(side); },
        ondblclick: () => openEntry(side, e),
        oncontextmenu: (ev) => { ev.preventDefault(); s.sel = e.name; render(side); App.menu(ev.clientX, ev.clientY, itemMenu(side, e, full)); },
        ondragstart: (ev) => { ev.dataTransfer.setData('codeome/' + side, JSON.stringify({ path: full, dir: e.dir })); ev.dataTransfer.effectAllowed = 'copy'; }
      }, h('span', { html: e.dir ? App.icons.folder : App.icons.file }), h('span.nm', e.name), h('span.sz', e.dir ? '' : App.fmtSize(e.size)));
      p.list.append(row);
    }
  }

  function openEntry(side, e) {
    const full = App.join(F[side].dir, e.name);
    if (e.dir) return F.go(side, full);
    const ed = App.views.editor;
    if (ed.isBinary(full) && ed.isPreviewable(full)) return ed.preview(full, { remote: side === 'remote' });
    if (ed.isBinary(full)) return side === 'local' ? codeome.shell.openPath(full) : App.toast('Download it to open ' + e.name + ' on your Mac.');
    ed.openFile(full, { remote: side === 'remote' });
  }

  function itemMenu(side, e, full) {
    const remote = side === 'remote';
    const other = remote ? F.local.dir : F.remote.dir;
    const ed = App.views.editor;
    const isScript = /\.(sh|slurm|sbatch|job)$/i.test(e.name);
    return [
      !e.dir ? { label: 'Open', run: () => openEntry(side, e) } : { label: 'Open folder', run: () => F.go(side, full) },
      !e.dir && ed.isPreviewable(full) ? { label: 'Preview', run: () => ed.preview(full, { remote }) } : null,
      remote && isScript ? { label: 'Submit to Slurm', run: () => App.views.slurm.submit(full) } : null,
      '-',
      remote ? { label: other ? `Download to ${App.basename(other)}` : 'Download', disabled: !other, run: () => F.transfer('down', full, F.local.dir) }
        : { label: other ? `Upload to HPC: ${App.basename(other)}` : 'Upload to HPC', disabled: !other || !App.hpcConnected, run: () => F.transfer('up', full, F.remote.dir) },
      e.dir ? { label: 'Terminal here', run: () => remote ? App.views.terminals.hpcShell(full) : App.views.terminals.localShell(full) } : null,
      ...(e.dir ? App.cfg.agents.map((a) => ({ label: `${a.name} here`, run: () => remote ? App.views.terminals.agentHpc(a, full) : App.views.terminals.agentLocal(a, full) })) : []),
      '-',
      { label: 'Copy path', run: () => navigator.clipboard.writeText(full) },
      !remote ? { label: 'Reveal in Finder', run: () => codeome.shell.reveal(full) } : null,
      remote && e.dir ? { label: 'Folder size', run: async () => { App.toast('Measuring ' + e.name + '…'); const r = await codeome.remote.du(full); App.toast(`${e.name}: ${r.size || 'unknown'}`); } } : null,
      { label: 'Rename…', run: () => rename(side, full) },
      remote ? { label: 'Delete…', danger: true, run: () => del(side, full, e) } : { label: 'Move to Trash', danger: true, run: () => del(side, full, e) }
    ];
  }

  function folderMenu(side) {
    const remote = side === 'remote';
    const dir = F[side].dir;
    return [
      { label: 'New file…', disabled: !dir, run: () => newItem(side, false) },
      { label: 'New folder…', disabled: !dir, run: () => newItem(side, true) },
      remote ? { label: 'Upload files from Mac…', disabled: !dir, run: async () => { const fs = await codeome.dialog.files({ defaultPath: F.local.dir }); fs.forEach((f) => F.transfer('up', f, dir)); } } : { label: 'Open another folder…', run: () => App.openProject() },
      '-',
      { label: 'Terminal here', disabled: !dir, run: () => remote ? App.views.terminals.hpcShell(dir) : App.views.terminals.localShell(dir) },
      ...App.cfg.agents.map((a) => ({ label: `${a.name} here`, disabled: !dir, run: () => remote ? App.views.terminals.agentHpc(a, dir) : App.views.terminals.agentLocal(a, dir) })),
      remote ? '-' : null,
      remote ? { label: 'Storage quota', run: async () => { const r = await codeome.hpc.quota(); App.modal({ title: 'Storage on ' + App.cfg.hpc.host, body: h('pre.logbox', r.text || 'No quota information.'), cancel: null }); } } : null,
      remote && dir ? { label: 'Set as HPC start folder', run: () => { App.cfg.hpc.remoteRoot = dir; App.saveConfig(); App.toast('HPC start folder set.'); } } : null,
      '-',
      { label: (App.cfg.showHidden ? 'Hide' : 'Show') + ' hidden files', run: () => { App.cfg.showHidden = !App.cfg.showHidden; App.saveConfig(); F.refresh('local'); F.refresh('remote'); } }
    ];
  }

  async function newItem(side, folder) {
    const name = await App.prompt(folder ? 'New folder' : 'New file', 'Name', '', { ok: 'Create' });
    if (!name) return;
    const p = App.join(F[side].dir, name);
    const api = side === 'remote' ? codeome.remote : codeome.local;
    const r = folder ? await api.mkdir(p) : await api.write(p, '');
    if (r.error) return App.err(r.error);
    F.refresh(side);
    if (!folder) App.views.editor.openFile(p, { remote: side === 'remote' });
  }

  async function rename(side, full) {
    const name = await App.prompt('Rename', 'New name', App.basename(full), { ok: 'Rename' });
    if (!name || name === App.basename(full)) return;
    const api = side === 'remote' ? codeome.remote : codeome.local;
    const r = await api.rename(full, App.join(App.dirname(full), name));
    if (r.error) return App.err(r.error);
    F.refresh(side);
  }

  async function del(side, full, e) {
    if (side === 'remote') {
      const ok = await App.confirm(`Delete ${e.name} on the HPC?`, `${e.dir ? 'This folder and everything in it' : 'This file'} will be permanently deleted from ${App.cfg.hpc.host}. This can't be undone.`, 'Delete permanently', true);
      if (!ok) return;
      const r = await codeome.remote.delete(full); if (r.error) return App.err(r.error);
    } else {
      const r = await codeome.local.trash(full); if (r.error) return App.err(r.error);
      App.toast(`Moved ${e.name} to the Trash.`);
    }
    F.refresh(side);
  }

  // ---------- transfers ----------
  F.transfer = async (direction, src, destDir) => {
    if (direction === 'up' && !App.requireHpc()) return;
    if (!destDir) return App.toast('Open a destination folder first.');
    const r = await codeome.transfer.start({ direction, src, destDir });
    const label = `${direction === 'up' ? 'Uploading' : 'Downloading'} ${App.basename(src)}`;
    const bar = h('i'); const meta = h('span.hint', ' starting…');
    const el = h('div.tx', h('div.row', h('span.grow', label, meta), App.iconBtn('trash', 'Cancel transfer', () => codeome.transfer.cancel(r.id))), h('div.bar', bar));
    F.transfers.set(r.id, { el, bar, meta, direction, destDir, label });
    F.txEl.hidden = false; F.txEl.prepend(el);
  };
  function onProgress({ id, pct, rate }) { const t = F.transfers.get(id); if (!t) return; t.bar.style.width = pct + '%'; t.meta.textContent = ` ${pct}%${rate ? ' · ' + rate : ''}`; }
  function onDone({ id, code, error }) {
    const t = F.transfers.get(id); if (!t) return;
    if (code === 0) {
      t.bar.style.width = '100%'; t.meta.textContent = ' done';
      if ((t.direction === 'up' && F.remote.dir === t.destDir) || (t.direction === 'down' && F.local.dir === t.destDir)) F.refresh(t.direction === 'up' ? 'remote' : 'local');
      setTimeout(() => { t.el.remove(); F.transfers.delete(id); if (!F.txEl.children.length) F.txEl.hidden = true; }, 4000);
    } else { t.el.classList.add('err'); t.meta.textContent = ' failed: ' + (error || 'rsync exited with ' + code); }
  }
})();
