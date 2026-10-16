// Packages view: stacked sections for Python and R, like the sections in Files.
// Python lists pip packages; R lists every library in .libPaths() with its packages.
// Both work on this Mac or on the HPC. The R section shows in R projects, or when
// turned on from the Python section's menu.
(function () {
  const h = App.h;
  const P = {
    py: { where: 'local', pkgs: [], filter: '' },
    r: { where: 'local', data: null, filter: '', shut: {}, old: null, project: null }
  };
  App.views.packages = P;
  const UI = {};

  P.init = () => {
    const root = document.querySelector('.view[data-view="packages"]');
    root.classList.add('files-view');
    P.stack = App.stack({ key: 'pkgPanes', sections: [pySection(), rSection()] });
    root.append(P.stack.el);
    App.listen('view', (v) => { if (v === 'packages') P.loadVisible(); });
    App.listen('project', () => { P.r.data = null; P.r.old = null; if (!App.isIdeas()) { detectR(); if (App.currentView === 'packages') P.loadVisible(); } });
    App.listen('hpc', () => { for (const k of ['py', 'r']) if (P[k].where === 'hpc') (k === 'py' ? P.loadPy : P.loadR)(); });
    detectR();
  };
  P.loadVisible = () => {
    if (P.stack.isOpen('python') && !P.py.pkgs.length) P.loadPy();
    if (P.stack.isOpen('r') && !P.r.data) P.loadR();
  };

  // ---------- Python ----------
  function pySection() {
    const whereSel = whereSelect('Python environment', (v) => { P.py.where = v; UI.pyInput.value = App.cfg.python[v === 'hpc' ? 'remote' : 'local']; P.loadPy(); });
    UI.pyInput = h('input', { type: 'text', value: App.cfg.python.local, spellcheck: 'false', 'aria-label': 'Python command', title: 'Python interpreter, e.g. python3, ~/miniforge3/envs/x/bin/python',
      onchange: () => { App.cfg.python[P.py.where === 'hpc' ? 'remote' : 'local'] = UI.pyInput.value.trim(); App.saveConfig(); P.loadPy(); } });
    const install = h('input', { type: 'text', placeholder: 'package name, e.g. pandas>=2', spellcheck: 'false', 'aria-label': 'Python package to install',
      onkeydown: (e) => { if (e.key === 'Enter') go(); } });
    const go = () => { if (install.value.trim()) { pyRun('install', `install --upgrade ${install.value.trim()}`); install.value = ''; } };
    const filter = h('input', { type: 'text', placeholder: 'Filter installed', 'aria-label': 'Filter installed Python packages', oninput: () => { P.py.filter = filter.value.toLowerCase(); renderPy(); } });
    UI.pyList = h('div.flist');
    return {
      id: 'python', title: 'Python',
      tools: [App.iconBtn('refresh', 'Refresh', () => P.loadPy())],
      menu: () => [
        { label: 'Python settings…', run: () => App.views.settings.open('python') },
        '-', ...P.stack.items('python')],
      items: () => [rToggleItem()],
      body: [h('div.pad.form.pkg-form', h('div.row', whereSel, UI.pyInput), h('div.row', install, h('button.btn.small', { onclick: go }, 'Install')), filter), UI.pyList],
      onExpand: () => { if (!P.py.pkgs.length) P.loadPy(); }
    };
  }

  function pyRun(title, args) {
    const cmd = `${UI.pyInput.value.trim()} -m pip ${args}`;
    if (P.py.where === 'hpc') { if (!App.requireHpc()) return; App.views.terminals.hpcTask('pip ' + title, cmd, '~'); setTimeout(P.loadPy, 8000); }
    else App.views.terminals.open({ kind: 'task', title: 'pip ' + title, command: cmd, cwd: App.project || '~', badge: 'Mac', onExit: () => P.loadPy() });
    setTimeout(P.loadPy, 15000);
  }

  P.loadPy = async () => {
    const list = UI.pyList;
    if (P.py.where === 'hpc' && !App.hpcConnected) { list.innerHTML = ''; list.append(h('div.empty', 'Connect to the HPC to list its packages.')); return; }
    list.innerHTML = ''; list.append(h('div.empty', h('span.spinner'), ' Reading packages…'));
    const r = await codeome.pip.list({ where: P.py.where, python: UI.pyInput.value.trim(), cwd: App.project });
    if (r.error) { list.innerHTML = ''; list.append(h('div.empty', r.error.split('\n').slice(-3).join('\n'))); return; }
    P.py.pkgs = r.packages; renderPy();
  };

  function renderPy() {
    const list = UI.pyList; list.innerHTML = '';
    const pk = P.py.pkgs.filter((p) => !P.py.filter || p.name.toLowerCase().includes(P.py.filter));
    if (!pk.length) { list.append(h('div.empty', P.py.filter ? 'No installed package matches.' : 'No packages found.')); return; }
    for (const p of pk) list.append(h('div.pkg', h('span', p.name), h('span.v', p.version),
      h('span.row', { style: { gap: '0' } },
        App.iconBtn('up', 'Upgrade', () => pyRun('upgrade', `install --upgrade ${p.name}`)),
        App.iconBtn('trash', 'Uninstall', async () => { if (await App.confirm(`Uninstall ${p.name}?`, `Removes ${p.name} ${p.version} from ${P.py.where === 'hpc' ? 'the HPC' : 'this Mac'} environment.`, 'Uninstall', true)) pyRun('uninstall', `uninstall -y ${p.name}`); }))));
  }

  // ---------- R ----------
  const SOURCES = [{ value: 'cran', label: 'CRAN' }, { value: 'bioc', label: 'Bioconductor' }, { value: 'github', label: 'GitHub' }];
  function rSection() {
    const whereSel = whereSelect('R installation', (v) => { P.r.where = v; P.r.data = null; P.r.old = null; P.loadR(); });
    UI.rVersion = h('span.hint.r-ver');
    const source = h('select', { 'aria-label': 'Install from', title: 'Where to install from' }, SOURCES.map((s) => h('option', { value: s.value }, s.label)));
    const install = h('input', { type: 'text', spellcheck: 'false', 'aria-label': 'R packages to install', placeholder: 'e.g. vegan, or user/repo',
      onkeydown: (e) => { if (e.key === 'Enter') go(); } });
    const go = () => {
      const names = install.value.split(/[\s,]+/).filter(Boolean);
      if (!names.length) return;
      if (names.some((n) => !/^[\w.@#:/-]+$/.test(n))) return App.err('Package names can only have letters, digits and . _ - / @ #');
      // user/repo means GitHub, whatever the menu says.
      const src = names.every((n) => n.includes('/')) ? 'github' : source.value;
      rRun('install ' + names.join(' '), installCode(src, names));
      install.value = '';
    };
    const filter = h('input', { type: 'text', placeholder: 'Filter installed', 'aria-label': 'Filter installed R packages', oninput: () => { P.r.filter = filter.value.toLowerCase(); renderR(); } });
    UI.rList = h('div.flist');
    return {
      id: 'r', title: 'R libraries',
      tools: [App.iconBtn('refresh', 'Refresh', () => P.loadR())],
      menu: () => {
        const outdated = outdatedList();
        return [
          { label: 'Check for updates', run: () => P.loadR({ outdated: true }) },
          { label: outdated.length ? `Update ${outdated.length} outdated package${outdated.length > 1 ? 's' : ''}` : 'Update outdated packages', disabled: !outdated.length, run: () => updateAll(outdated) },
          '-',
          { label: 'R settings…', run: () => App.views.settings.open('r') },
          '-', ...P.stack.items('r')];
      },
      items: () => [rToggleItem()],
      body: [h('div.pad.form.pkg-form', h('div.row', whereSel, UI.rVersion), h('div.row', source, install, h('button.btn.small', { onclick: go }, 'Install')), filter), UI.rList],
      onExpand: () => { if (!P.r.data) P.loadR(); }
    };
  }

  // Shown in R projects unless hidden from the menu; turned on by hand anywhere.
  const rShown = () => { const s = P.stack.cfg('r').shown; return s === undefined ? !!P.r.project : s; };
  function rToggleItem() {
    const on = rShown();
    return { label: on ? 'Hide R libraries' : 'Show R libraries', run: () => { P.stack.cfg('r').shown = !on; App.saveConfig(); applyR(); } };
  }
  function applyR() { P.stack.setHidden('r', !rShown()); if (rShown() && P.stack.isOpen('r') && !P.r.data && App.currentView === 'packages') P.loadR(); }

  // An R project: an .Rproj, a package (DESCRIPTION), renv, or R and R Markdown files at the top.
  const R_MARKERS = ['DESCRIPTION', 'NAMESPACE', 'renv.lock', 'renv', '.Rprofile'];
  P.isRProject = (names) => names.some((n) => R_MARKERS.includes(n) || /\.(rproj|r|rmd)$/i.test(n));
  async function detectR() {
    const dir = App.project;
    P.r.project = null; applyR();
    if (!dir) return;
    const r = await codeome.local.list(dir);
    if (dir !== App.project || r.error) return;
    P.r.project = P.isRProject(r.entries.map((e) => e.name)) ? dir : null;
    applyR();
  }

  const rWhere = () => (P.r.where === 'hpc' ? { remote: true, cwd: App.remoteDir || '~' } : { remote: false, cwd: App.project || '~' });
  // Runs R code in a terminal (in the project folder, so renv installs into the project library).
  function rRun(title, code) {
    const rcmd = (P.r.where === 'hpc' ? App.cfg.r.remote : App.cfg.r.local) || 'R --no-save --quiet';
    const cmd = `${rcmd} -s -e ${App.shq(REPOS + code)}`;
    const t = 'R ' + (title.length > 40 ? title.slice(0, 39) + '…' : title);
    if (P.r.where === 'hpc') { if (!App.requireHpc()) return; App.views.terminals.hpcTask(t, cmd, rWhere().cwd); setTimeout(() => P.loadR(), 20000); }
    else App.views.terminals.open({ kind: 'task', title: t, command: cmd, cwd: rWhere().cwd, badge: 'Mac', onExit: () => P.loadR() });
  }
  // A CRAN mirror when none is set, so install.packages() doesn't ask.
  const REPOS = 'local({ r <- getOption("repos"); if (is.null(r) || identical(unname(r["CRAN"]), "@CRAN@")) options(repos = c(CRAN = "https://cloud.r-project.org")) }); ';
  const vec = (names) => `c(${names.map((n) => JSON.stringify(n)).join(', ')})`;
  const need = (pkg) => `if (!requireNamespace("${pkg}", quietly = TRUE)) install.packages("${pkg}"); `;
  function installCode(src, names, lib) {
    const at = lib ? `, lib = ${JSON.stringify(lib)}` : '';
    if (src === 'bioc') return need('BiocManager') + `BiocManager::install(${vec(names)}, update = FALSE, ask = FALSE${at})`;
    if (src === 'github') return need('remotes') + `remotes::install_github(${vec(names)}${at})`;
    return `install.packages(${vec(names)}${at})`;
  }
  const sourceOf = (p) => (p.source === 'bioc' ? 'bioc' : /^(github|gitlab|bitbucket|git)$/.test(p.source) ? 'remote' : 'cran');
  function updateCode(p, lib) {
    const s = sourceOf(p);
    if (s === 'remote') return need('remotes') + `remotes::update_packages(${JSON.stringify(p.name)}, upgrade = "never")`;
    return installCode(s, [p.name], lib);
  }
  function outdatedList() {
    if (!P.r.old || !P.r.data) return [];
    const out = [];
    for (const l of P.r.data.libs) if (l.writable) for (const p of l.pkgs) if (P.r.old[l.path + '\t' + p.name]) out.push({ p, lib: l.path });
    return out;
  }
  function updateAll(list) {
    const bioc = list.filter((x) => sourceOf(x.p) === 'bioc').map((x) => x.p.name);
    const cran = list.filter((x) => sourceOf(x.p) === 'cran').map((x) => x.p.name);
    const code = [cran.length ? installCode('cran', cran) : '', bioc.length ? installCode('bioc', bioc) : ''].filter(Boolean).join('; ');
    if (code) rRun(`update ${list.length} packages`, code);
  }

  P.loadR = async ({ outdated = false } = {}) => {
    const list = UI.rList;
    if (P.r.where === 'hpc' && !App.hpcConnected) { list.innerHTML = ''; list.append(h('div.empty', 'Connect to the HPC to list its R libraries.')); return; }
    list.innerHTML = ''; list.append(h('div.empty', h('span.spinner'), outdated ? ' Checking the repositories for updates…' : ' Reading R libraries…'));
    const where = P.r.where;
    const r = await codeome.rpkg.list({ where, cwd: rWhere().cwd, outdated });
    if (where !== P.r.where) return;
    if (r.error) {
      list.innerHTML = '';
      list.append(h('div.empty', r.error, h('br'), h('button.btn.small', { onclick: () => App.views.settings.open('r') }, 'R settings')));
      return;
    }
    P.r.data = r;
    if (outdated) { P.r.old = r.old; const n = outdatedList().length; App.toast(n ? `${n} R package${n > 1 ? 's have' : ' has'} an update.` : 'All R packages are up to date.'); }
    UI.rVersion.textContent = r.r ? 'R ' + r.r : '';
    renderR();
  };

  // "renv", "User", "Site", "System" from where a library lives.
  P.libLabel = (lib, home) => {
    const p = lib.path;
    if (/\/renv\/(library|staging)\//.test(p)) return 'Project (renv)';
    if (lib.pkgs.some((x) => x.priority === 'base')) return 'System';
    if (/site-library/.test(p)) return 'Site';
    if ((home && p.startsWith(home + '/')) || /^\/(home|Users)\//.test(p)) return 'User';
    return 'Library';
  };

  function renderR() {
    const list = UI.rList; list.innerHTML = '';
    const d = P.r.data; if (!d) return;
    const f = P.r.filter;
    let shown = 0;
    for (const lib of d.libs) {
      const pk = lib.pkgs.filter((p) => !f || p.name.toLowerCase().includes(f));
      if (f && !pk.length) continue;
      const label = P.libLabel(lib, App.env.home);
      // The system library starts folded when there are others; a filter opens every group.
      const shut = !f && (P.r.shut[lib.path] ?? (label === 'System' && d.libs.length > 1));
      const head = h('button.lib-head', { 'aria-expanded': String(!shut), title: lib.path + (lib.writable ? '' : '\nRead-only: packages here can only be changed by an administrator'),
        onclick: () => { P.r.shut[lib.path] = !shut; renderR(); } },
        h('span.chev', { html: '<svg viewBox="0 0 16 16"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>' }),
        h('span.lib-name', label), h('span.lib-path', '\u200e' + App.tildify(lib.path) + '\u200e'), lib.writable ? null : h('span.lib-ro', 'read-only'), h('span.lib-n', String(pk.length)));
      list.append(head);
      if (shut) continue;
      for (const p of pk) { list.append(rRow(p, lib)); shown++; }
    }
    if (!list.children.length) list.append(h('div.empty', f ? 'No installed R package matches.' : 'No R packages found.'));
    else if (f && !shown) list.append(h('div.empty', 'Matches are in folded libraries.'));
  }

  const TAGS = { bioc: 'Bioc', github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', git: 'git', url: 'url', local: 'local' };
  function rRow(p, lib) {
    const newer = P.r.old && P.r.old[lib.path + '\t' + p.name];
    const tag = TAGS[p.source] || (p.priority === 'base' ? 'base' : '');
    const fixed = !lib.writable || p.priority === 'base';
    return h('div.pkg.rpkg', { title: `${p.name} ${p.version}${p.source ? ' · ' + p.source : ''}\n${lib.path}` },
      h('span.nm', p.name, tag ? h('span.src', tag) : null),
      h('span.v', p.version, newer ? h('span.newer', ' → ' + newer) : null),
      h('span.row', { style: { gap: '0' } },
        App.iconBtn('terminal', 'Load in the R console: library(' + p.name + ')', () => App.views.terminals.sendR(`library(${p.name})`, rWhere())),
        fixed ? null : App.iconBtn('up', newer ? 'Update to ' + newer : 'Reinstall the latest version', () => rRun('update ' + p.name, updateCode(p, lib.path))),
        fixed ? null : App.iconBtn('trash', 'Remove', async () => {
          if (await App.confirm(`Remove ${p.name}?`, `Removes ${p.name} ${p.version} from ${App.tildify(lib.path)} on ${P.r.where === 'hpc' ? 'the HPC' : 'this Mac'}.`, 'Remove', true)) {
            rRun('remove ' + p.name, `remove.packages(${JSON.stringify(p.name)}, lib = ${JSON.stringify(lib.path)})`);
          }
        })));
  }

  function whereSelect(label, onchange) {
    const sel = h('select', { 'aria-label': label, onchange: () => onchange(sel.value) },
      h('option', { value: 'local' }, 'This Mac'), h('option', { value: 'hpc' }, 'HPC'));
    return sel;
  }
})();
