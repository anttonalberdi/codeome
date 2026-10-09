// Publish view: Zenodo depositions and building/uploading Python packages to PyPI.
(function () {
  const h = App.h;
  const P = { deps: [], open: null, loading: false };
  App.views.publish = P;
  let root, zBody, pyBody;

  P.init = () => {
    root = document.querySelector('.view[data-view="publish"]');
    zBody = h('div'); pyBody = h('div');
    root.append(
      h('div.side-head', h('h2', 'Zenodo'), App.iconBtn('plus', 'New upload', () => P.create()), App.iconBtn('refresh', 'Refresh', () => P.load())), zBody,
      h('div.side-section', h('div.side-head', h('h2', 'Python package (PyPI)')), pyBody));
    codeome.zenodo.onProgress(({ file, p }) => { const s = document.getElementById('zprog'); if (s) s.textContent = `Uploading ${App.basename(file)} ${Math.round(p * 100)}%`; });
    App.listen('view', (v) => { if (v === 'publish') { if (!P.deps.length) P.load(); renderPy(); } });
    App.listen('project', renderPy);
  };

  P.load = async () => {
    const key = 'zenodo:' + (App.cfg.zenodo.sandbox ? 'sandbox' : 'prod');
    if (!(await codeome.secret.has(key))) {
      zBody.innerHTML = '';
      zBody.append(h('div.empty', `Add a Zenodo personal access token${App.cfg.zenodo.sandbox ? ' for the sandbox' : ''} (scopes: deposit:write, deposit:actions) to manage uploads here.`, h('br'),
        h('button.btn.small', { onclick: () => App.views.settings.open('zenodo') }, 'Add token')));
      return;
    }
    zBody.innerHTML = ''; zBody.append(h('div.empty', h('span.spinner'), ' Loading uploads…'));
    const r = await codeome.zenodo.list();
    if (r.error) { zBody.innerHTML = ''; zBody.append(h('div.empty', r.error)); return; }
    P.deps = r.data; renderZ();
  };

  function renderZ() {
    zBody.innerHTML = '';
    zBody.append(h('div.pad', { style: { paddingTop: 0 } }, h('label.check', h('input', { type: 'checkbox', checked: App.cfg.zenodo.sandbox, onchange: (e) => { App.cfg.zenodo.sandbox = e.target.checked; App.saveConfig(); P.deps = []; P.load(); } }), 'Use the Zenodo sandbox (for testing)')));
    if (!P.deps.length) { zBody.append(h('div.empty', 'No uploads yet.', h('br'), h('button.btn.small', { onclick: () => P.create() }, 'New upload'))); return; }
    for (const d of P.deps) {
      const open = P.open === d.id;
      const card = h('div.card' + (open ? '.open' : ''),
        h('div.row', { style: { cursor: 'pointer' }, onclick: () => { P.open = open ? null : d.id; renderZ(); } },
          h('h3.grow', d.title), h('span.pill' + (d.submitted ? '.ok' : '.warn'), d.submitted ? 'published' : 'draft')),
        h('div.sub', d.doi ? 'DOI ' + d.doi : 'No DOI yet', ' · ', d.files.length + ' file' + (d.files.length === 1 ? '' : 's')));
      if (open) {
        const files = h('div', { style: { margin: '6px 0' } }, d.files.map((f) => h('div.hint', `${f.name} · ${App.fmtSize(f.size)}`)));
        card.append(files, h('div#zprog.hint'),
          h('div.row.wrap', { style: { marginTop: '6px' } },
            !d.submitted ? h('button.btn.small', { onclick: () => P.upload(d) }, 'Add files…') : null,
            !d.submitted ? h('button.btn.small', { onclick: () => P.edit(d) }, 'Edit details…') : null,
            !d.submitted ? h('button.btn.small.primary', { onclick: () => P.publish(d) }, 'Publish…') : h('button.btn.small', { onclick: () => P.newVersion(d) }, 'New version'),
            d.html ? h('button.btn.small.ghost', { onclick: () => codeome.shell.open(d.html) }, 'Open on Zenodo') : null));
      }
      zBody.append(card);
    }
  }

  function metaFields(m = {}) {
    const creators = (m.creators || []).map((c) => c.name + (c.affiliation ? ' | ' + c.affiliation : '') + (c.orcid ? ' | ' + c.orcid : '')).join('\n');
    return [
      { key: 'title', label: 'Title', value: m.title || '' },
      { key: 'upload_type', label: 'Type', type: 'select', value: m.upload_type || 'dataset', options: [
        { value: 'dataset', label: 'Dataset' }, { value: 'software', label: 'Software' }, { value: 'publication', label: 'Publication' }, { value: 'poster', label: 'Poster' }, { value: 'presentation', label: 'Presentation' }, { value: 'image', label: 'Image' }, { value: 'other', label: 'Other' }] },
      { key: 'description', label: 'Description', type: 'textarea', value: m.description || '' },
      { key: 'creators', label: 'Creators', type: 'textarea', rows: 3, value: creators, hint: 'One per line: Family, Given | Affiliation | ORCID (affiliation and ORCID optional)' },
      { key: 'keywords', label: 'Keywords', value: (m.keywords || []).join(', '), placeholder: 'comma separated' },
      { key: 'license', label: 'License', value: (m.license && (m.license.id || m.license)) || 'cc-by-4.0' },
      { key: 'access_right', label: 'Access', type: 'select', value: m.access_right || 'open', options: ['open', 'embargoed', 'restricted', 'closed'] }
    ];
  }
  function toMeta(v) {
    const creators = v.creators.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, affiliation, orcid] = l.split('|').map((s) => s.trim());
      return { name, ...(affiliation ? { affiliation } : {}), ...(orcid ? { orcid } : {}) };
    });
    return { title: v.title, upload_type: v.upload_type, description: v.description || v.title, creators, license: v.license, access_right: v.access_right,
      keywords: v.keywords.split(',').map((s) => s.trim()).filter(Boolean) };
  }

  P.create = async () => {
    const v = await App.modal({ title: 'New Zenodo upload', text: 'Creates a draft. Nothing is public until you publish it.', ok: 'Create draft', fields: metaFields() });
    if (!v) return;
    if (!v.title.trim() || !v.creators.trim()) return App.err('A title and at least one creator are required.');
    const r = await codeome.zenodo.create(toMeta(v));
    if (r.error) return App.err(r.error);
    P.open = r.data.id; App.toast('Draft created.'); P.load();
  };
  P.edit = async (d) => {
    const v = await App.modal({ title: 'Edit details', ok: 'Save', fields: metaFields(d.metadata) });
    if (!v) return;
    const r = await codeome.zenodo.update({ id: d.id, metadata: toMeta(v) });
    if (r.error) return App.err(r.error);
    App.toast('Saved.'); P.load();
  };
  P.upload = async (d) => {
    const files = await codeome.dialog.files({ defaultPath: App.project });
    for (const f of files) {
      const r = await codeome.zenodo.upload({ id: d.id, file: f });
      if (r.error) { App.err(r.error); break; }
    }
    if (files.length) { App.toast(`Added ${files.length} file${files.length > 1 ? 's' : ''}.`); P.load(); }
  };
  P.publish = async (d) => {
    const ok = await App.confirm(`Publish "${d.title}"?`, `This mints a permanent DOI on ${App.cfg.zenodo.sandbox ? 'the Zenodo sandbox' : 'Zenodo'}. Published files can't be changed or deleted — only superseded by a new version.`, 'Publish', true);
    if (!ok) return;
    const r = await codeome.zenodo.publish(d.id);
    if (r.error) return App.err(r.error);
    App.toast('Published. DOI ' + (r.data.doi || '')); P.load();
  };
  P.newVersion = async (d) => {
    const r = await codeome.zenodo.newVersion(d.id);
    if (r.error) return App.err(r.error);
    P.open = r.data.id; App.toast('New version draft created.'); P.load();
  };

  // ---------- PyPI ----------
  async function renderPy() {
    pyBody.innerHTML = '';
    if (!App.project) { pyBody.append(h('div.empty', 'Open a project folder with a pyproject.toml to build and upload it.')); return; }
    const has = await codeome.local.read(App.join(App.project, 'pyproject.toml'));
    if (has.error) { pyBody.append(h('div.empty', `No pyproject.toml in ${App.basename(App.project)}.`)); return; }
    const name = (has.content.match(/^\s*name\s*=\s*["']([^"']+)/m) || [])[1] || App.basename(App.project);
    const version = (has.content.match(/^\s*version\s*=\s*["']([^"']+)/m) || [])[1] || 'dynamic';
    const [test, prod] = await Promise.all([codeome.pip.hasToken('testpypi'), codeome.pip.hasToken('pypi')]);
    const py = App.cfg.python.local;
    const build = `${py} -m pip install -q --upgrade build twine && rm -rf dist && ${py} -m build && ${py} -m twine check dist/*`;
    pyBody.append(h('div.pad.form',
      h('div', h('b', name), ' ', h('span.pill', version)),
      h('div.row.wrap',
        h('button.btn.small', { onclick: () => App.views.terminals.task('build ' + name, build, App.project) }, 'Build'),
        h('button.btn.small', { disabled: !test, onclick: () => App.views.terminals.task('TestPyPI', `${build} && ${py} -m twine upload --repository-url https://test.pypi.org/legacy/ dist/*`, App.project, { secretEnv: 'pypi:testpypi' }) }, 'Upload to TestPyPI'),
        h('button.btn.small.primary', { disabled: !prod, onclick: async () => {
          if (!(await App.confirm(`Upload ${name} ${version} to PyPI?`, 'Anyone will be able to install this version, and a version number can never be reused on PyPI.', 'Upload to PyPI', true))) return;
          App.views.terminals.task('PyPI', `${build} && ${py} -m twine upload dist/*`, App.project, { secretEnv: 'pypi:pypi' });
        } }, 'Upload to PyPI')),
      (!test || !prod) ? h('div.hint', 'Add PyPI API tokens in Settings to enable uploads. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); App.views.settings.open('pypi'); } }, 'Add tokens')) : null));
  }
})();
