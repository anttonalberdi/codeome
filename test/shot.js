// Dev helper: launch the app with a throwaway profile, run a UI script, save screenshots, quit.
// Usage: electron test/shot.js <outdir> [scenario]
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const rest = process.argv.slice(process.argv.findIndex((a) => a.endsWith('shot.js')) + 1);
const out = path.resolve(rest[0] || 'shots');
const scenario = rest[1] || 'welcome';
app.setPath('userData', path.join(out, 'profile'));
fs.mkdirSync(path.join(out, 'profile'), { recursive: true });
// SHOT_STORAGE: a local folder the storage section browses through a stand-in sftp
// that talks to this Mac's own sftp-server instead of a real host.
// SHOT_HISTORY saves made-up chats, so that run keeps Codeome's own files in the output folder.
if (process.env.SHOT_HISTORY) process.env.CODEOME_HOME = path.join(out, 'home');
const storageDir = process.env.SHOT_STORAGE;
if (storageDir) {
  const bin = path.join(out, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'sftp'), '#!/bin/sh\n# drop the destination (last argument)\nn=$#; i=0; for a; do i=$((i+1)); [ $i -lt $n ] && set -- "$@" "$a"; done; shift $n\nexec /usr/bin/sftp -D /usr/libexec/sftp-server "$@"\n', { mode: 0o755 });
  process.env.PATH = bin + ':' + process.env.PATH;
}
const extra = {
  transfer: { storage: { host: 'erda', root: storageDir || '' } },
  files: { storage: { host: 'erda', root: storageDir || '' }, ui: { panes: { remote: { collapsed: false }, storage: { title: 'ERDA archive', weight: 1.4 }, local: { weight: 1 } } } },
  // SHOT_HOST: the HPC login to check (default myhpc). Uses Codeome's own VPN tunnel.
  'settings-hpc': { hpc: { host: process.env.SHOT_HOST || 'myhpc', vpn: { mode: process.env.SHOT_VPN_MODE || 'tunnel', server: 'vpn.example.org', user: '', port: 11097, args: '' } } },
  'settings-storage': { storage: { host: 'io.erda.dk', user: 'you@example.org' } },
  vpn: { hpc: { host: 'myhpc', vpn: { mode: 'tunnel', server: 'vpn.example.org', user: '', port: 11097, args: '' } } }
}[scenario] || {};
fs.writeFileSync(path.join(out, 'profile', 'config.json'), JSON.stringify({ recentFolders: [path.resolve(__dirname, '..')], hpc: { host: 'myhpc' }, ...extra }));
require('../main/main.js');

