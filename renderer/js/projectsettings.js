// Per-project agent rules and chat defaults. Unset values inherit from Settings.
(function () {
  const h = App.h;
  const P = {};
  App.views.projectSettings = P;
  let root, defaults = null, codexModels = [], loadError = '', catalogError = '', saveError = '', busy = false;
  const CHAT_ROWS = [
    ['model', 'Claude model'], ['effort', 'Claude effort'], ['codexModel', 'Codex model'],
    ['codexEffort', 'Codex effort'], ['mode', 'Default permission mode'], ['engine', 'Default engine']
  ];
  const MODEL_RE = /^(?!-)[\w.:/[\]-]{1,80}$/;

  P.init = () => {
    root = document.querySelector('.view[data-view="projectSettings"]');
    App.listen('view', (view) => { if (view === 'projectSettings') P.refresh(); });
    App.listen('project', () => { if (App.currentView === 'projectSettings') P.refresh(); });
    App.listen('config', () => { if (App.currentView === 'projectSettings' && !busy) P.refresh(); });
    loadDefaults();
  };

  async function loadDefaults() {
    defaults = null; loadError = ''; catalogError = '';
    P.refresh();
    const [policy, catalog] = await Promise.allSettled([codeome.policy.defaults(), codeome.agents.models()]);
    if (policy.status === 'fulfilled' && Array.isArray(policy.value)) defaults = policy.value;
    else loadError = policy.status === 'rejected' ? policy.reason.message || String(policy.reason) : 'Invalid policy definitions.';
    if (catalog.status === 'fulfilled') codexModels = catalog.value?.codex?.models || [];
    else catalogError = catalog.reason.message || String(catalog.reason);
    P.refresh();
  }

  const policyValue = (item, path) => {
    const project = (App.cfg.projectPolicy || {})[path] || {};
    const app = App.cfg.policyDefaults || {};
    for (const source of [project, app]) {
      if (item.options.some((option) => option.value === source[item.key])) return source[item.key];
    }
    return item.default;
  };
  const appPolicyValue = (item) => {
    const value = (App.cfg.policyDefaults || {})[item.key];
    return item.options.some((option) => option.value === value) ? value : item.default;
  };

  async function save(path, scope, key, value) {
    if (busy || !path) return;
    App.cfg.projectPolicy = App.cfg.projectPolicy || {};
    App.cfg.projectChat = App.cfg.projectChat || {};
    const previousPolicy = App.cfg.projectPolicy[path];
    const previousChat = App.cfg.projectChat[path];
    if (scope === null) {
      delete App.cfg.projectPolicy[path];
      delete App.cfg.projectChat[path];
    } else {
      const collection = scope === 'policy' ? App.cfg.projectPolicy : App.cfg.projectChat;
      const next = { ...(collection[path] || {}) };
      if (value === null || (scope === 'chat' && value === '')) delete next[key];
      else next[key] = value;
      if (Object.keys(next).length) collection[path] = next;
      else delete collection[path];
    }
    busy = true; saveError = ''; P.refresh();
    try {
      App.cfg = await codeome.config.set(App.cfg);
      App.emit('config', App.cfg);
    } catch (error) {
      if (previousPolicy) App.cfg.projectPolicy[path] = previousPolicy;
      else delete App.cfg.projectPolicy[path];
      if (previousChat) App.cfg.projectChat[path] = previousChat;
      else delete App.cfg.projectChat[path];
      saveError = error.message || String(error);
    } finally { busy = false; P.refresh(); }
  }

  function inheritance(settingLabel, appLabel, overridden, onReset) {
    return h('div.ps-inheritance', overridden
      ? h('button.ps-reset', { type: 'button', disabled: busy, 'aria-label': `Use app default for ${settingLabel}`, onclick: onReset }, 'Use app default')
      : `App default: ${appLabel}`);
  }

  function policyRow(item, path) {
    const projectValue = ((App.cfg.projectPolicy || {})[path] || {})[item.key];
    const overridden = item.options.some((option) => option.value === projectValue);
    const appValue = appPolicyValue(item);
    const appLabel = item.options.find((option) => option.value === appValue)?.label || appValue;
    return h('div.ps-row', { 'data-policy-key': item.key },
      h('div.ps-label', h('span', item.label), item.advisory ? h('span.ps-tag', 'advisory') : null,
        overridden ? h('span.ps-tag.ps-overridden', 'overridden') : null),
      h('p.ps-help', item.help),
      App.policyControl(item, policyValue(item, path), (value) => save(path, 'policy', item.key, value), busy),
      inheritance(item.label, appLabel, overridden, () => save(path, 'policy', item.key, null)));
  }

  function chatSelect(key, label, options, selected, path) {
    const choices = [{ value: '', label: 'Use app default' }, ...options.filter((option) => option.value !== '')];
    if (selected && !choices.some((option) => option.value === selected)) choices.push({ value: selected, label: selected });
    const isModel = key === 'model' || key === 'codexModel';
    if (isModel) choices.push({ value: '\u0000other', label: 'Other…' });
    const error = h('span.ps-field-error', { role: 'alert' });
    const select = h('select', { 'aria-label': label, disabled: busy, onchange: async (event) => {
      error.textContent = '';
      let value = event.target.value;
      if (value === '\u0000other') {
        const answer = await App.prompt('Model', 'Model ID or alias', selected || '', { placeholder: 'e.g. claude-opus-5-5' });
        if (answer === null || answer === '') { event.target.value = selected; return; }
        if (!MODEL_RE.test(answer)) { error.textContent = 'Enter a valid model ID or alias.'; event.target.value = selected; return; }
        value = answer;
      }
      await save(path, 'chat', key, value);
    } }, choices.map((option) => h('option', { value: option.value, selected: option.value === selected }, option.label)));
    return h('div.ps-chat-control', select, error);
  }

  function chatRow(key, label, options, path) {
    const project = (App.cfg.projectChat || {})[path] || {};
    const overridden = typeof project[key] === 'string' && project[key] !== '';
    const appValue = (App.cfg.chat || {})[key] || '';
    const appLabel = options.find((option) => option.value === appValue)?.label || appValue;
    return h('div.ps-row', { 'data-chat-key': key },
      h('div.ps-label', h('span', label), overridden ? h('span.ps-tag.ps-overridden', 'overridden') : null),
      chatSelect(key, label, options, overridden ? project[key] : '', path),
      inheritance(label, appLabel, overridden, () => save(path, 'chat', key, null)));
  }

  async function saveHpc(path, paths) {
    if (busy) return;
    App.cfg.projectHpc = App.cfg.projectHpc || {};
    const previous = App.cfg.projectHpc[path];
    if (paths.length) App.cfg.projectHpc[path] = { paths };
    else delete App.cfg.projectHpc[path];
    busy = true; saveError = ''; P.refresh();
    try { await App.saveConfig(); }
    catch (error) {
      if (previous) App.cfg.projectHpc[path] = previous;
      else delete App.cfg.projectHpc[path];
      saveError = error.message || String(error);
    } finally { busy = false; P.refresh(); }
  }

  function hpcFolders(path) {
    const paths = ((App.cfg.projectHpc || {})[path] || {}).paths || [];
    const error = h('span.ps-field-error', { role: 'alert' });
    const input = h('input', { type: 'text', 'aria-label': 'HPC folder path', placeholder: '/projects/your-folder', disabled: busy,
      onkeydown: (event) => { if (event.key === 'Enter') { event.preventDefault(); add(input.value); } } });
    const add = (raw) => {
      const trimmed = (raw || '').trim();
      const value = trimmed.replace(/\/+$/, '') || (trimmed.startsWith('/') ? '/' : '');
      if (!value || !(value.startsWith('/') || value.startsWith('~'))) { error.textContent = 'Enter an absolute HPC path or one starting with ~.'; return; }
      if (paths.includes(value)) { error.textContent = 'That HPC folder is already listed.'; return; }
      return saveHpc(path, [...paths, value]);
    };
    return h('section.ps-card', h('h3.ps-card-title', 'HPC folders'),
      h('div.ps-list',
        h('p.ps-help', 'Jobs tagged for this project or run in these folders appear in its Slurm view. The first folder is its root.'),
        paths.length ? paths.map((folder, i) => h('div.ps-hpc-path', h('span', { title: folder }, folder),
          i === 0 ? h('span.ps-tag', 'root') : null,
          h('button.btn.small', { type: 'button', disabled: busy, 'aria-label': 'Remove HPC folder ' + folder,
            onclick: () => saveHpc(path, paths.filter((_, n) => n !== i)) }, 'Remove'))) : h('p.ps-help', 'No HPC folders saved. The current HPC folder is used until you add one.'),
        h('div.ps-hpc-add', input, h('button.btn.small', { type: 'button', disabled: busy, onclick: () => add(input.value) }, 'Add folder')),
        h('button.btn.small', { type: 'button', disabled: busy || !App.remoteDir, onclick: () => add(App.remoteDir) }, 'Use current HPC folder'),
        error));
  }

  P.refresh = () => {
    if (!root) return;
    const path = App.project;
    const heading = h('div.side-head', h('h2', 'Project settings'));
    if (!path) {
      root.replaceChildren(heading, h('div.empty', 'Open a project folder to set its agent rules.'));
      return;
    }
    if (loadError) {
      root.replaceChildren(heading, h('div.empty', { role: 'alert' }, 'Could not load agent rules: ' + loadError, h('br'),
        h('button.btn.small', { type: 'button', onclick: loadDefaults }, 'Retry')));
      return;
    }
    if (!defaults) {
      root.replaceChildren(heading, h('div.empty', { role: 'status' }, 'Loading agent rules…'));
      return;
    }
    const options = App.agentDefaultOptions(codexModels);
    const hasOverrides = !!Object.keys((App.cfg.projectPolicy || {})[path] || {}).length || !!Object.keys((App.cfg.projectChat || {})[path] || {}).length;
    root.replaceChildren(heading,
      h('div.ps-intro',
        h('div.ps-project', App.isIdeas(path) ? 'Ideas' : App.basename(path)),
        h('div.ps-path', { title: path }, path),
        h('p', 'Project choices override the defaults in Settings. Permission changes apply to running chats; prompt text applies to new chats.')),
      h('section.ps-card', h('h3.ps-card-title', 'Agent policy'),
        h('div.ps-list', defaults.map((item) => policyRow(item, path)))),
      h('section.ps-card', h('h3.ps-card-title', 'Agent defaults'),
        catalogError ? h('div.ps-catalog-error', { role: 'alert' }, 'Could not load Codex model choices: ' + catalogError,
          h('button.btn.small', { type: 'button', onclick: loadDefaults }, 'Retry')) : null,
        h('div.ps-list', CHAT_ROWS.map(([key, label]) => chatRow(key, label, options[key], path)))),
      App.isIdeas(path) ? null : hpcFolders(path),
      h('section.ps-card', h('h3.ps-card-title', 'Connected projects'),
        App.isIdeas(path) ? h('div.lp-note', 'Ideas cannot be connected to projects.') : App.views.projects.linkPicker(path)),
      h('div.ps-footer',
        h('button.ps-reset', { type: 'button', disabled: busy || !hasOverrides, onclick: () => save(path, null, null, null) }, 'Reset to app defaults'),
        saveError ? h('p.ps-error', { role: 'alert' }, 'Could not save project settings: ' + saveError) : null,
        h('p.ps-note', 'Matching is heuristic, not a security boundary.')));
  };
})();
