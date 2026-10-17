// Transfer view: two file panes side by side, each on this Mac, the HPC or the
// long-term storage, with the transfer queue below. Pick the host of a pane in its
// header; drag between the panes, or select and use the arrows, to queue copies.
// The queue is shared with the Files sidebar and runs a few transfers at a time.
(function () {
  const h = App.h;
  const HOSTS = ['local', 'remote', 'storage'];
  const X = { queue: [], seq: 0, paused: false, panes: {}, lists: [] };
  App.views.transfer = X;
  let root = null;

  const F = () => App.views.files;
  const api = (host) => ({ local: codeome.local, remote: codeome.remote, storage: codeome.storage })[host];
  const title = (host) => F().title(host);
  const isUp = (host) => F().isUp(host);
  const where = (host) => ({ remote: host === 'remote', storage: host === 'storage' });
  // Saved in App.cfg.ui.transfer: { left, right: { host, dirs }, queueH, parallel }.
  const ui = () => (App.cfg.ui.transfer = App.cfg.ui.transfer || {});

  // ---------- queue ----------
  // How a copy between two hosts runs: in the main process (rsync, sftp, cp) or, between
  // the HPC and the storage, as sftp in a terminal on the HPC so the data skips this Mac.
  X.route = (from, to) => {
    const pair = [from, to].sort().join('-');
    if (pair === 'storage-storage') return { error: 'Copying within the storage is not supported: SFTP has no copy.' };
    return { via: pair === 'remote-storage' ? 'terminal' : 'main' };
  };
  // The waiting transfers to start now, oldest first, given how many may run at once.
  X.pick = (queue, max, paused) => {
    const free = paused ? 0 : max - queue.filter((t) => t.status === 'running').length;
    return free > 0 ? queue.filter((t) => t.status === 'queued').slice(0, free) : [];
  };
  // "2 running · 3 waiting · 1 failed"
  X.summary = (queue) => [['running', 'running'], ['queued', 'waiting'], ['failed', 'failed'], ['done', 'done']]
    .map(([s, label]) => [queue.filter((t) => t.status === s).length, label]).filter(([n]) => n).map(([n, label]) => n + ' ' + label).join(' · ');
  X.parallel = () => Math.max(1, Math.min(4, Number(ui().parallel) || 2));

  const newId = () => 'tx' + Date.now().toString(36) + (++X.seq);
  const requireHost = (host) => host === 'local' || (host === 'remote' ? App.requireHpc() : App.requireStorage());

  // Queue copies of items ([{ path, dir, size }] on `from`) into the folder destDir on `to`.
  X.enqueue = (from, items, to, destDir) => {
    if (!requireHost(from) || !requireHost(to)) return [];
    if (!destDir) { App.toast('Open a destination folder first.'); return []; }
    const r = X.route(from, to);
    if (r.error) { App.err(r.error); return []; }
    const added = [];
    for (const it of items) {
      if (from === to && (App.dirname(it.path) === destDir || it.path === destDir || destDir.startsWith(it.path + '/'))) { App.toast(`${App.basename(it.path)} is already in that folder.`); continue; }
      const t = { id: newId(), from, to, src: it.path, destDir, name: App.basename(it.path), dir: !!it.dir, size: it.dir ? null : it.size, status: 'queued', pct: 0, rate: '', error: '' };
      X.queue.push(t); added.push(t);
    }
    pump();
    return added;
  };

  function pump() {
    // Starting one can fail at once and start the next, so check each is still waiting.
    for (const t of X.pick(X.queue, X.parallel(), X.paused)) if (t.status === 'queued') start(t);
    X.changed();
  }

  async function start(t) {
    t.status = 'running'; t.pct = 0; t.rate = ''; t.error = ''; t.term = null;
    const down = [t.from, t.to].find((s) => !isUp(s));
    if (down) return finish(t, 'failed', 'Not connected to ' + title(down));
    if (X.route(t.from, t.to).via === 'terminal') {
      const id = t.id;
      const r = await codeome.storage.hpcCommand(t.from === 'remote' ? 'up' : 'down', t.src, t.destDir);
      if (t.id !== id || t.status !== 'running') return;
      if (r.error) return finish(t, 'failed', r.error);
      const term = await App.views.terminals.open({ kind: 'hpc-transfer', title: `${t.name} → ${title(t.to)}`, command: r.command, cwd: t.from === 'remote' ? App.dirname(t.src) : t.destDir,
        badge: 'HPC', global: true, onExit: (code) => { if (t.id === id) ended(t, code, 'sftp on the HPC exited with ' + code); } });
      if (t.id !== id || t.status !== 'running') { if (term.alive) App.views.terminals.close(term.id); return; }
      if (!term.alive) return finish(t, 'failed', 'Could not start a terminal on the HPC');
      t.term = term.id; X.changed();
      return;
    }
    const id = t.id;
    const r = await codeome.transfer.start({ id, from: t.from, to: t.to, src: t.src, destDir: t.destDir });
    if (r.error && t.id === id) ended(t, -1, r.error);
  }

  function finish(t, status, error) {
    t.status = status; t.error = error || ''; t.rate = ''; t.ended = Date.now();
    if (status === 'done') { t.pct = 100; App.emit('transferred', t); }
    // The sidebar's short list drops finished transfers after a moment.
    setTimeout(() => X.changed(), 4100);
    pump();
  }
  const ended = (t, code, error) => { if (t.status === 'running') finish(t, code === 0 ? 'done' : 'failed', code === 0 ? '' : (error || 'exited with ' + code)); };

  X.cancel = (t) => {
    if (t.status === 'queued') return finish(t, 'cancelled');
    if (t.status !== 'running') return;
    const term = t.term;
    finish(t, 'cancelled');
    if (term) App.views.terminals.close(term); else codeome.transfer.cancel(t.id);
  };
  // A new try gets a new name, so what is left of the last one can't be taken for it.
  X.retry = (t) => { t.id = newId(); t.status = 'queued'; t.pct = 0; t.error = ''; pump(); };
  X.remove = (t) => { if (['queued', 'running'].includes(t.status)) X.cancel(t); X.queue.splice(X.queue.indexOf(t), 1); X.changed(); };
  X.clearFinished = () => { X.queue = X.queue.filter((t) => ['queued', 'running'].includes(t.status)); X.changed(); };
  X.setPaused = (on) => { X.paused = !!on; pump(); };
  X.changed = () => { for (const l of X.lists) l.sync(); App.emit('transfers', X.queue); };

  X.init = () => {
    codeome.transfer.onProgress(({ id, pct, rate }) => {
      const t = X.queue.find((x) => x.id === id);
      if (!t || t.status !== 'running') return;
      t.pct = pct; t.rate = rate || ''; X.changed();
    });
    codeome.transfer.onDone(({ id, code, error }) => { const t = X.queue.find((x) => x.id === id); if (t) ended(t, code, error); });
    for (const [ev, host] of [['hpc', 'remote'], ['storage', 'storage']]) {
      App.listen(ev, () => { for (const p of panes()) { paintSeg(p); if (p.host === host) go(p); } });
    }
    App.listen('config', () => { for (const p of panes()) { paintSeg(p); if (!isUp(p.host)) offline(p); } });
    // The Mac side follows the active project: each project keeps the folder it was left in.
    let last = App.project;
    App.listen('project', (dir) => {
      const keep = (ui().localDirs = ui().localDirs || {});
      for (const p of panes()) {
        if (last && p.dir && p.host === 'local') keep[last] = p.dir;
        p.dirs.local = dir && !App.isIdeas(dir) ? keep[dir] || dir : p.dirs.local;
        remember(p);
        if (p.host === 'local' && dir && !App.isIdeas(dir)) { p.dir = null; go(p); }
      }
      last = dir;
      App.saveConfig();
    });
    App.listen('transferred', (t) => { for (const p of panes()) if (p.host === t.to && p.dir === t.destDir) go(p); });
  };

  // ---------- queue lists ----------
  // A live list of the queue. compact (the Files sidebar): what is waiting, running or failed.
  X.queueList = ({ compact = false } = {}) => {
    const el = h('div.xq' + (compact ? '.compact' : ''), { role: 'list', 'aria-label': 'Transfers' });
    const rows = new Map();
    const shown = (t) => !compact || ['queued', 'running', 'failed'].includes(t.status) || Date.now() - t.ended < 4000;
    const l = {
      el, count: () => rows.size,
      sync: () => {
        const items = X.queue.filter(shown);
        for (const [t, r] of rows) if (!items.includes(t)) { r.el.remove(); rows.delete(t); }
        for (const t of items) {
          if (!rows.has(t)) { rows.set(t, row(t, compact)); el.append(rows.get(t).el); }
          rows.get(t).paint();
        }
      }
    };
    X.lists.push(l); l.sync();
    return l;
  };

  function row(t, compact) {
    const bar = h('i'), status = h('span.xq-status'), acts = h('span.xq-acts');
    const el = h('div.xq-row', { role: 'listitem' },
      h('span.xq-name', { title: `${t.src}\n${title(t.from)} → ${title(t.to)}: ${t.destDir}` }, h('span', { html: t.dir ? App.icons.folder : App.icons.file }),
        h('span.nm', compact ? `${t.name} → ${title(t.to)}` : t.name)),
      compact ? null : h('span.xq-route', title(t.from), ' → ', title(t.to)),
      compact ? null : h('span.xq-dest', { title: t.destDir }, t.destDir),
      compact ? null : h('span.xq-size', t.size == null ? '' : App.fmtSize(t.size)),
      status, acts, h('div.bar', bar));
    let painted = '';
    const paint = () => {
      el.className = 'xq-row ' + t.status;
      bar.style.width = (t.status === 'running' ? t.pct : t.status === 'done' ? 100 : 0) + '%';
      status.textContent = {
        queued: X.paused ? 'Paused' : 'Waiting', done: 'Done', cancelled: 'Cancelled', failed: 'Failed: ' + t.error,
        running: t.term ? 'In an HPC terminal' : t.pct || t.rate ? `${t.pct}%${t.rate ? ' · ' + t.rate : ''}` : 'Starting…'
      }[t.status];
      status.title = t.error;
      const key = t.status + (t.term ? 't' : '');
      if (key === painted) return;
      painted = key; acts.innerHTML = '';
      const live = ['queued', 'running'].includes(t.status);
      acts.append(...[
        t.status === 'running' && t.term ? App.iconBtn('terminal', 'Show its terminal', () => { App.views.terminals.showPanel(); App.views.terminals.activate(t.term); }) : null,
        ['failed', 'cancelled'].includes(t.status) ? App.iconBtn('refresh', 'Try again', () => X.retry(t)) : null,
        App.iconBtn('close', live ? 'Cancel' : 'Remove from the list', () => (live ? X.cancel(t) : X.remove(t)))
      ].filter(Boolean));
    };
    return { el, paint };
  }

  // ---------- panes ----------
  const panes = () => (root ? [X.panes.left, X.panes.right] : []);
  const other = (p) => (p.id === 'left' ? X.panes.right : X.panes.left);
  const configured = (host) => host === 'local' || !!(host === 'remote' ? App.cfg.hpc.host : App.cfg.storage.host);
  const remember = (p) => { ui()[p.id] = { host: p.host, dirs: p.dirs }; };

  X.sortEntries = (entries, { key, asc }) => {
    const by = { name: (a, b) => a.name.localeCompare(b.name), size: (a, b) => a.size - b.size, mtime: (a, b) => a.mtime - b.mtime }[key];
    return [...entries].sort((a, b) => (b.dir - a.dir) || (asc ? by(a, b) : by(b, a)) || a.name.localeCompare(b.name));
  };

  function pane(id, host) {
    const saved = ui()[id] || {};
    const p = { id, host: HOSTS.includes(saved.host) ? saved.host : host, dirs: { ...(saved.dirs || {}) }, dir: null, entries: [], shown: [], sel: new Set(), anchor: null, cursor: null, sort: { key: 'name', asc: true }, token: 0 };
    const side = id === 'left' ? 'Left' : 'Right';
    p.seg = h('div.xf-seg', { role: 'tablist', 'aria-label': side + ' pane: host' });
    p.path = h('input', { type: 'text', spellcheck: 'false', 'aria-label': side + ' pane: folder', onkeydown: (e) => { if (e.key === 'Enter') go(p, p.path.value.trim()); } });
    p.cols = h('div.xf-cols');
    p.list = h('div.flist.xf-list', { tabindex: '0', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': side + ' pane: files' });
    p.foot = h('div.xf-foot');
    p.el = h('section.xf-pane', { 'aria-label': side + ' pane' },
      h('div.xf-head', p.seg, h('span.grow'),
        App.iconBtn('up', 'Parent folder', () => p.dir && go(p, App.dirname(p.dir))),
        App.iconBtn('home', 'Start folder', () => go(p, F().startDir(p.host))),
        App.iconBtn('refresh', 'Refresh', () => go(p)),
        App.iconBtn('dots', 'More', (e) => App.menuAt(e.currentTarget, paneMenu(p)))),
      h('div.pathbar', p.path), p.cols, p.list, p.foot);

    // Drop target: rows from the other pane or the Files sidebar, or files from Finder.
    const accepts = (dt) => dt.types.includes('codeome/xfer') || HOSTS.some((s) => dt.types.includes('codeome/' + s)) || dt.types.includes('Files');
    let lit = null;
    const light = (el) => { if (lit === el) return; if (lit) lit.classList.remove('dropping'); lit = el; if (lit) lit.classList.add('dropping'); };
    p.list.addEventListener('dragover', (e) => {
      if (!p.dir || !accepts(e.dataTransfer)) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
      light(e.target.closest('.fitem.dir') || p.list);
    });
    p.list.addEventListener('dragleave', (e) => { if (!p.list.contains(e.relatedTarget)) light(null); });
    p.list.addEventListener('drop', (e) => {
      light(null);
      if (!p.dir || !accepts(e.dataTransfer)) return;
      e.preventDefault();
      const dt = e.dataTransfer, folder = e.target.closest('.fitem.dir');
      const dest = folder ? App.join(p.dir, folder.dataset.name) : p.dir;
      if (dt.types.includes('codeome/xfer')) {
        const d = JSON.parse(dt.getData('codeome/xfer'));
        // Within a pane, only a drop onto one of its folders copies.
        if (d.pane === p.id && !folder) return;
        X.enqueue(d.host, d.items, p.host, dest);
        return;
      }
      const from = HOSTS.find((s) => dt.types.includes('codeome/' + s));
      if (from) return void X.enqueue(from, [JSON.parse(dt.getData('codeome/' + from))], p.host, dest);
      X.enqueue('local', [...dt.files].map((f) => codeome.pathForFile(f)).filter(Boolean).map((path) => ({ path })), p.host, dest);
    });
    p.list.addEventListener('keydown', (e) => keyNav(p, e));
    p.list.addEventListener('click', (e) => { if (e.target === p.list) { p.sel.clear(); paintSel(p); } });
    return p;
  }

  function paintSeg(p) {
    p.seg.innerHTML = '';
    for (const host of HOSTS) {
      const tip = host === 'local' ? 'Files on this Mac' : isUp(host) ? 'Connected' : configured(host) ? 'Not connected' : 'Not set up';
      p.seg.append(h('button' + (host === p.host ? '.on' : ''), { role: 'tab', 'aria-selected': String(host === p.host), title: tip, onclick: () => X.setHost(p, host) },
        host === 'local' ? null : h('i.pane-dot' + (isUp(host) ? '.ok' : configured(host) ? '.bad' : '')), title(host)));
    }
  }

  function paintCols(p) {
    p.cols.innerHTML = '';
    for (const [key, label] of [['name', 'Name'], ['size', 'Size'], ['mtime', 'Modified']]) {
      const on = p.sort.key === key;
      p.cols.append(h('button' + (on ? '.on' : ''), { title: 'Sort by ' + label.toLowerCase(), 'aria-pressed': String(on),
        onclick: () => { p.sort = { key, asc: on ? !p.sort.asc : key === 'name' }; render(p); } }, label, on ? (p.sort.asc ? ' ↑' : ' ↓') : ''));
    }
  }

  X.setHost = (p, host) => {
    if (p.host === host) return;
    p.host = host; p.dir = null;
    remember(p); App.saveConfig();
    go(p);
  };

  // Open dir on the pane's host, or the folder it last showed there.
  async function go(p, dir) {
    const host = p.host;
    paintSeg(p);
    if (!isUp(host)) return offline(p);
    dir = dir || p.dir || p.dirs[host] || F().startDir(host);
    const token = ++p.token;
    p.list.innerHTML = '';
    p.list.append(h('div.empty', h('span.spinner'), ' Loading…'));
    const r = await api(host).list(dir);
    if (token !== p.token) return;
    p.sel.clear(); p.anchor = p.cursor = null;
    if (r.error) {
      // A saved folder may be gone; the next visit starts over.
      if (p.dirs[host] === dir) delete p.dirs[host];
      p.dir = null; p.entries = []; p.shown = []; p.path.value = dir;
      p.list.innerHTML = ''; p.list.append(h('div.empty', r.error));
      paintCols(p); paintSel(p);
      return;
    }
    p.dir = p.dirs[host] = r.cwd; remember(p);
    p.entries = r.entries.filter((x) => App.cfg.showHidden || !x.name.startsWith('.'));
    p.path.value = r.cwd;
    render(p);
  }

  // What a pane shows while its host can't list anything.
  function offline(p) {
    p.token++; p.dir = null; p.entries = []; p.shown = []; p.sel.clear(); p.path.value = '';
    p.list.innerHTML = '';
    p.list.append(F().stateNote(p.host));
    paintCols(p); paintSel(p);
  }

  function render(p) {
    paintCols(p);
    p.list.innerHTML = '';
    p.shown = X.sortEntries(p.entries, p.sort);
    if (!p.shown.length) p.list.append(h('div.empty', 'This folder is empty.'));
    for (const e of p.shown) {
      p.list.append(h('div.fitem.xf-row' + (e.dir ? '.dir' : ''), {
        draggable: 'true', role: 'option', 'data-name': e.name, title: e.name,
        onclick: (ev) => pick(p, e, ev), ondblclick: () => openEntry(p, e),
        oncontextmenu: (ev) => { ev.preventDefault(); if (!p.sel.has(e.name)) { p.sel = new Set([e.name]); p.anchor = p.cursor = e.name; paintSel(p); } App.menu(ev.clientX, ev.clientY, itemMenu(p, e)); },
        ondragstart: (ev) => {
          if (!p.sel.has(e.name)) { p.sel = new Set([e.name]); p.anchor = p.cursor = e.name; paintSel(p); }
          const items = selected(p);
          ev.dataTransfer.setData('codeome/xfer', JSON.stringify({ pane: p.id, host: p.host, items }));
          // The Files sidebar takes one item at a time.
          if (items.length === 1) ev.dataTransfer.setData('codeome/' + p.host, JSON.stringify(items[0]));
          ev.dataTransfer.effectAllowed = 'copy';
        }
      }, h('span', { html: e.dir ? App.icons.folder : App.icons.file }), h('span.nm', e.name), h('span.sz', e.dir ? '' : App.fmtSize(e.size)), h('span.mt', App.fmtAgo(e.mtime))));
    }
    paintSel(p);
  }

  const selected = (p) => p.shown.filter((e) => p.sel.has(e.name)).map((e) => ({ path: App.join(p.dir, e.name), dir: e.dir, size: e.size }));

  function paintSel(p) {
    for (const el of p.list.querySelectorAll('.fitem')) {
      const on = p.sel.has(el.dataset.name);
      el.classList.toggle('sel', on); el.setAttribute('aria-selected', String(on));
    }
    const sel = p.shown.filter((e) => p.sel.has(e.name));
    const n = (c, word) => c + ' ' + word + (c === 1 ? '' : 's');
    p.foot.textContent = !p.dir ? '' : sel.length
      ? `${sel.length} selected` + (sel.some((e) => e.dir) ? '' : ' · ' + App.fmtSize(sel.reduce((s, e) => s + e.size, 0)))
      : n(p.shown.length, 'item');
    paintMid();
  }

  function pick(p, e, ev) {
    const names = p.shown.map((x) => x.name), i = names.indexOf(e.name);
    if (ev.shiftKey && p.anchor != null && names.includes(p.anchor)) {
      const a = names.indexOf(p.anchor);
      p.sel = new Set(names.slice(Math.min(a, i), Math.max(a, i) + 1));
    } else if (ev.metaKey) {
      if (p.sel.has(e.name)) p.sel.delete(e.name); else p.sel.add(e.name);
      p.anchor = e.name;
    } else { p.sel = new Set([e.name]); p.anchor = e.name; }
    p.cursor = e.name;
    paintSel(p);
  }

  function keyNav(p, e) {
    const names = p.shown.map((x) => x.name); if (!names.length) return;
    let i = names.indexOf(p.cursor);
    if (e.key === 'a' && e.metaKey) { e.preventDefault(); p.sel = new Set(names); return paintSel(p); }
    if (e.key === 'Backspace' && e.metaKey) return p.dir && go(p, App.dirname(p.dir));
    if (e.key === 'Enter' && i >= 0) return openEntry(p, p.shown[i]);
    if (e.key === 'ArrowDown') i = Math.min(names.length - 1, i + 1);
    else if (e.key === 'ArrowUp') i = Math.max(0, i - 1);
    else return;
    e.preventDefault();
    p.cursor = names[i];
    if (e.shiftKey && p.anchor != null && names.includes(p.anchor)) {
      const a = names.indexOf(p.anchor);
      p.sel = new Set(names.slice(Math.min(a, i), Math.max(a, i) + 1));
    } else { p.sel = new Set([names[i]]); p.anchor = names[i]; }
    paintSel(p);
    p.list.querySelector(`.fitem[data-name="${CSS.escape(names[i])}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  async function openEntry(p, e) {
    const full = App.join(p.dir, e.name);
    if (e.dir) return go(p, full);
    // A link on a server may point at a folder.
    if (e.link && p.host !== 'local' && !(await api(p.host).list(full)).error) return go(p, full);
    const ed = App.views.editor;
    if (ed.isBinary(full) && ed.isPreviewable(full)) return ed.preview(full, where(p.host));
    if (ed.isBinary(full)) return p.host === 'local' ? codeome.shell.openPath(full) : App.toast('Copy ' + e.name + ' to your Mac to open it.');
    ed.openFile(full, where(p.host));
  }

  // Queue the selection of one pane into the folder the other one shows.
  X.copy = (id) => {
    const p = X.panes[id], o = other(p), items = selected(p);
    if (!items.length) return App.toast('Select what to copy first.');
    X.enqueue(p.host, items, o.host, o.dir);
  };

  // Folders changed here also show in the other pane and in the Files sidebar.
  function touched(host, dir) {
    for (const p of panes()) if (p.host === host && p.dir === dir) go(p);
    if (F()[host].dir === dir) F().refresh(host);
  }

  function itemMenu(p, e) {
    const o = other(p), items = selected(p), one = items.length === 1;
    const full = App.join(p.dir, e.name);
    return [
      { label: `Copy ${one ? '' : items.length + ' items '}to ${title(o.host)}${o.dir ? ': ' + App.basename(o.dir) : ''}`, disabled: !o.dir, run: () => X.copy(p.id) },
      one ? (e.dir ? { label: 'Open folder', run: () => go(p, full) } : { label: 'Open in the editor', run: () => openEntry(p, e) }) : null,
      '-',
      one ? { label: 'Copy path', run: () => navigator.clipboard.writeText(full) } : null,
      one && p.host === 'local' ? { label: 'Reveal in Finder', run: () => codeome.shell.reveal(full) } : null,
      one ? { label: 'Rename…', run: () => renameItem(p, full) } : null,
      { label: p.host === 'local' ? 'Move to Trash' : 'Delete…', danger: true, run: () => del(p, items) }
    ];
  }

  function paneMenu(p) {
    const host = p.host, dir = p.dir;
    return [
      { label: 'New folder…', disabled: !dir, run: () => newFolder(p) },
      host !== 'local' ? { label: 'Upload files from Mac…', disabled: !dir, run: async () => { const fs = await codeome.dialog.files({ defaultPath: App.project || '~' }); X.enqueue('local', fs.map((path) => ({ path })), host, dir); } } : null,
      { label: (App.cfg.showHidden ? 'Hide' : 'Show') + ' hidden files', run: () => { App.cfg.showHidden = !App.cfg.showHidden; App.saveConfig(); panes().forEach((x) => go(x)); HOSTS.forEach(F().refresh); } },
      '-',
      { label: 'Show in the Files sidebar', disabled: !dir, run: () => F().show(host, dir) },
      host !== 'storage' ? { label: 'Terminal here', disabled: !dir, run: () => (host === 'remote' ? App.views.terminals.hpcShell(dir) : App.views.terminals.localShell(dir)) } : null,
      host === 'remote' ? '-' : null,
      host === 'remote' ? (App.hpcConnected ? { label: 'Disconnect', run: () => App.disconnectHpc() } : { label: 'Connect', run: () => App.connectHpc() }) : null,
      host === 'storage' ? '-' : null,
      host === 'storage' ? (App.storageConnected ? { label: 'Disconnect', run: () => App.disconnectStorage() } : { label: 'Connect', run: () => App.connectStorage() }) : null,
      host === 'storage' ? { label: 'Storage settings…', run: () => App.views.settings.open('storage') } : null
    ];
  }

  async function newFolder(p) {
    const host = p.host, dir = p.dir;
    const name = await App.prompt('New folder', 'Name', '', { ok: 'Create' });
    if (!name) return;
    const r = await api(host).mkdir(App.join(dir, name));
    if (r.error) return App.err(r.error);
    touched(host, dir);
  }

  async function renameItem(p, full) {
    const host = p.host, dir = p.dir;
    const name = await App.prompt('Rename', 'New name', App.basename(full), { ok: 'Rename' });
    if (!name || name === App.basename(full)) return;
    const r = await api(host).rename(full, App.join(dir, name));
    if (r.error) return App.err(r.error);
    touched(host, dir);
  }

  async function del(p, items) {
    const host = p.host, dir = p.dir;
    const what = items.length === 1 ? App.basename(items[0].path) : items.length + ' items';
    if (host !== 'local') {
      const ok = await App.confirm(`Delete ${what} on ${title(host)}?`, `${items.length === 1 ? (items[0].dir ? 'This folder and everything in it' : 'This file') : 'These items, and everything in the folders among them,'} will be permanently deleted. This can't be undone.`, 'Delete permanently', true);
      if (!ok) return;
    }
    for (const it of items) {
      const r = host === 'local' ? await codeome.local.trash(it.path) : host === 'remote' ? await codeome.remote.delete(it.path) : await codeome.storage.delete(it.path, it.dir);
      if (r.error) { App.err(r.error); break; }
    }
    if (host === 'local') App.toast(`Moved ${what} to the Trash.`);
    touched(host, dir);
  }

  // ---------- the view ----------
  let mid = {}, qhead = {};
  function paintMid() {
    if (!root) return;
    const { left, right } = X.panes;
    mid.toRight.disabled = !left.sel.size || !right.dir;
    mid.toLeft.disabled = !right.sel.size || !left.dir;
  }

  function paintQueueHead() {
    const live = X.queue.some((t) => ['queued', 'running'].includes(t.status));
    qhead.sum.textContent = X.summary(X.queue) || 'Nothing queued';
    qhead.pause.textContent = X.paused ? 'Resume' : 'Pause';
    qhead.pause.title = X.paused ? 'Start the waiting transfers again' : 'Start no more transfers; the running ones finish';
    qhead.pause.disabled = !X.paused && !live;
    qhead.clear.disabled = !X.queue.some((t) => !['queued', 'running'].includes(t.status));
    qhead.empty.hidden = X.queue.length > 0;
  }

  function build() {
    const u = ui();
    X.panes.left = pane('left', 'local');
    X.panes.right = pane('right', App.cfg.hpc.host ? 'remote' : App.cfg.storage.host ? 'storage' : 'local');
    // Panes saved under another project start in this project's folder.
    const mine = App.project && !App.isIdeas(App.project) && ((u.localDirs || {})[App.project] || App.project);
    if (mine) for (const p of [X.panes.left, X.panes.right]) p.dirs.local = mine;
    mid = {
      toRight: App.iconBtn('right', 'Copy the selection to the right pane', () => X.copy('left')),
      toLeft: App.iconBtn('left', 'Copy the selection to the left pane', () => X.copy('right'))
    };
    const swap = App.iconBtn('swap', 'Swap the two panes', () => {
      const { left, right } = X.panes;
      [left.host, right.host] = [right.host, left.host]; [left.dirs, right.dirs] = [right.dirs, left.dirs];
      left.dir = right.dir = null;
      remember(left); remember(right); App.saveConfig();
      go(left); go(right);
    });

    const list = X.queueList();
    qhead = {
      sum: h('span.hint.grow'),
      pause: h('button.btn.small', { onclick: () => X.setPaused(!X.paused) }),
      clear: h('button.btn.small', { title: 'Remove the transfers that are done, failed or cancelled', onclick: () => X.clearFinished() }, 'Clear finished'),
      empty: h('div.empty', 'Nothing queued. Drag files from one side to the other, or select them and use the arrows between the panes.')
    };
    const parallel = h('select', { 'aria-label': 'Transfers at a time', title: 'How many transfers run at the same time',
      onchange: () => { ui().parallel = Number(parallel.value); App.saveConfig(); pump(); } },
      [1, 2, 3, 4].map((n) => h('option', { value: n, selected: n === X.parallel() }, n + ' at a time')));
    const queue = h('section.xf-queue', { 'aria-label': 'Transfer queue', style: { height: (u.queueH || 200) + 'px' } },
      h('div.xf-qhead', h('b', 'Queue'), qhead.sum, parallel, qhead.pause, qhead.clear),
      h('div.xf-qbody', qhead.empty, list.el));

    // Drag the line above the queue to give it more or less room.
    const rz = h('div.pane-resizer', { role: 'separator', 'aria-orientation': 'horizontal', title: 'Drag to resize the queue' });
    rz.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const h0 = queue.getBoundingClientRect().height, y0 = e.clientY, max = root.getBoundingClientRect().height - 160;
      document.body.classList.add('row-resizing');
      const move = (ev) => { queue.style.height = Math.max(72, Math.min(max, h0 + y0 - ev.clientY)) + 'px'; };
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); document.body.classList.remove('row-resizing'); ui().queueH = Math.round(queue.getBoundingClientRect().height); App.saveConfig(); };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    });

    root = h('div.xfer', h('div.xf-panes', X.panes.left.el, h('div.xf-mid', mid.toRight, mid.toLeft, swap), X.panes.right.el), rz, queue);
    App.listen('transfers', paintQueueHead);
    paintQueueHead();
  }

  // Opens the view in a tab; with a host (and folder), the left pane shows it.
  X.open = ({ host, dir } = {}) => {
    const first = !root;
    if (first) build();
    // One view for every project: the tab that is showing holds it.
    App.views.editor.openCustom({ key: 'transfer', title: 'Transfer', render: (el, tab) => { el.append(root); tab.layout = () => { if (root.parentNode !== el) el.append(root); }; } });
    const { left, right } = X.panes;
    if (host) { left.host = host; left.dir = null; remember(left); }
    if (first || host) go(left, dir);
    if (first) go(right);
  };
})();
