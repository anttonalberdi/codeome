// Title bar: 5-hour and weekly usage of Claude and Codex for the active account, and
// a popover to see every account, choose the active one, and add accounts.
(function () {
  const h = App.h;
  const U = { snap: null };
  App.views.usage = U;
  const ENGINES = [['claude', 'Claude'], ['codex', 'Codex']];
  const WINDOWS = [['fiveHour', '5h', '5-hour'], ['weekly', 'wk', 'Weekly']];
  const STALE_S = 30 * 60;

  U.init = async () => {
    U.snap = await codeome.usage.get();
    codeome.usage.onUpdate((s) => { U.snap = s; paint(); App.emit('usage', s); });
    paint();
    // Reset times and "updated … ago" move on even when nothing new arrives.
    setInterval(() => { if (!document.hidden) paint(); }, 60000);
  };

  U.stopAt = () => (U.snap && U.snap.stopAt) || App.cfg.usage.stopAt || 90;
  U.accounts = (engine) => (U.snap && U.snap[engine] ? U.snap[engine].accounts : []);
  U.active = (engine) => { const e = U.snap && U.snap[engine]; return e ? e.accounts.find((a) => a.name === e.active) || e.accounts[0] : null; };
  const fresh = (a) => a && a.asOf && Date.now() / 1000 - a.asOf <= STALE_S;
  // A window that has reset since the reading is back at zero.
  U.pct = (a, k) => {
    const w = a && a.windows && a.windows[k];
    if (!w || w.pct == null) return null;
    return w.resetsAt && w.resetsAt <= Date.now() / 1000 ? 0 : w.pct;
  };
  U.level = (a) => {
    if (!fresh(a)) return null;
    if (a.reached) return 100;
    const ps = WINDOWS.map(([k]) => U.pct(a, k)).filter((p) => p != null);
    return ps.length ? Math.max(...ps) : null;
  };
  U.tone = (p) => (p == null ? 'none' : p >= U.stopAt() ? 'bad' : p >= U.stopAt() - 15 ? 'warn' : 'ok');
  // "5-hour 72% (resets in 1 h 20 min)" for the window closest to the limit.
  U.worst = (a) => {
    let best = null;
    for (const [k, , long] of WINDOWS) { const p = U.pct(a, k); if (p != null && (!best || p > best.p)) best = { p, long, reset: a.windows[k].resetsAt }; }
    return best ? `${best.long} ${Math.round(best.p)}%${best.reset ? ' (resets ' + App.fmtReset(best.reset) + ')' : ''}` : 'no recent reading';
  };

  function summary(engine, label, a) {
    if (!a) return label + ': no account';
    const parts = WINDOWS.map(([k, , long]) => { const p = U.pct(a, k); return p == null ? null : `${long} ${Math.round(p)}%` + (a.windows[k].resetsAt ? `, resets ${App.fmtReset(a.windows[k].resetsAt)}` : ''); }).filter(Boolean);
    const who = U.accounts(engine).length > 1 ? ` · ${a.name}` : '';
    if (!parts.length) return `${label}${who}: ${engine === 'claude' ? 'no reading yet — appears once a Claude Code session started here gets its first reply' : (a.error || 'no reading yet')}`;
    return `${label}${who}: ${parts.join(' · ')}${fresh(a) ? '' : ' (old reading)'}`;
  }

  function meter(a, k, short) {
    const p = a && a.asOf ? U.pct(a, k) : null;
    const tone = fresh(a) ? U.tone(p) : (p == null ? 'none' : 'old');
    return h('span.u-row.' + tone,
      h('span.u-k', short),
      h('span.u-bar', h('i', { style: { width: Math.min(100, p || 0) + '%' } })),
      h('span.u-v', p == null ? '–' : Math.round(p) + '%'));
  }

  function paint() {
    const el = document.getElementById('usage');
    if (!el) return;
    el.innerHTML = '';
    for (const [engine, label] of ENGINES) {
      const a = U.active(engine);
      const many = U.accounts(engine).length > 1;
      el.append(h('button.u-eng', { title: summary(engine, label, a), 'aria-label': summary(engine, label, a), 'aria-haspopup': 'dialog', onclick: (e) => open(engine, e.currentTarget) },
        h('span.u-name', label, many ? h('span.u-acct', a ? a.name : '') : null),
        h('span.u-bars', WINDOWS.map(([k, short]) => meter(a, k, short)))));
    }
    if (App.pop && App.pop.engine) App.pop.set(popContent(App.pop.engine));
  }

  function open(engine, anchor) {
    if (App.pop && App.pop.engine === engine) return App.closePopover();
    const p = App.popover(anchor, popContent(engine), (engine === 'claude' ? 'Claude' : 'Codex') + ' accounts');
    p.engine = engine;
  }

  function popContent(engine) {
    const label = engine === 'claude' ? 'Claude' : 'Codex';
    const e = U.snap && U.snap[engine];
    const wrap = h('div.u-pop');
    let refreshing = false;
    const refreshBtn = h('button.btn.small.ghost', { onclick: async () => {
      if (refreshing) return; refreshing = true; refreshBtn.textContent = 'Refreshing…';
      await codeome.usage.refresh(); refreshing = false; refreshBtn.textContent = 'Refresh';
    } }, 'Refresh');
    wrap.append(h('div.u-pop-head', h('h3', label + ' usage'), refreshBtn));
    for (const a of (e ? e.accounts : [])) {
      const isActive = a.name === e.active;
      const who = [a.email, a.plan].filter(Boolean).join(' · ');
      wrap.append(h('div.u-acc' + (isActive ? '.active' : ''),
        h('div.row',
          h('b.grow', a.name),
          isActive ? h('span.pill.ok', 'active') : h('button.btn.small', { onclick: () => codeome.usage.setActive(engine, a.name) }, 'Make active')),
        h('div.sub', who || (a.signedOut ? 'Not signed in' : (App.tildify(a.dir) || (engine === 'claude' ? '~/.claude' : '~/.codex')))),
        a.signedOut ? h('button.btn.small.primary', { style: { marginTop: '4px' }, onclick: () => U.signIn(engine, a) }, 'Sign in…') : null,
        WINDOWS.map(([k, , long]) => {
          const p = U.pct(a, k);
          const w = a.windows && a.windows[k];
          return h('div.u-line.' + (fresh(a) ? U.tone(p) : 'old'),
            h('span.u-k', long),
            h('span.u-bar', h('i', { style: { width: Math.min(100, p || 0) + '%' } })),
            h('span.u-v', p == null ? '–' : Math.round(p) + '%'),
            h('span.u-r', w && w.resetsAt ? 'resets ' + App.fmtReset(w.resetsAt) : ''));
        }),
        h('div.sub', a.asOf ? 'Updated ' + App.fmtAgo(a.asOf * 1000) + (fresh(a) ? '' : ' — old reading, not used for limits') : (engine === 'claude' ? 'Appears once a Claude Code session started from Codeome gets its first reply.' : (a.error || 'No reading yet.')))));
    }
    wrap.append(h('div.u-pop-foot',
      h('button.btn.small', { onclick: () => U.addAccount(engine) }, 'Add account…'),
      h('span.hint.grow', `Jobs wait at ${U.stopAt()}%`),
      h('button.btn.small.ghost', { onclick: () => { App.closePopover(); App.views.settings.open(); } }, 'Settings')));
    return wrap;
  }

  // ---------- accounts ----------
  const LOGIN = { claude: (d) => `CLAUDE_CONFIG_DIR=${d} claude auth login`, codex: (d) => `CODEX_HOME=${d} codex login` };
  const ENV = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };

  U.signIn = (engine, a) => {
    App.closePopover();
    const cmd = a.dir ? `mkdir -p ${App.shPath(a.dir)} && ${LOGIN[engine](App.shPath(a.dir))}`
      : (engine === 'claude' ? 'unset CLAUDE_CONFIG_DIR; claude auth login' : 'unset CODEX_HOME; codex login');
    App.views.terminals.task(`Sign in · ${engine === 'claude' ? 'Claude' : 'Codex'} ${a.name}`, cmd, App.env.home || '~', { onExit: () => codeome.usage.refresh() });
  };

  U.addAccount = async (engine) => {
    App.closePopover();
    const label = engine === 'claude' ? 'Claude' : 'Codex';
    const list = App.cfg.accounts[engine].list;
    const v = await App.modal({
      title: `Add a ${label} account`,
      text: `Each account lives in its own folder (${ENV[engine]}). Codeome opens a terminal to sign in; agent jobs then use whichever account has headroom.`,
      ok: 'Add and sign in',
      fields: [
        { key: 'name', label: 'Name', placeholder: 'Work', value: '' },
        { key: 'dir', label: 'Folder', placeholder: engine === 'claude' ? '~/.claude-work' : '~/.codex-work', hint: 'Leave empty to use ~/.' + engine + '-<name>.' }
      ]
    });
    if (!v || !v.name.trim()) return;
    const name = v.name.trim();
    if (list.some((a) => a.name === name)) return App.err(`There is already a ${label} account called ${name}.`);
    const dir = (v.dir.trim() || `~/.${engine}-${App.safeName(name)}`).replace(/\/+$/, '');
    list.push({ name, dir });
    await App.saveConfig();
    U.signIn(engine, { name, dir });
  };

  U.paint = paint;
})();
