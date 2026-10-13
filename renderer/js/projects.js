// Left column: one card per open project. Each project keeps its own editor tabs,
// terminal and agent sessions (which keep running while another project is shown)
// and its place in the HPC file browser. Each project has a color (a hue) shared by its
// card and the tag in the title bar; it is picked when the project is first opened.
// Cards can be put in named groups, which fold to their header. The groups come first,
// in their own order, and the projects in no group follow.
// Projects can also be connected to each other: the agent chat of a project works across
// the folders of the projects connected to it. The card shows a chain and how many, and
// the tag in the title bar is followed by a smaller tag for each of them.
(function () {
  const h = App.h;
  const P = { list: [], state: {} }; // state[dir] = { remoteDir, jobs }
  App.views.projects = P;
  let el, dragging = null, pending = 0;

  P.init = () => {
    el = document.getElementById('projects');
    P.list = (App.cfg.openProjects || []).filter(Boolean);
    App.cfg.projectColors = App.cfg.projectColors || {};
    App.cfg.projectGroups = (App.cfg.projectGroups || []).filter((g) => g && g.id);
    App.cfg.projectGroup = App.cfg.projectGroup || {};
    App.cfg.projectLinks = App.cfg.projectLinks || {};
    P.list = shown();
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

  // group: the group the project goes into; without one it returns to the group it was last in.
  P.open = async (dir, group) => {
    dir = dir || await codeome.dialog.folder({ defaultPath: App.project || App.cfg.localRoot });
    if (!dir) return;
    if (!P.list.includes(dir)) P.list.push(dir);
    if (group) { setGroup(dir, group); group.collapsed = false; }
    P.list = shown();
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
    const next = P.list[(i + step + P.list.length) % P.list.length], g = groupOf(next);
    if (g) g.collapsed = false;
    P.switchTo(next);
  };

  // ---------- groups ----------
  // cfg.projectGroups = [{ id, name, collapsed }] in the order shown; cfg.projectGroup maps
  // a project to its group's id, and is kept when the project is closed.
  const groupOf = (dir) => App.cfg.projectGroups.find((g) => g.id === App.cfg.projectGroup[dir]) || null;
  const members = (g) => P.list.filter((d) => groupOf(d) === g); // g = null: the projects in no group
  const shown = () => [...App.cfg.projectGroups.flatMap(members), ...members(null)];
  function setGroup(dir, g) { if (g) App.cfg.projectGroup[dir] = g.id; else delete App.cfg.projectGroup[dir]; }

  function saveOrder() {
    P.list = shown();
    App.cfg.openProjects = P.list.slice(); App.saveConfig();
    render();
  }

  // Put a project last in a group, or last among the ungrouped ones.
  function moveTo(dir, g) {
    setGroup(dir, g);
    P.list.splice(P.list.indexOf(dir), 1); P.list.push(dir);
    saveOrder();
  }

  P.addGroup = async () => {
    const name = await App.prompt('New group', 'Name', '', { placeholder: 'e.g. Thesis', ok: 'Create' });
    if (!name) return null;
    const g = { id: 'g' + Date.now().toString(36), name, collapsed: false };
    App.cfg.projectGroups.push(g);
    saveOrder();
    return g;
  };

  async function renameGroup(g) {
    const name = await App.prompt('Rename group', 'Name', g.name, { ok: 'Rename' });
    if (!name) return;
    g.name = name;
    saveOrder();
  }

  // Its projects stay open and join the ungrouped ones.
  function removeGroup(g) {
    for (const [dir, id] of Object.entries(App.cfg.projectGroup)) if (id === g.id) delete App.cfg.projectGroup[dir];
    App.cfg.projectGroups.splice(App.cfg.projectGroups.indexOf(g), 1);
    saveOrder();
  }

  function moveGroup(g, step) {
    const all = App.cfg.projectGroups, i = all.indexOf(g), j = i + step;
    if (j < 0 || j >= all.length) return;
    [all[i], all[j]] = [all[j], all[i]];
    saveOrder();
  }

  function toggleGroup(g) { g.collapsed = !g.collapsed; App.saveConfig(); render(); }

  // The most pressing state among a folded group's projects, as the class of its dot.
  function mark(dirs) {
    const of = (dir) => {
      const cs = App.views.chat.stats(dir);
      if (cs.waiting) return 'm-wait';
      if (cs.working || state(dir).jobs) return 'm-jobs';
      if (cs.unread) return 'm-done';
      return App.views.editor.tabs.some((t) => t.project === dir && t.dirty) ? 'm-dirty' : null;
    };
    const marks = dirs.map(of);
    return ['m-wait', 'm-jobs', 'm-done', 'm-dirty'].find((m) => marks.includes(m)) || null;
  }

  function groupMenu(g) {
    const all = App.cfg.projectGroups, i = all.indexOf(g), n = members(g).length;
    return [
      { label: g.collapsed ? 'Expand' : 'Collapse', run: () => toggleGroup(g) },
      { label: 'Rename…', run: () => renameGroup(g) },
      { label: 'Open a project here…', run: () => P.open(null, g) },
      '-',
      { label: 'Move up', disabled: i <= 0, run: () => moveGroup(g, -1) },
      { label: 'Move down', disabled: i >= all.length - 1, run: () => moveGroup(g, 1) },
      '-',
      { label: n ? 'Ungroup projects' : 'Delete group', run: () => removeGroup(g) }
    ];
  }

  function groupBlock(g) {
    const dirs = members(g), n = dirs.length;
    const dot = g.collapsed ? mark(dirs) : null;
    const head = h('button.pg-head' + (g.collapsed && dirs.includes(App.project) ? '.active' : ''), {
      'data-g': g.id, 'aria-expanded': String(!g.collapsed),
      title: `${g.name} · ${n} project${n === 1 ? '' : 's'}`,
      onclick: () => toggleGroup(g),
      oncontextmenu: (e) => { e.preventDefault(); App.menu(e.clientX, e.clientY, groupMenu(g)); },
      ondragover: (e) => { if (!dragging) return; e.preventDefault(); head.classList.add('drop-in'); },
      ondragleave: () => head.classList.remove('drop-in'),
      ondrop: (e) => {
        e.preventDefault();
        if (!dragging) return;
        const dir = dragging; dragging = null;
        moveTo(dir, g);
      }
    },
    h('span.pg-chev', { html: `<svg viewBox="0 0 16 16"><path d="${g.collapsed ? 'm6 4 4 4-4 4' : 'm4 6 4 4 4-4'}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>` }),
    h('span.pg-name', g.name),
    dot ? h('i.' + dot) : null,
    h('span.pg-count', String(n)));
    return h('div.pg', { role: 'group', 'aria-label': g.name }, head,
      g.collapsed ? null : n ? dirs.map(card) : h('div.pg-empty', 'Drag a project here'));
  }

  // ---------- connections ----------
  // cfg.projectLinks maps a project to the projects it is connected to. A connection goes
  // both ways and is direct: A–B and B–C do not connect A and C. Chats pick a change up
  // when they next start (see chat:start in main.js).
  const linksOf = (dir) => App.cfg.projectLinks[dir] || [];
  P.linksOf = linksOf;
  function setLink(a, b, on) {
    for (const [x, y] of [[a, b], [b, a]]) {
      const l = linksOf(x).filter((d) => d !== y);
      if (on) l.push(y);
      if (l.length) App.cfg.projectLinks[x] = l; else delete App.cfg.projectLinks[x];
    }
    App.saveConfig();
    render();
    paintTag();
  }
  const LINK_ICON = '<svg viewBox="0 0 16 16"><path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.9-.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

  // The other open projects, and connected ones that are closed, each with a checkbox.
  function pickLinks(dir, anchor) {
    const others = [...new Set([...P.list, ...linksOf(dir)])].filter((d) => d !== dir);
    const body = h('div.link-pick',
      h('div.cp-head', 'Connect ', h('b', App.basename(dir)), ' to'),
      others.length ? h('div.lp-list', others.map((d) => {
        const box = h('input', { type: 'checkbox', checked: linksOf(dir).includes(d), onchange: () => setLink(dir, d, box.checked) });
        return h('label.lp-item', { title: App.tildify(d) }, box,
          h('span.lp-dot.ptint', { style: '--ph: ' + colorOf(d) }),
          h('span.lp-name', App.basename(d)),
          P.list.includes(d) ? null : h('span.lp-note', 'closed'));
      })) : h('div.lp-note', 'Open another project to connect it.'),
      h('div.lp-help', 'The agent chat of each project can read and edit the other\'s files. Chats that are running pick this up when they restart.'));
    const p = App.popover(anchor, body, 'Connected projects');
    p.pop.classList.add('color-pop');
    p.set(body);
  }

  const state = (dir) => (P.state[dir] = P.state[dir] || {});

  // Running agent jobs per project, read from each project's .codeome/jobs/.
  let polling = false;
  async function pollJobs() {
    if (polling || document.hidden || !P.list.length) return;
    polling = true;
    try {
      let changed = false;
      await Promise.all(P.list.map(async (dir) => {
        const list = await codeome.jobs.list(dir);
        // Codex jobs end outside the chat stream; reconcile every project's chats with
        // the job records, not only the open one's, so its card gets the finished marker.
        App.views.chat.syncJobs(dir, list);
        const n = list.filter((j) => j.status === 'running').length;
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
    // The projects connected to it follow as smaller tags, each after a chain link.
    const links = document.getElementById('project-links');
    links.innerHTML = '';
    for (const d of dir ? linksOf(dir) : []) {
      links.append(h('span.tag-chain', { html: LINK_ICON }),
        h('button.project-tag.sub.ptint', {
          style: '--ph: ' + colorOf(d), title: App.tildify(d), 'aria-label': `Connected project ${App.basename(d)}`,
          onclick: () => P.open(d)
        }, App.basename(d)));
    }
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
    const focused = el.contains(document.activeElement), fg = focused && document.activeElement.dataset.g;
    el.innerHTML = '';
    // Dropping a card on the empty part of the list takes it out of its group.
    const list = h('div.proj-list', {
      role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'Projects',
      ondragover: (e) => { if (dragging && groupOf(dragging) && !e.target.closest('.pg')) e.preventDefault(); },
      ondrop: (e) => {
        if (!dragging || e.target.closest('.pg, .proj')) return;
        e.preventDefault();
        const dir = dragging; dragging = null;
        moveTo(dir, null);
      }
    });
    App.cfg.projectGroups.forEach((g) => list.append(groupBlock(g)));
    members(null).forEach((dir) => list.append(card(dir)));
    const collapsed = !!App.cfg.ui.projectsCollapsed;
    el.append(list, h('div.proj-foot',
      h('button.proj-add', { title: 'Open a project (⌘O)', 'aria-label': 'Open a project', onclick: () => P.open() }, h('span', { html: App.icons.plus }), collapsed ? null : h('span', 'Project')),
      h('button.proj-add', { title: 'New group of projects', 'aria-label': 'New group of projects', onclick: () => P.addGroup() }, h('span', { html: collapsed ? GROUP_ICON : App.icons.plus }), collapsed ? null : h('span', 'Group')),
      h('button.proj-fold', { title: collapsed ? 'Show project names' : 'Hide project names', 'aria-label': collapsed ? 'Expand project column' : 'Collapse project column', onclick: toggleCollapsed },
        h('span', { html: `<svg viewBox="0 0 16 16"><path d="${collapsed ? 'm6 4 4 4-4 4' : 'm10 4-4 4 4 4'}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>` }))));
    if (focused) { const a = (fg && el.querySelector(`.pg-head[data-g="${fg}"]`)) || el.querySelector('.proj.active') || el.querySelector('.proj-add'); if (a) a.focus(); }
  }
  const GROUP_ICON = '<svg viewBox="0 0 16 16"><path d="M2.5 3.5h11v3.5h-11zM2.5 9h11v3.5h-11z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

  function card(dir) {
    const name = App.basename(dir);
    const active = dir === App.project;
    const jobs = state(dir).jobs || 0;
    const sessions = App.views.terminals.list.filter((t) => t.project === dir && t.alive).length;
    const cs = App.views.chat.stats(dir);
    const working = cs.working > 0;
    const unsaved = App.views.editor.tabs.filter((t) => t.project === dir && t.dirty).length;
    const links = linksOf(dir), linkText = links.length ? `connected to ${links.map(App.basename).join(', ')}` : '';
    const workingText = cs.working > 1 ? `${cs.working} agents working` : 'agent working';
    const stat = [
      cs.waiting ? h('span.ps-wait', `${cs.waiting > 1 ? cs.waiting + ' chats need' : 'agent needs'} you`) : null,
      working ? h('span.ps-jobs', h('i'), workingText) : null,
      jobs ? h('span.ps-jobs', working ? null : h('i'), `${jobs} job${jobs > 1 ? 's' : ''}`) : null,
      cs.unread ? h('span.ps-done', `✓ ${cs.unread > 1 ? cs.unread + ' tasks' : 'task'} finished`) : null,
      sessions ? h('span', `${sessions} session${sessions > 1 ? 's' : ''}`) : null,
      unsaved ? h('span.ps-dirty', `${unsaved} unsaved`) : null
    ].filter(Boolean);
    const label = [name, cs.waiting ? `${cs.waiting} chat${cs.waiting > 1 ? 's' : ''} waiting for you` : '', working ? workingText : '', jobs ? `${jobs} agent job${jobs > 1 ? 's' : ''} running` : '', cs.unread ? `${cs.unread} unseen agent repl${cs.unread > 1 ? 'ies' : 'y'}` : '', sessions ? `${sessions} live session${sessions > 1 ? 's' : ''}` : '', unsaved ? `${unsaved} unsaved file${unsaved > 1 ? 's' : ''}` : '', linkText].filter(Boolean).join(', ');
    const c = h('div.proj.ptint' + (active ? '.active' : ''), {
      role: 'tab', 'aria-selected': String(active), 'aria-label': label, tabindex: active ? '0' : '-1', draggable: 'true',
      title: App.tildify(dir), style: '--ph: ' + colorOf(dir),
      onclick: () => P.switchTo(dir),
      onauxclick: (e) => { if (e.button === 1) P.close(dir); },
      oncontextmenu: (e) => { e.preventDefault(); App.menu(e.clientX, e.clientY, menu(dir, c)); },
      onkeydown: (e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const cards = [...el.querySelectorAll('.proj')];
          const next = cards[(cards.indexOf(c) + (e.key === 'ArrowDown' ? 1 : -1) + cards.length) % cards.length];
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
        setGroup(dragging, groupOf(dir));
        P.list.splice(P.list.indexOf(dragging), 1);
        P.list.splice(P.list.indexOf(dir) + (after ? 1 : 0), 0, dragging);
        dragging = null;
        saveOrder();
      }
    },
    h('span.pmono', initials(name), cs.waiting ? h('i.m-wait') : jobs || working ? h('i.m-jobs') : cs.unread ? h('i.m-done') : (unsaved ? h('i.m-dirty') : null)),
    h('span.pinfo',
      h('span.prow', h('span.pname', name),
        links.length ? h('span.plink', { title: 'Connected to ' + links.map(App.basename).join(', '), onclick: (e) => { e.stopPropagation(); pickLinks(dir, c); }, html: LINK_ICON + links.length }) : null),
      h('span.ppath', App.tildify(App.dirname(dir))),
      stat.length ? h('span.pstat', stat) : null));
    return c;
  }

  function menu(dir, card) {
    const g = groupOf(dir), near = members(g), i = near.indexOf(dir);
    return [
      dir !== App.project ? { label: 'Switch to project', run: () => P.switchTo(dir) } : null,
      { label: 'Project color…', run: () => pickColor(dir, card) },
      { label: 'Reveal in Finder', run: () => codeome.shell.reveal(dir) },
      { label: 'Copy path', run: () => navigator.clipboard.writeText(dir) },
      { label: 'Connect to projects…', run: () => pickLinks(dir, card) },
      '-',
      { label: 'Move up', disabled: i <= 0, run: () => move(dir, -1) },
      { label: 'Move down', disabled: i >= near.length - 1, run: () => move(dir, 1) },
      '-',
      ...App.cfg.projectGroups.filter((x) => x !== g).map((x) => ({ label: `Move to ${x.name}`, run: () => moveTo(dir, x) })),
      { label: 'Move to a new group…', run: async () => { const x = await P.addGroup(); if (x) moveTo(dir, x); } },
      g ? { label: `Remove from ${g.name}`, run: () => moveTo(dir, null) } : null,
      '-',
      { label: 'Close project', key: '⇧⌘W', danger: true, run: () => P.close(dir) }
    ];
  }

  function move(dir, step) {
    // Within its group: the neighbours there are neighbours in P.list too.
    const near = members(groupOf(dir)), other = near[near.indexOf(dir) + step];
    if (!other) return;
    const i = P.list.indexOf(dir), j = P.list.indexOf(other);
    [P.list[i], P.list[j]] = [P.list[j], P.list[i]];
    saveOrder();
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
