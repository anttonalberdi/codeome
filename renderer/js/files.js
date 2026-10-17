// Files view: three stacked sections — this Mac, the HPC and the long-term storage
// (SFTP, e.g. ERDA) — with transfers at the bottom. Each section can be renamed,
// collapsed to its header, and resized by dragging the line between two sections.
// Drag between sections (or use the context menu) to copy; the copies go to the
// queue of the Transfer view (transfer.js), which the button at the bottom opens.
(function () {
  const h = App.h;
  const SIDES = ['local', 'remote', 'storage'];
  const DEFAULT_TITLE = { local: 'This Mac', remote: 'HPC', storage: 'ERDA' };
  const F = { panes: {} };
  for (const s of SIDES) F[s] = { dir: null, entries: [], sel: null };
  App.views.files = F;
  let root;

  const api = (side) => ({ local: codeome.local, remote: codeome.remote, storage: codeome.storage })[side];
  const host = (side) => (side === 'remote' ? App.cfg.hpc.host : side === 'storage' ? App.cfg.storage.host : 'this Mac');
  // Layout and names live in App.cfg.ui.panes[side]: { title, collapsed, weight } (see stack.js).
  F.title = (side) => (F.stack ? F.stack.title(side) : (App.cfg.ui.panes || {})[side]?.title || DEFAULT_TITLE[side]);
  F.isUp = (side) => side === 'local' || (side === 'remote' ? App.hpcConnected : App.storageConnected);
  F.startDir = (side) => (side === 'local' ? (App.project || '~') : side === 'remote' ? (App.cfg.hpc.remoteRoot || '~') : (App.cfg.storage.root || '.'));
  const where = (side) => ({ remote: side === 'remote', storage: side === 'storage' });

  F.init = () => {
    root = document.querySelector('.view[data-view="files"]');
    root.innerHTML = '';
    root.classList.add('files-view');
    const sections = SIDES.map((side) => { F.panes[side] = pane(side); return F.panes[side].section; });
    F.stack = App.stack({ key: 'panes', sections });
    for (const side of SIDES) Object.assign(F.panes[side], F.stack.panes[side]);
    const X = App.views.transfer;
    F.tx = X.queueList({ compact: true });
    F.txEl = h('div.transfers', { hidden: true }, F.tx.el);
    const sum = h('span.hint.grow');
    root.append(F.stack.el, F.txEl, h('div.files-foot',
      h('button.btn.ghost.small', { title: 'Two panes side by side, with the transfer queue (⌘8)', onclick: () => X.open() }, h('span', { html: App.icons.swap }), 'Transfer view'), sum));
    App.listen('transfers', (queue) => { F.txEl.hidden = !F.tx.count(); sum.textContent = X.summary(queue); });
    App.listen('transferred', (t) => { if (F[t.to].dir === t.destDir) F.refresh(t.to); });
    App.listen('local-changed', () => F.refresh('local'));
    App.listen('remote-changed', () => F.refresh('remote'));
    // Pick up changes made outside the UI (agents, scripts) without a manual refresh.
    for (const [side, every] of [['local', 2000], ['remote', 15000]]) setInterval(() => F.poll(side), every);
    for (const [ev, side] of [['hpc', 'remote'], ['storage', 'storage']]) {
      App.listen(ev, (up) => { if (up) { paintDot(side); F.go(side, F[side].dir || F.startDir(side)); } else renderState(side); });
    }
    App.listen('project', (dir) => { clearSearch(); if (!App.isIdeas(dir)) F.go('local', dir); });
    App.listen('config', () => { F.stack.retitle(); renderState('remote'); renderState('storage'); });
    renderState('remote'); renderState('storage');
  };

  function clearSearch() {
    const b = F.panes.local?.searchBox;
    if (b && b.value) { b.value = ''; b.nextSibling.hidden = true; F.search(''); }
  }

  function pane(side) {
    const pathInput = h('input', { type: 'text', spellcheck: 'false', 'aria-label': F.title(side) + ' folder',
      onkeydown: (e) => { if (e.key === 'Enter') { clearSearch(); F.go(side, pathInput.value.trim()); } } });
    let searchBox = null, searchClear = null;
    if (side === 'local') {
      let timer = 0;
      searchBox = h('input', { type: 'text', placeholder: 'Search files in project…', spellcheck: 'false', 'aria-label': 'Search files in the project',
        oninput: () => { clearTimeout(timer); searchClear.hidden = !searchBox.value; timer = setTimeout(() => F.search(searchBox.value), 250); },
        onkeydown: (e) => { if (e.key === 'Escape') { searchBox.value = ''; searchClear.hidden = true; F.search(''); } } });
      searchClear = App.iconBtn('close', 'Clear search', () => { searchBox.value = ''; searchClear.hidden = true; F.search(''); searchBox.focus(); });
      searchClear.hidden = true;
    }
    const list = h('div.flist', { tabindex: '0', role: 'listbox', 'aria-label': F.title(side) + ' files' });
    const dot = side === 'local' ? null : h('i.pane-dot');
    const section = {
      id: side, title: DEFAULT_TITLE[side], dot,
      tools: [
        App.iconBtn('up', 'Parent folder', () => F.go(side, App.dirname(F[side].dir || '/'))),
        App.iconBtn('home', side === 'local' ? 'Project folder' : 'Start folder', () => F.go(side, F.startDir(side))),
        App.iconBtn('refresh', 'Refresh', () => F.refresh(side))],
      menu: () => folderMenu(side), items: () => sectionItems(side),
      body: [h('div.pathbar', pathInput), searchBox ? h('div.pathbar.searchbar', searchBox, searchClear) : null, list].filter(Boolean),
      onExpand: () => { if (F.isUp(side) && !F[side].dir) F.go(side, F.startDir(side)); }
    };

    // Drop target: dragging from another section copies into this folder (or onto a sub-folder).
    const sourceOf = (dt) => SIDES.find((s) => s !== side && dt.types.includes('codeome/' + s));
    list.addEventListener('dragover', (e) => {
      if (!sourceOf(e.dataTransfer) && !(side !== 'local' && e.dataTransfer.types.includes('Files'))) return;
      e.preventDefault(); list.classList.add('dropping');
    });
    list.addEventListener('dragleave', (e) => { if (!list.contains(e.relatedTarget)) list.classList.remove('dropping'); });
    list.addEventListener('drop', (e) => {
      list.classList.remove('dropping'); e.preventDefault();
      const target = e.target.closest('.fitem.dir');
      const dest = target ? App.join(F[side].dir, target.dataset.name) : F[side].dir;
      const from = sourceOf(e.dataTransfer);
      if (from) { const item = JSON.parse(e.dataTransfer.getData('codeome/' + from)); F.transfer(from, item.path, side, dest); return; }
      // Files dragged in from Finder go straight up.
      if (side !== 'local') for (const f of e.dataTransfer.files) { const fp = codeome.pathForFile(f); if (fp) F.transfer('local', fp, side, dest); }
    });
    list.addEventListener('keydown', (e) => keyNav(side, e));
    return { section, list, pathInput, dot, searchBox };
  }

  // ---------- sections ----------
  F.toggle = (side, open) => F.stack.toggle(side, open);
  F.solo = (side) => F.stack.solo(side);
  F.rename = (side) => F.stack.rename(side);
  // Open a folder from elsewhere in the app, expanding its section.
  F.show = (side, dir) => { App.setView('files'); F.stack.expand(side); F.go(side, dir); };

  // Extra items for a section's header menu (after rename / collapse / show only).
  function sectionItems(side) {
    return [
      side === 'remote' && App.hpcConnected ? { label: 'Disconnect', run: () => App.disconnectHpc() } : null,
      side === 'storage' && App.storageConnected ? { label: 'Disconnect', run: () => App.disconnectStorage() } : null,
      side === 'storage' ? { label: 'Storage settings…', run: () => App.views.settings.open('storage') } : null
    ];
  }

  // ---------- browsing ----------
  function keyNav(side, e) {
    const s = F[side]; const items = s.entries; if (!items.length) return;
    let i = items.findIndex((x) => x.name === s.sel);
    if (e.key === 'ArrowDown') i = Math.min(items.length - 1, i + 1);
    else if (e.key === 'ArrowUp') i = Math.max(0, i - 1);
    else if (e.key === 'Enter' && i >= 0) return openEntry(side, items[i]);
    else if (e.key === 'Backspace' && e.metaKey) return F.go(side, App.dirname(s.dir));
    else return;
    e.preventDefault(); s.sel = items[i].name; render(side);
    F.panes[side].list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }

  F.go = async (side, dir) => {
    if (!dir) return;
    const p = F.panes[side];
    if (!F.isUp(side)) { renderState(side); return; }
    p.list.innerHTML = '';
    p.list.append(h('div.empty', h('span.spinner'), ' Loading…'));
    const r = await api(side).list(dir);
    if (r.error) { p.list.innerHTML = ''; p.list.append(h('div.empty', r.error)); return; }
    F[side].dir = r.cwd; F[side].entries = r.entries.filter((x) => App.cfg.showHidden || !x.name.startsWith('.'));
    F[side].sel = null;
    if (side === 'remote') { App.remoteDir = r.cwd; App.emit('remote-dir', r.cwd); }
    p.pathInput.value = r.cwd;
    render(side);
  };
  const polling = {};
  F.poll = async (side) => {
    const s = F[side];
    if (document.hidden || !s.dir || polling[side] || !F.isUp(side)) return;
    polling[side] = true;
    try {
      const dir = s.dir, r = await api(side).list(dir);
      if (r.error || s.dir !== dir) return;
      const next = r.entries.filter((x) => App.cfg.showHidden || !x.name.startsWith('.'));
      const sig = (a) => JSON.stringify(a);
      if (sig(next) === sig(s.entries)) return;
      s.entries = next;
      if (s.sel && !next.some((x) => x.name === s.sel)) s.sel = null;
      render(side);
    } catch {} finally { polling[side] = false; }
  };
  // Search the project (local pane only): results replace the folder listing until cleared.
  let searchSeq = 0;
  F.search = async (query) => {
    const p = F.panes.local; const q = query.trim(); const seq = ++searchSeq;
    if (!q) { F.local.searching = false; render('local'); return; }
    const root = App.project || F.local.dir;
    if (!root) return;
    F.local.searching = true;
    p.list.innerHTML = '';
    p.list.append(h('div.empty', h('span.spinner'), ' Searching…'));
    const r = await codeome.local.search(root, q);
    if (seq !== searchSeq) return;
    p.list.innerHTML = '';
    const res = (r.results || []).filter((x) => App.cfg.showHidden || !x.rel.split('/').some((n) => n.startsWith('.')));
    if (!res.length) { p.list.append(h('div.empty', `No files match “${q}”.`)); return; }
    for (const x of res) {
      const name = App.basename(x.path), parent = App.dirname(x.rel);
      p.list.append(h('div.fitem' + (x.dir ? '.dir' : ''), {
        role: 'option', title: x.rel,
        ondblclick: () => { if (x.dir) { p.searchBox.value = ''; F.search(''); F.go('local', x.path); } else openEntry('local', { name, dir: false }, x.path); },
        oncontextmenu: (ev) => { ev.preventDefault(); App.menu(ev.clientX, ev.clientY, itemMenu('local', { name, dir: x.dir, size: 0, mtime: 0 }, x.path)); }
      }, h('span', { html: x.dir ? App.icons.folder : App.icons.file }), h('span.nm', name), h('span.sz', parent && parent !== '.' ? parent : '')));
    }
    if (r.truncated) p.list.append(h('div.empty', 'Showing the first matches — refine the search.'));
  };
  F.refresh = (side) => F[side].dir && F.go(side, F[side].dir);
  // How to name a local path to the agent: relative to the project when inside it.
  F.relRef = (p) => (App.project && p === App.project ? 'the project root' : App.project && p.startsWith(App.project + '/') ? p.slice(App.project.length + 1) : App.tildify(p));

  function paintDot(side) {
    const p = F.panes[side];
    p.dot.className = 'pane-dot ' + (F.isUp(side) ? 'ok' : host(side) ? 'bad' : '');
    p.dot.title = F.isUp(side) ? 'Connected to ' + host(side) : host(side) ? 'Not connected' : 'Not set up';
  }
  // What a remote host shows while it can't list anything: how to set it up, or connect.
  F.stateNote = (side) => {
    if (side === 'remote') {
      if (!App.cfg.hpc.host) return h('div.empty', 'Add your cluster login in Settings to browse HPC files.', h('br'), h('button.btn.small', { onclick: () => App.views.settings.open('hpc') }, 'Open Settings'));
      return h('div.empty', `Not connected to ${App.hpcName()}. Make sure the VPN is on, then connect.`, h('br'), h('button.btn.small.primary', { onclick: () => App.connectHpc() }, 'Connect'));
    }
    if (!App.cfg.storage.host) return h('div.empty', `Add an SFTP login (for example ERDA, io.erda.dk) in Settings to browse ${F.title(side)} here.`, h('br'), h('button.btn.small', { onclick: () => App.views.settings.open('storage') }, 'Set up storage'));
    return h('div.empty', `Not connected to ${App.cfg.storage.host}.`, h('br'), h('button.btn.small.primary', { onclick: () => App.connectStorage() }, 'Connect'));
  };
  function renderState(side) {
    const p = F.panes[side]; if (!p || side === 'local') return;
    paintDot(side);
    if (F.isUp(side)) return;
    p.list.innerHTML = '';
    p.list.append(F.stateNote(side));
  }

  function render(side) {
    const s = F[side]; const p = F.panes[side];
    if (side === 'local' && s.searching && p.searchBox?.value.trim()) return;
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

  async function openEntry(side, e, path) {
    const full = path || App.join(F[side].dir, e.name);
    if (e.dir) return F.go(side, full);
    // A link on a server may point at a folder.
    if (e.link && side !== 'local' && !(await api(side).list(full)).error) return F.go(side, full);
    const ed = App.views.editor;
    if (ed.isBinary(full) && ed.isPreviewable(full)) return ed.preview(full, where(side));
    if (ed.isBinary(full)) return side === 'local' ? codeome.shell.openPath(full) : App.toast('Download it to open ' + e.name + ' on your Mac.');
    ed.openFile(full, where(side));
  }

  // "Upload to HPC: data", "Download to This Mac: proj", "Copy to ERDA: archive"
  function copyItems(side, full) {
    return SIDES.filter((o) => o !== side && (o === 'local' || host(o))).map((o) => {
      const d = F[o].dir;
      const verb = o === 'local' ? 'Download to' : side === 'local' ? 'Upload to' : 'Copy to';
      return { label: `${verb} ${F.title(o)}${d ? ': ' + App.basename(d) : ''}`, disabled: !d || !F.isUp(o) || !F.isUp(side), run: () => F.transfer(side, full, o, d) };
    });
  }

  function itemMenu(side, e, full) {
    const remote = side === 'remote', local = side === 'local';
    const ed = App.views.editor;
    const isScript = /\.(sh|slurm|sbatch|job)$/i.test(e.name);
    return [
      !e.dir ? { label: 'Open', run: () => openEntry(side, e) } : { label: 'Open folder', run: () => F.go(side, full) },
      !e.dir && ed.isPreviewable(full) ? { label: 'Preview', run: () => ed.preview(full, where(side)) } : null,
      remote && isScript ? { label: 'Submit to Slurm', run: () => App.views.slurm.submit(full) } : null,
      '-',
      ...copyItems(side, full),
      e.dir && side !== 'storage' ? { label: 'Terminal here', run: () => remote ? App.views.terminals.hpcShell(full) : App.views.terminals.localShell(full) } : null,
      e.dir && side !== 'storage' ? { label: 'R console here', run: () => App.views.terminals.rConsole({ remote, cwd: full }) } : null,
      ...(e.dir && remote ? App.cfg.agents.map((a) => ({ label: `${a.name} here`, run: () => App.views.terminals.agentHpc(a, full) })) : []),
      e.dir && local ? { label: 'Ask the agent about this folder', run: () => App.views.chat.ask(`About ${F.relRef(full)}: `) } : null,
      '-',
      { label: 'Copy path', run: () => navigator.clipboard.writeText(full) },
      local ? { label: 'Reveal in Finder', run: () => codeome.shell.reveal(full) } : null,
      remote && e.dir ? { label: 'Folder size', run: async () => { App.toast('Measuring ' + e.name + '…'); const r = await codeome.remote.du(full); App.toast(`${e.name}: ${r.size || 'unknown'}`); } } : null,
      { label: 'Rename…', run: () => renameItem(side, full) },
      local ? { label: 'Move to Trash', danger: true, run: () => del(side, full, e) } : { label: 'Delete…', danger: true, run: () => del(side, full, e) }
    ];
  }

  function folderMenu(side) {
    const remote = side === 'remote', local = side === 'local';
    const dir = F[side].dir;
    return [
      { label: 'New file…', disabled: !dir, run: () => newItem(side, false) },
      { label: 'New folder…', disabled: !dir, run: () => newItem(side, true) },
      local ? { label: 'Open another project…', run: () => App.openProject() }
        : { label: 'Upload files from Mac…', disabled: !dir, run: async () => { const fs = await codeome.dialog.files({ defaultPath: F.local.dir }); fs.forEach((f) => F.transfer('local', f, side, dir)); } },
      '-',
      side !== 'storage' ? { label: 'Terminal here', disabled: !dir, run: () => remote ? App.views.terminals.hpcShell(dir) : App.views.terminals.localShell(dir) } : null,
      side !== 'storage' ? { label: 'R console here', disabled: !dir, run: () => App.views.terminals.rConsole({ remote, cwd: dir }) } : null,
      ...(remote ? App.cfg.agents.map((a) => ({ label: `${a.name} here`, disabled: !dir, run: () => App.views.terminals.agentHpc(a, dir) })) : []),
      local ? { label: 'Ask the agent about this folder', disabled: !dir, run: () => App.views.chat.ask(`About ${F.relRef(dir)}: `) } : null,
      remote ? { label: 'Storage quota', run: async () => { const r = await codeome.hpc.quota(); App.modal({ title: 'Storage on ' + App.hpcName(), body: h('pre.logbox', r.text || 'No quota information.'), cancel: null }); } } : null,
      remote && dir ? { label: 'Set as HPC start folder', run: () => { App.cfg.hpc.remoteRoot = dir; App.saveConfig(); App.toast('HPC start folder set.'); } } : null,
      side === 'storage' && dir ? { label: `Set as ${F.title(side)} start folder`, run: () => { App.cfg.storage.root = dir; App.saveConfig(); App.toast('Start folder set.'); } } : null,
      { label: 'Open in the Transfer view', disabled: !dir, run: () => App.views.transfer.open({ host: side, dir }) },
      { label: (App.cfg.showHidden ? 'Hide' : 'Show') + ' hidden files', run: () => { App.cfg.showHidden = !App.cfg.showHidden; App.saveConfig(); SIDES.forEach(F.refresh); } },
      '-',
      ...F.stack.items(side)
    ];
  }

  async function newItem(side, folder) {
    const name = await App.prompt(folder ? 'New folder' : 'New file', 'Name', '', { ok: 'Create' });
    if (!name) return;
    const p = App.join(F[side].dir, name);
    const r = folder ? await api(side).mkdir(p) : await api(side).write(p, '');
    if (r.error) return App.err(r.error);
    F.refresh(side);
    if (!folder) App.views.editor.openFile(p, where(side));
  }

  async function renameItem(side, full) {
    const name = await App.prompt('Rename', 'New name', App.basename(full), { ok: 'Rename' });
    if (!name || name === App.basename(full)) return;
    const r = await api(side).rename(full, App.join(App.dirname(full), name));
    if (r.error) return App.err(r.error);
    F.refresh(side);
  }

  async function del(side, full, e) {
    if (side === 'local') {
      const r = await codeome.local.trash(full); if (r.error) return App.err(r.error);
      App.toast(`Moved ${e.name} to the Trash.`);
    } else {
      const ok = await App.confirm(`Delete ${e.name} on ${F.title(side)}?`, `${e.dir ? 'This folder and everything in it' : 'This file'} will be permanently deleted from ${host(side)}. This can't be undone.`, 'Delete permanently', true);
      if (!ok) return;
      const r = side === 'remote' ? await codeome.remote.delete(full) : await codeome.storage.delete(full, e.dir);
      if (r.error) return App.err(r.error);
    }
    F.refresh(side);
  }

  // ---------- transfers ----------
  // Copies join the queue of the Transfer view, which runs them a few at a time.
  F.transfer = (from, src, to, destDir) => App.views.transfer.enqueue(from, [{ path: src, dir: (F[from].entries.find((e) => App.join(F[from].dir, e.name) === src) || {}).dir }], to, destDir);
})();
