// Title bar: 5-hour and weekly usage of Claude and Codex for the active account, and
// a popover to see every account, choose the active one, and add accounts by email.
(function () {
  const h = App.h;
  const U = { snap: null, found: { claude: [], codex: [] } };
  App.views.usage = U;
  const ENGINES = [['claude', 'Claude'], ['codex', 'Codex']];
  const WINDOWS = [['fiveHour', '5h', '5-hour'], ['weekly', 'wk', 'Weekly']];
  const STALE_S = 30 * 60;

  U.init = async () => {
    U.snap = await codeome.usage.get();
    codeome.usage.onUpdate((s) => { U.snap = s; paint(); App.emit('usage', s); adopt(); });
    paint();
    adopt();
    // Reset times and "updated … ago" move on even when nothing new arrives.
    setInterval(() => { if (!document.hidden) paint(); }, 60000);
  };

  // An account is named by the email address it signs in with (same rule as main/usage.js).
  U.isEmail = (s) => /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(String(s || ''));
  const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  // you@example.org → you, where there is no room for the address.
  U.short = (name) => (U.isEmail(name) ? name.split('@')[0] : name);
  // Signed in as itself: the only accounts work is started on or moved to.
  U.ready = (a) => !!(a && a.signedIn && !a.mismatch);

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
  // The windows an account's plan has: a reading without a 5-hour window means there is none.
  // Before the first reading, both are assumed.
  U.windows = (a) => (a && a.asOf && a.windows && Object.keys(a.windows).length ? WINDOWS.filter(([k]) => a.windows[k]) : WINDOWS);
  // max → Max, the subscription as the CLI names it.
  U.plan = (a) => (a && a.plan ? String(a.plan).replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase()) : null);
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

  // The two windows of an account as bars with their reset times, and how old the reading is.
  U.lines = (engine, a) => [
    U.windows(a).map(([k, , long]) => {
      const p = U.pct(a, k);
      const w = a.windows && a.windows[k];
      return h('div.u-line.' + (fresh(a) ? U.tone(p) : 'old'),
        h('span.u-k', long),
        h('span.u-bar', h('i', { style: { width: Math.min(100, p || 0) + '%' } })),
        h('span.u-v', p == null ? '–' : Math.round(p) + '%'),
        h('span.u-r', w && w.resetsAt ? 'resets ' + App.fmtReset(w.resetsAt) : ''));
    }),
    h('div.sub', a.asOf ? 'Updated ' + App.fmtAgo(a.asOf * 1000) + (fresh(a) ? '' : ' — old reading, not used for limits') : (engine === 'claude' ? 'Appears once a Claude Code session started from Codeome gets its first reply.' : (a.error || 'No reading yet.')))
  ];

  function paint() {
    const el = document.getElementById('usage');
    if (!el) return;
    el.innerHTML = '';
    for (const [engine, label] of ENGINES) {
      const a = U.active(engine);
      const many = U.accounts(engine).length > 1;
      el.append(h('button.u-eng', { title: summary(engine, label, a), 'aria-label': summary(engine, label, a), 'aria-haspopup': 'dialog', onclick: (e) => open(engine, e.currentTarget) },
        h('span.u-name', label, many ? h('span.u-acct', a ? U.short(a.name) : '') : null),
        h('span.u-bars', U.windows(a).map(([k, short]) => meter(a, k, short)))));
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
      const who = same(a.email, a.name) ? null : a.email;
      wrap.append(h('div.u-acc' + (isActive ? '.active' : ''),
        h('div.row',
          h('b', a.name), U.plan(a) ? h('span.pill', { title: label + ' subscription' }, U.plan(a)) : null, h('span.grow'),
          isActive ? h('span.pill.ok', 'active') : a.signedOut ? null : h('button.btn.small', { onclick: () => codeome.usage.setActive(engine, a.name) }, 'Make active')),
        h('div.sub', a.mismatch ? `Signed in as ${a.email}, not ${a.name}` : a.signedOut ? 'Not signed in' : (who || (a.signedIn ? 'Signed in' : 'Asking who is signed in…'))),
        a.signedOut ? h('button.btn.small.primary', { style: { marginTop: '4px' }, onclick: () => U.signInAll([{ engine, a }]) }, 'Sign in…') : U.lines(engine, a)));
    }
    wrap.append(h('div.u-pop-foot',
      h('button.btn.small', { onclick: () => U.addAccount(engine) }, 'Add account…'),
      h('span.hint.grow', `Jobs wait at ${U.stopAt()}%`),
      h('button.btn.small.ghost', { onclick: () => { App.closePopover(); App.views.settings.open(); } }, 'Settings')));
    return wrap;
  }

  // ---------- accounts ----------
  // An account is an email address. Signing in confirms it, and its sign-in then stays
  // in the account's own folder, so moving to it later never asks again.
  const ENV = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };
  const NAME = { claude: 'Claude', codex: 'Codex' };
  // Claude's sign-in page can start with the address filled in; Codex's cannot.
  const LOGIN = { claude: (a) => 'claude auth login' + (U.isEmail(a.name) ? ' --email ' + a.name : ''), codex: () => 'codex login' };
  const inSnap = (snap, engine, a) => ((snap && snap[engine] && snap[engine].accounts) || []).find((x) => (a.dir == null ? x.name === a.name : (x.dir || '') === (a.dir || '')));

  // The account goes by this address from now on. Chats started under the old name still find it.
  U.rename = (engine, name, email) => {
    const accts = App.cfg.accounts[engine];
    const entry = accts.list.find((x) => x.name === name);
    if (!entry || accts.list.some((x) => x !== entry && same(x.name, email))) return false;
    entry.aka = [...(entry.aka || []), entry.name];
    if (accts.active === entry.name) accts.active = email;
    entry.name = email;
    return true;
  };

  // An account without an address (the CLI's own folder, or one from before accounts
  // were emails) takes the address it is signed in with.
  let adopting = false;
  async function adopt() {
    if (adopting) return;
    let changed = false;
    for (const [engine] of ENGINES) {
      for (const a of U.accounts(engine)) {
        const entry = App.cfg.accounts[engine].list.find((x) => x.name === a.name && (x.dir || '') === (a.dir || ''));
        if (entry && !U.isEmail(entry.name) && a.signedIn && U.isEmail(a.email) && U.rename(engine, entry.name, a.email)) changed = true;
      }
    }
    if (!changed) return;
    adopting = true;
    try { await App.saveConfig(); } finally { adopting = false; }
  }

  // Folders on this Mac that are signed in but are no account yet: { engine: [{ dir, email, plan }] }.
  U.findFound = async () => { U.found = await codeome.usage.found(); return U.found; };

  // Sign in to one account in a terminal over the workspace; resolves with its exit code.
  // Started from Settings, it returns there afterwards (stay: the caller does that).
  U.signIn = async (engine, a, { stay = false } = {}) => {
    App.closePopover();
    const back = App.views.settings.isOpen && !stay;
    App.views.settings.close();
    const T = App.views.terminals;
    const cmd = a.dir ? `mkdir -p ${App.shPath(a.dir)} && ${ENV[engine]}=${App.shPath(a.dir)} ${LOGIN[engine](a)}` : `unset ${ENV[engine]}; ${LOGIN[engine](a)}`;
    let done;
    const ended = new Promise((r) => { done = r; });
    // A console tab ends with its command, so the sign-in is known to be over.
    const t = await T.open({ kind: 'console', title: `Sign in · ${NAME[engine]} ${U.short(a.name)}`, command: cmd, cwd: App.env.home || '~', badge: 'Mac', global: true, onExit: (code) => done(code) });
    if (!t.alive) done(-1);
    const code = await ended;
    // A finished sign-in closes its tab; a failed one stays open to show why.
    if (code === 0) setTimeout(() => T.get(t.id) && T.close(t.id), 1500);
    if (back) App.views.settings.open('accounts');
    // The sign-in is what confirms the address: ask the CLI who it is now.
    const now = inSnap(await codeome.usage.refresh(), engine, a);
    if (now && now.mismatch) App.err(`That sign-in was ${now.email}, not ${a.name}, so the account is not used yet. Sign in again as ${a.name}, or switch the account to ${now.email} on its card in Settings.`);
    else if (now && now.signedIn) App.toast(`${NAME[engine]} account ${U.isEmail(a.name) ? a.name : now.email || a.name} is confirmed and ready.`);
    else if (code !== 0) App.err(`${NAME[engine]} account ${a.name} was not signed in. The terminal shows why.`);
    return code;
  };

  // Every account that is not signed in, one after the other. Each is announced first:
  // the browser page looks the same for all of them.
  U.signInAll = async (todo) => {
    const back = App.views.settings.isOpen;
    for (const [i, { engine, a }] of todo.entries()) {
      const ok = await App.modal({
        title: `Sign in to ${NAME[engine]}${U.isEmail(a.name) ? ' as ' + a.name : ''}`,
        text: `${todo.length > 1 ? `Account ${i + 1} of ${todo.length}. ` : ''}A terminal opens and sends you to the browser. ${U.isEmail(a.name) ? `Sign in there as ${a.name}` : `Sign in there with the ${NAME[engine]} login for this account`}. If the browser is still signed in to another ${NAME[engine]} login, switch there first. This is needed once: the account then stays signed in.`,
        ok: 'Sign in', cancel: todo.length > 1 ? 'Stop' : 'Cancel'
      });
      if (!ok) break;
      await U.signIn(engine, a, { stay: true });
    }
    if (back) App.views.settings.open('accounts');
  };

  // An email address is all an account needs. found: { email, dir } for a folder on this
  // Mac that is already signed in, which is added as it is.
  U.addAccount = async (engine, found) => {
    App.closePopover();
    const label = NAME[engine];
    let email = found && found.email;
    if (!email) {
      email = await App.prompt(`Add a ${label} account`, 'Email address', '', { placeholder: 'you@university.org', ok: 'Add and sign in',
        text: `The address you sign in to ${label} with. Codeome sends you to the browser to sign in once; after that the account stays ready, and work moves to it without asking again.` });
      if (!email) return;
    }
    if (!U.isEmail(email)) return App.err(`"${email}" is not an email address.`);
    const list = App.cfg.accounts[engine].list;
    if (list.some((a) => same(a.name, email))) return App.err(`${email} is already a ${label} account.`);
    // A folder that is already signed in with this address is used as it is; otherwise Codeome makes one.
    const known = found || (U.found[engine] || []).find((f) => same(f.email, email));
    list.push(known ? { name: email, dir: known.dir } : { name: email });
    await App.saveConfig();
    const now = inSnap(await codeome.usage.refresh(), engine, { name: email });
    if (!now) return;
    if (U.ready(now)) return App.toast(`${label} account ${email} is confirmed and ready.`);
    await U.signInAll([{ engine, a: now }]);
  };

  U.paint = paint;
})();
