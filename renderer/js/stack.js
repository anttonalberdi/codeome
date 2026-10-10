// Stacked sections in a sidebar view: Files (this Mac, HPC, storage) and Packages
// (Python, R). Click a header to collapse the section to it, drag the line between
// two open sections to resize them (double-click to even them out), right-click a
// header to rename it or show only that section. A section can also be hidden.
// Layout and names are saved in App.cfg.ui[key][id]: { title, collapsed, weight }.
(function () {
  const h = App.h;
  const CHEVRON = '<svg viewBox="0 0 16 16"><path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

  // sections: [{ id, title, tools: [nodes], dot: node, menu: () => items (the ⋯ button),
  //   items: () => extra items for the header's context menu, body: node, onExpand }]
  App.stack = function ({ key, sections }) {
    const ids = sections.map((s) => s.id);
    const def = Object.fromEntries(sections.map((s) => [s.id, s]));
    const S = { panes: {}, hidden: new Set(), el: h('div.pane-stack') };
    const cfgOf = (id) => { const u = App.cfg.ui; const p = (u[key] = u[key] || {}); return (p[id] = p[id] || {}); };
    const open = (id) => !S.hidden.has(id) && !cfgOf(id).collapsed;
    S.cfg = cfgOf;
    S.title = (id) => cfgOf(id).title || def[id].title;
    S.isOpen = open;

    function pane(s) {
      const titleEl = h('span.pane-title', S.title(s.id));
      const toggle = h('button.pane-toggle', { title: 'Collapse or expand (right-click to rename)', onclick: () => S.toggle(s.id) },
        h('span.chev', { html: CHEVRON }), titleEl, s.dot || null);
      const tools = h('div.pane-tools', s.tools || []);
      const head = h('div.side-head.pane-head', { oncontextmenu: (e) => { e.preventDefault(); App.menu(e.clientX, e.clientY, S.items(s.id)); } },
        toggle, tools, s.menu ? App.iconBtn('dots', 'More', (e) => App.menuAt(e.currentTarget, s.menu())) : null);
      const body = h('div.pane-body', s.body || []);
      const el = h('div.side-section.split-pane', { 'data-side': s.id }, head, body);
      return { el, head, body, titleEl, toggle, tools };
    }

    // The nearest open section above (dir -1) or below (dir 1) the handle in front of ids[i].
    function neighbour(i, dir) {
      for (let j = dir < 0 ? i - 1 : i; j >= 0 && j < ids.length; j += dir) if (open(ids[j])) return ids[j];
      return null;
    }

    function resizer(i) {
      const rz = h('div.pane-resizer', { 'data-i': i, role: 'separator', 'aria-orientation': 'horizontal', title: 'Drag to resize · double-click to even out' });
      rz.addEventListener('mousedown', (e) => {
        const a = neighbour(i, -1), b = neighbour(i, 1);
        if (!a || !b) return;
        e.preventDefault();
        const ha = S.panes[a].el.getBoundingClientRect().height, hb = S.panes[b].el.getBoundingClientRect().height;
        const w = (cfgOf(a).weight || 1) + (cfgOf(b).weight || 1), total = ha + hb, min = 64, y0 = e.clientY;
        document.body.classList.add('row-resizing');
        const move = (ev) => {
          const na = Math.max(min, Math.min(total - min, ha + ev.clientY - y0));
          cfgOf(a).weight = w * na / total; cfgOf(b).weight = w * (total - na) / total;
          S.layout();
        };
        const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); document.body.classList.remove('row-resizing'); App.saveConfig(); };
        addEventListener('mousemove', move); addEventListener('mouseup', up);
      });
      rz.addEventListener('dblclick', () => { for (const id of ids) delete cfgOf(id).weight; S.layout(); App.saveConfig(); });
      return rz;
    }

    S.layout = () => {
      for (const id of ids) {
        const p = S.panes[id], c = cfgOf(id);
        p.el.hidden = S.hidden.has(id);
        p.el.classList.toggle('collapsed', !!c.collapsed);
        p.body.hidden = p.tools.hidden = !!c.collapsed;
        p.toggle.setAttribute('aria-expanded', String(!c.collapsed));
        p.el.style.flex = c.collapsed ? '0 0 auto' : `${c.weight || 1} 1 0px`;
      }
      // A handle shows between two shown sections, and works with an open one on both sides.
      S.el.querySelectorAll(':scope > .pane-resizer').forEach((rz) => {
        const i = Number(rz.dataset.i);
        rz.hidden = S.hidden.has(ids[i]) || ids.slice(0, i).every((id) => S.hidden.has(id));
        rz.classList.toggle('inert', !neighbour(i, -1) || !neighbour(i, 1));
      });
    };

    S.toggle = (id, wantOpen) => {
      const c = cfgOf(id);
      c.collapsed = wantOpen === undefined ? !c.collapsed : !wantOpen;
      S.layout(); App.saveConfig();
      if (!c.collapsed && def[id].onExpand) def[id].onExpand();
    };
    S.setHidden = (id, hide) => { if (hide) S.hidden.add(id); else S.hidden.delete(id); S.layout(); };
    // Only this section open (or all of them again).
    S.solo = (id) => {
      const others = ids.filter((x) => x !== id && !S.hidden.has(x));
      const soloed = !cfgOf(id).collapsed && others.every((x) => cfgOf(x).collapsed);
      for (const x of others) cfgOf(x).collapsed = !soloed;
      S.toggle(id, true);
      if (soloed) for (const x of others) if (def[x].onExpand) def[x].onExpand();
    };
    S.expand = (id) => { if (cfgOf(id).collapsed) S.toggle(id, true); };

    S.rename = (id) => {
      const p = S.panes[id];
      if (p.head.querySelector('.pane-rename')) return;
      if (cfgOf(id).collapsed) S.toggle(id, true);
      const input = h('input.pane-rename', { type: 'text', value: S.title(id), maxlength: '40', spellcheck: 'false', 'aria-label': 'Section name', placeholder: def[id].title });
      p.toggle.hidden = true; p.head.prepend(input);
      input.focus(); input.select();
      let finished = false;
      const done = (save) => {
        // Removing the input blurs it, which calls this again.
        if (finished) return;
        finished = true;
        const v = input.value.trim();
        input.remove(); p.toggle.hidden = false; p.toggle.focus();
        if (!save) return;
        const c = cfgOf(id);
        if (!v || v === def[id].title) delete c.title; else c.title = v;
        p.titleEl.textContent = S.title(id);
        App.saveConfig();
        if (def[id].onRename) def[id].onRename();
      };
      input.onkeydown = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); done(true); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      };
      input.onblur = () => done(true);
    };
    S.retitle = () => { for (const id of ids) S.panes[id].titleEl.textContent = S.title(id); };

    S.items = (id) => {
      const c = cfgOf(id);
      const shown = ids.filter((x) => !S.hidden.has(x));
      return [
        { label: 'Rename section…', run: () => S.rename(id) },
        { label: c.collapsed ? 'Expand section' : 'Collapse section', run: () => S.toggle(id) },
        shown.length > 1 ? { label: shown.every((x) => x === id || cfgOf(x).collapsed) && !c.collapsed ? 'Show all sections' : 'Show only this section', run: () => S.solo(id) } : null,
        ...(def[id].items ? def[id].items() : [])
      ];
    };

    sections.forEach((s, i) => {
      if (i) S.el.append(resizer(i));
      S.panes[s.id] = pane(s);
      S.el.append(S.panes[s.id].el);
    });
    S.layout();
    return S;
  };
})();
