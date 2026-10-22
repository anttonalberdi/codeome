// Centre stage: Monaco file tabs plus custom tabs (previews, diffs, job logs).
// Every tab belongs to the project that was open when it was created; only the
// current project's tabs are shown.
(function () {
  const h = App.h;
  const E = { tabs: [], active: null, editor: null, seq: 0, lastActive: {} };
  App.views.editor = E;

  const LANG = {
    r: 'r', R: 'r', rmd: 'rmarkdown', qmd: 'rmarkdown', md: 'markdown', py: 'python', ipynb: 'json', sh: 'shell', bash: 'shell', zsh: 'shell',
    slurm: 'shell', sbatch: 'shell', smk: 'python', snakefile: 'python', nf: 'groovy', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', cfg: 'ini', ini: 'ini',
    js: 'javascript', ts: 'typescript', html: 'html', css: 'css', sql: 'sql', tex: 'latex', bib: 'latex', c: 'c', cpp: 'cpp', h: 'cpp', java: 'java', rs: 'rust', go: 'go', jl: 'julia',
    xml: 'xml', csv: 'plaintext', tsv: 'plaintext', txt: 'plaintext', log: 'plaintext', dockerfile: 'dockerfile', makefile: 'shell'
  };
  E.lang = (p) => {
    const b = App.basename(p).toLowerCase();
    if (b === 'snakefile') return 'python';
    if (b === 'dockerfile') return 'dockerfile';
    if (b === 'makefile') return 'shell';
    return LANG[App.ext(p)] || 'plaintext';
  };
  const PREVIEWABLE = ['qmd', 'rmd', 'ipynb', 'html', 'htm', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'pdf', 'webp'];
  E.isPreviewable = (p) => PREVIEWABLE.includes(App.ext(p));
  const BINARY = ['png', 'jpg', 'jpeg', 'gif', 'pdf', 'webp', 'gz', 'zip', 'bz2', 'xz', 'bam', 'cram', 'rds', 'rdata', 'pkl', 'h5', 'xlsx', 'docx', 'pptx', 'sif', 'tar', 'so', 'o'];
  E.isBinary = (p) => BINARY.includes(App.ext(p));

  E.initMonaco = function () {
    const m = window.monaco;
    m.editor.defineTheme('codeome-dark', { base: 'vs-dark', inherit: true, rules: [{ token: 'comment', foreground: '7d8898', fontStyle: 'italic' }, { token: 'keyword', foreground: '9cc59f' }, { token: 'string', foreground: 'e0b45a' }, { token: 'number', foreground: '6cc4bb' }],
      colors: { 'editor.background': '#20262e', 'editor.lineHighlightBackground': '#252c35', 'editorLineNumber.foreground': '#4a5462', 'editorLineNumber.activeForeground': '#9cc59f', 'editor.selectionBackground': '#2b3a4d', 'editorCursor.foreground': '#9cc59f', 'editorIndentGuide.background1': '#2f3742' } });
    m.editor.defineTheme('codeome-light', { base: 'vs', inherit: true, rules: [{ token: 'comment', foreground: '7a8494', fontStyle: 'italic' }, { token: 'keyword', foreground: '3e7a4a' }, { token: 'string', foreground: '94680f' }, { token: 'number', foreground: '2f8a83' }],
      colors: { 'editor.background': '#ffffff', 'editor.lineHighlightBackground': '#f6f7f8', 'editorLineNumber.foreground': '#b5bcc6', 'editorLineNumber.activeForeground': '#3e7a4a', 'editor.selectionBackground': '#d5e3f3', 'editorCursor.foreground': '#3e7a4a' } });
    E.editor = m.editor.create(document.getElementById('monaco-host'), {
      model: null, automaticLayout: true, fontFamily: '"SF Mono", Menlo, ui-monospace, monospace', fontSize: App.cfg.editor.fontSize || 13,
      minimap: { enabled: false }, scrollBeyondLastLine: false, renderWhitespace: 'selection', rulers: [80], tabSize: 2,
      bracketPairColorization: { enabled: true }, smoothScrolling: true, padding: { top: 8 }, wordWrap: 'off', stickyScroll: { enabled: true }
    });
    E.applyTheme();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', E.applyTheme);

    E.editor.addAction({ id: 'codeome.send', label: 'Run line, statement or selection', keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.Enter], contextMenuGroupId: 'navigation', contextMenuOrder: 0, run: (ed) => E.sendSelection(ed) });
    E.editor.addAction({ id: 'codeome.sendFile', label: 'Run whole file (current chunk in Rmd)', keybindings: [m.KeyMod.CtrlCmd | m.KeyMod.Shift | m.KeyCode.Enter], contextMenuGroupId: 'navigation', contextMenuOrder: 1, run: (ed) => E.runFile(ed) });
    E.editor.addAction({ id: 'codeome.preview', label: 'Preview / render', contextMenuGroupId: 'navigation', contextMenuOrder: 2, run: () => E.previewCurrent() });
    E.editor.addAction({ id: 'codeome.sbatch', label: 'Submit to Slurm (sbatch)', contextMenuGroupId: 'navigation', contextMenuOrder: 3, run: () => { const t = E.cur(); if (t && t.remote) App.views.slurm.submit(t.path); else App.toast('Open the script from the HPC side to submit it.'); } });
    E.editor.addAction({ id: 'codeome.askAgent', label: 'Ask the agent about this…', contextMenuGroupId: 'navigation', contextMenuOrder: 4, run: (ed) => E.askAgent(ed) });
    App.views.rmd.init(E.editor);
    document.getElementById('md-preview').onclick = () => E.mdPreview();
    document.getElementById('md-wrap').onclick = () => { localStorage.setItem('mdWrap', localStorage.getItem('mdWrap') === '1' ? '0' : '1'); E.applyWrap(); };
  };

  E.applyTheme = () => {
    const t = document.documentElement.dataset.theme;
    const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    if (window.monaco) monaco.editor.setTheme(dark ? 'codeome-dark' : 'codeome-light');
    for (const t of E.tabs) if (t.gdocDark) t.gdocDark();
  };

  E.cur = () => E.tabs.find((t) => t.id === E.active);
  const mine = (t, project = App.project) => t.project === project;
  E.visible = () => E.tabs.filter((t) => mine(t));

  // Files open from this Mac, the HPC (remote) or the long-term storage (storage).
  const fileApi = (t) => (t.remote ? codeome.remote : t.storage ? codeome.storage : codeome.local);
  const prefix = (o) => (o.remote ? 'hpc:' : o.storage ? 'store:' : '');
  E.openFile = async function (path, opts = {}) {
    App.expandMain();
    const remote = !!opts.remote, storage = !opts.remote && !!opts.storage;
    const key = prefix({ remote, storage }) + path;
    const existing = E.tabs.find((t) => t.key === key && mine(t));
    if (existing) { E.activate(existing.id); return existing; }
    if (E.isGdoc(path)) { if (remote || storage) { App.toast('Google files open from this Mac only.'); return; } return E.gdoc(path); }
    if (E.isBinary(path)) { if (E.isPreviewable(path)) return E.preview(path, { remote, storage }); App.toast(App.basename(path) + ' is a binary file.'); return; }
    const r = await fileApi({ remote, storage }).read(path);
    if (r.error) { App.err(r.error); return; }
    const uri = monaco.Uri.from({ scheme: remote ? 'hpc' : storage ? 'store' : 'file', path: path.startsWith('/') ? path : '/' + path });
    const model = monaco.editor.getModel(uri) || monaco.editor.createModel(r.content, E.lang(path), uri);
    // Two projects can open the same file: they share its model (and its unsaved edits).
    const twin = E.tabs.find((t) => t.model === model);
    const tab = { id: 'e' + (++E.seq), key, kind: 'file', path, remote, storage, title: App.basename(path), model, project: App.project, saved: twin ? twin.saved : model.getAlternativeVersionId(), viewState: null };
    model.onDidChangeContent(() => { tab.dirty = model.getAlternativeVersionId() !== tab.saved; renderTabs(); });
    E.tabs.push(tab);
    E.activate(tab.id);
    return tab;
  };

  E.newFile = async function () {
    const base = App.project || await codeome.local.home();
    const name = await App.prompt('New file', 'File name (in ' + App.basename(base) + ')', 'untitled.R', { ok: 'Create' });
    if (!name) return;
    const p = name.startsWith('/') ? name : App.join(base, name);
    const w = await codeome.local.write(p, '');
    if (w.error) return App.err(w.error);
    App.emit('local-changed');
    E.openFile(p);
  };

  // Custom tabs: render(el) builds content once; onActivate refreshes.
  E.openCustom = function ({ key, title, badge, render, onActivate, onClose }) {
    App.expandMain();
    const existing = E.tabs.find((t) => t.key === key && mine(t));
    if (existing) { E.activate(existing.id); if (existing.onActivate) existing.onActivate(existing); return existing; }
    const el = h('div', { style: { display: 'contents' } });
    const tab = { id: 'e' + (++E.seq), key, kind: 'custom', title, badge, el, onActivate, onClose, project: App.project };
    E.tabs.push(tab);
    render(el, tab);
    E.activate(tab.id);
    return tab;
  };

  // Markdown files can wrap at the window edge instead of scrolling sideways; the button sits beside A−/A+.
  const isMd = (t) => t && t.kind === 'file' && ['md', 'markdown'].includes(App.ext(t.path || ''));
  E.applyWrap = () => {
    const t = E.cur(), md = isMd(t), on = localStorage.getItem('mdWrap') === '1';
    const btn = document.getElementById('md-wrap');
    if (btn) { btn.hidden = !md; btn.classList.toggle('active', on); btn.setAttribute('aria-pressed', String(on)); }
    const pv = document.getElementById('md-preview');
    if (pv) pv.hidden = !md;
    if (E.editor) E.editor.updateOptions({ wordWrap: md && on ? 'on' : 'off' });
  };

  // Formatted view of the open Markdown file; it follows the editor text as you type.
  E.mdPreview = function () {
    const t = E.cur();
    if (!isMd(t)) return;
    const body = h('div.msg.md.md-doc');
    const draw = () => { body.innerHTML = App.md(t.model.getValue()); };
    let sub = null;
    E.openCustom({
      key: 'mdview:' + t.id, title: t.title, badge: 'Formatted',
      render: (el) => {
        el.append(h('div.toolbar', h('span.path', t.path), h('button.btn.small', { onclick: () => E.openFile(t.path, { remote: t.remote, storage: t.storage }) }, 'Back to source')), h('div.md-doc-scroll', body));
        draw();
        sub = t.model.onDidChangeContent(draw);
      },
      onActivate: draw,
      onClose: () => sub && sub.dispose()
    });
  };

  E.activate = function (id) {
    const prev = E.cur();
    if (prev && prev.kind === 'file' && E.editor) prev.viewState = E.editor.saveViewState();
    E.active = id;
    const t = E.cur();
    if (t) E.lastActive[t.project] = id;
    const monacoHost = document.getElementById('monaco-host');
    const alt = document.getElementById('alt-host');
    document.getElementById('welcome').hidden = !!t;
    if (!t) { monacoHost.hidden = true; alt.hidden = true; E.applyWrap(); renderTabs(); return; }
    if (t.kind === 'file') {
      alt.hidden = true; monacoHost.hidden = false;
      E.editor.setModel(t.model);
      E.applyWrap();
      if (t.viewState) E.editor.restoreViewState(t.viewState);
      setTimeout(() => { E.editor.layout(); E.editor.focus(); });
    } else {
      monacoHost.hidden = true; alt.hidden = false;
      E.applyWrap();
      for (const c of [...alt.children]) alt.removeChild(c);
      alt.append(t.el);
      if (t.layout) setTimeout(t.layout);
    }
    renderTabs();
    App.emit('tab', t);
  };

  // Resolves false when the user keeps the tab open.
  E.close = async function (id) {
    const t = E.tabs.find((x) => x.id === id); if (!t) return true;
    const shared = t.kind === 'file' && E.tabs.some((x) => x !== t && x.model === t.model);
    if (t.dirty && !shared) {
      const r = await App.modal({ title: `Save changes to ${t.title}?`, text: 'Your changes will be lost if you close without saving.', ok: 'Save', cancel: 'Cancel', fields: [] });
      if (r === null) { const disc = await App.confirm('Discard changes?', `Close ${t.title} without saving.`, 'Discard', true); if (!disc) return false; }
      else if (!(await E.save(t))) return false;
    }
    if (t.kind === 'file' && !shared) t.model.dispose();
    if (t.onClose) t.onClose(t);
    const siblings = E.tabs.filter((x) => x.project === t.project);
    const i = siblings.indexOf(t);
    E.tabs.splice(E.tabs.indexOf(t), 1);
    if (E.lastActive[t.project] === id) delete E.lastActive[t.project];
    if (E.active === id) { const n = siblings[i + 1] || siblings[i - 1]; E.active = null; E.activate(n ? n.id : null); } else renderTabs();
    return true;
  };

  // Close every tab of a project, asking about unsaved files. False if the user cancels.
  E.closeProject = async function (project) {
    for (const t of E.tabs.filter((x) => x.project === project)) if (!(await E.close(t.id))) return false;
    return true;
  };

  // Show the project's own tabs, back on the one last used there.
  App.listen('project', (project) => {
    const last = E.tabs.find((t) => t.id === E.lastActive[project] && mine(t, project));
    const vis = E.tabs.filter((t) => mine(t, project));
    E.active = null;
    E.activate(last ? last.id : (vis.length ? vis[vis.length - 1].id : null));
  });

  E.save = async function (t = E.cur()) {
    if (!t || t.kind !== 'file') return false;
    const content = t.model.getValue();
    const r = await fileApi(t).write(t.path, content);
    if (r.error) { App.err('Could not save: ' + r.error); return false; }
    // Tabs sharing the model (same file in two projects) are saved too.
    for (const x of E.tabs) if (x.model === t.model) { x.saved = t.model.getAlternativeVersionId(); x.dirty = false; }
    renderTabs();
    App.emit('saved', t);
    return true;
  };

  // Re-read a file tab from disk (asking first when it has unsaved edits); preview tabs re-render.
  E.refresh = async function (t) {
    if (t.kind !== 'file') { if (t.reload) t.reload(true); return; }
    if (t.dirty && !(await App.confirm('Reload ' + t.title + '?', 'Your unsaved edits to this file will be lost.', 'Reload', true))) return;
    const r = await fileApi(t).read(t.path);
    if (r.error) return App.err(r.error);
    if (r.content !== t.model.getValue()) t.model.setValue(r.content);
    for (const x of E.tabs) if (x.model === t.model) { x.saved = t.model.getAlternativeVersionId(); x.dirty = false; }
    renderTabs();
    App.toast('Reloaded ' + t.title);
  };

  // Pick up changes made outside the editor (an agent, a terminal): the shown local file is re-read
  // and, when it has no unsaved edits, updated in place. Edited tabs are left alone.
  let syncing = false;
  const syncActive = async () => {
    const t = E.cur();
    if (syncing || document.hidden || !t || t.kind !== 'file' || t.remote || t.storage || t.dirty) return;
    syncing = true;
    try {
      const r = await fileApi(t).read(t.path);
      if (r.error || E.cur() !== t || t.dirty || r.content === t.model.getValue()) return;
      const view = E.editor && E.editor.saveViewState();
      t.model.setValue(r.content);
      if (view && E.cur() === t) E.editor.restoreViewState(view);
      for (const x of E.tabs) if (x.model === t.model) { x.saved = t.model.getAlternativeVersionId(); x.dirty = false; }
      renderTabs();
    } finally { syncing = false; }
  };
  setInterval(syncActive, 1500);
  window.addEventListener('focus', syncActive);

  // R code (R files, R chunks) goes to the R console; anything else to the active terminal.
  // With no selection, R sends the whole statement under the cursor, like RStudio.
  E.sendSelection = function (ed) {
    const t = E.cur(); if (!t || t.kind !== 'file') return;
    const sel = ed.getSelection(); const model = ed.getModel();
    const R = App.views.rmd;
    const line = sel.startLineNumber;
    let lo = 1, hi = model.getLineCount(), lang = E.lang(t.path);
    if (R.isRmd(t.path)) {
      const c = R.chunkAt(model, line);
      if (!c || line === c.start || (c.closed && line === c.end)) {
        // Prose: step to the next line; a selection still goes to R.
        if (sel.isEmpty()) { const n = Math.min(line + 1, hi); ed.setPosition({ lineNumber: n, column: 1 }); ed.revealLine(n); return; }
        lang = 'r';
      } else { lo = c.start + 1; hi = c.closed ? c.end - 1 : c.end; lang = c.engine === 'r' ? 'r' : c.engine; }
    }
    let text, last = line;
    if (!sel.isEmpty()) text = model.getValueInRange(sel);
    else if (lang === 'r') {
      const st = R.statementAt(model, line, lo, hi);
      if (st) { text = model.getValueInRange({ startLineNumber: st.start, startColumn: 1, endLineNumber: st.end, endColumn: model.getLineMaxColumn(st.end) }); last = st.end; }
    } else text = model.getLineContent(line);
    // Move on to the next line with code (or just past the chunk / file).
    if (sel.isEmpty()) {
      let n = last + 1;
      while (n <= hi && !model.getLineContent(n).trim()) n++;
      if (n > hi) n = Math.min(last + 1, model.getLineCount());
      ed.setPosition({ lineNumber: n, column: 1 }); ed.revealLine(n);
    }
    if (!text || !text.trim()) return;
    text = text.replace(/\r/g, '');
    if (lang === 'r') App.views.terminals.sendR(text, R.whereFor(t)); else App.views.terminals.send(text);
  };

  E.runFile = async function (ed) {
    const t = E.cur(); if (!t || t.kind !== 'file') return;
    // In R Markdown and Quarto, ⇧⌘↩ runs the chunk under the cursor, like RStudio.
    if (App.views.rmd.isRmd(t.path)) return App.views.rmd.runChunk(t.model, (ed || E.editor).getPosition().lineNumber);
    if (t.dirty) await E.save(t);
    const ext = App.ext(t.path);
    // R scripts are sourced into the R console, so their objects stay around.
    if (ext === 'r' && !t.storage) return App.views.terminals.sourceR(t.path, App.views.rmd.whereFor(t));
    const runner = { r: 'Rscript', py: App.cfg.python[t.remote ? 'remote' : 'local'], sh: 'bash', bash: 'bash' }[ext];
    if (!runner) return App.toast('No runner for .' + ext + ' files.');
    if (t.storage) return App.toast('Copy the file to this Mac or the HPC to run it.');
    const cmd = `${runner} '${t.path.replace(/'/g, "'\\''")}'`;
    if (t.remote) App.views.terminals.hpcTask(t.title, cmd, App.dirname(t.path)); else App.views.terminals.task(t.title, cmd, App.dirname(t.path));
  };

  // Puts a reference to the file (and selected lines) in the Agent chat's composer.
  E.askAgent = function (ed) {
    const t = E.cur();
    if (!t || t.kind !== 'file') return App.views.chat.ask('');
    const s = ed.getSelection();
    const where = t.remote ? `${t.path} on the HPC` : t.storage ? `${t.path} on ${App.views.files.title('storage')} (SFTP storage)` : App.views.files.relRef(t.path);
    App.views.chat.ask(s.isEmpty() ? `In ${where}: ` : `In ${where}, lines ${s.startLineNumber}-${s.endLineNumber}: `);
  };

  E.previewCurrent = () => { const t = E.cur(); if (t && t.kind === 'file') E.preview(t.path, { remote: t.remote, storage: t.storage }); };

  // ---------- previews ----------
  E.preview = function (path, { remote, storage } = {}) {
    const ext = App.ext(path);
    const renderable = ['qmd', 'rmd', 'ipynb'].includes(ext);
    const away = remote || storage;
    return E.openCustom({
      key: 'preview:' + prefix({ remote, storage }) + path, title: App.basename(path), badge: 'Preview',
      render: (el, tab) => {
        const frameWrap = h('div', { style: { flex: 1, display: 'flex', minHeight: 0 } });
        const status = h('span.hint');
        const log = h('pre.logbox.small', { hidden: true });
        const auto = h('input', { type: 'checkbox', checked: true });
        const bar = h('div.toolbar',
          h('span.path', (remote ? 'HPC: ' : storage ? App.views.files.title('storage') + ': ' : '') + path), status,
          renderable && !away ? h('label.check', auto, 'Re-render on save') : null,
          h('button.btn.small', { onclick: () => load(true) }, renderable ? 'Render' : 'Reload'),
          h('button.btn.small', { onclick: () => tab.localFile && codeome.shell.openPath(tab.localFile) }, 'Open externally'));
        el.append(bar, frameWrap, log);
        let unlog = null;
        async function load(force) {
          let file = path;
          if (away) {
            status.textContent = 'Fetching…';
            const r = remote ? await codeome.preview.fetchRemote(path) : await codeome.storage.fetch(path);
            if (r.error) { status.textContent = ''; return App.err(r.error); }
            file = r.local;
          }
          if (renderable) {
            if (away) { status.textContent = 'Rendering remote notebooks is not supported — render where the file lives, then preview the HTML.'; return; }
            status.innerHTML = ''; status.append(h('span.spinner'), ' Rendering…');
            log.hidden = false; log.textContent = '';
            unlog = codeome.preview.onLog((s) => { log.textContent += s; log.scrollTop = log.scrollHeight; });
            const r = await codeome.preview.render(file);
            unlog && unlog(); unlog = null;
            if (r.error) { status.textContent = 'Render failed'; log.textContent += '\n' + r.error; return; }
            file = r.html; log.hidden = true; status.textContent = 'Rendered ' + new Date().toLocaleTimeString();
          } else status.textContent = '';
          tab.localFile = file;
          frameWrap.innerHTML = '';
          const url = 'file://' + file + '?t=' + Date.now();
          if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(App.ext(file))) frameWrap.append(h('div.preview-img', h('img', { src: url, alt: App.basename(file) })));
          else frameWrap.append(h('iframe.preview-frame', { src: url, title: 'Preview of ' + App.basename(file) }));
        }
        tab.reload = load;
        tab.autoRender = () => auto.checked;
        load();
      }
    });
  };
  App.listen('saved', (t) => {
    const pv = E.tabs.find((x) => x.key === 'preview:' + prefix(t) + t.path);
    if (pv && pv.reload && (!pv.autoRender || pv.autoRender())) pv.reload(true);
  });

  // ---------- Google Docs ----------
  // Google Drive for desktop's pointer files open as the live Google editor: a native view that the main process
  // lays over `host`. It sits above the page, so it is hidden whenever the tab is not shown, a dialog, menu or popover is up,
  // or a page such as Settings covers the editor.
  const GDOC = ['gdoc', 'gsheet', 'gslides'];
  E.isGdoc = (p) => GDOC.includes(App.ext(p));
  E.gdoc = function (path) {
    return E.openCustom({
      key: 'gdoc:' + path, title: App.basename(path).replace(/\.[^.]+$/, ''), badge: 'Google',
      render: (el, tab) => {
        const host = h('div', { style: { flex: 1, minHeight: 0 } });
        const status = h('span.hint');
        let url = '', original = false;
        // In dark mode the document is shown with flipped colours; the button switches this tab back to Google's own.
        const flip = h('button.btn.small', { onclick: () => { original = !original; tab.gdocDark(); } });
        tab.gdocDark = () => {
          const t = document.documentElement.dataset.theme;
          const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
          flip.hidden = !dark;
          flip.textContent = original ? 'Dark colours' : 'Original colours';
          flip.title = original ? 'Show this document with flipped, dark colours' : 'Show this document in Google\u2019s own colours';
          codeome.gdoc.dark(tab.id, dark && !original);
        };
        tab.gdocDark();
        el.append(h('div.toolbar', h('span.path', path), status, flip,
          h('button.btn.small', { title: 'Ask the agent to read or edit this document', onclick: () => App.views.chat.ask(`In the Google document ${App.views.files.relRef(path)}: `) }, 'Ask the agent'),
          h('button.btn.small', { onclick: () => codeome.gdoc.reload(tab.id) }, 'Reload'),
          h('button.btn.small', { onclick: () => url && codeome.shell.open(url) }, 'Open in browser')), host);
        const layers = ['overlay', 'menu-pop'].map((id) => document.getElementById(id));
        const place = () => {
          const r = host.getBoundingClientRect();
          const covered = () => !host.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
          const shown = host.isConnected && r.width > 0 && r.height > 0 && layers.every((l) => l.hidden) && !document.querySelector('.popover') && !covered();
          let { x, y, width, height } = r;
          // The page is a native view above the DOM: make room for toasts (bottom right) and tooltips (which open downwards).
          const over = (el) => { const b = el && el.getBoundingClientRect(); return b && b.width && b.height && b.left < x + width && b.right > x && b.top < y + height && b.bottom > y ? b : null; };
          const toasts = over(document.getElementById('toasts'));
          if (toasts && toasts.top > y) height = toasts.top - 8 - y;
          const tip = over(document.getElementById('tip'));
          if (tip) { const d = tip.bottom + 4 - y; if (d > 0 && d < height) { y += d; height -= d; } }
          codeome.gdoc.place(tab.id, shown && height > 0 ? { x, y, width, height } : null);
        };
        const ro = new ResizeObserver(place); ro.observe(host);
        const mo = new MutationObserver(place); for (const l of layers) mo.observe(l, { attributes: true, attributeFilter: ['hidden'] });
        mo.observe(document.body, { childList: true });
        mo.observe(document.getElementById('toasts'), { childList: true });
        mo.observe(document.getElementById('app'), { attributes: true, attributeFilter: ['class'] });
        window.addEventListener('resize', place);
        const off = codeome.gdoc.onState((s) => {
          if (s.id !== tab.id) return;
          url = s.url;
          const signIn = /^https:\/\/accounts\.google\./.test(s.url);
          status.textContent = s.error ? s.error : signIn ? 'Sign in to Google to open this document.' : s.loading ? 'Loading…' : '';
        });
        tab.layout = place;
        tab.onClose = () => { ro.disconnect(); mo.disconnect(); window.removeEventListener('resize', place); off(); codeome.gdoc.close(tab.id); };
        codeome.gdoc.open(tab.id, path).then((r) => { if (r.error) status.textContent = r.error; else { url = r.url; place(); tab.gdocDark(); } });
      }
    });
  };

  // ---------- diff tabs ----------
  E.diff = function ({ key, title, original, modified, lang }) {
    return E.openCustom({
      key, title, badge: 'Diff',
      render: (el, tab) => {
        const host = h('div.diff-host');
        el.append(host);
        const d = monaco.editor.createDiffEditor(host, { readOnly: true, automaticLayout: true, renderSideBySide: true, fontFamily: '"SF Mono", Menlo, monospace', fontSize: App.cfg.editor.fontSize || 13, minimap: { enabled: false } });
        const a = monaco.editor.createModel(original, lang), b = monaco.editor.createModel(modified, lang);
        d.setModel({ original: a, modified: b });
        tab.onClose = () => { d.dispose(); a.dispose(); b.dispose(); };
        tab.layout = () => d.layout();
      }
    });
  };

  E.layout = () => { if (E.editor) E.editor.layout(); const t = E.cur(); if (t && t.layout) t.layout(); };

  let dragId = null;
  const clearDrop = () => document.querySelectorAll('#tabs .drop-before,#tabs .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));

  function renderTabs() {
    const el = document.getElementById('tabs'); el.innerHTML = '';
    App.emit('sessions');
    for (const t of E.visible()) {
      const tabEl = h('div.tab' + (t.id === E.active ? '.active' : '') + (t.dirty ? '.dirty' : ''), {
        draggable: 'true',
        ondragstart: (e) => { dragId = t.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.title); },
        ondragend: () => { dragId = null; clearDrop(); },
        ondragover: (e) => {
          if (!dragId || dragId === t.id) return;
          e.preventDefault();
          const r = tabEl.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
          tabEl.classList.toggle('drop-after', after); tabEl.classList.toggle('drop-before', !after);
        },
        ondragleave: () => tabEl.classList.remove('drop-before', 'drop-after'),
        ondrop: (e) => {
          e.preventDefault();
          const from = E.tabs.find((x) => x.id === dragId);
          if (!from || from === t) return;
          const after = tabEl.classList.contains('drop-after');
          dragId = null;
          E.tabs.splice(E.tabs.indexOf(from), 1);
          E.tabs.splice(E.tabs.indexOf(t) + (after ? 1 : 0), 0, from);
          renderTabs();
        },
        onclick: () => E.activate(t.id), title: t.path ? (t.remote ? 'HPC: ' : t.storage ? App.views.files.title('storage') + ': ' : '') + t.path : t.title,
        onauxclick: (e) => { if (e.button === 1) E.close(t.id); },
        oncontextmenu: (e) => {
          e.preventDefault();
          App.menu(e.clientX, e.clientY, [
            { label: 'Copy name', run: () => navigator.clipboard.writeText(t.path ? App.basename(t.path) : t.title) },
            t.path ? { label: 'Copy path', run: () => navigator.clipboard.writeText(t.path) } : null,
            t.kind === 'file' || t.reload ? { label: 'Refresh', run: () => E.refresh(t) } : null,
            '-',
            { label: 'Close', run: () => E.close(t.id) }
          ]);
        }
      },
      t.remote ? h('span.badge.hpc', 'HPC') : t.storage ? h('span.badge.store', App.views.files.title('storage')) : (t.badge ? h('span.badge', t.badge) : null),
      h('span.t', t.title),
      h('button.x', { title: 'Close', onclick: (e) => { e.stopPropagation(); E.close(t.id); } }, h('span', '×')));
      el.append(tabEl);
    }
  }
  E.renderTabs = renderTabs;
})();
