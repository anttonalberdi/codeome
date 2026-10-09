// Codeome — main process.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const config = require('./config');
const ssh = require('./ssh');
const slurm = require('./slurm');
const zenodo = require('./zenodo');
const { run, q, expandHome, augmentedEnv } = require('./util');

let pty = null;
let ptyError = '';
try { pty = require('node-pty'); } catch (e) { ptyError = String(e.message || e); }

let win = null;
const ptys = new Map();
const transfers = new Map();
let cfg = null;

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 940, minWidth: 980, minHeight: 600,
    title: 'Codeome',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1c1f' : '#f6f5f2',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Links clicked in previews or panels open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const cmd = (name) => () => send('menu', name);
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: cmd('open-folder') },
      { label: 'New File', accelerator: 'CmdOrCtrl+N', click: cmd('new-file') },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: cmd('save') },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: cmd('close-tab') },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: cmd('settings') }
    ] },
    { role: 'editMenu' },
    { label: 'Go', submenu: [
      { label: 'Files', accelerator: 'CmdOrCtrl+1', click: cmd('view-files') },
      { label: 'Slurm Jobs', accelerator: 'CmdOrCtrl+2', click: cmd('view-slurm') },
      { label: 'Git & GitHub', accelerator: 'CmdOrCtrl+3', click: cmd('view-git') },
      { label: 'Publish (Zenodo, PyPI)', accelerator: 'CmdOrCtrl+4', click: cmd('view-publish') },
      { label: 'Python Packages', accelerator: 'CmdOrCtrl+5', click: cmd('view-pip') },
      { type: 'separator' },
      { label: 'Toggle Terminal Panel', accelerator: 'CmdOrCtrl+J', click: cmd('toggle-panel') },
      { label: 'New Local Terminal', accelerator: 'CmdOrCtrl+T', click: cmd('new-terminal') },
      { label: 'New HPC Terminal', accelerator: 'CmdOrCtrl+Shift+T', click: cmd('new-hpc-terminal') },
      { label: 'Preview Current File', accelerator: 'CmdOrCtrl+Shift+V', click: cmd('preview') }
    ] },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- terminals ----------
function loginShell() { return process.env.SHELL || '/bin/zsh'; }

function ptySpec(spec) {
  const sh = loginShell();
  const cwd = expandHome(spec.cwd) || os.homedir();
  const host = cfg.hpc.host;
  switch (spec.kind) {
    case 'shell': return { file: sh, args: ['-l'], cwd };
    case 'task': return { file: sh, args: ['-l', '-c', `${spec.command}; echo; echo "[process exited with $?]"; exec ${sh} -l`], cwd };
    case 'agent-local': return { file: sh, args: ['-l', '-c', `${spec.command}; exec ${sh} -l`], cwd };
    case 'hpc-login': return { file: 'ssh', args: ssh.masterArgs(host), cwd: os.homedir() };
    case 'hpc-shell': {
      const dir = spec.cwd && spec.cwd !== '~' ? `cd ${q(spec.cwd)} && exec $SHELL -l` : '';
      return { file: 'ssh', args: ssh.shellArgs(host, dir || undefined), cwd: os.homedir() };
    }
    case 'agent-hpc': {
      const dir = spec.cwd || '~';
      const inner = `cd ${dir === '~' ? '~' : q(dir)} && ${spec.command}; exec $SHELL -l`;
      let remote;
      if (cfg.hpc.useTmux && spec.session) {
        // Persistent session: reattach if it already exists.
        remote = `command -v tmux >/dev/null && tmux new-session -A -s ${q(spec.session)} ${q(inner)} || bash -lc ${q(inner)}`;
      } else remote = `bash -lc ${q(inner)}`;
      return { file: 'ssh', args: ssh.shellArgs(host, remote), cwd: os.homedir() };
    }
    case 'hpc-task': return { file: 'ssh', args: ssh.shellArgs(host, `bash -lc ${q(`cd ${q(spec.cwd || '~')} 2>/dev/null; ${spec.command}; echo; echo "[process exited with $?]"; exec $SHELL -l`)}`), cwd: os.homedir() };
    default: throw new Error('Unknown terminal kind ' + spec.kind);
  }
}

