// Centre stage: Monaco file tabs plus custom tabs (previews, diffs, job logs).
(function () {
  const h = App.h;
  const E = { tabs: [], active: null, editor: null, seq: 0 };
  App.views.editor = E;

  const LANG = {
    r: 'r', R: 'r', rmd: 'markdown', qmd: 'markdown', md: 'markdown', py: 'python', ipynb: 'json', sh: 'shell', bash: 'shell', zsh: 'shell',
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

    E.editor.addAction({ id: 'codeome.send', label: 'Run line or selection in terminal', keybindings: [m.KeyMod.CtrlCmd | m.KeyCode.Enter], contextMenuGroupId: 'navigation', contextMenuOrder: 0, run: (ed) => E.sendSelection(ed) });
    E.editor.addAction({ id: 'codeome.sendFile', label: 'Run whole file in terminal', keybindings: [m.KeyMod.CtrlCmd | m.KeyMod.Shift | m.KeyCode.Enter], contextMenuGroupId: 'navigation', contextMenuOrder: 1, run: () => E.runFile() });
    E.editor.addAction({ id: 'codeome.preview', label: 'Preview / render', contextMenuGroupId: 'navigation', contextMenuOrder: 2, run: () => E.previewCurrent() });
    E.editor.addAction({ id: 'codeome.sbatch', label: 'Submit to Slurm (sbatch)', contextMenuGroupId: 'navigation', contextMenuOrder: 3, run: () => { const t = E.cur(); if (t && t.remote) App.views.slurm.submit(t.path); else App.toast('Open the script from the HPC side to submit it.'); } });
    E.editor.addAction({ id: 'codeome.askAgent', label: 'Ask agent about selection…', contextMenuGroupId: 'navigation', contextMenuOrder: 4, run: (ed) => E.askAgent(ed) });
  };

  E.applyTheme = () => {
    const t = document.documentElement.dataset.theme;
    const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    if (window.monaco) monaco.editor.setTheme(dark ? 'codeome-dark' : 'codeome-light');
  };

  E.cur = () => E.tabs.find((t) => t.id === E.active);

  E.openFile = async function (path, opts = {}) {
    const remote = !!opts.remote;
    const key = (remote ? 'hpc:' : '') + path;
    const existing = E.tabs.find((t) => t.key === key);
    if (existing) { E.activate(existing.id); return existing; }
    if (E.isBinary(path)) { if (E.isPreviewable(path)) return E.preview(path, { remote }); App.toast(App.basename(path) + ' is a binary file.'); return; }
    const r = remote ? await codeome.remote.read(path) : await codeome.local.read(path);
    if (r.error) { App.err(r.error); return; }
    const uri = monaco.Uri.from({ scheme: remote ? 'hpc' : 'file', path: path.startsWith('/') ? path : '/' + path });
    const model = monaco.editor.getModel(uri) || monaco.editor.createModel(r.content, E.lang(path), uri);
    const tab = { id: 'e' + (++E.seq), key, kind: 'file', path, remote, title: App.basename(path), model, saved: model.getAlternativeVersionId(), viewState: null };
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
    const existing = E.tabs.find((t) => t.key === key);
    if (existing) { E.activate(existing.id); if (existing.onActivate) existing.onActivate(existing); return existing; }
    const el = h('div', { style: { display: 'contents' } });
    const tab = { id: 'e' + (++E.seq), key, kind: 'custom', title, badge, el, onActivate, onClose };
    E.tabs.push(tab);
    render(el, tab);
    E.activate(tab.id);
    return tab;
  };

  E.activate = function (id) {
    const prev = E.cur();
    if (prev && prev.kind === 'file' && E.editor) prev.viewState = E.editor.saveViewState();
    E.active = id;
    const t = E.cur();
    const monacoHost = document.getElementById('monaco-host');
    const alt = document.getElementById('alt-host');
    document.getElementById('welcome').hidden = !!t;
    if (!t) { monacoHost.hidden = true; alt.hidden = true; renderTabs(); return; }
    if (t.kind === 'file') {
      alt.hidden = true; monacoHost.hidden = false;
      E.editor.setModel(t.model);
      if (t.viewState) E.editor.restoreViewState(t.viewState);
      setTimeout(() => { E.editor.layout(); E.editor.focus(); });
    } else {
      monacoHost.hidden = true; alt.hidden = false;
      for (const c of [...alt.children]) alt.removeChild(c);
      alt.append(t.el);
      if (t.layout) setTimeout(t.layout);
    }
    renderTabs();
    App.emit('tab', t);
  };

  E.close = async function (id) {
    const t = E.tabs.find((x) => x.id === id); if (!t) return;
    if (t.dirty) {
      const r = await App.modal({ title: `Save changes to ${t.title}?`, text: 'Your changes will be lost if you close without saving.', ok: 'Save', cancel: 'Cancel', fields: [] });
      if (r === null) { const disc = await App.confirm('Discard changes?', `Close ${t.title} without saving.`, 'Discard', true); if (!disc) return; }
      else if (!(await E.save(t))) return;
    }
    if (t.kind === 'file') t.model.dispose();
    if (t.onClose) t.onClose(t);
    const i = E.tabs.indexOf(t);
    E.tabs.splice(i, 1);
    if (E.active === id) { const n = E.tabs[i] || E.tabs[i - 1]; E.active = null; E.activate(n ? n.id : null); } else renderTabs();
  };

  E.save = async function (t = E.cur()) {
    if (!t || t.kind !== 'file') return false;
    const content = t.model.getValue();
    const r = t.remote ? await codeome.remote.write(t.path, content) : await codeome.local.write(t.path, content);
    if (r.error) { App.err('Could not save: ' + r.error); return false; }
    t.saved = t.model.getAlternativeVersionId(); t.dirty = false; renderTabs();
    App.emit('saved', t);
    return true;
  };

  E.sendSelection = function (ed) {
    const sel = ed.getSelection(); const model = ed.getModel();
    let text;
    if (sel.isEmpty()) {
      text = model.getLineContent(sel.startLineNumber);
      const next = Math.min(sel.startLineNumber + 1, model.getLineCount());
      ed.setPosition({ lineNumber: next, column: 1 }); ed.revealLine(next);
    } else text = model.getValueInRange(sel);
    if (text.trim()) App.views.terminals.send(text.replace(/\r/g, ''));
  };

  E.runFile = async function () {
    const t = E.cur(); if (!t || t.kind !== 'file') return;
    if (t.dirty) await E.save(t);
    const ext = App.ext(t.path);
    const runner = { r: 'Rscript', py: App.cfg.python[t.remote ? 'remote' : 'local'], sh: 'bash', bash: 'bash' }[ext];
    if (!runner) return App.toast('No runner for .' + ext + ' files.');
    const cmd = `${runner} '${t.path.replace(/'/g, "'\\''")}'`;
    if (t.remote) App.views.terminals.hpcTask(t.title, cmd, App.dirname(t.path)); else App.views.terminals.task(t.title, cmd, App.dirname(t.path));
  };

  E.askAgent = async function (ed) {
    const sel = ed.getModel().getValueInRange(ed.getSelection());
    const t = E.cur();
    const q = await App.prompt('Ask an agent', 'What should it do with this code?', 'Explain this and suggest improvements', { ok: 'Send to agent' });
    if (!q) return;
    const ref = t ? `In ${t.path}${sel ? ' (selected lines ' + ed.getSelection().startLineNumber + '-' + ed.getSelection().endLineNumber + ')' : ''}: ` : '';
    const term = App.views.terminals.current();
    if (term && /claude|codex/i.test(term.title)) App.views.terminals.send(ref + q);
    else App.toast('Switch to a Claude Code or Codex session in the panel, then try again.');
  };

  E.previewCurrent = () => { const t = E.cur(); if (t && t.kind === 'file') E.preview(t.path, { remote: t.remote }); };

  // ---------- previews ----------
  E.preview = function (path, { remote } = {}) {
    const ext = App.ext(path);
    const renderable = ['qmd', 'rmd', 'ipynb'].includes(ext);
    return E.openCustom({
      key: 'preview:' + (remote ? 'hpc:' : '') + path, title: App.basename(path), badge: 'Preview',
      render: (el, tab) => {
        const frameWrap = h('div', { style: { flex: 1, display: 'flex', minHeight: 0 } });
        const status = h('span.hint');
        const log = h('pre.logbox.small', { hidden: true });
        const auto = h('input', { type: 'checkbox', checked: true });
        const bar = h('div.toolbar',
          h('span.path', (remote ? 'HPC: ' : '') + path), status,
          renderable && !remote ? h('label.check', auto, 'Re-render on save') : null,
          h('button.btn.small', { onclick: () => load(true) }, renderable ? 'Render' : 'Reload'),
          h('button.btn.small', { onclick: () => tab.localFile && codeome.shell.openPath(tab.localFile) }, 'Open externally'));
        el.append(bar, frameWrap, log);
        let unlog = null;
        async function load(force) {
          let file = path;
          if (remote) {
            status.textContent = 'Fetching from HPC…';
            const r = await codeome.preview.fetchRemote(path);
            if (r.error) { status.textContent = ''; return App.err(r.error); }
            file = r.local;
          }
          if (renderable) {
            if (remote) { status.textContent = 'Rendering remote notebooks is not supported — render on the HPC, then preview the HTML.'; return; }
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
    const pv = E.tabs.find((x) => x.key === 'preview:' + (t.remote ? 'hpc:' : '') + t.path);
    if (pv && pv.reload && (!pv.autoRender || pv.autoRender())) pv.reload(true);
  });

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

  function renderTabs() {
    const el = document.getElementById('tabs'); el.innerHTML = '';
    for (const t of E.tabs) {
      el.append(h('div.tab' + (t.id === E.active ? '.active' : '') + (t.dirty ? '.dirty' : ''), {
        onclick: () => E.activate(t.id), title: t.path ? (t.remote ? 'HPC: ' : '') + t.path : t.title,
        onauxclick: (e) => { if (e.button === 1) E.close(t.id); }
      },
      t.remote ? h('span.badge.hpc', 'HPC') : (t.badge ? h('span.badge', t.badge) : null),
      h('span.t', t.title),
      h('button.x', { title: 'Close', onclick: (e) => { e.stopPropagation(); E.close(t.id); } }, h('span', '×'))));
    }
  }
  E.renderTabs = renderTabs;
})();
