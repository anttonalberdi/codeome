// Settings: a full page over the workspace. Changes save as you make them.
// Sections: HPC, long-term storage, Agents (the chat's model, the project's agents with their engine and
// model, the command-line agents), accounts and limits, Python, publishing tokens,
// appearance, and what was found on this Mac.
(function () {
  const h = App.h;
  const S = { isOpen: false };
  App.views.settings = S;
  let page, nav, main, savedEl, agentsHost;
  const sections = {};

  const DEFAULT_DIR = { claude: '~/.claude', codex: '~/.codex' };
  const accountsText = (c, engine) => c.accounts[engine].list.map((a) => `${a.name} = ${a.dir || DEFAULT_DIR[engine]}`).join('\n');
  // "Name = folder" per line; the CLI's default folder is stored as ''.
  function parseAccounts(engine, text) {
    const seen = new Set();
    return text.split('\n').map((l) => l.split('=')).filter((p) => p[0].trim()).map(([n, ...d]) => {
      const dir = d.join('=').trim().replace(/\/+$/, '');
      return { name: n.trim(), dir: !dir || dir === DEFAULT_DIR[engine] || dir === (App.env.home || '~') + DEFAULT_DIR[engine].slice(1) ? '' : dir };
    }).filter((a) => !seen.has(a.name) && seen.add(a.name));
  }

  // Claude Code takes an alias (latest of that family) or a full model ID.
  const CLAUDE_MODELS = [
    { value: 'opus', label: 'Opus (latest)' },
    { value: 'sonnet', label: 'Sonnet (latest)' },
    { value: 'haiku', label: 'Haiku (latest)' },
    { value: 'claude-fable-5-1', label: 'Fable 5.1' },
    { value: 'claude-opus-5-5', label: 'Opus 5.5' },
    { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { value: 'claude-haiku-5-5', label: 'Haiku 5.5' }
  ];
  const ENGINES = [
    { value: 'claude', label: 'Claude' },
    { value: 'codex', label: 'Codex' },
    { value: 'cross', label: 'The other engine' }
  ];
  const ENGINE_NAME = { claude: 'Claude', codex: 'Codex', cross: 'the other engine' };
  const MODEL_RE = /^[\w.:/[\]-]{1,80}$/;
  const SECTIONS = [
    ['hpc', 'HPC'], ['storage', 'Storage'], ['agents', 'Agents'], ['accounts', 'Accounts & limits'], ['r', 'R'], ['python', 'Python'],
    ['publishing', 'Zenodo & PyPI'], ['appearance', 'Appearance'], ['mac', 'This Mac']
  ];
  const ALIAS = { zenodo: 'publishing', pypi: 'publishing', erda: 'storage' };

  // ---------- page ----------
  S.open = async (section) => {
    if (!page) build();
    S.isOpen = true;
    page.hidden = false;
    document.getElementById('app').classList.add('settings-open');
    // Sections exist only once rendered, so wait before jumping to one.
    await render();
    const id = ALIAS[section] || section;
    requestAnimationFrame(() => { if (id && sections[id]) jump(id, false); else main.scrollTop = 0; page.querySelector('.sp-nav button.on, .sp-nav button')?.focus(); });
  };

  S.close = () => {
    if (!page || page.hidden) return;
    page.hidden = true; S.isOpen = false;
    document.getElementById('app').classList.remove('settings-open');
    App.views.editor.layout();
  };
  S.toggle = (section) => (S.isOpen ? S.close() : S.open(section));

  function build() {
    nav = h('nav.sp-nav', { 'aria-label': 'Settings sections' });
    main = h('div.sp-main', { onscroll: spy });
    savedEl = h('span.sp-saved', { 'aria-live': 'polite' });
    page = h('section#settings-page', { hidden: true, role: 'region', 'aria-label': 'Settings' },
    h('div.sp-side', h('div.sp-title', h('h1', 'Settings'), savedEl), nav,
      h('div.sp-side-foot', h('button.btn', { onclick: S.close }, 'Done'), h('span.hint', 'Esc'))),
    main);
    document.getElementById('app').append(page);
    // Escape closes the page unless a dialog, menu or popover is open on top of it.
    document.addEventListener('keydown', (e) => {
      if (!S.isOpen || e.key !== 'Escape' || e.defaultPrevented) return;
      if (!document.getElementById('overlay').hidden || !document.getElementById('menu-pop').hidden || App.pop) return;
      e.preventDefault(); S.close();
    });
    // Navigating elsewhere closes the page; switching projects refreshes the agents.
    App.listen('view', () => S.close());
    App.listen('project', () => { if (S.isOpen) renderAgents(); });
  }

  function jump(id, smooth = true) {
    const el = sections[id];
    if (!el) return;
    main.scrollTo({ top: el.offsetTop - 16, behavior: smooth ? 'smooth' : 'auto' });
    markNav(id);
  }
  function markNav(id) { nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.id === id)); }
  function spy() {
    let on = SECTIONS[0][0];
    for (const [id] of SECTIONS) if (sections[id] && sections[id].offsetTop - 40 <= main.scrollTop) on = id;
    if (main.scrollTop + main.clientHeight >= main.scrollHeight - 4) on = SECTIONS[SECTIONS.length - 1][0];
    markNav(on);
  }

  // Save after a change, then apply what needs applying.
  let saveTimer = null, pendingApply = {};
  function commit(apply = {}) {
    Object.assign(pendingApply, apply);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const a = pendingApply; pendingApply = {};
      await App.saveConfig();
      if (a.theme) App.applyTheme();
      if (a.font) {
        if (App.views.editor.editor) App.views.editor.editor.updateOptions({ fontSize: App.cfg.editor.fontSize });
        for (const t of App.views.terminals.list) t.term.options.fontSize = App.cfg.editor.fontSize;
      }
      if (a.host || a.storage) App.pollHpc();
      flash();
    }, 250);
  }
  function flash(text = 'Saved') {
    savedEl.textContent = text; savedEl.classList.add('on');
    clearTimeout(flash.t); flash.t = setTimeout(() => savedEl.classList.remove('on'), 1600);
  }

  // ---------- building blocks ----------
  const section = (id, title, intro, ...kids) => (sections[id] = h('section.sp-section', { 'data-id': id, 'aria-labelledby': 'sp-' + id },
    h('h2', { id: 'sp-' + id }, title), intro ? h('p.sp-intro', intro) : null, ...kids));
  const card = (title, ...kids) => h('div.sp-card', title ? h('div.sp-card-h', title) : null, ...kids);
  // A labelled row: text and hint on the left, the control on the right.
  const row = (label, control, hint) => h('div.sp-row', h('div.sp-label', h('label', label), hint ? h('div.hint', hint) : null), h('div.sp-ctl', control));

  // Inputs that write to the config when they change.
  function text(get, set, opts = {}) {
    return h('input', { type: opts.type || 'text', value: get() ?? '', placeholder: opts.placeholder || '', spellcheck: 'false', autocomplete: 'off', 'aria-label': opts.label || '',
      onchange: (e) => { set(e.target.value); commit(opts.apply); } });
  }
  function check(label, get, set, apply) {
    const i = h('input', { type: 'checkbox', checked: !!get(), onchange: (e) => { set(e.target.checked); commit(apply); } });
    return h('label.check', i, label);
  }
  function select(options, value, onchange, label) {
    const has = options.some((o) => o.value === value);
    return h('select', { 'aria-label': label || '', onchange: (e) => onchange(e.target.value, e.target) },
      has ? null : h('option', { value, selected: true }, value),
      options.map((o) => (o.group ? h('optgroup', { label: o.group }, o.options.map((x) => h('option', { value: x.value, selected: x.value === value }, x.label))) : h('option', { value: o.value, selected: o.value === value }, o.label))));
  }
  // A model picker with an "Other…" entry for any model ID.
  function modelSelect(options, value, save, label) {
    const opts = [...options, { value: '\u0000other', label: 'Other…' }];
    const sel = select(opts, value, async (v, el) => {
      if (v === '\u0000other') {
        const m = await App.prompt('Model', 'Model ID or alias', value || '', { placeholder: 'e.g. claude-opus-5-5' });
        if (!m || !MODEL_RE.test(m)) { el.value = value; if (m) App.err('Not a model name: ' + m); return; }
        v = m;
      }
      value = v;
      save(v);
    }, label);
    return sel;
  }

  // ---------- render ----------
  async function render() {
    const c = App.cfg;
    nav.innerHTML = '';
    for (const [id, label] of SECTIONS) nav.append(h('button', { 'data-id': id, onclick: () => jump(id) }, label));
    main.innerHTML = '';
    agentsHost = h('div');
    main.append(h('div.sp-content',
      hpcSection(c), storageSection(c), agentsSection(c), accountsSection(c), rSection(c), pythonSection(c),
      await publishingSection(), appearanceSection(c), macSection()));
    markNav(SECTIONS[0][0]);
    renderAgents();
  }

  function hpcSection(c) {
    return section('hpc', 'HPC', 'How Codeome reaches your cluster. It uses your system ssh, so ~/.ssh/config, keys and ProxyJump apply.',
      card(null,
        row('Login', text(() => App.cfg.hpc.host, (v) => { App.cfg.hpc.host = v.trim(); }, { placeholder: 'myhpc  or  user@login.cluster.example.org', apply: { host: true }, label: 'HPC login' }),
          'A Host alias from ~/.ssh/config if you have one.'),
        row('Start folder', text(() => App.cfg.hpc.remoteRoot, (v) => { App.cfg.hpc.remoteRoot = v.trim() || '~'; }, { placeholder: '~ or /projects/mygroup', label: 'Start folder' })),
        row('VPN check', text(() => App.cfg.hpc.vpnCheckHost, (v) => { App.cfg.hpc.vpnCheckHost = v.trim(); }, { placeholder: 'login.cluster.example.org', label: 'VPN check host' }),
          'Optional. A host only reachable on the VPN; the title bar shows whether it answers.'),
        row('Agent sessions', check('Keep agent sessions on the HPC running in tmux', () => App.cfg.hpc.useTmux, (v) => { App.cfg.hpc.useTmux = v; }),
          'They reattach after a disconnect.'),
        row('Refresh Slurm every', h('div.row', text(() => App.cfg.slurm.refreshSeconds, (v) => { App.cfg.slurm.refreshSeconds = Math.max(5, Number(v) || 20); }, { type: 'number', label: 'Seconds' }), h('span.hint', 'seconds')))));
  }

  function storageSection(c) {
    const files = App.views.files;
    return section('storage', 'Storage', 'Long-term storage reached over SFTP, such as ERDA. It shows as the third section in Files. Servers that only allow SFTP (no shell) work.',
      card(null,
        row('Name', text(() => files.title('storage'), (v) => { const p = App.cfg.ui.panes.storage = App.cfg.ui.panes.storage || {}; if (v.trim() && v.trim() !== 'ERDA') p.title = v.trim().slice(0, 40); else delete p.title; }, { placeholder: 'ERDA', label: 'Storage name' }),
          'How the section is labelled. You can also right-click a section header in Files to rename it.'),
        row('Login', text(() => App.cfg.storage.host, (v) => { App.cfg.storage.host = v.trim(); }, { placeholder: 'erda  or  you@example.org@io.erda.dk', apply: { storage: true }, label: 'Storage login' }),
          h('span', 'A Host alias from ~/.ssh/config is easiest, e.g.', h('pre.sp-code', 'Host erda\n  HostName io.erda.dk\n  User you@example.org'), 'For ERDA, set an SFTP password or key first under Setup → SFTP on erda.dk.')),
        row('Start folder', text(() => App.cfg.storage.root, (v) => { App.cfg.storage.root = v.trim(); }, { placeholder: 'Login folder', label: 'Storage start folder' })),
        row('From the HPC', text(() => App.cfg.storage.hpcHost, (v) => { App.cfg.storage.hpcHost = v.trim(); }, { placeholder: 'Same as the login', label: 'Storage login from the HPC' }),
          'Copies between the HPC and the storage run sftp on the HPC, in a terminal there. Set this if the HPC knows the storage by another name.')));
  }

  function rSection(c) {
    return section('r', 'R', 'The R console that ⌘↩ sends R code to, from R scripts and from chunks in R Markdown and Quarto documents.',
      card(null,
        row('On this Mac', text(() => App.cfg.r.local, (v) => { App.cfg.r.local = v.trim() || 'R --no-save --quiet'; }, { label: 'R command on this Mac' }),
          'Starts in the project folder, so .Rprofile and renv load as in RStudio.'),
        row('On the HPC', text(() => App.cfg.r.remote, (v) => { App.cfg.r.remote = v.trim() || 'R --no-save --quiet'; }, { placeholder: 'module load R && R --no-save --quiet', label: 'R command on the HPC' }),
          'Runs in a login shell. Load modules or a conda environment here if R needs them.')));
  }

  // ---------- agents ----------
  function agentsSection(c) {
    const chatCmd = (c.agents.find((a) => /^claude(\s|$)/.test(a.cmd)) || { cmd: 'claude' }).cmd;
    const fromCmd = (chatCmd.match(/--model(?:=|\s+)(\S+)/) || [])[1];
    return section('agents', 'Agents', 'The agent chat, the specialists it hands work to, and the command-line agents offered as terminal sessions.',
      card('Agent chat (orchestrator)',
        row('AI', h('span.pill.ok', 'Claude Code'), `Runs "${chatCmd}" — the first Claude command below.`),
        row('Model', modelSelect([{ value: '', label: fromCmd ? `From the command (${fromCmd})` : 'Claude Code default' }, ...CLAUDE_MODELS], (App.cfg.chat || {}).model || '',
          (v) => { App.cfg.chat = { ...(App.cfg.chat || {}), model: v }; commit(); }, 'Chat model'),
          'For chats started from now on. Chats already open keep their model until they restart.')),
      agentsHost,
      card('Command-line agents', cliAgents(),
        h('div.sp-foot.hint', 'Offered as sessions in terminals and on the HPC. The agent chat runs the first Claude command.')));
  }

  function cliAgents() {
    const box = h('div.cli-list');
    const draw = () => {
      box.innerHTML = '';
      App.cfg.agents.forEach((a, i) => {
        box.append(h('div.cli-row',
          h('input', { type: 'text', value: a.name, 'aria-label': 'Name', placeholder: 'Name', onchange: (e) => { const v = e.target.value.trim(); if (v) { App.cfg.agents[i].name = v; commit(); } else e.target.value = App.cfg.agents[i].name; } }),
          h('input.mono', { type: 'text', value: a.cmd, 'aria-label': 'Command', placeholder: 'claude --model opus', spellcheck: 'false', onchange: (e) => { const v = e.target.value.trim(); if (v) { App.cfg.agents[i].cmd = v; commit(); } else e.target.value = App.cfg.agents[i].cmd; } }),
          h('button.icon-btn.small', { title: 'Remove', 'aria-label': 'Remove ' + a.name, disabled: App.cfg.agents.length < 2, onclick: () => { App.cfg.agents.splice(i, 1); commit(); draw(); }, html: App.icons.trash })));
      });
      box.append(h('div.row', h('button.btn.small', { onclick: () => { App.cfg.agents.push({ name: 'Claude (Sonnet)', cmd: 'claude --model sonnet' }); commit(); draw(); box.querySelector('.cli-row:last-of-type input')?.select(); } }, '+ Add agent')));
    };
    draw();
    return box;
  }

  // The project's agents: kit roles and its own, each with an engine and a model.
  let codexCatalog = null;
  async function renderAgents() {
    if (!agentsHost) return;
    const project = App.project;
    const host = agentsHost;
    if (!project) { host.replaceChildren(card('Team', h('div.sp-empty', 'Open a project to see its agents.'))); return; }
    const [res, kit, models] = await Promise.all([codeome.agents.list(project), codeome.kit.status(project), codeome.agents.models()]);
    if (project !== App.project || host !== agentsHost) return;
    codexCatalog = models.codex || { models: [] };
    const list = res.agents || [];
    const name = App.basename(project);
    const head = h('div.sp-card-h.row',
      h('span.grow', `Team in ${name}`),
      kit.installed ? h('button.btn.small.ghost', { onclick: () => openFile(App.join(project, '.claude/skills/orchestrate/routing.md')) }, 'Routing') : null,
      kit.installed ? h('button.btn.small.ghost', { onclick: () => App.views.agents.install().then(renderAgents) }, kit.outdated ? `Update kit to ${kit.latest}…` : 'Role groups…') : null,
      h('button.btn.small', { onclick: newAgent }, '+ New agent'));
    const body = [];
    if (res.error) body.push(h('div.sp-empty', res.error));
    if (!kit.installed) {
      body.push(h('div.sp-banner', h('div.grow', h('b', 'No agent kit here. '), `Install it to give the chat ${kit.roles ? kit.roles.length : 15} specialist roles and the Codex job runner. Until then, Codex is not used.`),
        h('button.btn.small.primary', { onclick: () => App.views.agents.install().then(renderAgents) }, 'Install…')));
    } else if (kit.outdated) {
      body.push(h('div.sp-banner', h('div.grow', `Agent kit ${kit.latest} is available (this project has ${kit.version}). The update is needed for Codex models chosen here to take effect.`),
        h('button.btn.small.primary', { onclick: () => App.views.agents.install().then(renderAgents) }, 'Update…')));
    }
    if (!list.length && !res.error) body.push(h('div.sp-empty', 'No agents in .claude/agents/ yet.'));
    else if (list.length) {
      body.push(h('div.ag-table', { role: 'table', 'aria-label': 'Agents' },
        h('div.ag-row.ag-headrow', { role: 'row' }, ['Agent', 'AI', 'Model', 'Access', ''].map((x) => h('span', { role: 'columnheader' }, x))),
        list.map((a) => agentRow(project, a))));
      body.push(h('div.sp-foot.hint', 'The AI is the default the chat routes each role to (routing.md); it can still override per task. Claude models go in the agent file; Codex models in .codeome/agents.json. Edits to the files are kept on kit updates.'));
    }
    host.replaceChildren(h('div.sp-card', head, ...body));
  }

  function agentRow(project, a) {
    const el = h('div.ag-row', { role: 'row' });
    const save = async (patch) => {
      const r = await codeome.agents.set(project, a.name, patch);
      if (r.error) { App.err(r.error); return renderAgents(); }
      Object.assign(a, r.agent);
      el.replaceWith(agentRow(project, a));
      flash();
      App.views.agents.refresh(true);
    };
    const claude = (label) => modelSelect([{ value: '', label: 'Same as the chat' }, ...CLAUDE_MODELS], a.claudeModel, (v) => save({ claudeModel: v }), label || `Claude model for ${a.name}`);
    const codexOpts = [{ value: '', label: codexCatalog.default ? `Codex default (${codexCatalog.default})` : 'Codex default' }, ...codexCatalog.models.map((m) => ({ value: m.id, label: m.label }))];
    const codex = (label) => modelSelect(codexOpts, a.codexModel, (v) => save({ codexModel: v }), label || `Codex model for ${a.name}`);
    let model;
    if (a.engine === 'codex') model = codex();
    else if (a.engine === 'cross') model = h('div.ag-two', h('label', h('span', 'Claude'), claude(`Claude model for ${a.name}`)), h('label', h('span', 'Codex'), codex(`Codex model for ${a.name}`)));
    else model = claude();
    const changed = a.kit && a.engine !== a.defaultEngine;
    el.append(
      h('div.ag-name', { role: 'cell' },
        h('div.row', h('b', a.name), a.kit ? h('span.pill', a.group || 'kit') : h('span.pill.own', 'own'), a.edited ? h('span.pill.warn', { title: 'Edited here; kit updates leave it alone' }, 'edited') : null),
        a.description ? h('div.ag-desc', { title: a.description }, a.description) : null),
      h('div', { role: 'cell' }, select(ENGINES, a.engine, (v) => save({ engine: v }), `AI for ${a.name}`),
        changed ? h('div.ag-def', `kit default: ${ENGINE_NAME[a.defaultEngine]}`) : null),
      h('div', { role: 'cell' }, model),
      h('div', { role: 'cell' }, h('span.ag-access.' + (a.access === 'writes' ? 'w' : 'r'), a.access)),
      h('div', { role: 'cell' }, h('button.btn.small', { title: `Edit ${a.file}`, onclick: () => openFile(a.path) }, 'Edit .md')));
    return el;
  }

  function openFile(p) { S.close(); App.views.editor.openFile(p); }

  async function newAgent() {
    const project = App.project;
    const name = await App.prompt('New agent', 'Name (lowercase, dashes)', '', { placeholder: 'e.g. stats-reviewer', ok: 'Create' });
    if (!name) return;
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) return App.err('Use lowercase letters, digits and dashes.');
    const p = App.join(project, `.claude/agents/${name}.md`);
    const exists = await codeome.local.read(p);
    if (!exists.error) return App.err(`${name} already exists.`);
    await codeome.local.mkdir(App.join(project, '.claude/agents'));
    const r = await codeome.local.write(p, `---\nname: ${name}\ndescription: What this agent does and when the orchestrator should use it.\ntools: Read, Grep, Glob, Bash\n---\n\nYou are the ${name}. Describe how to work and what to report.\n`);
    if (r.error) return App.err(r.error);
    App.emit('local-changed');
    openFile(p);
  }

  // ---------- accounts ----------
  function accountsSection(c) {
    const area = (engine) => h('textarea', { rows: Math.max(2, c.accounts[engine].list.length + 1), spellcheck: 'false', 'aria-label': `${engine} accounts`,
      onchange: (e) => {
        const list = parseAccounts(engine, e.target.value);
        if (!list.length) { e.target.value = accountsText(App.cfg, engine); return; }
        const cur = App.cfg.accounts[engine];
        App.cfg.accounts[engine] = { active: list.some((a) => a.name === cur.active) ? cur.active : list[0].name, list };
        commit();
      } }, accountsText(c, engine));
    const add = (engine, label) => h('button.btn.small.ghost', { onclick: () => App.views.usage.addAccount(engine) }, `Add a ${label} account and sign in…`);
    return section('accounts', 'Accounts & limits', 'Each account is a config folder. Agent jobs and new chats move to an account with headroom.',
      card(null,
        row('Claude accounts', h('div', area('claude'), add('claude', 'Claude')), 'One per line: Name = config folder (CLAUDE_CONFIG_DIR). ~/.claude is the default sign-in.'),
        row('Codex accounts', h('div', area('codex'), add('codex', 'Codex')), 'One per line: Name = folder (CODEX_HOME). ~/.codex is the default.'),
        row('Hold back new jobs at', h('div.row', text(() => App.cfg.usage.stopAt, (v) => { App.cfg.usage.stopAt = Math.min(100, Math.max(50, Number(v) || 90)); }, { type: 'number', label: 'Percent' }), h('span.hint', '% of the 5-hour or weekly limit')),
          'Codex jobs move to an account with headroom; Claude subagents pause; new chats start on the Claude account with the most headroom.')));
  }

  function pythonSection(c) {
    return section('python', 'Python', null,
      card(null,
        row('On this Mac', text(() => App.cfg.python.local, (v) => { App.cfg.python.local = v.trim() || 'python3'; }, { label: 'Python on this Mac' })),
        row('On the HPC', text(() => App.cfg.python.remote, (v) => { App.cfg.python.remote = v.trim() || 'python3'; }, { label: 'Python on the HPC' }))));
  }

  // Tokens go straight to the Keychain; the page only knows whether one is saved.
  async function publishingSection() {
    const keys = [
      ['zenodo:prod', 'Zenodo token', 'zenodo.org → Applications → Personal access tokens (deposit:write, deposit:actions).'],
      ['zenodo:sandbox', 'Zenodo sandbox token', null],
      ['pypi:pypi', 'PyPI API token', null],
      ['pypi:testpypi', 'TestPyPI API token', null]
    ];
    const has = await Promise.all(keys.map(([k]) => codeome.secret.has(k)));
    return section('publishing', 'Zenodo & PyPI', 'Tokens are encrypted with the macOS Keychain and never shown again.',
      card(null, keys.map(([k, label, hint], i) => {
        const status = h('span.pill' + (has[i] ? '.ok' : ''), has[i] ? 'saved' : 'not set');
        const input = h('input', { type: 'password', placeholder: has[i] ? 'Saved — paste a new one to replace' : 'Paste token', autocomplete: 'off', 'aria-label': label });
        const saveBtn = h('button.btn.small', { onclick: async () => {
          if (!input.value.trim()) return;
          await codeome.secret.set(k, input.value.trim());
          input.value = ''; input.placeholder = 'Saved — paste a new one to replace';
          status.className = 'pill ok'; status.textContent = 'saved'; flash('Token saved');
        } }, 'Save');
        input.onkeydown = (e) => { if (e.key === 'Enter') saveBtn.click(); };
        return row(label, h('div.row', input, saveBtn, status), hint);
      })));
  }

  function appearanceSection(c) {
    return section('appearance', 'Appearance', null,
      card(null,
        row('Theme', select([{ value: 'auto', label: 'Match macOS' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }], c.editor.theme,
          (v) => { App.cfg.editor.theme = v; commit({ theme: true }); }, 'Theme')),
        row('Editor & terminal font size', text(() => App.cfg.editor.fontSize, (v) => { App.cfg.editor.fontSize = Math.min(24, Math.max(10, Number(v) || 13)); }, { type: 'number', apply: { font: true }, label: 'Font size' }))));
  }

  function macSection() {
    const tools = Object.entries(App.env.tools || {});
    return section('mac', 'This Mac', 'Command-line tools Codeome looked for on your login shell\'s PATH.',
      card(null, h('div.sp-tools', tools.length ? tools.map(([t, ok]) => h('span.pill' + (ok ? '.ok' : '.warn'), (ok ? '' : 'missing: ') + t)) : h('span.hint', 'Still checking…'))));
  }
})();