// PyPI tokens go straight from the Keychain into the process env; the UI never sees them.
function secretEnv(name) {
  if (!name || !/^pypi:(pypi|testpypi)$/.test(name)) return {};
  const t = config.getSecret(name);
  return t ? { TWINE_USERNAME: '__token__', TWINE_PASSWORD: t } : {};
}

ipcMain.handle('pty:spawn', (_e, spec) => {
  if (!pty) return { error: 'Terminal backend failed to load: ' + ptyError + '\nRun "npm run rebuild" in the project folder.' };
  try {
    const s = ptySpec(spec);
    const env = augmentedEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Codeome', ...(spec.env || {}), ...secretEnv(spec.secretEnv) });
    const p = pty.spawn(s.file, s.args, { name: 'xterm-256color', cols: spec.cols || 100, rows: spec.rows || 30, cwd: fs.existsSync(s.cwd) ? s.cwd : os.homedir(), env });
    ptys.set(spec.id, p);
    p.onData((d) => send('pty:data', { id: spec.id, data: d }));
    p.onExit(({ exitCode }) => { ptys.delete(spec.id); send('pty:exit', { id: spec.id, code: exitCode }); });
    return { ok: true, pid: p.pid };
  } catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.on('pty:write', (_e, { id, data }) => { const p = ptys.get(id); if (p) p.write(data); });
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => { const p = ptys.get(id); if (p && cols > 0 && rows > 0) { try { p.resize(cols, rows); } catch {} } });
ipcMain.on('pty:kill', (_e, { id }) => { const p = ptys.get(id); if (p) { try { p.kill(); } catch {} ptys.delete(id); } });

// ---------- config & secrets ----------
ipcMain.handle('config:get', () => cfg);
ipcMain.handle('config:set', (_e, c) => { cfg = config.save(c); return cfg; });
ipcMain.handle('secret:set', (_e, { key, value }) => { config.setSecret(key, value); return true; });
ipcMain.handle('secret:has', (_e, key) => config.hasSecret(key));

// ---------- dialogs & shell ----------
ipcMain.handle('dialog:folder', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: expandHome(opts.defaultPath) });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:files', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], defaultPath: expandHome(opts.defaultPath) });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('dialog:confirm', async (_e, { message, detail, ok }) => {
  const r = await dialog.showMessageBox(win, { type: 'question', buttons: [ok || 'OK', 'Cancel'], defaultId: 1, cancelId: 1, message, detail });
  return r.response === 0;
});
ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));
ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));