const steps = {
  welcome: [],
  editor: [`App.views.editor.openFile(${JSON.stringify(path.resolve(__dirname, '../main/slurm.js'))})`],
  slurm: [`App.views.slurm.refresh = ()=>{}; App.hpcConnected = true; App.emit('hpc', true); App.views.slurm.queue = [{id:'4810231',name:'metaspades_assembly',state:'RUNNING',elapsed:'5:12:40',limit:'1-00:00:00',cpus:'32',partition:'gpu',reason:'node-a17',workdir:'/projects/holo/asm'},{id:'4810240',name:'kraken2_classify',state:'PENDING',elapsed:'0:00',limit:'8:00:00',cpus:'16',partition:'standard',reason:'(Priority)'}]; App.views.slurm.history=[{id:'4810101',name:'fastp_qc',state:'COMPLETED',elapsed:'00:42:10',exitcode:'0:0',maxrss:'3.1G',end:new Date(Date.now()-3600e3).toISOString()},{id:'4810099',name:'bowtie2_map',state:'OUT_OF_MEMORY',elapsed:'01:02:00',exitcode:'0:125',maxrss:'64G',end:new Date(Date.now()-7200e3).toISOString()}]; App.emit('jobs',{running:1,pending:1,failed:1}); App.views.slurm.resources = {total:{nodes:42,offline:2,cpus:2560,cpusUsed:1984,mem:20480000,memUsed:9216000,gpus:8,gpusUsed:5},partitions:[{name:'standard',nodes:36,offline:2,cpus:2176,cpusUsed:1900,mem:17408000,memUsed:8000000,gpus:0,gpusUsed:0,pendingJobs:212,pendingCpus:3392},{name:'gpu',nodes:4,offline:0,cpus:384,cpusUsed:84,mem:3072000,memUsed:1216000,gpus:8,gpusUsed:5,pendingJobs:0,pendingCpus:0}]}; if (${JSON.stringify(process.env.SHOT_DARK || '')}) document.documentElement.dataset.theme = 'dark'; App.setView('slurm'); App.views.slurm.render();`],
  // SHOT_PROJECT: a repository to show (e.g. one with many changed files).
  // SHOT_SIDE / SHOT_PANEL: sidebar width and terminal panel height in px, to check tight layouts.
  git: [`App.openProject(${JSON.stringify(process.env.SHOT_PROJECT || path.resolve(__dirname, '..'))}).then(() => {
    if (${JSON.stringify(process.env.SHOT_SIDE || '')}) document.documentElement.style.setProperty('--side-w', ${JSON.stringify(process.env.SHOT_SIDE || '')} + 'px');
    if (${JSON.stringify(process.env.SHOT_PANEL || '')}) document.documentElement.style.setProperty('--panel-h', ${JSON.stringify(process.env.SHOT_PANEL || '')} + 'px');
    App.setView('git');
  }); 0`],
  // Three file sections; the storage one lists SHOT_STORAGE through the stand-in sftp.
  files: [`(async () => {
    await App.openProject(${JSON.stringify(path.resolve(__dirname, '..'))});
    App.setView('files');
    App.storageConnected = true; App.emit('storage', true);
    if (${JSON.stringify(process.env.SHOT_COLLAPSE || '')}) { App.views.files.toggle('remote'); App.views.files.rename('local'); document.querySelector('.pane-rename').value = 'Laptop'; document.querySelector('.pane-rename').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); }
    if (${JSON.stringify(process.env.SHOT_DARK || '')}) { document.documentElement.dataset.theme = 'dark'; App.views.editor.applyTheme(); }
    // SHOT_DOWNLOAD: also copy a file and a folder up to the storage, and a file down into this folder.
    const dl = ${JSON.stringify(process.env.SHOT_DOWNLOAD || '')};
    if (dl) {
      await new Promise((r) => setTimeout(r, 1500));
      const F = App.views.files, root = ${JSON.stringify(path.resolve(__dirname, '..'))};
      await F.transfer('local', root + '/LICENSE', 'storage', F.storage.dir);
      await F.transfer('local', root + '/kit/roles', 'storage', F.storage.dir);
      await F.transfer('storage', F.storage.dir + '/reads_R1.fastq.gz', 'local', dl);
    }
  })(); 0`],
  // The Transfer view: this Mac on the left, SHOT_STORAGE (through the stand-in sftp) on the right,
  // with a few copies queued both ways. SHOT_DARK for the dark theme.
  transfer: [`(async () => {
    const root = ${JSON.stringify(path.resolve(__dirname, '..'))};
    await App.openProject(root);
    if (${JSON.stringify(process.env.SHOT_DARK || '')}) { document.documentElement.dataset.theme = 'dark'; App.views.editor.applyTheme(); }
    App.storageConnected = true; App.emit('storage', true);
    const X = App.views.transfer;
    App.cfg.ui.transfer = { left: { host: 'local' }, right: { host: 'storage' }, parallel: 1 };
    X.open();
    await new Promise((r) => setTimeout(r, 1500));
    const { left, right } = X.panes;
    X.enqueue('local', [{ path: root + '/kit/roles', dir: true }, { path: root + '/LICENSE', size: 1071 }, { path: root + '/README.md', size: 20516 }], 'storage', right.dir);
    X.enqueue('storage', [{ path: right.dir + '/reads_R1.fastq.gz', size: 3e6 }], 'local', ${JSON.stringify(process.env.SHOT_DOWNLOAD || '')} || left.dir);
    X.enqueue('local', [{ path: root + '/no-such-file', size: 1 }], 'storage', right.dir);
    if (${JSON.stringify(process.env.SHOT_DOWNLOAD || '')}) X.enqueue('local', [{ path: root + '/kit', dir: true }], 'local', ${JSON.stringify(process.env.SHOT_DOWNLOAD || '')});
    left.sel = new Set(['main', 'package.json']); document.querySelectorAll('.xf-row')[0].dispatchEvent(new MouseEvent('click', { metaKey: true, bubbles: true }));
  })(); 0`],
  // SHOT_RMD: an R Markdown file. Opens it, then runs its second chunk in a new R console.
  rmd: [`(async () => {
    const f = ${JSON.stringify(process.env.SHOT_RMD || '')};
    await App.openProject(${JSON.stringify(path.dirname(process.env.SHOT_RMD || __dirname))});
    const t = await App.views.editor.openFile(f);
    if (${JSON.stringify(process.env.SHOT_DARK || '')}) { document.documentElement.dataset.theme = 'dark'; App.views.editor.applyTheme(); App.views.terminals.retheme(); }
    const c = App.views.rmd.parseChunks(t.model.getLinesContent())[1];
    App.views.editor.editor.setPosition({ lineNumber: c.start + 1, column: 1 });
    App.views.rmd.runChunk(t.model, c.start + 1);
    setTimeout(() => { App.views.editor.editor.setPosition({ lineNumber: c.end + 3, column: 1 }); App.views.editor.sendSelection(App.views.editor.editor); }, 2500);
  })(); 0`],
  diff: [`App.views.editor.diff({key:'d',title:'x.R',original:'a <- 1\\nb <- 2\\n',modified:'a <- 1\\nb <- 3\\nc <- 4\\n',lang:'r'}); 0`],
  // SHOT_PROJECT: a folder with the agent kit installed and some jobs recorded.
  agents: [`App.openProject(${JSON.stringify(process.env.SHOT_PROJECT || path.resolve(__dirname, '..'))}).then(() => { App.setView('agents'); setTimeout(() => { const j = App.views.agents.jobs.find((x) => x.engine === 'codex'); if (j) App.views.agents.openJob(j); }, 1200); }); 0`],
  settings: [`document.documentElement.dataset.theme='dark'; App.views.editor.applyTheme(); App.views.terminals.retheme(); App.views.settings.open(${JSON.stringify(process.env.SHOT_SECTION || '')}); 0`],
  // The HPC setup checklist; SHOT_TEST also runs the key test.
  'settings-hpc': [`if (${JSON.stringify(process.env.SHOT_DARK || '')}) { document.documentElement.dataset.theme = 'dark'; App.views.editor.applyTheme(); } App.views.settings.open('hpc').then(() => { if (!${JSON.stringify(process.env.SHOT_TOP || '')}) setTimeout(() => document.querySelector('.su-list').scrollIntoView(), 600); }); if (${JSON.stringify(process.env.SHOT_TEST || '')}) setTimeout(() => App.setup.testLogin(), 800); if (${JSON.stringify(process.env.SHOT_VPN || '')}) setTimeout(() => App.setup.testVpn(), 800); 0`],
  // Signing in to Codeome's VPN tunnel; put a stand-in openconnect first on PATH (and SHELL=/bin/sh).
  // SHOT_VPN_STEP: user (nothing saved: asks for the username), password (asks for it), mfa (all saved).
  vpn: [`(async () => {
    const step = ${JSON.stringify(process.env.SHOT_VPN_STEP || 'user')};
    if (step !== 'user') { App.cfg.hpc.vpn.user = 'abc123'; await App.saveConfig(); }
    await codeome.secret.set('vpn:password', step === 'mfa' ? 'pw' : '');
    if (${JSON.stringify(process.env.SHOT_DARK || '')}) { document.documentElement.dataset.theme = 'dark'; App.views.editor.applyTheme(); }
    await App.views.settings.open('hpc');
    App.setup.startVpn();
  })(); 0`],
  // The storage host, username, password and connection.
  'settings-storage': [`if (${JSON.stringify(process.env.SHOT_DARK || '')}) { document.documentElement.dataset.theme = 'dark'; App.views.editor.applyTheme(); } App.views.settings.open('storage'); 0`],
  // SHOT_PROJECT: a folder with the agent kit installed. Opens the Agents section.
  'settings-agents': [`App.openProject(${JSON.stringify(process.env.SHOT_PROJECT || path.resolve(__dirname, '..'))}).then(() => { if (${JSON.stringify(process.env.SHOT_DARK || '')}) { document.documentElement.dataset.theme = 'dark'; App.views.editor.applyTheme(); } App.views.settings.open('agents'); }); 0`],
  // The Skills card, below the team. Use a SHOT_PROJECT that has the kit installed.
  'settings-skills': [`App.openProject(${JSON.stringify(process.env.SHOT_PROJECT || path.resolve(__dirname, '..'))}).then(async () => { if (${JSON.stringify(process.env.SHOT_DARK || '')}) { document.documentElement.dataset.theme = 'dark'; App.views.editor.applyTheme(); } await App.views.settings.open('agents'); setTimeout(() => { const r = document.querySelector('.sk-row'); if (r) r.parentElement.parentElement.scrollIntoView(); }, 1200); }); 0`],
  // Four chat tabs in different states (made up; no agent sessions are started).
  chats: [`(async () => {
    const P = ${JSON.stringify(process.env.SHOT_PROJECT || path.resolve(__dirname, '..'))};
    await App.openProject(P); App.setView('agents');
    await new Promise((r) => setTimeout(r, 900));
    const C = App.views.chat;
    const mk = (title, f) => { C.newChat(); const c = C.current(); c.title = title; c.started = true; c.items.push({ t: 'user', text: title }); f(c); return c; };
    const now = Date.now();
    mk('Fix the failing assembly tests', (c) => { c.running = c.busy = true; c.items.push({ t: 'job', id: 'j1', engine: 'codex', role: 'debugger', title: 'Find why test_assembly fails', status: 'running', startedAt: now - 95000 }, { t: 'job', id: 'j2', engine: 'claude', role: 'explorer', title: 'Map the assembly module', status: 'running', startedAt: now - 40000, activity: 'Read main/assembly.py' }); });
    mk('Plan the 0.4 release', (c) => { c.running = c.busy = true; const it = { t: 'ask', requestId: 'r1', questions: [{ question: 'Ship the kit update in 0.4?', header: 'Release', options: [{ label: 'Yes', description: 'Bump to 0.4.0' }, { label: 'Later' }] }] }; c.items.push(it); c.requests.r1 = { input: {}, item: it }; });
    mk('How is this project organised?', (c) => { c.running = true; c.unread = true; c.outcome = 'done'; c.items.push({ t: 'text', text: 'Three parts: **main/** (Electron), **renderer/** (UI) and **kit/**.' }); });
    const d = mk('Review my uncommitted changes', (c) => { c.running = true; c.items.push({ t: 'tool', id: 't1', name: 'Bash', input: { command: 'git diff --stat' }, done: true }, { t: 'text', text: 'The diff touches **4 files**. Two findings:\\n\\n1. renderer/js/chat.js:120 — the draft is lost when a tab closes.\\n2. Missing test for withModel.' }); });
    // SHOT_QUICK: also attach two files and open the saved-messages menu.
    if (${JSON.stringify(process.env.SHOT_QUICK || '')}) { d.items.push({ t: 'user', text: 'Does this match the README?', files: [P + '/README.md'] }); d.attach.push(P + '/package.json', P + '/main/chat.js'); }
    C.activate(d);
    if (${JSON.stringify(process.env.SHOT_SIDE || '')}) document.documentElement.style.setProperty('--side-w', ${JSON.stringify(process.env.SHOT_SIDE || '')} + 'px');
    if (${JSON.stringify(process.env.SHOT_DARK || '')}) { document.documentElement.dataset.theme = 'dark'; App.views.editor.applyTheme(); }
    if (${JSON.stringify(process.env.SHOT_QUICK || '')}) setTimeout(() => document.querySelector('.chat-row .icon-btn:last-child').click(), 300);
    // SHOT_HISTORY: save a few made-up chats and open the history.
    if (${JSON.stringify(process.env.SHOT_HISTORY || '')}) {
      const id = (n) => '00000000-0000-4000-8000-00000000000' + n;
      for (const [n, title] of ['Why is the Slurm queue empty?', 'Write the 0.3 release notes', 'Explain the transfer queue'].entries()) await codeome.chat.save(P, { id: id(n), title, started: true, items: [{ t: 'user', text: title }, { t: 'text', text: 'Done.' }] });
      await codeome.chat.save(P, { id: d.id, title: d.title, started: true, items: d.items });
      setTimeout(() => document.querySelector('.agent-head [aria-label="Chat history"]').click(), 300);
    }
  })(); 0`],
  // A chat whose context is filling up, and the Statistics tab. The meter's messages are sent
  // from here as a session would send them. CODEOME_HOME: a folder with stats/turns.jsonl to show.
  // SHOT_POPOVER: also open the chat's token popover.
  stats: [`(async () => {
    await App.openProject(${JSON.stringify(path.resolve(__dirname, '..'))}); App.setView('agents');
    await new Promise((r) => setTimeout(r, 900));
    const C = App.views.chat;
    C.newChat(); const c = C.current(); c.title = 'Rework the transfer queue'; c.started = c.running = true; c.model = 'claude-opus-5-5';
    c.items.push({ t: 'user', text: c.title }, { t: 'text', text: 'Done: the queue now retries a failed copy **twice** before it gives up.' });
    C.activate(c);
    if (${JSON.stringify(process.env.SHOT_DARK || '')}) { document.documentElement.dataset.theme = 'dark'; App.views.editor.applyTheme(); }
  })(); 0`],
  // SHOT_PROJECT: an R project. Starts an R console there and draws a few plots.
  // SHOT_PLOTS: also pick a journal size and open the plots in a tab ('tab').
  plots: [`(async () => {
    const P = ${JSON.stringify(process.env.SHOT_PROJECT || path.resolve(__dirname, '..'))};
    await App.openProject(P);
    if (${JSON.stringify(process.env.SHOT_DARK || '')}) { document.documentElement.dataset.theme = 'dark'; App.views.editor.applyTheme(); App.views.terminals.retheme(); }
    document.documentElement.style.setProperty('--side-w', '380px');
    await App.views.terminals.sendR('plot(1:10, main = "Base graphics"); abline(h = 5, col = "tomato")');
    await App.views.terminals.sendR('hist(rnorm(500), col = "grey80", main = "Histogram")');
    await App.views.terminals.sendR('library(ggplot2); ggplot(mtcars, aes(wt, mpg, colour = factor(cyl))) + geom_point(size = 2) + theme_minimal()');
    const mode = ${JSON.stringify(process.env.SHOT_PLOTS || '')};
    if (mode) setTimeout(() => {
      const v = App.views.plots.viewers[0];
      v.preset.value = 'col1'; v.preset.dispatchEvent(new Event('change'));
      if (mode === 'tab') App.views.plots.openTab();
    }, 5000);
    // SHOT_EXPORT: a folder to export the current plot to, in every format, and copy it.
    const ex = ${JSON.stringify(process.env.SHOT_EXPORT || '')};
    if (ex) setTimeout(async () => {
      const e = App.views.plots.current(), cv = App.views.plots.canvas();
      for (const fmt of ['png', 'pdf', 'svg', 'tiff', 'jpeg', 'eps']) {
        const r = await codeome.plots.render({ where: e.where, dir: e.dir, id: e.id, rev: e.rev, fmt, w: cv.w, h: cv.h, res: cv.dpi, bg: cv.bg, out: ex + '/plot.' + fmt });
        console.warn('export', fmt, JSON.stringify(r));
      }
      await App.views.plots.copy();
      console.warn('code', App.views.plots.code('ggsave'), '|', App.views.plots.code('device'));
    }, 7000);
  })(); 0`],
  // SHOT_PROJECT: an R project; the Packages view with its Python and R sections.
  packages: [`(async () => {
    await App.openProject(${JSON.stringify(process.env.SHOT_PROJECT || path.resolve(__dirname, '..'))});
    if (${JSON.stringify(process.env.SHOT_DARK || '')}) { document.documentElement.dataset.theme = 'dark'; App.views.editor.applyTheme(); }
    document.documentElement.style.setProperty('--side-w', '380px');
    App.setView('packages');
  })(); 0`],
  // Settings → Accounts & limits with five made-up accounts: confirmed, signed out, another sign-in, and one doubled.
  'settings-accounts': [`(async () => {
    const now = Date.now() / 1000, w = (a, b) => ({ fiveHour: { pct: a, resetsAt: now + 4800 }, weekly: { pct: b, resetsAt: now + 3.2 * 86400 } });
    const fake = { version: 1, stopAt: 90,
      claude: { active: 'me@example.org', accounts: [
        { name: 'me@example.org', dir: '', email: 'me@example.org', plan: 'max', signedIn: true, windows: w(93, 61), asOf: now - 90 },
        { name: 'lab@example.org', dir: '~/.claude-lab-example-org', email: 'lab@example.org', plan: 'pro', signedIn: true, windows: w(12, 34), asOf: now - 600 },
        { name: 'teaching@example.org', dir: '~/.claude-teaching-example-org', signedIn: false, signedOut: true, windows: {} }] },
      codex: { active: 'me@example.org', accounts: [
        { name: 'me@example.org', dir: '', email: 'me@example.org', plan: 'plus', signedIn: true, windows: { weekly: w(41, 77).weekly }, asOf: now - 120 }, // a plan with no 5-hour window
        { name: 'lab@example.org', dir: '~/.codex-lab-example-org', email: 'me@example.org', plan: 'plus', signedIn: true, mismatch: true, signedOut: true, windows: w(41, 77), asOf: now - 120 }] } };
    for (const e of ['claude', 'codex']) App.cfg.accounts[e] = { active: fake[e].active, list: fake[e].accounts.map((a) => ({ name: a.name, dir: a.dir })) };
    const U = App.views.usage;
    const put = () => { U.snap = fake; U.paint(); };
    put(); setInterval(() => { if (U.snap !== fake) { put(); App.emit('usage', fake); } }, 150);
    if (${JSON.stringify(process.env.SHOT_DARK || '')}) { document.documentElement.dataset.theme = 'dark'; App.views.editor.applyTheme(); }
    await App.views.settings.open('accounts');
  })(); 0`],
  // Two project cards, a file in each, and usage bars from made-up readings.
  projects: [`(async () => {
    const now = Date.now() / 1000, w = (a, b) => ({ fiveHour: { pct: a, resetsAt: now + 4800 }, weekly: { pct: b, resetsAt: now + 3.2 * 86400 } });
    App.views.usage.snap = { version: 1, stopAt: 90,
      claude: { active: 'me@example.org', accounts: [{ name: 'me@example.org', dir: '', email: 'me@example.org', plan: 'max', signedIn: true, windows: w(93, 61), asOf: now - 90 }, { name: 'lab@example.org', dir: '~/.claude-lab-example-org', email: 'lab@example.org', plan: 'pro', signedIn: true, windows: w(12, 34), asOf: now - 600 }] },
      codex: { active: 'me@example.org', accounts: [{ name: 'me@example.org', dir: '', email: 'me@example.org', plan: 'plus', signedIn: true, windows: w(41, 77), asOf: now - 120 }] } };
    App.cfg.accounts.claude.list = [{ name: 'me@example.org', dir: '' }, { name: 'lab@example.org', dir: '~/.claude-lab-example-org' }];
    App.views.usage.paint();
    const fake = App.views.usage.snap;
    setTimeout(() => { App.views.usage.snap = fake; App.views.usage.paint(); App.emit('usage', fake); }, 1800);
    await App.openProject(${JSON.stringify(process.env.SHOT_PROJECT2 || path.resolve(__dirname, '../kit'))});
    await App.views.editor.openFile(${JSON.stringify(path.resolve(__dirname, '../kit/manifest.json'))});
    // SHOT_LINK: connect this project to the other one and to a closed one, shown as chained tags in the title bar.
    if (${JSON.stringify(process.env.SHOT_LINK || '')}) App.cfg.projectLinks[${JSON.stringify(path.resolve(__dirname, '..'))}] = [${JSON.stringify(process.env.SHOT_PROJECT2 || path.resolve(__dirname, '../kit'))}, ${JSON.stringify(path.resolve(__dirname, '../renderer'))}];
    await App.openProject(${JSON.stringify(path.resolve(__dirname, '..'))});
    await App.views.editor.openFile(${JSON.stringify(path.resolve(__dirname, '../main/usage.js'))});
    App.views.projects.state[${JSON.stringify(process.env.SHOT_PROJECT2 || path.resolve(__dirname, '../kit'))}] = { jobs: 2 };
    App.views.projects.render();
    App.setView('agents');
    if (${JSON.stringify(process.env.SHOT_LIGHT || '')}) { document.documentElement.dataset.theme = 'light'; App.views.editor.applyTheme(); document.querySelector('.proj-fold').click(); }
    if (${JSON.stringify(process.env.SHOT_POPOVER || '')}) setTimeout(() => document.querySelector('.u-eng').click(), 2000);
    if (${JSON.stringify(process.env.SHOT_DARK || '')}) { document.documentElement.dataset.theme = 'dark'; App.views.editor.applyTheme(); }
    // SHOT_COLOR: open the color picker from the title-bar tag (a swatch number also picks that swatch).
    const pick = ${JSON.stringify(process.env.SHOT_COLOR || '')};
    if (pick) setTimeout(() => { document.getElementById('project-btn').click(); document.querySelector('#menu-pop button').click(); if (+pick) document.querySelectorAll('.swatch')[+pick].click(); }, 2000);
  })(); 0`],
  // Settings → Secrets with three made-up secrets. SHOT_ENV: also start a terminal and an agent
  // session and log which of them each one sees.
  'settings-secrets': [`(async () => {
    if (${JSON.stringify(process.env.SHOT_DARK || '')}) { document.documentElement.dataset.theme = 'dark'; App.views.editor.applyTheme(); }
    for (const n of ['GITHUB_TOKEN', 'HF_TOKEN', 'ZENODO_COPY']) await codeome.secrets.set(n, 'made-up-' + n.toLowerCase());
    App.cfg.secrets = [{ name: 'GITHUB_TOKEN', note: 'Fine-grained, read-only. Expires March 2027', terminals: true, agents: true }, { name: 'HF_TOKEN', note: '', terminals: true, agents: false, projects: [${JSON.stringify(path.resolve(__dirname, '..'))}] }, { name: 'ZENODO_COPY', note: 'Copy only', terminals: false, agents: false }, { name: 'LOST', note: '', terminals: false, agents: false }];
    await App.saveConfig();
    await App.views.settings.open('secrets');
    if (${JSON.stringify(process.env.SHOT_PICK || '')}) document.querySelectorAll('.sec-scope')[1].click();
    if (${JSON.stringify(process.env.SHOT_ENV || '')}) {
      const seen = {};
      codeome.pty.onData(({ id, data }) => { seen[id] = (seen[id] || '') + data; });
      const cmd = 'echo "sees:[$GITHUB_TOKEN][$HF_TOKEN][$ZENODO_COPY]"';
      await codeome.pty.spawn({ id: 'shot-task', kind: 'task', command: cmd, cwd: '~', project: ${JSON.stringify(path.resolve(__dirname, '..'))} });
      await codeome.pty.spawn({ id: 'shot-other', kind: 'task', command: cmd, cwd: '~', project: '/somewhere/else' });
      await codeome.pty.spawn({ id: 'shot-agent', kind: 'agent-local', command: cmd, cwd: '~' });
      await new Promise((r) => setTimeout(r, 1800));
      for (const id of Object.keys(seen)) console.warn(id, (seen[id].match(/sees:\\[[^\\n\\r]*/) || ['nothing'])[0]);
      console.warn('copy', JSON.stringify(await codeome.secrets.copy('ZENODO_COPY')), JSON.stringify(await codeome.secrets.copy('LOST')), JSON.stringify(await codeome.secrets.set('PATH', 'x')));
    }
  })(); 0`],
  // Five project cards in two groups, the second folded, and one card in no group.
  // SHOT_NARROW: also collapse the column to monograms.
  groups: [`(async () => {
    const root = ${JSON.stringify(path.resolve(__dirname, '..'))}, dirs = ['kit', 'main', 'renderer', 'test'].map((d) => root + '/' + d);
    for (const d of [...dirs, root]) await App.openProject(d);
    App.cfg.projectGroups = [{ id: 'a', name: 'Thesis', collapsed: false }, { id: 'b', name: 'Teaching', collapsed: true }, { id: 'c', name: 'Side projects', collapsed: false }];
    App.cfg.projectGroup = { [dirs[0]]: 'a', [root]: 'a', [dirs[1]]: 'b', [dirs[2]]: 'b' };
    App.cfg.projectLinks = { [root]: [dirs[0], dirs[3]], [dirs[0]]: [root], [dirs[3]]: [root] };
    App.views.projects.state[dirs[1]] = { jobs: 1 };
    App.views.projects.render();
    if (${JSON.stringify(process.env.SHOT_DARK || '')}) { document.documentElement.dataset.theme = 'dark'; App.views.editor.applyTheme(); }
    if (${JSON.stringify(process.env.SHOT_NARROW || '')}) document.querySelector('.proj-fold').click();
    // SHOT_LINKS: open the connections of the active project from its chain.
    if (${JSON.stringify(process.env.SHOT_LINKS || '')}) document.querySelector('.proj.active .plink').click();
  })(); 0`]
};

