// Resource samples are requested only while this full-page view is open.
(function () {
  const M = { isOpen: false };
  App.views.metrics = M;
  const cpu = (value) => Number.isFinite(value) ? value.toFixed(1) + '%' : '–';
  const memory = (kb) => {
    if (!Number.isFinite(kb)) return '–';
    const mb = kb / 1024;
    return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
  };
  M._fmt = { cpu, memory };
  let page, content, cores, updated, error, done;
  let timer = null, inFlight = false, generation = 0;
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  M.init = () => { if (!page) build(); };
  M.open = () => {
    M.init();
    App.views.settings.close();
    clearInterval(timer);
    if (!M.isOpen) generation++;
    M.isOpen = true;
    page.hidden = false;
    document.getElementById('app').classList.add('metrics-open');
    document.getElementById('metrics-btn').setAttribute('aria-expanded', 'true');
    sample();
    timer = setInterval(sample, 5000);
    done.focus();
  };
  M.close = () => {
    clearInterval(timer); timer = null;
    if (!M.isOpen) return;
    M.isOpen = false; generation++;
    page.hidden = true;
    document.getElementById('app').classList.remove('metrics-open');
    const button = document.getElementById('metrics-btn');
    button.setAttribute('aria-expanded', 'false');
    if (page.contains(document.activeElement)) button.focus();
    App.views.editor.layout();
  };
  M.toggle = () => M.isOpen ? M.close() : M.open();
  function build() {
    page = el('section'); page.id = 'metrics-page'; page.hidden = true;
    page.setAttribute('aria-label', 'Resource monitor');
    const main = el('div', undefined, 'sp-content');
    const heading = el('div', undefined, 'metrics-heading');
    cores = el('span', '', 'metrics-cores');
    done = el('button', 'Done', 'btn'); done.onclick = M.close;
    heading.append(el('h1', 'Resource monitor'), cores, done);
    updated = el('div', 'Loading resource usage…', 'metrics-status');
    updated.setAttribute('role', 'status');
    error = el('div', '', 'metrics-error'); error.setAttribute('role', 'alert');
    content = el('div');
    main.append(heading, el('p', 'CPU is % of one core, so 100% = one full core', 'sp-intro'), updated, error, content);
    page.append(main); document.getElementById('app').append(page);
    document.addEventListener('keydown', (e) => {
      if (!M.isOpen || e.key !== 'Escape' || e.defaultPrevented) return;
      if (!document.getElementById('overlay').hidden || !document.getElementById('menu-pop').hidden || App.pop) return;
      e.preventDefault(); M.close();
    });
    App.listen('view', M.close);
  }
  async function sample() {
    if (!M.isOpen || inFlight) return;
    inFlight = true;
    const session = generation;
    try {
      const data = await window.codeome.metrics.agents();
      if (!M.isOpen || session !== generation) return;
      if (data.error) throw new Error(data.error);
      render(data);
      error.textContent = '';
      updated.textContent = 'Updated ' + new Date(data.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    } catch (e) {
      if (M.isOpen && session === generation) {
        error.textContent = 'Could not load resource usage: ' + (e.message || String(e));
        if (!content.children.length) updated.textContent = 'Resource usage unavailable.';
      }
    } finally {
      inFlight = false;
      // Reopening during an older request still gets its own immediate sample.
      if (M.isOpen && session !== generation) sample();
    }
  }
  function row(label, values, kind) {
    const tr = el('tr'), name = el('th', label);
    name.setAttribute('scope', 'row');
    if (kind) name.append(el('span', { chat: 'Chat', terminal: 'Terminal', job: 'Job' }[kind] || kind, 'metrics-kind'));
    tr.append(name, el('td', cpu(values.cpu)), el('td', memory(values.rssKb)), el('td', values.nproc ?? '–'));
    return tr;
  }
  function table() {
    const t = el('table', undefined, 'metrics-table'), head = el('thead'), tr = el('tr');
    for (const label of ['Agent', 'CPU', 'Memory', 'Processes']) {
      const th = el('th', label); th.setAttribute('scope', 'col');
      if (label === 'CPU') th.title = 'Average CPU since the process was last sampled by the OS (ps), as % of one core';
      if (label === 'Memory') th.title = 'Resident memory including child processes; shared pages are counted per process, so totals can over-count slightly';
      tr.append(th);
    }
    head.append(tr); t.append(head); return t;
  }
  function render(data) {
    cores.textContent = data.ncpu + ' cores';
    content.replaceChildren();
    if (!data.projects.some((group) => group.items.length)) content.append(el('p', 'No agents running.', 'sp-intro'));
    for (const group of data.projects) {
      const card = el('section', undefined, 'sp-card');
      const basename = group.project.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || group.project;
      const title = el('h2', basename, 'sp-card-h'); title.title = group.project;
      const t = table(), body = el('tbody'), foot = el('tfoot');
      t.setAttribute('aria-label', 'Agents in ' + group.project);
      for (const item of group.items) body.append(row(item.label, item, item.kind));
      foot.append(row('Project total', group.totals)); t.append(body, foot);
      const wrap = el('div', undefined, 'metrics-table-wrap'); wrap.append(t);
      card.append(title, wrap); content.append(card);
    }
    const card = el('div', undefined, 'sp-card metrics-table-wrap'), t = table(), body = el('tbody');
    t.setAttribute('aria-label', 'Codeome app resource usage');
    body.append(row('Codeome app', data.app)); t.append(body); card.append(t); content.append(card);
  }
})();