// ---------- local files ----------
ipcMain.handle('local:list', async (_e, dir) => {
  dir = expandHome(dir);
  try {
    const names = await fs.promises.readdir(dir);
    const entries = [];
    for (const name of names) {
      try {
        const st = await fs.promises.stat(path.join(dir, name));
        entries.push({ name, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs });
      } catch { entries.push({ name, dir: false, size: 0, mtime: 0, broken: true }); }
    }
    entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    return { cwd: dir, entries };
  } catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.handle('local:read', async (_e, p) => {
  try {
    const st = await fs.promises.stat(p);
    if (st.size > 20 * 1024 * 1024) return { error: 'File larger than 20 MB — open it with another app.' };
    return { content: await fs.promises.readFile(p, 'utf8') };
  } catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.handle('local:write', async (_e, { path: p, content }) => {
  try { await fs.promises.writeFile(p, content, 'utf8'); return { ok: true }; } catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.handle('local:mkdir', async (_e, p) => { try { await fs.promises.mkdir(p, { recursive: true }); return { ok: true }; } catch (e) { return { error: e.message }; } });
ipcMain.handle('local:rename', async (_e, { from, to }) => { try { await fs.promises.rename(from, to); return { ok: true }; } catch (e) { return { error: e.message }; } });
ipcMain.handle('local:trash', async (_e, p) => { try { await shell.trashItem(p); return { ok: true }; } catch (e) { return { error: e.message }; } });
ipcMain.handle('local:home', () => os.homedir());

// ---------- HPC ----------
ipcMain.handle('hpc:status', () => ssh.check(cfg.hpc.host));
ipcMain.handle('hpc:disconnect', () => ssh.disconnect(cfg.hpc.host));
ipcMain.handle('hpc:vpn', async () => {
  const h = cfg.hpc.vpnCheckHost;
  if (!h) return { known: false };
  const r = await run('nc', ['-z', '-G', '3', h, '22'], { timeout: 5000 });
  return { known: true, up: r.code === 0 };
});
ipcMain.handle('remote:list', (_e, dir) => ssh.list(cfg.hpc.host, dir));
ipcMain.handle('remote:read', (_e, p) => ssh.readFile(cfg.hpc.host, p));
ipcMain.handle('remote:write', (_e, { path: p, content }) => ssh.writeFile(cfg.hpc.host, p, content));
ipcMain.handle('remote:mkdir', async (_e, p) => { const r = await ssh.exec(cfg.hpc.host, `mkdir -p ${q(p)}`); return r.code === 0 ? { ok: true } : { error: r.stderr.trim() }; });
ipcMain.handle('remote:rename', async (_e, { from, to }) => { const r = await ssh.exec(cfg.hpc.host, `mv ${q(from)} ${q(to)}`); return r.code === 0 ? { ok: true } : { error: r.stderr.trim() }; });
ipcMain.handle('remote:delete', async (_e, p) => { const r = await ssh.exec(cfg.hpc.host, `rm -rf -- ${q(p)}`); return r.code === 0 ? { ok: true } : { error: r.stderr.trim() }; });
ipcMain.handle('remote:du', async (_e, p) => { const r = await ssh.exec(cfg.hpc.host, `du -sh ${q(p)} 2>/dev/null | cut -f1`, { timeout: 120000 }); return { size: r.stdout.trim() }; });
ipcMain.handle('remote:quota', async () => {
  const r = await ssh.exec(cfg.hpc.host, `(command -v lfs >/dev/null && lfs quota -h -u "$USER" "$HOME" 2>/dev/null) || quota -s 2>/dev/null || df -h "$HOME"`, { timeout: 20000 });
  return { text: r.stdout.trim() || r.stderr.trim() };
});

let rsyncIsGnu = false;
run('rsync', ['--version'], { timeout: 5000 }).then((r) => { rsyncIsGnu = /rsync\s+version\s+3/.test(r.stdout) && !/openrsync/.test(r.stdout); });

// Transfers use rsync over the master connection: resumable and incremental.
ipcMain.handle('transfer:start', (_e, t) => {
  const id = 'tx' + Date.now() + Math.random().toString(36).slice(2, 6);
  const host = cfg.hpc.host;
  const src = t.direction === 'up' ? t.src : `${host}:${q(t.src)}`;
  const dst = t.direction === 'up' ? `${host}:${q(t.destDir.replace(/\/?$/, '/'))}` : t.destDir.replace(/\/?$/, '/');
  // macOS ships openrsync, which lacks some GNU rsync flags; Homebrew rsync gets resumable transfers.
  const args = ['-a', ...(rsyncIsGnu ? ['--partial'] : []), '--progress', '-e', ssh.rsyncSshCommand(), src, dst];
  const { spawn } = require('child_process');
  const child = spawn('rsync', args, { env: augmentedEnv() });
  transfers.set(id, child);
  let lastErr = '';
  const onData = (d) => {
    const s = String(d);
    const m = s.match(/(\d+)%[^\n\r]*?([\d.]+[kMG]B\/s)?/g);
    if (m) {
      const last = m[m.length - 1];
      const pct = Number(last.match(/(\d+)%/)[1]);
      const rate = (last.match(/([\d.]+[kMG]B\/s)/) || [])[1] || '';
      send('transfer:progress', { id, pct, rate });
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', (d) => { lastErr += d; });
  child.on('close', (code) => { transfers.delete(id); send('transfer:done', { id, code, error: code ? lastErr.trim().split('\n').slice(-2).join(' ') : '' }); });
  child.on('error', (e) => { send('transfer:done', { id, code: -1, error: e.message }); });
  return { id };
});
ipcMain.handle('transfer:cancel', (_e, id) => { const c = transfers.get(id); if (c) c.kill('SIGINT'); return true; });

// ---------- Slurm ----------
ipcMain.handle('slurm:queue', () => slurm.queue(cfg.hpc.host));
ipcMain.handle('slurm:history', () => slurm.history(cfg.hpc.host, cfg.slurm.historyDays));
ipcMain.handle('slurm:details', (_e, id) => slurm.details(cfg.hpc.host, id));
ipcMain.handle('slurm:tail', (_e, { file, lines }) => slurm.tail(cfg.hpc.host, file, lines));
ipcMain.handle('slurm:cancel', (_e, id) => slurm.cancel(cfg.hpc.host, id));
ipcMain.handle('slurm:submit', (_e, p) => slurm.submit(cfg.hpc.host, p));
ipcMain.handle('slurm:partitions', () => slurm.partitions(cfg.hpc.host));

// ---------- Preview / rendering ----------
const cacheDir = () => { const d = path.join(app.getPath('userData'), 'preview-cache'); fs.mkdirSync(d, { recursive: true }); return d; };

ipcMain.handle('preview:render', async (_e, file) => {
  const ext = path.extname(file).toLowerCase();
  const dir = path.dirname(file);
  const stem = path.basename(file, ext);
  let r;
  if (ext === '.qmd' || ext === '.ipynb' || ((ext === '.rmd' || ext === '.md') && (await run('which', ['quarto'])).code === 0 && ext !== '.rmd')) {
    r = await run('quarto', ['render', file, '--to', 'html'], { cwd: dir, timeout: 15 * 60000, onStderr: (s) => send('preview:log', s), onStdout: (s) => send('preview:log', s) });
  } else if (ext === '.rmd') {
    r = await run('Rscript', ['-e', `rmarkdown::render(${JSON.stringify(file)}, output_format = "html_document")`], { cwd: dir, timeout: 15 * 60000, onStderr: (s) => send('preview:log', s), onStdout: (s) => send('preview:log', s) });
  } else return { error: 'Nothing to render for ' + ext };
  const out = path.join(dir, stem + '.html');
  if (r.code !== 0) return { error: (r.stderr || r.stdout).split('\n').slice(-25).join('\n') };
  if (!fs.existsSync(out)) return { error: 'Render finished but no HTML found at ' + out };
  return { html: out };
});

ipcMain.handle('preview:fetchRemote', async (_e, remotePath) => {
  const dest = path.join(cacheDir(), Date.now() + '-' + path.basename(remotePath));
  const r = await run('scp', ['-o', `ControlPath=${ssh.CONTROL_PATH}`, '-o', 'ControlMaster=no', `${cfg.hpc.host}:${remotePath}`, dest], { timeout: 10 * 60000 });
  if (r.code !== 0) return { error: r.stderr.trim() };
  return { local: dest };
});

// ---------- Git & GitHub ----------
async function git(cwd, args, opts = {}) { return run('git', args, { cwd, timeout: opts.timeout || 60000 }); }
ipcMain.handle('git:status', async (_e, cwd) => {
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return { repo: false };
  const root = top.stdout.trim();
  const st = await git(root, ['status', '--porcelain=v1', '-b', '-uall']);
  const lines = st.stdout.split('\n').filter(Boolean);
  const head = (lines.shift() || '').replace(/^## /, '');
  const files = lines.map((l) => ({ x: l[0], y: l[1], path: l.slice(3).replace(/^.* -> /, '') }));
  const remote = (await git(root, ['remote', 'get-url', 'origin'])).stdout.trim();
  const log = (await git(root, ['log', '-n', '15', '--pretty=format:%h\t%s\t%an\t%cr'])).stdout.split('\n').filter(Boolean).map((l) => { const [h, s, a, t] = l.split('\t'); return { hash: h, subject: s, author: a, when: t }; });
  const gh = (await run('gh', ['auth', 'status'], { timeout: 8000 }));
  return { repo: true, root, head, files, remote, log, gh: gh.code === 0 };
});
ipcMain.handle('git:diff', async (_e, { root, file, staged }) => {
  const r = await git(root, ['diff', ...(staged ? ['--cached'] : []), '--', file]);
  if (r.stdout) return { diff: r.stdout };
  // untracked file: show it as all-new
  const p = path.join(root, file);
  try { return { diff: (await fs.promises.readFile(p, 'utf8')).split('\n').map((l) => '+' + l).join('\n'), untracked: true }; } catch { return { diff: '' }; }
});
ipcMain.handle('git:show', async (_e, { root, file }) => { const r = await git(root, ['show', `HEAD:${file}`]); return { content: r.code === 0 ? r.stdout : '' }; });
ipcMain.handle('git:run', async (_e, { root, args }) => {
  const allowed = ['add', 'reset', 'commit', 'pull', 'push', 'fetch', 'checkout', 'restore', 'init', 'stash', 'switch', 'branch', 'tag'];
  if (!allowed.includes(args[0])) return { error: 'Not allowed: git ' + args[0] };
  const r = await git(root, args, { timeout: 180000 });
  return r.code === 0 ? { ok: true, out: (r.stdout + r.stderr).trim() } : { error: (r.stderr || r.stdout).trim() };
});
ipcMain.handle('gh:run', async (_e, { root, args }) => {
  const allowed = ['repo', 'pr', 'release', 'browse', 'issue', 'run'];
  if (!allowed.includes(args[0])) return { error: 'Not allowed: gh ' + args[0] };
  const r = await run('gh', args, { cwd: root, timeout: 180000 });
  return r.code === 0 ? { ok: true, out: (r.stdout + r.stderr).trim() } : { error: (r.stderr || r.stdout).trim() };
});

// ---------- Zenodo ----------
function zArgs() { const t = config.getSecret('zenodo:' + (cfg.zenodo.sandbox ? 'sandbox' : 'prod')); if (!t) throw new Error('Add your Zenodo token in Settings.'); return [t, cfg.zenodo.sandbox]; }
const wrap = (fn) => async (_e, ...a) => { try { return { data: await fn(...a) }; } catch (e) { return { error: String(e.message || e) }; } };
ipcMain.handle('zenodo:list', wrap(() => zenodo.list(...zArgs())));
ipcMain.handle('zenodo:create', wrap((meta) => zenodo.create(...zArgs(), meta)));
ipcMain.handle('zenodo:update', wrap(({ id, metadata }) => zenodo.update(...zArgs(), id, metadata)));
ipcMain.handle('zenodo:upload', wrap(({ id, file }) => zenodo.upload(...zArgs(), id, file, (p) => send('zenodo:progress', { id, file, p }))));
ipcMain.handle('zenodo:publish', wrap((id) => zenodo.publish(...zArgs(), id)));
ipcMain.handle('zenodo:newVersion', wrap((id) => zenodo.newVersion(...zArgs(), id)));

// ---------- Python packages ----------
ipcMain.handle('pip:list', async (_e, { where, python, cwd }) => {
  const cmd = `${python} -m pip list --format=json --disable-pip-version-check`;
  const r = where === 'hpc' ? await ssh.exec(cfg.hpc.host, `bash -lc ${q(cmd)}`, { timeout: 60000 })
    : await run(loginShell(), ['-l', '-c', cmd], { cwd: expandHome(cwd), timeout: 60000 });
  try { return { packages: JSON.parse(r.stdout.trim().split('\n').pop()) }; } catch { return { error: (r.stderr || r.stdout || 'pip failed').trim() }; }
});
ipcMain.handle('pypi:hasToken', (_e, which) => config.hasSecret('pypi:' + which));

// ---------- environment detection ----------
ipcMain.handle('env:detect', async () => {
  const tools = ['git', 'gh', 'quarto', 'Rscript', 'python3', 'rsync', 'ssh', 'tmux'].concat(cfg.agents.map((a) => a.cmd.split(' ')[0]));
  const out = {};
  await Promise.all(tools.map(async (t) => { out[t] = (await run(loginShell(), ['-l', '-c', `command -v ${t}`], { timeout: 8000 })).code === 0; }));
  return { tools: out, ptyOk: !!pty, ptyError, platform: process.platform, home: os.homedir() };
});

app.whenReady().then(() => {
  cfg = config.load();
  app.setName('Codeome');
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { for (const p of ptys.values()) { try { p.kill(); } catch {} } if (process.platform !== 'darwin') app.quit(); });
