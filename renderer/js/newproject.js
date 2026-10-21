// Create a project from one of the templates supplied by the main process.
(function () {
  const h = App.h;
  const P = App.views.projects;

  // Keep this check in step with main/templates.js; the backend validates again.
  P.newProjectNameError = (type, name) => {
    if (!type) return 'Choose a project type.';
    if (typeof name !== 'string' || !name.trim()) return 'Enter a project name.';
    if (name.length > 100) return 'Project names must be at most 100 characters.';
    if (name.startsWith('.') || /[\\/\x00-\x1f\x7f]/.test(name) || name !== name.trim()) {
      return 'Use a name without path separators, leading dots or surrounding spaces.';
    }
    if (type === 'r-package' && !/^[A-Za-z][A-Za-z0-9.]*[A-Za-z0-9]$/.test(name) && !/^[A-Za-z]$/.test(name)) {
      return 'R package names must start with a letter and contain only letters, digits or dots, without a trailing dot.';
    }
    const importName = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    const pythonKeyword = 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' ').includes(importName);
    const moduleName = pythonKeyword ? importName + '_' : importName;
    if (type === 'python-package' && ((!/^[A-Za-z][A-Za-z0-9._-]*[A-Za-z0-9]$/.test(name) && !/^[A-Za-z]$/.test(name)) || !/^[a-z][a-z0-9_]*$/.test(moduleName))) {
      return 'Python package names must start with a letter and contain only letters, digits, dots, hyphens or underscores.';
    }
    return null;
  };
  P.newProjectAuthorError = (license, author) => license !== 'none' && !author.trim() ? 'Enter an author for this license.' : null;

  P.newProjectDefaults = (cfg = {}, identity = {}) => ({
    name: '', description: '',
    author: identity.effectiveName || identity.name || cfg.git?.name || cfg.author || '',
    email: identity.effectiveEmail || identity.email || cfg.git?.email || cfg.email || '',
    license: 'mit', git: true
  });

  P.newProjectPayload = (type, values) => ({
    type, name: values.name,
    opts: {
      description: values.description.trim(), author: values.author.trim(),
      email: values.email.trim(), license: values.license, git: values.git
    }
  });

  P.newProject = () => new Promise((resolve) => {
    const ov = document.getElementById('overlay');
    const root = App.cfg.projectsDir || '~/Codeome';
    let templates = null, loading = true, loadError = '', type = '', step = 1;
    let values = P.newProjectDefaults(App.cfg);
    let authorInput = null, emailInput = null, authorTouched = false, emailTouched = false, checkDetails = null;
    let busy = false, done = false, createError = '', nameServerError = '';

    const close = (dir = null) => {
      if (done) return;
      done = true;
      ov.hidden = true; ov.replaceChildren(); ov.onclick = null;
      document.removeEventListener('keydown', onKey, true);
      resolve(dir);
    };
    const onKey = (event) => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); close(); }
    };
    const emailError = () => values.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim()) ? 'Enter a valid email address.' : null;

    const field = (label, input, error) => h('label.field', h('span', label), input, error);
    const details = () => {
      const nameInput = h('input', { type: 'text', value: values.name, maxlength: 101, autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'new-project-name-error' });
      const nameError = h('div.agent-field-error#new-project-name-error', { role: 'alert' });
      const destination = h('div.hint');
      emailInput = h('input', { type: 'text', value: values.email, autocomplete: 'email', 'aria-describedby': 'new-project-email-error' });
      const emailMessage = h('div.agent-field-error#new-project-email-error', { role: 'alert' });
      const authorMessage = h('div.agent-field-error#new-project-author-error', { role: 'alert' });
      const create = h('button.btn.primary', { type: 'submit', form: 'new-project-form' }, 'Create project');
      const check = () => {
        const badName = P.newProjectNameError(type, values.name);
        const badEmail = emailError();
        const badAuthor = P.newProjectAuthorError(values.license, values.author);
        nameError.textContent = values.name ? badName || nameServerError : '';
        emailMessage.textContent = badEmail || '';
        authorMessage.textContent = badAuthor || '';
        nameInput.setAttribute('aria-invalid', badName ? 'true' : 'false');
        emailInput.setAttribute('aria-invalid', badEmail ? 'true' : 'false');
        authorInput?.setAttribute('aria-invalid', badAuthor ? 'true' : 'false');
        create.disabled = !!(badName || badEmail || badAuthor || busy);
        destination.textContent = `Create in ${root}${values.name && !badName ? '/' + values.name : ''}`;
      };
      checkDetails = check;
      nameInput.oninput = () => { values.name = nameInput.value; createError = ''; nameServerError = ''; error.textContent = ''; check(); };
      nameInput.onblur = () => { nameError.textContent = P.newProjectNameError(type, values.name) || nameServerError; };
      emailInput.oninput = () => { values.email = emailInput.value; emailTouched = true; createError = ''; error.textContent = ''; check(); };
      const description = h('textarea', { rows: 3, placeholder: 'What is this project for?' }, values.description);
      description.oninput = () => { values.description = description.value; };
      authorInput = h('input', { type: 'text', value: values.author, autocomplete: 'name', 'aria-describedby': 'new-project-author-error' });
      authorInput.oninput = () => { values.author = authorInput.value; authorTouched = true; check(); };
      const license = h('select', templates.licenses.map((item) => h('option', { value: item.id, selected: item.id === values.license }, item.label)));
      license.onchange = () => { values.license = license.value; check(); };
      const git = h('input', { type: 'checkbox', checked: values.git });
      git.onchange = () => { values.git = git.checked; };
      const status = h('div.hint', { role: 'status' });
      const error = h('div.agent-field-error', { role: 'alert' }, createError);
      const form = h('form#new-project-form', { onsubmit: async (event) => {
        event.preventDefault();
        if (busy) return;
        check();
        if (create.disabled) { nameError.textContent = P.newProjectNameError(type, values.name) || ''; return; }
        busy = true; create.disabled = true; status.textContent = 'Creating project…';
        try {
          const result = await codeome.project.create(P.newProjectPayload(type, values));
          if (done) return;
          if (result?.dir) { App.toast(result.warning || `Created ${values.name}.`); close(result.dir); return; }
          createError = result?.error || 'Could not create the project.';
        } catch (cause) { createError = cause.message || String(cause); }
        busy = false; status.textContent = '';
        if (createError.includes('already exists')) { nameServerError = createError; error.textContent = ''; }
        else error.textContent = createError;
        check();
      } },
        field('Project name', nameInput, nameError),
        field('Description', description),
        field('Author', authorInput, authorMessage),
        field('Email', emailInput, emailMessage),
        field('License', license),
        h('label.check', git, 'Initialise a git repository'),
        destination, status, error);
      check();
      return { body: form, footer: h('footer',
        h('button.btn', { type: 'button', onclick: () => { if (!busy) { step = 1; render(); } } }, 'Back'),
        h('button.btn', { type: 'button', onclick: () => { if (!busy) close(); } }, 'Cancel'), create), focus: nameInput };
    };

    const render = () => {
      if (done) return;
      let content;
      if (loading) content = { body: h('div.hint', { role: 'status' }, 'Loading project types…'), footer: h('footer', h('button.btn', { onclick: () => close() }, 'Cancel')) };
      else if (loadError) content = { body: h('div.agent-field-error', { role: 'alert' }, loadError), footer: h('footer',
        h('button.btn', { onclick: () => close() }, 'Cancel'), h('button.btn.primary', { onclick: load }, 'Try again')) };
      else if (step === 1) {
        const cards = templates.types.map((item) => h('button.new-project-type', { type: 'button', onclick: () => { type = item.id; step = 2; render(); } },
          h('strong', item.label), h('span', item.description), h('small', item.standard)));
        content = { body: h('div.new-project-types', cards), footer: h('footer', h('button.btn', { onclick: () => close() }, 'Cancel')) };
      } else content = details();
      const modal = h('div.modal.new-project-modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Create a new project' },
        h('header', h('h2', step === 1 ? 'Create a new project' : `Create ${templates.types.find((item) => item.id === type)?.label || 'project'}`),
          h('p', step === 1 ? 'Choose a starting template.' : 'Add the details for your new project.')),
        h('div.body', content.body), content.footer);
      ov.replaceChildren(modal); ov.hidden = false;
      ov.onclick = (event) => { if (event.target === ov && !busy) close(); };
      setTimeout(() => { if (!done && ov.contains(modal)) (content.focus || modal.querySelector('button')).focus(); }, 0);
    };
    const load = async () => {
      loading = true; loadError = ''; render();
      try {
        const result = await codeome.project.templates();
        if (!Array.isArray(result?.types) || !result.types.length || !Array.isArray(result?.licenses) || !result.licenses.length) {
          throw new Error('Project templates are unavailable.');
        }
        templates = result;
      } catch (cause) { loadError = cause.message || String(cause); }
      loading = false; render();
    };
    document.addEventListener('keydown', onKey, true);
    load();
    if (App.project && !App.isIdeas(App.project)) {
      codeome.gitAccounts.identityGet(App.project).then((result) => {
        if (done || result?.error) return;
        const defaults = P.newProjectDefaults(App.cfg, result.data || {});
        if (!authorTouched) { values.author = defaults.author; if (authorInput) authorInput.value = values.author; }
        if (!emailTouched) { values.email = defaults.email; if (emailInput) emailInput.value = values.email; }
        if (checkDetails) checkDetails();
      }).catch(() => {});
    }
  });
})();
