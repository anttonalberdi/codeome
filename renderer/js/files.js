// Files view: three stacked sections — this Mac, the HPC and the long-term storage
// (SFTP, e.g. ERDA) — with transfers at the bottom. Each section can be renamed,
// collapsed to its header, and resized by dragging the line between two sections.
// Drag between sections (or use the context menu) to copy.
(function () {
  const h = App.h;
  const SIDES = ['local', 'remote', 'storage'];
  const DEFAULT_TITLE = { local: 'This Mac', remote: 'HPC', storage: 'ERDA' };
  const F = { transfers: new Map(), panes: {} };
  for (const s of SIDES) F[s] = { dir: null, entries: [], sel: null };
  App.views.files = F;
  let root;

  const CHEVRON = '<svg viewBox="0 0 16 16"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
  const api = (side) => ({ local: codeome.local, remote: codeome.remote, storage: codeome.storage })[side];
  const host = (side) => (side === 'remote' ? App.cfg.hpc.host : side === 'storage' ? App.cfg.storage.host : 'this Mac');
  // Layout and names live in App.cfg.ui.panes[side]: { title, collapsed, weight }.
  const paneCfg = (side) => { const p = (App.cfg.ui.panes = App.cfg.ui.panes || {}); return (p[side] = p[side] || {}); };
  F.title = (side) => paneCfg(side).title || DEFAULT_TITLE[side];
  F.isUp = (side) => side === 'local' || (side === 'remote' ? App.hpcConnected : App.storageConnected);
  F.startDir = (side) => (side === 'local' ? (App.project || '~') : side === 'remote' ? (App.cfg.hpc.remoteRoot || '~') : (App.cfg.storage.root || '.'));
  const where = (side) => ({ remote: side === 'remote', storage: side === 'storage' });

  F.init = () => {
    root = document.querySelector('.view[data-view="files"]');
    root.innerHTML = '';
    root.classList.add('files-view');
    F.stack = h('div.pane-stack');
    SIDES.forEach((side, i) => {
      if (i) F.stack.append(resizer(i));
      F.panes[side] = pane(side);
      F.stack.append(F.panes[side].el);
    });
    F.txEl = h('div.transfers', { hidden: true });
    root.append(F.stack, F.txEl);
    layout();
    codeome.transfer.onProgress(onProgress);
    codeome.transfer.onDone(onDone);
    App.listen('local-changed', () => F.refresh('local'));
    App.listen('remote-changed', () => F.refresh('remote'));
    for (const [ev, side] of [['hpc', 'remote'], ['storage', 'storage']]) {
      App.listen(ev, (up) => { if (up) { paintDot(side); F.go(side, F[side].dir || F.startDir(side)); } else renderState(side); });
    }
    App.listen('project', (dir) => F.go('local', dir));
    App.listen('config', () => { for (const s of SIDES) F.panes[s].titleEl.textContent = F.title(s); renderState('remote'); renderState('storage'); });
    renderState('remote'); renderState('storage');
  };

  function pane(side) {
    const pathInput = h('input', { type: 'text', spellcheck: 'false', 'aria-label': F.title(side) + ' folder',
      onkeydown: (e) => { if (e.key === 'Enter') F.go(side, pathInput.value.trim()); } });
    const list = h('div.flist', { tabindex: '0', role: 'listbox', 'aria-label': F.title(side) + ' files' });
    const titleEl = h('span.pane-title', F.title(side));
    const dot = side === 'local' ? null : h('i.pane-dot');
    const toggle = h('button.pane-toggle', { title: 'Collapse or expand (right-click to rename)', onclick: () => F.toggle(side) },
      h('span.chev', { html: CHEVRON }), titleEl, dot);
    const tools = h('div.pane-tools',
      App.iconBtn('up', 'Parent folder', () => F.go(side, App.dirname(F[side].dir || '/'))),
      App.iconBtn('home', side === 'local' ? 'Project folder' : 'Start folder', () => F.go(side, F.startDir(side))),
      App.iconBtn('refresh', 'Refresh', () => F.refresh(side)));
    const head = h('div.side-head.pane-head', { oncontextmenu: (e) => { e.preventDefault(); App.menu(e.clientX, e.clientY, sectionItems(side)); } },
      toggle, tools, App.iconBtn('dots', 'More', (e) => App.menuAt(e.currentTarget, folderMenu(side))));
    const body = h('div.pane-body', h('div.pathbar', pathInput), list);
    const el = h('div.side-section.split-pane', { 'data-side': side }, head, body);

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
    return { el, head, body, list, pathInput, titleEl, toggle, tools, dot };
  }

  // ---------- section layout ----------
  function layout() {
    for (const side of SIDES) {
      const p = F.panes[side], c = paneCfg(side);
      p.el.classList.toggle('collapsed', !!c.collapsed);
      p.body.hidden = p.tools.hidden = !!c.collapsed;
      p.toggle.setAttribute('aria-expanded', String(!c.collapsed));
      p.el.style.flex = c.collapsed ? '0 0 auto' : `${c.weight || 1} 1 0px`;
    }
    // A handle only works with an open section on both sides of it.
    F.stack.querySelectorAll('.pane-resizer').forEach((rz) => {
      const i = Number(rz.dataset.i);
      rz.classList.toggle('inert', !neighbour(i, -1) || !neighbour(i, 1));
    });
  }
  // The nearest open section above (dir -1) or below (dir 1) the handle in front of SIDES[i].
  function neighbour(i, dir) {
    for (let j = dir < 0 ? i - 1 : i; j >= 0 && j < SIDES.length; j += dir) if (!paneCfg(SIDES[j]).collapsed) return SIDES[j];
    return null;
  }

  function resizer(i) {
    const rz = h('div.pane-resizer', { 'data-i': i, role: 'separator', 'aria-orientation': 'horizontal', title: 'Drag to resize · double-click to even out' });
    rz.addEventListener('mousedown', (e) => {
      const a = neighbour(i, -1), b = neighbour(i, 1);
      if (!a || !b) return;
      e.preventDefault();
      const ha = F.panes[a].el.getBoundingClientRect().height, hb = F.panes[b].el.getBoundingClientRect().height;
      const w = (paneCfg(a).weight || 1) + (paneCfg(b).weight || 1), total = ha + hb, min = 64, y0 = e.clientY;
      document.body.classList.add('row-resizing');
      const move = (ev) => {
        const na = Math.max(min, Math.min(total - min, ha + ev.clientY - y0));
        paneCfg(a).weight = w * na / total; paneCfg(b).weight = w * (total - na) / total;
        layout();
      };
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); document.body.classList.remove('row-resizing'); App.saveConfig(); };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    });
    rz.addEventListener('dblclick', () => { for (const s of SIDES) delete paneCfg(s).weight; layout(); App.saveConfig(); });
    return rz;
  }

  F.toggle = (side, open) => {
    const c = paneCfg(side);
    c.collapsed = open === undefined ? !c.collapsed : !open;
    layout(); App.saveConfig();
    if (!c.collapsed && F.isUp(side) && !F[side].dir) F.go(side, F.startDir(side));
  };
  // Only this section open (or all of them again).
  F.solo = (side) => {
    const others = SIDES.filter((s) => s !== side);
    const soloed = !paneCfg(side).collapsed && others.every((s) => paneCfg(s).collapsed);
    for (const s of others) paneCfg(s).collapsed = !soloed;
    F.toggle(side, true);
    if (soloed) for (const s of others) if (F.isUp(s) && !F[s].dir) F.go(s, F.startDir(s));
  };
  // Open a folder from elsewhere in the app, expanding its section.
  F.show = (side, dir) => { App.setView('files'); if (paneCfg(side).collapsed) { paneCfg(side).collapsed = false; layout(); App.saveConfig(); } F.go(side, dir); };

  F.rename = (side) => {
    const p = F.panes[side];
    if (p.head.querySelector('.pane-rename')) return;
    if (paneCfg(side).collapsed) F.toggle(side, true);
    const input = h('input.pane-rename', { type: 'text', value: F.title(side), maxlength: '40', spellcheck: 'false', 'aria-label': 'Section name', placeholder: DEFAULT_TITLE[side] });
    p.toggle.hidden = true; p.head.prepend(input);
    input.focus(); input.select();
    const done = (save) => {
      if (!input.isConnected) return;
      const v = input.value.trim();
      input.remove(); p.toggle.hidden = false; p.toggle.focus();
      if (!save) return;
      const c = paneCfg(side);
      if (!v || v === DEFAULT_TITLE[side]) delete c.title; else c.title = v;
      p.titleEl.textContent = F.title(side);
      App.saveConfig();
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
    };
    input.onblur = () => done(true);
  };

  function sectionItems(side) {
    const c = paneCfg(side);
    return [
      { label: 'Rename section…', run: () => F.rename(side) },
      { label: c.collapsed ? 'Expand section' : 'Collapse section', run: () => F.toggle(side) },
      { label: SIDES.every((s) => s === side || paneCfg(s).collapsed) && !c.collapsed ? 'Show all sections' : 'Show only this section', run: () => F.solo(side) },
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
    if (side === 'remote') App.remoteDir = r.cwd;
    p.pathInput.value = r.cwd;
    render(side);
  };
  F.refresh = (side) => F[side].dir && F.go(side, F[side].dir);
  // How to name a local path to the agent: relative to the project when inside it.
  F.relRef = (p) => (App.project && p === App.project ? 'the project root' : App.project && p.startsWith(App.project + '/') ? p.slice(App.project.length + 1) : App.tildify(p));

  function paintDot(side) {
    const p = F.panes[side];
    p.dot.className = 'pane-dot ' + (F.isUp(side) ? 'ok' : host(side) ? 'bad' : '');
    p.dot.title = F.isUp(side) ? 'Connected to ' + host(side) : host(side) ? 'Not connected' : 'Not set up';
  }
  // What a remote section shows while it can't list anything.
  function renderState(side) {
    const p = F.panes[side]; if (!p || side === 'local') return;
    paintDot(side);
    if (F.isUp(side)) return;
    p.list.innerHTML = '';
    const name = F.title(side);
    if (side === 'remote') {
      if (!App.cfg.hpc.host) p.list.append(h('div.empty', 'Add your cluster login in Settings to browse HPC files.', h('br'), h('button.btn.small', { onclick: () => App.views.settings.open('hpc') }, 'Open Settings')));
      else p.list.append(h('div.empty', `Not connected to ${App.cfg.hpc.host}. Make sure the VPN is on, then connect.`, h('br'), h('button.btn.small.primary', { onclick: () => App.connectHpc() }, 'Connect')));
    } else {
      if (!App.cfg.storage.host) p.list.append(h('div.empty', `Add an SFTP login (for example ERDA, io.erda.dk) in Settings to browse ${name} here.`, h('br'), h('button.btn.small', { onclick: () => App.views.settings.open('storage') }, 'Set up storage')));
      else p.list.append(h('div.empty', `Not connected to ${App.cfg.storage.host}.`, h('br'), h('button.btn.small.primary', { onclick: () => App.connectStorage() }, 'Connect')));
    }
  }

  function render(side) {
    const s = F[side]; const p = F.panes[side];
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

  async function openEntry(side, e) {
    const full = App.join(F[side].dir, e.name);
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
      remote ? { label: 'Storage quota', run: async () => { const r = await codeome.hpc.quota(); App.modal({ title: 'Storage on ' + App.cfg.hpc.host, body: h('pre.logbox', r.text || 'No quota information.'), cancel: null }); } } : null,
      remote && dir ? { label: 'Set as HPC start folder', run: () => { App.cfg.hpc.remoteRoot = dir; App.saveConfig(); App.toast('HPC start folder set.'); } } : null,
      side === 'storage' && dir ? { label: `Set as ${F.title(side)} start folder`, run: () => { App.cfg.storage.root = dir; App.saveConfig(); App.toast('Start folder set.'); } } : null,
      { label: (App.cfg.showHidden ? 'Hide' : 'Show') + ' hidden files', run: () => { App.cfg.showHidden = !App.cfg.showHidden; App.saveConfig(); SIDES.forEach(F.refresh); } },
      '-',
      ...sectionItems(side)
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
  const requireSide = (side) => side === 'local' || (side === 'remote' ? App.requireHpc() : App.requireStorage());

  F.transfer = async (from, src, to, destDir) => {
    if (!requireSide(from) || !requireSide(to)) return;
    if (!destDir) return App.toast('Open a destination folder first.');
    // Between the HPC and the storage, the copy runs on the HPC so data doesn't pass through this Mac.
    if ([from, to].includes('remote') && [from, to].includes('storage')) {
      const r = await codeome.storage.hpcCommand(from === 'remote' ? 'up' : 'down', src, destDir);
      if (r.error) return App.err(r.error);
      App.views.terminals.hpcTask(`${App.basename(src)} → ${F.title(to)}`, r.command, from === 'remote' ? App.dirname(src) : destDir);
      return;
    }
    const r = await codeome.transfer.start({ from, to, src, destDir });
    if (r.error) return App.err(r.error);
    const label = `${to === 'local' ? 'Downloading' : 'Uploading'} ${App.basename(src)} → ${F.title(to)}`;
    const bar = h('i'); const meta = h('span.hint', ' starting…');
    const el = h('div.tx', h('div.row', h('span.grow', label, meta), App.iconBtn('trash', 'Cancel transfer', () => codeome.transfer.cancel(r.id))), h('div.bar', bar));
    F.transfers.set(r.id, { el, bar, meta, to, destDir, label });
    F.txEl.hidden = false; F.txEl.prepend(el);
  };
  function onProgress({ id, pct, rate }) { const t = F.transfers.get(id); if (!t) return; t.bar.style.width = pct + '%'; t.meta.textContent = ` ${pct}%${rate ? ' · ' + rate : ''}`; }
  function onDone({ id, code, error }) {
    const t = F.transfers.get(id); if (!t) return;
    if (code === 0) {
      t.bar.style.width = '100%'; t.meta.textContent = ' done';
      if (F[t.to].dir === t.destDir) F.refresh(t.to);
      setTimeout(() => { t.el.remove(); F.transfers.delete(id); if (!F.txEl.children.length) F.txEl.hidden = true; }, 4000);
    } else { t.el.classList.add('err'); t.meta.textContent = ' failed: ' + (error || 'exited with ' + code); }
  }
})();
