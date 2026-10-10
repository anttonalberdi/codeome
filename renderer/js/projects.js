// Left column: one card per open project. Each project keeps its own editor tabs,
// terminal and agent sessions (which keep running while another project is shown)
// and its place in the HPC file browser. Each project has a color (a hue) shared by its
// card and the tag in the title bar; it is picked when the project is first opened.
(function () {
  const h = App.h;
  const P = { list: [], state: {} }; // state[dir] = { remoteDir, jobs }
  App.views.projects = P;
  let el, dragging = null, pending = 0;

  P.init = () => {
    el = document.getElementById('projects');
    P.list = (App.cfg.openProjects || []).filter(Boolean);
    App.cfg.projectColors = App.cfg.projectColors || {};
    P.list.forEach(colorOf);
    const tag = document.getElementById('project-btn');
    tag.onclick = () => (App.project ? App.menuAt(tag, tagMenu()) : P.open());
    tag.oncontextmenu = (e) => { e.preventDefault(); if (App.project) App.menu(e.clientX, e.clientY, tagMenu()); };
    applyCollapsed();
    // Unsaved files and live sessions change the cards.
    App.listen('sessions', schedule);
    App.listen('chat-state', schedule);
    setInterval(pollJobs, 5000);
    render();
  };

  // Restore the cards from last time (or the most recent folder).
  P.restore = async () => {
    if (!P.list.length && App.cfg.recentFolders[0]) P.list = [App.cfg.recentFolders[0]];
    const want = P.list.includes(App.cfg.activeProject) ? App.cfg.activeProject : P.list[0];
    if (want) await P.switchTo(want); else render();
    pollJobs();
  };

  P.open = async (dir) => {
    dir = dir || await codeome.dialog.folder({ defaultPath: App.project || App.cfg.localRoot });
    if (!dir) return;
    if (!P.list.includes(dir)) P.list.push(dir);
    colorOf(dir);
    await P.switchTo(dir);
  };

  P.switchTo = async (dir) => {
    if (dir && dir === App.project) return;
    if (App.project) state(App.project).remoteDir = App.remoteDir;
    App.closePopover();
    App.project = dir;
    if (dir) {
      App.cfg.localRoot = dir;
      App.cfg.recentFolders = [dir, ...App.cfg.recentFolders.filter((d) => d !== dir)].slice(0, 8);
    }
    App.cfg.openProjects = P.list.slice();
    App.cfg.activeProject = dir;
    paintTag();
    document.title = dir ? App.basename(dir) + ' — Codeome' : 'Codeome';
    render();
    App.emit('project', dir);
    const rd = dir && state(dir).remoteDir;
    if (rd && App.hpcConnected && rd !== App.remoteDir) App.views.files.go('remote', rd);
    await App.saveConfig();
  };

  P.close = async (dir) => {
    const T = App.views.terminals, E = App.views.editor;
    const live = T.list.filter((t) => t.project === dir && t.alive).map((t) => t.title);
    const busyChats = App.views.chat.stats(dir).working + App.views.chat.stats(dir).waiting;
    if (busyChats) live.unshift(busyChats > 1 ? `${busyChats} agent chats` : 'the agent chat');
    if (live.length && !(await App.confirm(`Close ${App.basename(dir)}?`,
      `${live.length > 1 ? 'These' : 'This'} will be stopped: ${live.join(', ')}. Sessions kept in tmux on the HPC and specialist jobs keep running.`, 'Close project', true))) return;
    if (!(await E.closeProject(dir))) return;
    T.closeProject(dir);
    App.views.chat.closeProject(dir);
    const i = P.list.indexOf(dir);
    if (i >= 0) P.list.splice(i, 1);
    delete P.state[dir];
    if (App.project === dir) await P.switchTo(P.list[Math.min(i, P.list.length - 1)] || null);
    else { App.cfg.openProjects = P.list.slice(); await App.saveConfig(); render(); }
  };

  P.cycle = (step) => {
    if (P.list.length < 2) return;
    const i = P.list.indexOf(App.project);
    P.switchTo(P.list[(i + step + P.list.length) % P.list.length]);
  };

  const state = (dir) => (P.state[dir] = P.state[dir] || {});

  // Running agent jobs per project, read from each project's .codeome/jobs/.
  let polling = false;
  async function pollJobs() {
    if (polling || document.hidden || !P.list.length) return;
    polling = true;
    try {
      let changed = false;
      await Promise.all(P.list.map(async (dir) => {
        const n = (await codeome.jobs.list(dir)).filter((j) => j.status === 'running').length;
        if (state(dir).jobs !== n) { state(dir).jobs = n; changed = true; }
      }));
      if (changed) render();
    } finally { polling = false; }
  }

  function schedule() { if (!pending) pending = requestAnimationFrame(() => { pending = 0; render(); }); }

  function initials(name) {
    const parts = name.replace(/\.[^.]+$/, '').split(/[-_\s.]+/).filter(Boolean);
    return ((parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)) || '?').toUpperCase();
  }

  // ---------- project colors ----------
  // Twelve hues 30° apart. A new project takes the one furthest from the other open
  // projects' hues; ties go to the earliest in PICK, so the first few are well spread.
  const HUES = [[0, 'Red'], [30, 'Orange'], [60, 'Yellow'], [90, 'Lime'], [120, 'Green'], [150, 'Jade'],
    [180, 'Teal'], [210, 'Blue'], [240, 'Indigo'], [270, 'Violet'], [300, 'Magenta'], [330, 'Pink']];
  const PICK = [210, 30, 120, 300, 180, 0, 270, 90, 150, 330, 240, 60];
  const gap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

  function colorOf(dir) {
    const c = App.cfg.projectColors;
    if (c[dir] == null) {
      const used = P.list.filter((d) => d !== dir && c[d] != null).map((d) => c[d]);
      const far = (hue) => Math.min(Infinity, ...used.map((u) => gap(hue, u)));
      c[dir] = PICK.reduce((best, hue) => (far(hue) > far(best) ? hue : best));
    }
    return c[dir];
  }

  function setColor(dir, hue, save = true) {
    App.cfg.projectColors[dir] = hue;
    render();
    paintTag();
    if (save) App.saveConfig();
  }

  function paintTag() {
    const tag = document.getElementById('project-btn'), dir = App.project;
    document.getElementById('project-name').textContent = dir ? App.basename(dir) : 'No folder open';
    tag.classList.toggle('empty', !dir);
    if (dir) tag.style.setProperty('--ph', colorOf(dir)); else tag.style.removeProperty('--ph');
    tag.title = dir ? App.tildify(dir) : 'Open a project folder (⌘O)';
    tag.setAttribute('aria-label', dir ? `Project ${App.basename(dir)}` : 'Open a project folder');
  }

  // Swatches and a hue slider under the card or tag; changes show as you pick.
  function pickColor(dir, anchor) {
    const swatches = HUES.map(([hue, name]) => h('button.swatch.ptint', {
      style: '--ph: ' + hue, title: name, 'aria-label': name, onclick: () => { setColor(dir, hue); sync(); }
    }));
    const slider = h('input.hue-slider', {
      type: 'range', min: 0, max: 359, step: 1, value: colorOf(dir), 'aria-label': 'Hue',
      oninput: () => { setColor(dir, +slider.value, false); sync(); },
      onchange: () => App.saveConfig()
    });
    const sync = () => {
      const cur = colorOf(dir);
      swatches.forEach((b, i) => b.setAttribute('aria-pressed', String(HUES[i][0] === cur)));
      slider.value = cur;
    };
    sync();
    const body = h('div.color-pick',
      h('div.cp-head', 'Color of ', h('b', App.basename(dir))),
      h('div.swatches', swatches),
      h('label.cp-hue', h('span', 'Any hue'), slider));
    const p = App.popover(anchor, body, 'Project color');
    p.pop.classList.add('color-pop');
    p.set(body);
  }

  function tagMenu() {
    const dir = App.project, tag = document.getElementById('project-btn');
    return [
      { label: 'Project color…', run: () => pickColor(dir, tag) },
      { label: 'Reveal in Finder', run: () => codeome.shell.reveal(dir) },
      { label: 'Copy path', run: () => navigator.clipboard.writeText(dir) },
      '-',
      { label: 'Open another project…', key: '⌘O', run: () => P.open() },
      { label: 'Close project', key: '⇧⌘W', danger: true, run: () => P.close(dir) }
    ];
  }

  function render() {
    if (!el) return;
    const focused = el.contains(document.activeElement);
    el.innerHTML = '';
    const list = h('div.proj-list', { role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'Projects' });
    P.list.forEach((dir) => list.append(card(dir)));
    const collapsed = !!App.cfg.ui.projectsCollapsed;
    el.append(list, h('div.proj-foot',
      h('button.proj-add', { title: 'Open a project (⌘O)', 'aria-label': 'Open a project', onclick: () => P.open() }, h('span', { html: App.icons.plus }), collapsed ? null : h('span', 'Open project')),
      h('button.proj-fold', { title: collapsed ? 'Show project names' : 'Hide project names', 'aria-label': collapsed ? 'Expand project column' : 'Collapse project column', onclick: toggleCollapsed },
        h('span', { html: `<svg viewBox="0 0 16 16"><path d="${collapsed ? 'm6 4 4 4-4 4' : 'm10 4-4 4 4 4'}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>` }))));
    if (focused) { const a = el.querySelector('.proj.active') || el.querySelector('.proj-add'); if (a) a.focus(); }
  }

  function card(dir) {
    const name = App.basename(dir);
    const active = dir === App.project;
    const jobs = state(dir).jobs || 0;
    const sessions = App.views.terminals.list.filter((t) => t.project === dir && t.alive).length;
    const cs = App.views.chat.stats(dir);
    const working = cs.working > 0;
    const unsaved = App.views.editor.tabs.filter((t) => t.project === dir && t.dirty).length;
    const workingText = cs.working > 1 ? `${cs.working} agents working` : 'agent working';
    const stat = [
      cs.waiting ? h('span.ps-wait', `${cs.waiting > 1 ? cs.waiting + ' chats need' : 'agent needs'} you`) : null,
      working ? h('span.ps-jobs', h('i'), workingText) : null,
      jobs ? h('span.ps-jobs', working ? null : h('i'), `${jobs} job${jobs > 1 ? 's' : ''}`) : null,
      cs.unread ? h('span.ps-done', `${cs.unread} repl${cs.unread > 1 ? 'ies' : 'y'} ready`) : null,
      sessions ? h('span', `${sessions} session${sessions > 1 ? 's' : ''}`) : null,
      unsaved ? h('span.ps-dirty', `${unsaved} unsaved`) : null
    ].filter(Boolean);
    const label = [name, cs.waiting ? `${cs.waiting} chat${cs.waiting > 1 ? 's' : ''} waiting for you` : '', working ? workingText : '', jobs ? `${jobs} agent job${jobs > 1 ? 's' : ''} running` : '', cs.unread ? `${cs.unread} unseen agent repl${cs.unread > 1 ? 'ies' : 'y'}` : '', sessions ? `${sessions} live session${sessions > 1 ? 's' : ''}` : '', unsaved ? `${unsaved} unsaved file${unsaved > 1 ? 's' : ''}` : ''].filter(Boolean).join(', ');
    const c = h('div.proj.ptint' + (active ? '.active' : ''), {
      role: 'tab', 'aria-selected': String(active), 'aria-label': label, tabindex: active ? '0' : '-1', draggable: 'true',
      title: App.tildify(dir), style: '--ph: ' + colorOf(dir),
      onclick: () => P.switchTo(dir),
      onauxclick: (e) => { if (e.button === 1) P.close(dir); },
      oncontextmenu: (e) => { e.preventDefault(); App.menu(e.clientX, e.clientY, menu(dir, c)); },
      onkeydown: (e) => {
        const i = P.list.indexOf(dir);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const next = el.querySelectorAll('.proj')[(i + (e.key === 'ArrowDown' ? 1 : -1) + P.list.length) % P.list.length];
          if (next) next.focus();
        } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); P.switchTo(dir); }
      },
      ondragstart: (e) => { dragging = dir; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dir); },
      ondragend: () => { dragging = null; el.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after')); },
      ondragover: (e) => {
        if (!dragging || dragging === dir) return;
        e.preventDefault();
        const r = c.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
        c.classList.toggle('drop-after', after); c.classList.toggle('drop-before', !after);
      },
      ondragleave: () => c.classList.remove('drop-before', 'drop-after'),
      ondrop: (e) => {
        e.preventDefault();
        if (!dragging || dragging === dir) return;
        const after = c.classList.contains('drop-after');
        P.list.splice(P.list.indexOf(dragging), 1);
        P.list.splice(P.list.indexOf(dir) + (after ? 1 : 0), 0, dragging);
        dragging = null;
        App.cfg.openProjects = P.list.slice(); App.saveConfig();
        render();
      }
    },
    h('span.pmono', initials(name), cs.waiting ? h('i.m-wait') : jobs || working ? h('i.m-jobs') : cs.unread ? h('i.m-done') : (unsaved ? h('i.m-dirty') : null)),
    h('span.pinfo',
      h('span.pname', name),
      h('span.ppath', App.tildify(App.dirname(dir))),
      stat.length ? h('span.pstat', stat) : null));
    return c;
  }

  function menu(dir, card) {
    const i = P.list.indexOf(dir);
    return [
      dir !== App.project ? { label: 'Switch to project', run: () => P.switchTo(dir) } : null,
      { label: 'Project color…', run: () => pickColor(dir, card) },
      { label: 'Reveal in Finder', run: () => codeome.shell.reveal(dir) },
      { label: 'Copy path', run: () => navigator.clipboard.writeText(dir) },
      '-',
      { label: 'Move up', disabled: i <= 0, run: () => move(dir, -1) },
      { label: 'Move down', disabled: i >= P.list.length - 1, run: () => move(dir, 1) },
      '-',
      { label: 'Close project', key: '⇧⌘W', danger: true, run: () => P.close(dir) }
    ];
  }

  function move(dir, step) {
    const i = P.list.indexOf(dir), j = i + step;
    if (j < 0 || j >= P.list.length) return;
    [P.list[i], P.list[j]] = [P.list[j], P.list[i]];
    App.cfg.openProjects = P.list.slice(); App.saveConfig();
    render();
  }

  function applyCollapsed() {
    const c = !!App.cfg.ui.projectsCollapsed;
    document.getElementById('app').classList.toggle('proj-collapsed', c);
  }
  function toggleCollapsed() {
    App.cfg.ui.projectsCollapsed = !App.cfg.ui.projectsCollapsed;
    App.saveConfig();
    applyCollapsed();
    render();
    App.views.editor.layout();
  }

  P.render = render;
})();
