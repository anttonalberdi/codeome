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
const storageDir = process.env.SHOT_STORAGE;
if (storageDir) {
  const bin = path.join(out, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'sftp'), '#!/bin/sh\n# drop the destination (last argument)\nn=$#; i=0; for a; do i=$((i+1)); [ $i -lt $n ] && set -- "$@" "$a"; done; shift $n\nexec /usr/bin/sftp -D /usr/libexec/sftp-server "$@"\n', { mode: 0o755 });
  process.env.PATH = bin + ':' + process.env.PATH;
}
const extra = {
  files: { storage: { host: 'erda', root: storageDir || '' }, ui: { panes: { remote: { collapsed: false }, storage: { title: 'ERDA archive', weight: 1.4 }, local: { weight: 1 } } } },
  // SHOT_HOST: the HPC login to check (default myhpc). Uses Codeome's own VPN tunnel.
  'settings-hpc': { hpc: { host: process.env.SHOT_HOST || 'myhpc', vpn: { mode: 'tunnel', server: 'vpn.example.org', user: '', port: 11097, args: '' } } }
}[scenario] || {};
fs.writeFileSync(path.join(out, 'profile', 'config.json'), JSON.stringify({ recentFolders: [path.resolve(__dirname, '..')], hpc: { host: 'myhpc' }, ...extra }));
require('../main/main.js');

const steps = {
  welcome: [],
  editor: [`App.views.editor.openFile(${JSON.stringify(path.resolve(__dirname, '../main/slurm.js'))})`],
  slurm: [`App.hpcConnected = true; App.emit('hpc', true); App.views.slurm.queue = [{id:'4810231',name:'metaspades_assembly',state:'RUNNING',elapsed:'5:12:40',limit:'1-00:00:00',cpus:'32',partition:'gpu',reason:'node-a17',workdir:'/projects/holo/asm'},{id:'4810240',name:'kraken2_classify',state:'PENDING',elapsed:'0:00',limit:'8:00:00',cpus:'16',partition:'standard',reason:'(Priority)'}]; App.views.slurm.history=[{id:'4810101',name:'fastp_qc',state:'COMPLETED',elapsed:'00:42:10',exitcode:'0:0',maxrss:'3.1G',end:new Date(Date.now()-3600e3).toISOString()},{id:'4810099',name:'bowtie2_map',state:'OUT_OF_MEMORY',elapsed:'01:02:00',exitcode:'0:125',maxrss:'64G',end:new Date(Date.now()-7200e3).toISOString()}]; App.emit('jobs',{running:1,pending:1,failed:1}); App.setView('slurm'); App.views.slurm.refresh = ()=>{}; document.querySelector('[data-view=slurm] .jobs') && App.setView('slurm');`],
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
  'settings-hpc': [`if (${JSON.stringify(process.env.SHOT_DARK || '')}) { document.documentElement.dataset.theme = 'dark'; App.views.editor.applyTheme(); } App.views.settings.open('hpc').then(() => setTimeout(() => document.querySelector('.su-list').scrollIntoView(), 600)); if (${JSON.stringify(process.env.SHOT_TEST || '')}) setTimeout(() => App.setup.testLogin(), 800); 0`],
  // SHOT_PROJECT: a folder with the agent kit installed. Opens the Agents section.
  'settings-agents': [`App.openProject(${JSON.stringify(process.env.SHOT_PROJECT || path.resolve(__dirname, '..'))}).then(() => { if (${JSON.stringify(process.env.SHOT_DARK || '')}) { document.documentElement.dataset.theme = 'dark'; App.views.editor.applyTheme(); } App.views.settings.open('agents'); }); 0`],
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
    C.activate(d);
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
  // Two project cards, a file in each, and usage bars from made-up readings.
  projects: [`(async () => {
    const now = Date.now() / 1000, w = (a, b) => ({ fiveHour: { pct: a, resetsAt: now + 4800 }, weekly: { pct: b, resetsAt: now + 3.2 * 86400 } });
    App.views.usage.snap = { version: 1, stopAt: 90,
      claude: { active: 'Personal', accounts: [{ name: 'Personal', dir: '', email: 'me@example.org', plan: 'max', windows: w(93, 61), asOf: now - 90 }, { name: 'Lab', dir: '~/.claude-lab', email: 'lab@example.org', plan: 'pro', windows: w(12, 34), asOf: now - 600 }] },
      codex: { active: 'Default', accounts: [{ name: 'Default', dir: '', email: 'me@example.org', plan: 'plus', windows: w(41, 77), asOf: now - 120 }] } };
    App.cfg.accounts.claude.list = [{ name: 'Personal', dir: '' }, { name: 'Lab', dir: '~/.claude-lab' }];
    App.views.usage.paint();
    const fake = App.views.usage.snap;
    setTimeout(() => { App.views.usage.snap = fake; App.views.usage.paint(); App.emit('usage', fake); }, 1800);
    await App.openProject(${JSON.stringify(process.env.SHOT_PROJECT2 || path.resolve(__dirname, '../kit'))});
    await App.views.editor.openFile(${JSON.stringify(path.resolve(__dirname, '../kit/manifest.json'))});
    await App.openProject(${JSON.stringify(path.resolve(__dirname, '..'))});
    await App.views.editor.openFile(${JSON.stringify(path.resolve(__dirname, '../main/usage.js'))});
    App.views.projects.state[${JSON.stringify(process.env.SHOT_PROJECT2 || path.resolve(__dirname, '../kit'))}] = { jobs: 2 };
    App.views.projects.render();
    App.setView('agents');
    if (${JSON.stringify(process.env.SHOT_LIGHT || '')}) { document.documentElement.dataset.theme = 'light'; App.views.editor.applyTheme(); document.querySelector('.proj-fold').click(); }
    if (${JSON.stringify(process.env.SHOT_POPOVER || '')}) setTimeout(() => document.querySelector('.u-eng').click(), 2000);
  })(); 0`]
};

app.whenReady().then(() => {
  setTimeout(async () => {
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.on('console-message', (_e, level, msg) => { if (level >= 1) console.log('[renderer]', msg); });
    for (const s of steps[scenario] || []) { try { await win.webContents.executeJavaScript(s); } catch (e) { console.log('step error', e.message); } }
    await new Promise((r) => setTimeout(r, Number(process.env.SHOT_WAIT) || 2500));
    if (scenario === 'slurm') await win.webContents.executeJavaScript(`App.views.slurm.stop(); App.views.slurm.render(); App.views.slurm.openJob(App.views.slurm.queue[0]);`).catch((e)=>console.log(e.message));
    await new Promise((r) => setTimeout(r, 800));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, scenario + '.png'), img.toPNG());
    const errs = await win.webContents.executeJavaScript('window.__errs || []').catch(() => []);
    console.log('saved', scenario, errs.length ? errs : '');
    app.exit(0);
  }, 5000);
});
