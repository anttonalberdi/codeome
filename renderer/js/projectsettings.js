// Per-project agent rules. The switch definitions come from the policy backend.
(function () {
  const h = App.h;
  const P = {};
  App.views.projectSettings = P;
  let root, defaults = null, loadError = '', saveError = '', busy = false;

  P.init = () => {
    root = document.querySelector('.view[data-view="projectSettings"]');
    App.listen('view', (view) => { if (view === 'projectSettings') P.refresh(); });
    App.listen('project', () => { if (App.currentView === 'projectSettings') P.refresh(); });
    loadDefaults();
  };

  async function loadDefaults() {
    loadError = '';
    P.refresh();
    try {
      defaults = await codeome.policy.defaults();
      if (!Array.isArray(defaults)) throw new Error('Invalid policy definitions.');
    } catch (error) { loadError = error.message || String(error); }
    P.refresh();
  }

  function current(item, path) {
    const stored = (App.cfg.projectPolicy || {})[path] || {};
    return item.options.some((option) => option.value === stored[item.key]) ? stored[item.key] : item.default;
  }

  async function save(path, key, value) {
    if (busy || !path) return;
    const before = (App.cfg.projectPolicy || {})[path];
    const next = {};
    for (const item of defaults) {
      const selected = key === null ? item.default : item.key === key ? value : current(item, path);
      if (selected !== item.default) next[item.key] = selected;
    }
    App.cfg.projectPolicy = App.cfg.projectPolicy || {};
    if (Object.keys(next).length) App.cfg.projectPolicy[path] = next;
    else delete App.cfg.projectPolicy[path];
    busy = true; saveError = ''; P.refresh();
    try {
      App.cfg = await codeome.config.set(App.cfg);
      App.emit('config', App.cfg);
    } catch (error) {
      if (before) App.cfg.projectPolicy[path] = before;
      else delete App.cfg.projectPolicy[path];
      saveError = error.message || String(error);
    } finally { busy = false; P.refresh(); }
  }

  function control(item, path) {
    const value = current(item, path);
    if (item.type === 'bool') {
      return h('button.ps-switch', {
        type: 'button', role: 'switch', 'aria-label': item.label,
        'aria-checked': value === 'on' ? 'true' : 'false', disabled: busy,
        onclick: () => save(path, item.key, value === 'on' ? 'off' : 'on')
      }, h('span.ps-switch-thumb'));
    }
    return h('div.ps-segments', { role: 'radiogroup', 'aria-label': item.label },
      item.options.map((option) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': option.value === value ? 'true' : 'false',
        disabled: busy, onclick: () => save(path, item.key, option.value)
      }, option.label)));
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
    root.replaceChildren(heading,
      h('div.ps-intro',
        h('div.ps-project', App.isIdeas(path) ? 'Ideas' : App.basename(path)),
        h('div.ps-path', { title: path }, path),
        h('p', 'Rules for the agents in this project. Changes apply to running chats for permission checks; prompt text applies to new chats.')),
      h('div.ps-list', defaults.map((item) => h('div.ps-row', { 'data-policy-key': item.key },
        h('div.ps-label', h('span', item.label), item.advisory ? h('span.ps-tag', 'advisory') : null),
        h('p.ps-help', item.help), control(item, path)))),
      h('div.ps-footer',
        h('button.ps-reset', { type: 'button', disabled: busy || !(App.cfg.projectPolicy || {})[path], onclick: () => save(path, null, null) }, 'Reset to defaults'),
        saveError ? h('p.ps-error', { role: 'alert' }, 'Could not save agent rules: ' + saveError) : null,
        h('p.ps-note', 'Matching is heuristic, not a security boundary.')));
  };
})();