app.whenReady().then(() => {
  setTimeout(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.on('console-message', (_e, level, msg) => { if (level >= 1) console.log('[renderer]', msg); });
    for (const s of steps[scenario] || []) { try { await win.webContents.executeJavaScript(s); } catch (e) { console.log('step error', e.message); } }
    await new Promise((r) => setTimeout(r, Number(process.env.SHOT_WAIT) || 2500));
    if (scenario === 'stats') {
      const id = await win.webContents.executeJavaScript('App.views.chat.current().id');
      const say = (msg) => win.webContents.send('chat:event', { id, msg });
      say({ type: 'context', used: 61000, window: 0 });
      say({ type: 'turn_usage', input: 5200, output: 9100, cacheRead: 1840000, cacheWrite: 96000, costUsd: 2.41, context: 148200, peak: 148200, window: 200000, compactions: 0, run: {} });
      say({ type: 'result', subtype: 'success' });
      await win.webContents.executeJavaScript(`App.views.stats.open(); if (${JSON.stringify(process.env.SHOT_POPOVER || '')}) setTimeout(() => document.querySelector('.chat-ctx').click(), 400); 0`);
    }
    if (scenario === 'slurm') await win.webContents.executeJavaScript(`App.views.slurm.stop(); App.views.slurm.render(); App.views.slurm.openJob(App.views.slurm.queue[0]);`).catch((e)=>console.log(e.message));
    await new Promise((r) => setTimeout(r, 800));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, scenario + '.png'), img.toPNG());
    const errs = await win.webContents.executeJavaScript('window.__errs || []').catch(() => []);
    console.log('saved', scenario, errs.length ? errs : '');
    app.exit(0);
  }, 5000);
});
