// Codeome — main process.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, clipboard, ClipboardItem } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const config = require('./config');
const github = require('./github');
const ssh = require('./ssh');
const sftp = require('./sftp');
const slurm = require('./slurm');
const zenodo = require('./zenodo');
const kit = require('./kit');
const jobs = require('./jobs');
const usage = require('./usage');
const stats = require('./stats');
const { CodexSession } = require('./codexchat');
const chat = require('./chat');
const { createHost } = require('./forumhost');
const rtools = require('./rtools');
const setup = require('./setup');
const updates = require('./updates');
const vpn = require('./vpn');
const login = require('./login');
const gdoc = require('./gdoc');
const secrets = require('./secrets');
const { run, q, expandHome, augmentedEnv } = require('./util');

let pty = null;
let ptyError = '';
try { pty = require('node-pty'); } catch (e) { ptyError = String(e.message || e); }

let win = null;
const ptys = new Map();
const chats = new Map(); // chat id → chat.Session
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
  win.on('closed', () => { gdoc.closeAll(win); win = null; });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const cmd = (name) => () => send('menu', name);
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: cmd('open-folder') },
      { label: 'Close Project', accelerator: 'CmdOrCtrl+Shift+W', click: cmd('close-project') },
      { label: 'New File', accelerator: 'CmdOrCtrl+N', click: cmd('new-file') },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: cmd('save') },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: cmd('close-tab') },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: cmd('settings') }
    ] },
    { role: 'editMenu' },
    { label: 'Go', submenu: [
      { label: 'Agent Chat', accelerator: 'CmdOrCtrl+1', click: cmd('view-agents') },
      { label: 'Files', accelerator: 'CmdOrCtrl+2', click: cmd('view-files') },
      { label: 'Slurm Jobs', accelerator: 'CmdOrCtrl+3', click: cmd('view-slurm') },
      { label: 'Git & GitHub', accelerator: 'CmdOrCtrl+4', click: cmd('view-git') },
      { label: 'Publish (Zenodo, PyPI)', accelerator: 'CmdOrCtrl+5', click: cmd('view-publish') },
      { label: 'Packages', accelerator: 'CmdOrCtrl+6', click: cmd('view-packages') },
      { label: 'Plots', accelerator: 'CmdOrCtrl+7', click: cmd('view-plots') },
      { label: 'File Transfer', accelerator: 'CmdOrCtrl+8', click: cmd('transfer') },
      { label: 'New Agent Chat', accelerator: 'CmdOrCtrl+Shift+N', click: cmd('new-chat') },
      { label: 'Next Agent Chat', accelerator: 'CmdOrCtrl+Shift+]', click: cmd('next-chat') },
      { label: 'Previous Agent Chat', accelerator: 'CmdOrCtrl+Shift+[', click: cmd('prev-chat') },
      { type: 'separator' },
      { label: 'Next Project', accelerator: 'Ctrl+Tab', click: cmd('next-project') },
      { label: 'Previous Project', accelerator: 'Ctrl+Shift+Tab', click: cmd('prev-project') },
      { type: 'separator' },
      { label: 'Toggle Terminal Panel', accelerator: 'CmdOrCtrl+J', click: cmd('toggle-panel') },
      { label: 'New Local Terminal', accelerator: 'CmdOrCtrl+T', click: cmd('new-terminal') },
      { label: 'New HPC Terminal', accelerator: 'CmdOrCtrl+Shift+T', click: cmd('new-hpc-terminal') },
      { label: 'R Console', click: cmd('r-console') },
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
    // A console (R) ends with its program, so a dead tab means a dead session.
    case 'console': return { file: sh, args: ['-l', '-c', spec.command], cwd };
    // The logins in a terminal, offered when the background one (login.js) fails.
    case 'hpc-login': return { file: 'ssh', args: ssh.masterArgs(host), cwd: os.homedir() };
    case 'storage-login': return { file: 'ssh', args: ssh.masterArgs(sto()), cwd: os.homedir() };
    case 'hpc-console': return { file: 'ssh', args: ssh.shellArgs(host, `bash -lc ${q(`cd ${spec.cwd && spec.cwd !== '~' ? q(spec.cwd) : '~'} 2>/dev/null; ${spec.command}`)}`), cwd: os.homedir() };
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
    // A queued copy between the HPC and the storage: it ends with the copy, so the queue knows how it went.
    case 'hpc-transfer': return { file: 'ssh', args: ssh.shellArgs(host, `bash -lc ${q(`cd ${q(spec.cwd || '~')} 2>/dev/null; ${finished(spec.command)}`)}`), cwd: os.homedir() };
    // HPC setup steps report how they finished.
    case 'install': {
      const ic = spec.brew ? { command: setup.BREW_INSTALL } : setup.installCommand(spec.tools || []);
      if (!ic) throw new Error('Codeome does not know how to install ' + (spec.tools || []).join(', '));
      return { file: sh, args: ['-l', '-c', finished(ic.command)], cwd: os.homedir() };
    }
    // Updating Claude Code or Codex the way that copy was installed.
    case 'update': {
      const engines = (spec.engines || []).filter((e) => e === 'claude' || e === 'codex');
      if (!engines.length) throw new Error('Nothing to update.');
      const cmds = engines.map((e) => updates.updateCommand(e, updates.installedVia(whichSync(cliCmd(e)))));
      return { file: sh, args: ['-l', '-c', finished(cmds.join(' && '))], cwd: os.homedir() };
    }
    case 'keygen': {
      const p = keyTarget(spec.key);
      return { file: sh, args: ['-l', '-c', finished(`ssh-keygen -t ed25519 -f ${q(p)} -C ${q(os.userInfo().username + '@codeome')}`)], cwd: os.homedir() };
    }
    case 'hpc-copy-key': {
      const pub = fs.readFileSync(keyTarget(spec.key, true) + '.pub', 'utf8');
      if (!/^(ssh|ecdsa|sk)-[\w@.-]+ [A-Za-z0-9+/=]+( [^\n]*)?\s*$/.test(pub)) throw new Error('That does not look like an ssh public key.');
      return { file: sh, args: ['-l', '-c', finished(['ssh', ...ssh.copyKeyArgs(host, pub)].map(q).join(' '))], cwd: os.homedir() };
    }
    default: throw new Error('Unknown terminal kind ' + spec.kind);
  }
}

function whichSync(tool) {
  try { return require('child_process').execFileSync(loginShell(), ['-l', '-c', `command -v ${q(tool)}`], { encoding: 'utf8', timeout: 8000 }).trim().split('\n').pop(); } catch { return ''; }
}

// A one-off command that ends by saying how it went, keeping its exit status.
const finished = (cmd) => `${cmd}; s=$?; echo; if [ $s -eq 0 ]; then echo "[done]"; else echo "[failed with exit code $s]"; fi; exit $s`;

// An ssh key under ~/.ssh: the one to create (must not exist yet) or to copy (must exist).
function keyTarget(key, existing = false) {
  const p = path.resolve(expandHome(key || '~/.ssh/id_ed25519'));
  if (!p.startsWith(path.join(os.homedir(), '.ssh') + path.sep)) throw new Error('Keys live in ~/.ssh.');
  if (existing ? !fs.existsSync(p + '.pub') : fs.existsSync(p)) throw new Error(existing ? 'No public key at ' + key + '.pub' : key + ' already exists.');
  return p;
}

// PyPI tokens go straight from the Keychain into the process env; the UI never sees them.
function secretEnv(name) {
  if (!name || !/^pypi:(pypi|testpypi)$/.test(name)) return {};
  const t = config.getSecret(name);
  return t ? { TWINE_USERNAME: '__token__', TWINE_PASSWORD: t } : {};
}

// Your own secrets (Settings → Secrets) become environment variables where each is switched on:
// in terminals, tasks and consoles on this Mac, or in agent sessions, of the projects it is open to.
// HPC sessions get none.
const SECRET_SCOPE = { shell: 'terminals', task: 'terminals', console: 'terminals', 'agent-local': 'agents' };
const userSecretEnv = (scope, project) => secrets.envFor(cfg.secrets, scope, config.getSecret, project);

ipcMain.handle('pty:spawn', (_e, spec) => {
  if (!pty) return { error: 'Terminal backend failed to load: ' + ptyError + '\nRun "npm run rebuild" in the project folder.' };
  try {
    // Claude Code / Codex sessions on this Mac run on a chosen account.
    let acct = null;
    if (spec.kind === 'agent-local' && usage.ENV_VAR[spec.engine]) { acct = launchOn(spec.engine, spec.account, spec.command); spec = { ...spec, command: acct.command }; }
    const s = ptySpec(spec);
    const env = augmentedEnv({ ...userSecretEnv(SECRET_SCOPE[spec.kind], spec.project), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Codeome', ...(spec.env || {}), ...secretEnv(spec.secretEnv), ...(acct ? acct.env : {}) });
    if (acct) for (const k of acct.unset) delete env[k];
    const p = pty.spawn(s.file, s.args, { name: 'xterm-256color', cols: spec.cols || 100, rows: spec.rows || 30, cwd: fs.existsSync(s.cwd) ? s.cwd : os.homedir(), env });
    ptys.set(spec.id, p);
    p.onData((d) => send('pty:data', { id: spec.id, data: d }));
    // The saved password goes from the Keychain into ssh's prompt; the UI never sees it.
    if (spec.kind === 'hpc-login' || spec.kind === 'hpc-copy-key') p.onData(ssh.passwordFiller(config.getSecret('hpc:password'), (s) => p.write(s)));
    if (spec.kind === 'storage-login') p.onData(ssh.passwordFiller(config.getSecret('storage:password'), (s) => p.write(s)));
    p.onExit(({ exitCode }) => { ptys.delete(spec.id); send('pty:exit', { id: spec.id, code: exitCode }); });
    return { ok: true, pid: p.pid, account: acct && acct.info };
  } catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.on('pty:write', (_e, { id, data }) => { const p = ptys.get(id); if (p) p.write(data); });
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => { const p = ptys.get(id); if (p && cols > 0 && rows > 0) { try { p.resize(cols, rows); } catch {} } });
ipcMain.on('pty:kill', (_e, { id }) => { const p = ptys.get(id); if (p) { try { p.kill(); } catch {} ptys.delete(id); } });

// ---------- config & secrets ----------
ipcMain.handle('config:get', () => cfg);
// Codeome's own version. app.getVersion() gives Electron's when the app is started from another script.
ipcMain.handle('app:version', () => require('../package.json').version);
ipcMain.handle('config:set', (_e, c) => {
  for (const e of Object.keys(usage.ENV_VAR)) for (const a of (c.accounts && c.accounts[e] ? c.accounts[e].list : [])) a.dir = a.dir == null ? usage.folderFor(e, a.name) : usage.normDir(e, a.dir); // a new account gets its folder here
  const accountsChanged = JSON.stringify(c.accounts) !== JSON.stringify(cfg.accounts);
  cfg = config.save({ ...c, gitAccounts: cfg.gitAccounts, projectAccounts: cfg.projectAccounts });
  applyProxy();
  // The new list shows at once; who is signed in and the Codex limits follow.
  publishUsage();
  if (accountsChanged) refreshUsage(true);
  return cfg;
});
ipcMain.handle('secret:set', (_e, { key, value }) => { config.setSecret(key, value); return true; });
ipcMain.handle('secret:has', (_e, key) => config.hasSecret(key));
// Your own secrets. The window names them and never reads a value back: a copy goes from
// the Keychain straight to the clipboard, and is taken off it again after a while.
const COPY_SECONDS = 30;
let copied = null;
function clearCopied() {
  if (!copied) return;
  clearTimeout(copied.timer);
  if (clipboard.readText() === copied.value) clipboard.clear();
  copied = null;
}
ipcMain.handle('secrets:set', (_e, { name, value }) => {
  const bad = secrets.nameError(name);
  if (bad) return { error: bad };
  if (!value) return { error: 'Enter a value.' };
  config.setSecret(secrets.key(name), String(value));
  return { ok: true };
});
ipcMain.handle('secrets:remove', (_e, name) => { if (!secrets.nameError(name)) config.setSecret(secrets.key(name), ''); return { ok: true }; });
ipcMain.handle('secrets:has', (_e, names) => (Array.isArray(names) ? names : []).map((n) => !secrets.nameError(n) && config.hasSecret(secrets.key(n))));
ipcMain.handle('secrets:copy', (_e, name) => {
  const value = secrets.nameError(name) ? '' : config.getSecret(secrets.key(name));
  if (!value) return { error: 'No value is saved for ' + name + '.' };
  clearCopied();
  clipboard.writeText(value);
  copied = { value, timer: setTimeout(clearCopied, COPY_SECONDS * 1000) };
  return { ok: true, seconds: COPY_SECONDS };
});

// ---------- dialogs & shell ----------
ipcMain.handle('dialog:folder', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: expandHome(opts.defaultPath) });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:files', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], defaultPath: expandHome(opts.defaultPath) });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('dialog:save', async (_e, opts = {}) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: opts.defaultPath ? expandHome(opts.defaultPath) : undefined, filters: opts.filters });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('dialog:confirm', async (_e, { message, detail, ok }) => {
  const r = await dialog.showMessageBox(win, { type: 'question', buttons: [ok || 'OK', 'Cancel'], defaultId: 1, cancelId: 1, message, detail });
  return r.response === 0;
});
ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));
ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));

// ---------- Google Docs ----------
// Google Drive sometimes fails the first read of a pointer file it has not fetched yet, so a failure is tried again.
ipcMain.handle('gdoc:open', async (_e, { id, path: file }) => {
  for (let i = 0; ; i++) {
    try { return gdoc.open(win, id, expandHome(file), send); } catch (e) {
      if (i === 2) return { error: String(e.message || e) };
      await new Promise((r) => setTimeout(r, 400));
    }
  }
});
ipcMain.handle('gdoc:reload', (_e, id) => gdoc.reload(id));
ipcMain.on('gdoc:place', (_e, { id, bounds }) => gdoc.place(id, bounds));
ipcMain.on('gdoc:dark', (_e, { id, on }) => gdoc.setDark(id, on));
ipcMain.on('gdoc:close', (_e, { id }) => gdoc.close(id, win));

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
// With Codeome's tunnel on, ssh to the HPC host goes through it (and direct when it isn't running).
function applyProxy() {
  const v = cfg.hpc.vpn;
  ssh.setProxy(cfg.hpc.host, v.mode === 'tunnel' ? setup.proxyCommand(setup.portOf(v)) : '');
}

ipcMain.handle('hpc:status', () => ssh.check(cfg.hpc.host));
ipcMain.handle('hpc:disconnect', () => ssh.disconnect(cfg.hpc.host));
ipcMain.handle('hpc:vpn', async () => {
  const v = cfg.hpc.vpn;
  // While Codeome's own sign-in runs, the open port alone does not make it up (see setup.tunnelReady).
  if (v.mode === 'tunnel') return { known: true, tunnel: true, up: !(tunnel && !tunnel.ended && tunnelState.phase !== 'up') && await setup.portOpen(setup.portOf(v)) };
  const t = await setup.vpnTarget(cfg);
  if (!t) return { known: false };
  return { known: true, up: (await setup.probe(t.host, t.port)).result === 'ok', host: t.host };
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

// Codeome's VPN tunnel runs without a terminal (see vpn.js); the window shows its prompts.
// A saved password goes from the Keychain straight to openconnect. One typed in a dialog
// is saved only once the tunnel is up, so a wrong one is never kept.
let tunnel = null, tunnelState = { phase: 'stopped' }, pendingPassword = '';
ipcMain.handle('vpn:start', () => {
  if (tunnel && !tunnel.ended) return { ok: true, state: tunnel.state() };
  if (!pty) return { error: 'Terminal backend failed to load: ' + ptyError };
  const v = cfg.hpc.vpn;
  let command;
  try { command = setup.tunnelCommand(v); } catch (e) { return { error: e.message }; }
  pendingPassword = '';
  tunnel = vpn.start({
    spawn: () => pty.spawn(loginShell(), ['-l', '-c', command], { name: 'xterm-256color', cols: 200, rows: 30, cwd: os.homedir(), env: augmentedEnv({ TERM: 'xterm-256color' }) }),
    ready: setup.tunnelReady(cfg),
    user: v.user, password: config.getSecret('vpn:password'),
    emit: (s) => { tunnelState = s; send('vpn:state', s); },
    onUp: () => { if (pendingPassword) config.setSecret('vpn:password', pendingPassword); pendingPassword = ''; }
  });
  return { ok: true, state: tunnel.state() };
});
ipcMain.handle('vpn:answer', (_e, { id, value, save }) => {
  if (!tunnel) return false;
  const kind = tunnelState.prompt && tunnelState.prompt.kind;
  const ok = tunnel.answer(id, value);
  if (ok && kind === 'password') pendingPassword = save ? String(value) : '';
  return ok;
});
ipcMain.handle('vpn:stop', () => { if (tunnel) tunnel.stop(); return true; });
ipcMain.handle('vpn:state', () => tunnelState);
ipcMain.handle('vpn:log', () => (tunnel ? tunnel.log() : ''));

// The shared HPC and storage connections open without a terminal too (see login.js).
// A saved password goes from the Keychain straight to ssh; one typed in a dialog
// is saved only once the connection is up.
const logins = {};
const loginHost = (target) => (target === 'storage' ? sto() : cfg.hpc.host);
const loginSecret = (target) => target + ':password';
ipcMain.handle('login:start', (_e, target) => {
  if (target !== 'hpc' && target !== 'storage') return { error: 'Unknown connection ' + target };
  const cur = logins[target];
  if (cur && !cur.session.ended) return { ok: true, state: cur.session.state() };
  if (!pty) return { error: 'Terminal backend failed to load: ' + ptyError };
  const host = loginHost(target), secret = loginSecret(target);
  if (!host) return { error: 'No host is set in Settings.' };
  const l = { state: { phase: 'starting' }, pending: '' };
  logins[target] = l;
  l.session = login.start({
    spawn: () => pty.spawn('ssh', ssh.masterArgs(host), { name: 'xterm-256color', cols: 200, rows: 30, cwd: os.homedir(), env: augmentedEnv({ TERM: 'xterm-256color' }) }),
    verify: async () => (await ssh.check(host)).connected,
    password: secret ? config.getSecret(secret) : '',
    emit: (s) => { l.state = s; send('login:state', { target, ...s }); },
    onUp: () => { if (secret && l.pending) config.setSecret(secret, l.pending); l.pending = ''; }
  });
  return { ok: true, state: l.session.state() };
});
ipcMain.handle('login:answer', (_e, { target, id, value, save }) => {
  const l = logins[target];
  if (!l) return false;
  const kind = l.state.prompt && l.state.prompt.kind;
  const ok = l.session.answer(id, value);
  if (ok && kind === 'password') l.pending = save ? String(value) : '';
  return ok;
});
ipcMain.handle('login:stop', (_e, target) => { const l = logins[target]; if (l) l.session.stop(); return true; });
ipcMain.handle('login:state', (_e, target) => (logins[target] ? { target, ...logins[target].state } : { target, phase: 'stopped' }));
ipcMain.handle('login:log', (_e, target) => (logins[target] ? logins[target].session.log() : ''));
const stopLogins = () => { for (const l of Object.values(logins)) l.session.stop(); };

ipcMain.handle('setup:status', () => setup.status(cfg, loginShell()));
ipcMain.handle('setup:testVpn', () => setup.testVpn(cfg));
ipcMain.handle('setup:testLogin', async () => {
  if (!cfg.hpc.host) return { result: 'nohost' };
  const r = await ssh.testLogin(cfg.hpc.host);
  return { result: setup.classifyLogin(r.code, r.stderr), detail: r.stderr.trim().split('\n').filter((l) => !/^Warning: Permanently added/.test(l)).slice(-2).join(' ') };
});
ipcMain.handle('setup:install', (_e, tools) => { const ic = setup.installCommand(tools || []); return ic && { ...ic, brewInstall: setup.BREW_INSTALL }; });

// ---------- long-term storage (SFTP) ----------
const sto = () => sftp.target(cfg.storage.host, cfg.storage.user);
ipcMain.handle('storage:status', () => ssh.check(sto()));
ipcMain.handle('storage:disconnect', () => ssh.disconnect(sto()));
ipcMain.handle('storage:list', (_e, dir) => sftp.list(sto(), dir));
ipcMain.handle('storage:read', (_e, p) => sftp.readFile(sto(), p));
ipcMain.handle('storage:write', (_e, { path: p, content }) => sftp.writeFile(sto(), p, content));
ipcMain.handle('storage:mkdir', (_e, p) => sftp.mkdir(sto(), p));
ipcMain.handle('storage:rename', (_e, { from, to }) => sftp.rename(sto(), from, to));
ipcMain.handle('storage:delete', (_e, { path: p, dir }) => sftp.remove(sto(), p, dir));
ipcMain.handle('storage:fetch', (_e, p) => sftp.fetch(sto(), p));
// HPC ↔ storage copies run sftp on the HPC itself, in a terminal there.
ipcMain.handle('storage:hpcCommand', (_e, { direction, src, destDir }) => {
  try { return { command: sftp.hpcCommand(cfg.storage.hpcHost || sto(), direction, src, destDir) }; } catch (e) { return { error: e.message }; }
});

let rsyncIsGnu = false;
run('rsync', ['--version'], { timeout: 5000 }).then((r) => { rsyncIsGnu = /rsync\s+version\s+3/.test(r.stdout) && !/openrsync/.test(r.stdout); });

// Percent and rate from rsync's or sftp's progress output.
function progressOf(s) {
  const m = s.match(/(\d+)%[^\n\r]*?([\d.]+[kKMGT]?B\/s)?/g);
  if (!m) return null;
  const last = m[m.length - 1];
  return { pct: Number(last.match(/(\d+)%/)[1]), rate: (last.match(/([\d.]+[kKMGT]?B\/s)/) || [])[1] || '' };
}

// Transfers between this Mac and the HPC use rsync over the master connection
// (resumable and incremental); to and from the storage, sftp. A copy within this Mac
// is a local rsync, and one within the HPC a cp there.
// t: {id, from, to, src, destDir} with from/to in local | remote | storage. The queue
// (renderer/js/transfer.js) decides when each one starts, and names it.
ipcMain.handle('transfer:start', (_e, t) => {
  const id = /^tx\w+$/.test(t.id || '') && !transfers.has(t.id) ? t.id : 'tx' + Date.now() + Math.random().toString(36).slice(2, 6);
  const done = (code, error) => { transfers.delete(id); send('transfer:done', { id, code, error: code ? error : '' }); };
  const pair = [t.from, t.to].sort().join('-');
  const dest = t.destDir.replace(/\/?$/, '/');
  // A child process whose output carries the progress; its last lines explain a failure.
  const spawnTx = (cmd, args) => {
    const { spawn } = require('child_process');
    const child = spawn(cmd, args, { env: augmentedEnv() });
    transfers.set(id, { kill: (sig) => child.kill(sig) });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out = (out + d).slice(-2000); const p = progressOf(String(d)); if (p) send('transfer:progress', { id, ...p }); });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('close', (code) => done(code == null ? -1 : code, (err.trim() || out.trim()).split(/[\r\n]+/).slice(-2).join(' ')));
    child.on('error', (e) => done(-1, e.message));
    return { id };
  };
  if (pair === 'local-remote') {
    const host = cfg.hpc.host, up = t.from === 'local';
    // macOS ships openrsync, which lacks some GNU rsync flags; Homebrew rsync gets resumable transfers.
    return spawnTx('rsync', ['-a', ...(rsyncIsGnu ? ['--partial'] : []), '--progress', '-e', ssh.rsyncSshCommand(), up ? t.src : `${host}:${q(t.src)}`, up ? `${host}:${q(dest)}` : dest]);
  }
  if (pair === 'local-local') return spawnTx('rsync', ['-a', '--progress', t.src, dest]);
  // -tt: cancelling the copy here also ends the cp on the HPC.
  if (pair === 'remote-remote') return spawnTx('ssh', ssh.execArgs(cfg.hpc.host, `cp -a -- ${q(t.src)} ${q(dest)}`, ['-tt']));
  if (pair === 'local-storage') {
    if (!sto()) return { error: 'Set up the storage in Settings first.' };
    let batchFile;
    try {
      batchFile = path.join(cacheDir(), id + '.sftp');
      fs.writeFileSync(batchFile, sftp.transferBatch(t.from === 'local' ? 'up' : 'down', t.src, dest));
    } catch (e) { return { error: e.message }; }
    const args = sftp.transferArgs(sto(), batchFile);
    let out = '';
    const finish = (code) => { fs.rm(batchFile, { force: true }, () => {}); done(code, out.replace(/\r/g, '\n').split('\n').map((l) => l.trim()).filter((l) => l && !/^sftp>|%|^Progress meter/.test(l)).slice(-2).join(' ') || 'sftp exited with ' + code); };
    const onData = (d) => { out = (out + d).slice(-4000); const p = progressOf(String(d)); if (p) send('transfer:progress', { id, ...p }); };
    // sftp only draws its progress meter on a terminal.
    if (pty) {
      const p = pty.spawn('sftp', args, { name: 'xterm-256color', cols: 120, rows: 10, cwd: os.homedir(), env: augmentedEnv() });
      transfers.set(id, { kill: () => { try { p.kill(); } catch {} } });
      p.onData(onData);
      p.onExit(({ exitCode }) => finish(exitCode));
    } else {
      const { spawn } = require('child_process');
      const child = spawn('sftp', args, { env: augmentedEnv() });
      transfers.set(id, { kill: (sig) => child.kill(sig) });
      child.stdout.on('data', onData); child.stderr.on('data', onData);
      child.on('close', finish);
      child.on('error', (e) => done(-1, e.message));
    }
    return { id };
  }
  if (pair === 'remote-storage') return { error: 'Copies between the HPC and the storage run in an HPC terminal.' };
  return { error: 'Copying within the storage is not supported: SFTP has no copy.' };
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
ipcMain.handle('slurm:resources', () => slurm.resources(cfg.hpc.host));

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
async function git(cwd, args, opts = {}) { return run('git', args, { cwd, timeout: opts.timeout || 60000, env: opts.env }); }
// The folders git and gh may run in: the open projects, and the active one while it is not listed yet.
function openRoots() { return [...(cfg.openProjects || []), cfg.activeProject].filter((p) => typeof p === 'string' && p); }
function accountContext(root) { return github.contextFor({ accounts: cfg.gitAccounts, bindings: cfg.projectAccounts }, root, config.getSecret); }
ipcMain.handle('git:status', async (_e, cwd) => {
  if (!github.inProject(cwd, openRoots())) return { error: 'Choose an open project.' };
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return { repo: false };
  const root = top.stdout.trim();
  if (!github.inProject(root, openRoots())) return { error: 'Choose an open project.' };
  // A bound account that cannot be used must not hide the repository: the view shows the reason and lets you change it.
  let ctx = null, accountError = null;
  try { ctx = accountContext(root); } catch (e) { accountError = String(e.message || e); }
  const st = await git(root, ['status', '--porcelain=v1', '-b', '-uall']);
  const lines = st.stdout.split('\n').filter(Boolean);
  const head = (lines.shift() || '').replace(/^## /, '');
  const files = lines.map((l) => ({ x: l[0], y: l[1], path: l.slice(3).replace(/^.* -> /, '') }));
  const remote = (await git(root, ['remote', 'get-url', 'origin'])).stdout.trim();
  const log = (await git(root, ['log', '-n', '15', '--pretty=format:%h\t%s\t%an\t%cr'])).stdout.split('\n').filter(Boolean).map((l) => { const [h, s, a, t] = l.split('\t'); return { hash: h, subject: s, author: a, when: t }; });
  const ghCall = github.ghInvocation(ctx, ['auth', 'status', ...(ctx && ctx.account.host !== 'github.com' ? ['--hostname', ctx.account.host] : [])]);
  const gh = await run('gh', ghCall.args, { timeout: 8000, env: ghCall.env });
  return { repo: true, root, head, files, remote, log, gh: gh.code === 0,
    accountId: Object.hasOwn(cfg.projectAccounts, root) ? cfg.projectAccounts[root] : null, accountError,
    ...(ctx ? { account: { id: ctx.account.id, login: ctx.account.login, host: ctx.account.host, status: ctx.account.status } } : {}) };
});
// Cheap check for the rail marker: how many paths have uncommitted changes.
ipcMain.handle('git:dirty', async (_e, cwd) => {
  const st = await git(cwd, ['status', '--porcelain=v1', '-unormal'], { timeout: 15000 });
  if (st.code !== 0) return { repo: false, changes: 0 };
  return { repo: true, changes: st.stdout.split('\n').filter(Boolean).length };
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
  const error = github.checkGitArgs(args);
  if (error) return { error };
  if (!github.inProject(root, openRoots())) return { error: 'Choose an open project.' };
  let ctx;
  if (['push', 'pull', 'fetch'].includes(args[0])) {
    try { ctx = accountContext(root); } catch (e) { return { error: String(e.message || e) }; }
  }
  const invocation = github.gitInvocation(ctx, args);
  const r = await git(root, invocation.args, { timeout: 180000, env: invocation.env });
  const token = invocation.env.CODEOME_GIT_TOKEN;
  const stdout = token ? github.redact(r.stdout, [token]) : r.stdout;
  const stderr = token ? github.redact(r.stderr, [token]) : r.stderr;
  return r.code === 0 ? { ok: true, out: (stdout + stderr).trim() } : { error: (stderr || stdout).trim() };
});
ipcMain.handle('gh:run', async (_e, { root, args }) => {
  const error = github.checkGhArgs(args);
  if (error) return { error };
  if (!github.inProject(root, openRoots())) return { error: 'Choose an open project.' };
  let ctx;
  if (args[0] !== 'browse') {
    try { ctx = accountContext(root); } catch (e) { return { error: String(e.message || e) }; }
  }
  const invocation = github.ghInvocation(ctx, args);
  const r = await run('gh', invocation.args, { cwd: root, timeout: 180000, env: invocation.env });
  const token = invocation.env.CODEOME_GIT_TOKEN;
  const stdout = token ? github.redact(r.stdout, [token]) : r.stdout;
  const stderr = token ? github.redact(r.stderr, [token]) : r.stderr;
  return r.code === 0 ? { ok: true, out: (stdout + stderr).trim() } : { error: (stderr || stdout).trim() };
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

// ---------- GitHub accounts ----------
function accountStore() { return { accounts: cfg.gitAccounts, bindings: cfg.projectAccounts }; }
function saveAccounts(store) {
  cfg.gitAccounts = store.accounts;
  cfg.projectAccounts = store.bindings;
  cfg = config.save(cfg);
}
function projectRoot(root) {
  if (!github.inProject(root, openRoots())) throw new Error('Choose an open project.');
  return path.resolve(root);
}
async function addGitAccount({ provider: providerId, host, token }) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('Enter a GitHub token.');
  token = token.trim();
  if (!config.secretsEncrypted()) throw new Error('GitHub accounts require encrypted secret storage on this device.');
  try {
    const result = await github.provider(providerId).validate(token, host, { fetch });
    if (result.status === 'invalid' || result.status === 'error') throw new Error(result.message || 'GitHub rejected the token.');
    if (typeof result.login !== 'string' || !result.login.trim()) throw new Error('GitHub did not return an account login.');
    const id = crypto.randomUUID();
    const added = github.addAccount(accountStore(), { provider: providerId, host, login: result.login, status: result.status, scopes: result.scopes, checkedAt: new Date().toISOString() }, id);
    config.setSecret('github:' + id, token);
    saveAccounts(added.store);
    return { ...github.publicView(added.account), ...(result.warnings ? { warnings: result.warnings } : {}) };
  } catch (e) { throw new Error(github.redact(String(e.message || e), [token])); }
}
ipcMain.handle('gitacct:list', wrap(() => ({ accounts: cfg.gitAccounts.map(github.publicView), bindings: { ...cfg.projectAccounts } })));
ipcMain.handle('gitacct:add', wrap(addGitAccount));
ipcMain.handle('gitacct:validate', wrap(async ({ id }) => {
  const account = cfg.gitAccounts.find((a) => a.id === id);
  if (!account) throw new Error('GitHub account not found.');
  const token = config.getSecret('github:' + id);
  if (!token) throw new Error('GitHub token is missing for this account.');
  let result;
  try { result = await github.provider(account.provider).validate(token, account.host, { fetch }); }
  catch (e) { throw new Error(github.redact(String(e.message || e), [token])); }
  if (result.status === 'error') throw new Error('Could not reach GitHub. Try again later.');
  const updated = { ...account, status: result.status, login: result.login || account.login, scopes: result.scopes, checkedAt: new Date().toISOString() };
  saveAccounts({ ...accountStore(), accounts: cfg.gitAccounts.map((a) => a.id === id ? updated : a) });
  return github.publicView(updated);
}));
ipcMain.handle('gitacct:remove', wrap(({ id }) => {
  if (typeof id !== 'string' || !cfg.gitAccounts.some((account) => account.id === id)) throw new Error('GitHub account not found.');
  saveAccounts(github.removeAccount(accountStore(), id));
  config.setSecret('github:' + id, '');
  return true;
}));
ipcMain.handle('gitacct:import-gh', wrap(async ({ host = 'github.com' } = {}) => {
  const error = github.checkHost(host);
  if (error) throw new Error('Invalid GitHub host: ' + error);
  if (!config.secretsEncrypted()) throw new Error('GitHub accounts require encrypted secret storage on this device.');
  const r = await run('gh', ['auth', 'token', '--hostname', host], { timeout: 10000 });
  if (r.code !== 0 || !r.stdout.trim()) throw new Error('gh is not signed in for that host.');
  return addGitAccount({ provider: 'github', host, token: r.stdout.trim() });
}));
ipcMain.handle('gitacct:bind', wrap(({ root, id }) => {
  root = projectRoot(root);
  const store = github.bind(accountStore(), root, id);
  saveAccounts(store);
  return Object.hasOwn(store.bindings, root) ? store.bindings[root] : null;
}));
async function gitIdentity(root) {
  const get = async (local, key) => {
    const args = ['config', ...(local ? ['--local'] : []), '--get', key];
    const r = await run('git', args, { cwd: root, timeout: 10000 });
    if (r.code !== 0 && r.code !== 1) throw new Error((r.stderr || 'Could not read git identity.').trim());
    return r.code === 0 ? r.stdout.trim() : '';
  };
  const [name, email, effectiveName, effectiveEmail] = await Promise.all([
    get(true, 'user.name'), get(true, 'user.email'), get(false, 'user.name'), get(false, 'user.email')
  ]);
  return { name, email, effectiveName, effectiveEmail };
}
ipcMain.handle('gitacct:identity-get', wrap(({ root }) => gitIdentity(projectRoot(root))));
ipcMain.handle('gitacct:identity-set', wrap(async ({ root, name, email }) => {
  root = projectRoot(root);
  for (const value of [name, email]) {
    if (typeof value !== 'string' || /[\0\r\n]/.test(value) || value.length > 256) throw new Error('Git identity values must be at most 256 characters without NUL or newlines.');
  }
  name = name.trim(); email = email.trim();
  if (name.startsWith('-') || email.startsWith('-')) throw new Error('Git identity values must not start with a hyphen.');
  for (const [key, value] of [['user.name', name], ['user.email', email]]) {
    const r = await run('git', ['config', '--local', ...(value ? [key, value] : ['--unset', key])], { cwd: root, timeout: 10000 });
    if (r.code !== 0 && !(r.code === 5 && !value)) throw new Error('Could not set ' + key + ': ' + (r.stderr || 'git config failed.').trim());
  }
  return gitIdentity(root);
}));

// ---------- Python packages ----------
ipcMain.handle('pip:list', async (_e, { where, python, cwd }) => {
  const cmd = `${python} -m pip list --format=json --disable-pip-version-check`;
  const r = where === 'hpc' ? await ssh.exec(cfg.hpc.host, `bash -lc ${q(cmd)}`, { timeout: 60000 })
    : await run(loginShell(), ['-l', '-c', cmd], { cwd: expandHome(cwd), timeout: 60000 });
  try { return { packages: JSON.parse(r.stdout.trim().split('\n').pop()) }; } catch { return { error: (r.stderr || r.stdout || 'pip failed').trim() }; }
});

// ---------- R: plots and packages ----------
const rWhere = (where) => (where === 'hpc' ? cfg.hpc.host : null);
ipcMain.handle('plots:install', async (_e, where) => { try { return await rtools.install(where, rWhere(where)); } catch (e) { return { error: e.message }; } });
ipcMain.handle('plots:canvas', async (_e, { where, text }) => { try { return await rtools.setCanvas(where, rWhere(where), text); } catch (e) { return { error: e.message }; } });
ipcMain.handle('plots:render', async (_e, o) => {
  try {
    const d = path.join(cacheDir(), 'plots'); fs.mkdirSync(d, { recursive: true });
    return await rtools.render(o, { host: rWhere(o.where), cacheDir: d, shell: loginShell(), rcmd: o.where === 'hpc' ? cfg.r.remote : cfg.r.local });
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('plots:copy', async (_e, p) => {
  try {
    if (path.extname(p).toLowerCase() !== '.png') return { error: 'Only PNG images can be copied.' };
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([fs.readFileSync(p)], { type: 'image/png' }) })]);
    return { ok: true };
  } catch (e) { return { error: 'Could not copy the image: ' + e.message }; }
});
ipcMain.handle('rpkg:list', async (_e, { where, cwd, outdated }) => {
  try {
    const inst = await rtools.install(where, rWhere(where));
    if (inst.error) return inst;
    return await rtools.listPackages({ where, outdated, cwd: where === 'hpc' ? cwd : expandHome(cwd), host: rWhere(where), shell: loginShell(),
      rcmd: (where === 'hpc' ? cfg.r.remote : cfg.r.local) || 'R --no-save --quiet' });
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle('pypi:hasToken', (_e, which) => config.hasSecret('pypi:' + which));

// ---------- agent kit & jobs ----------
ipcMain.handle('kit:status', (_e, project) => { try { return kit.status(project); } catch (e) { return { error: e.message }; } });
ipcMain.handle('kit:install', (_e, { project, groups }) => { try { return kit.install(project, { groups }); } catch (e) { return { error: e.message }; } });
// Global agents and skills are the ones in the active Claude account's folder (each account has its own).
const claudeAccount = () => { const c = cfg.accounts.claude; return c.list.find((a) => a.name === c.active) || c.list[0] || { name: 'Default', dir: '' }; };
const claudeDir = () => expandHome(claudeAccount().dir || usage.DEFAULT_DIR.claude);
ipcMain.handle('skills:list', (_e, project) => { try { return { skills: kit.skillList(project, claudeDir()) }; } catch (e) { return { error: e.message }; } });
ipcMain.handle('agents:list', (_e, project) => { try { return { agents: kit.agents(project, claudeDir()) }; } catch (e) { return { error: e.message }; } });
ipcMain.handle('global:list', (_e, project) => {
  try { const dir = claudeDir(); return { dir, account: claudeAccount().name, accounts: cfg.accounts.claude.list.length, agents: kit.globalAgents(dir, project), skills: kit.globalSkills(dir, project) }; }
  catch (e) { return { error: e.message }; }
});
ipcMain.handle('global:setAgent', (_e, { project, name, patch }) => { try { return { agent: kit.setGlobalAgent(claudeDir(), name, patch, project) }; } catch (e) { return { error: e.message }; } });
ipcMain.handle('agents:set', (_e, { project, name, patch }) => { try { return { agent: kit.setAgent(project, name, patch) }; } catch (e) { return { error: e.message }; } });
ipcMain.handle('agents:models', () => {
  const c = cfg.accounts.codex;
  const acct = c.list.find((a) => a.name === c.active) || c.list[0] || { dir: '' };
  return { codex: usage.codexModels(acct.dir) };
});
ipcMain.handle('jobs:list', (_e, project) => jobs.list(project));
ipcMain.handle('jobs:read', (_e, { project, id, part }) => jobs.read(project, id, part));
ipcMain.handle('jobs:cancel', (_e, { project, id }) => jobs.cancel(project, id));
ipcMain.handle('jobs:clear', (_e, project) => jobs.clear(project));

// ---------- agent chat ----------
// One headless Claude Code orchestrator per conversation; see chat.js.
const claudeCmd = () => (cfg.agents.find((a) => /^claude(\s|$)/.test(a.cmd)) || { cmd: 'claude' }).cmd;

const codexCmd = () => (cfg.agents.find((a) => /^codex(\s|$)/.test(a.cmd)) || { cmd: 'codex' }).cmd;

function createAgentSession({ id, project, engine, account, resume, mode, meter, forum = false, persona }) {
  let kitInstalled = false;
  try { kitInstalled = kit.status(project).installed; } catch {}
  const command = engine === 'codex' ? codexCmd() : claudeCmd();
  const acct = launchOn(engine, account, command);
  const dir = (cfg.accounts[engine].list.find((a) => a.name === acct.info.name) || {}).dir || '';
  const [bin, ...extra] = command.trim().split(/\s+/);
  const env = augmentedEnv({ ...userSecretEnv('agents', project), ...acct.env, TERM_PROGRAM: 'Codeome' });
  for (const k of acct.unset) delete env[k];
  // The projects connected to this one: their folders, and (Claude) their CLAUDE.md files too.
  const linked = ((cfg.projectLinks || {})[project] || []).filter((d) => d !== project && fs.existsSync(d));
  // The job runner makes them writable for the Codex specialists it starts.
  if (linked.length) env.CODEOME_LINKED = linked.join(path.delimiter);
  const autoAllow = (r) => kitInstalled && r.tool_name === 'Bash' && chat.isJobRunner(r.input && r.input.command);
  const meterOpt = resume ? { ...(meter || {}), resumed: true } : {};
  let s;
  if (engine === 'codex') {
    const c = cfg.chat || {};
    s = new CodexSession({ id, cwd: project, shell: loginShell(), bin, args: [], env, autoAllow: forum ? () => false : autoAllow, meter: meterOpt, resume: !!resume, addDirs: linked,
      instructions: forum ? chat.forumPrompt() : chat.codexPrompt({ kitInstalled, linked, hpc: cfg.hpc, persona }), model: c.codexModel || '', effort: c.codexEffort || '' });
  } else {
    if (linked.length) env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD = '1';
    s = new chat.Session({ id, cwd: project, shell: loginShell(), bin, args: chat.buildArgs({ id, resume, mode, kitInstalled, extra, model: (cfg.chat || {}).model, effort: (cfg.chat || {}).effort, linked, hpc: cfg.hpc, settings: statusline && statusline.settings, persona, ...(forum ? { prompt: chat.forumPrompt() } : {}) }), env, autoAllow: forum ? () => false : autoAllow, meter: meterOpt });
    s.on('rateLimits', (rl) => { if (rl) { try { chat.recordUsage(dir, rl); } catch (e) { console.error('chat usage', e); } } });
  }
  return { s, acct, dir };
}

ipcMain.handle('chat:start', (_e, { id, project, account, resume, mode, meter, engine: asked, role }) => {
  if (chats.has(id)) return { ok: true };
  if (!project || !fs.existsSync(project)) return { error: 'Project folder not found.' };
  const engine = chat.engineOf(asked);
  const persona = typeof role === 'string' ? role : undefined;
  try {
    const { s, acct } = createAgentSession({ id, project, engine, account, resume, mode, meter, persona });
    s.on('message', (msg) => send('chat:event', { id, msg }));
    // Codex limits are read from its app-server by the usage poll, so only Claude's are recorded here.
    s.on('turn', (t) => { try { stats.record({ at: Date.now(), session: id, project, account: acct.info.name, engine, ...t }); } catch (e) { console.error('chat stats', e); } });
    s.on('exit', (r) => { chats.delete(id); send('chat:exit', { id, ...r }); });
    s.start();
    chats.set(id, s);
    return { ok: true, account: acct.info };
  } catch (e) { return { error: String(e.message || e) }; }
});

const forumHost = createHost({ getCfg: () => cfg, send, claudeCmd, codexCmd, launchOn, stats,
  makeAgentSession: (seat, project) => createAgentSession({ id: seat.sessionId, project, engine: seat.engine,
    account: seat.account, resume: !!seat.started, mode: 'plan', forum: true }).s });
forumHost.register(ipcMain);
// Move a stopped conversation to another Claude account, where its next message resumes it.
ipcMain.handle('chat:move', (_e, { id, from, to, engine }) => {
  if (chat.engineOf(engine) === 'codex') return { error: 'Codex chats can\'t change account yet.' };
  if (chats.has(id)) return { error: 'The session is still running.' };
  try {
    const dirOf = (name) => {
      const n = !name || name === 'auto' ? cfg.accounts.claude.active : name;
      const a = cfg.accounts.claude.list.find((x) => x.name === n || (x.aka || []).includes(n));
      if (!a) throw new Error('No Claude account named ' + n + '.');
      return path.resolve(expandHome(a.dir || usage.DEFAULT_DIR.claude));
    };
    const a = dirOf(from), b = dirOf(to);
    if (a !== b) chat.moveSession(a, b, id);
    return { ok: true };
  } catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.handle('chat:send', (_e, { id, text }) => { const s = chats.get(id); if (!s) return { error: 'The session is not running.' }; s.user(text); return { ok: true }; });
ipcMain.handle('chat:respond', (_e, { id, requestId, response }) => { const s = chats.get(id); if (!s) return { error: 'The session is not running.' }; s.respond(requestId, response); return { ok: true }; });
ipcMain.handle('chat:control', (_e, { id, request }) => { const s = chats.get(id); return s ? s.control(request) : { error: 'The session is not running.' }; });
ipcMain.handle('chat:stop', (_e, id) => { const s = chats.get(id); if (s) s.stop(); return { ok: true }; });
ipcMain.handle('chat:save', (_e, { project, chat: c }) => { try { return chat.saveChat(project, c); } catch (e) { return { error: e.message }; } });
ipcMain.handle('chat:list', (_e, project) => chat.listChats(project));
ipcMain.handle('chat:personas', () => chat.listPersonas());
ipcMain.handle('chat:load', (_e, { project, id }) => chat.loadChat(project, id));
ipcMain.handle('chat:delete', (_e, { project, id }) => chat.deleteChat(project, id));
// What the sessions used over the last days, with each session's chat title where it still exists.
ipcMain.handle('stats:get', (_e, days) => {
  try {
    const sum = stats.summary(stats.read(), { days: Number(days) || 30 });
    const titles = {};
    for (const s of sum.sessions) {
      if (!titles[s.project]) { titles[s.project] = {}; for (const c of chat.listChats(s.project)) titles[s.project][c.id] = c.title; }
      s.title = titles[s.project][s.session] || null;
    }
    return { ...sum, file: stats.file() };
  } catch (e) { return { error: e.message }; }
});

// ---------- usage limits & accounts ----------
// Live readings per account, keyed engine → account folder (an account can change its name).
const readings = { claude: {}, codex: {} };
const rk = (a) => usage.accountKey(a.dir);
const identities = { claude: {} };
let statusline = null;
const cliCmd = (engine) => ((cfg.agents.find((a) => new RegExp('^' + engine + '(\\s|$)').test(a.cmd)) || {}).cmd || engine).split(' ')[0];

function accountsOf(engine) {
  const now = Date.now() / 1000;
  return cfg.accounts[engine].list.map((a) => {
    const r = readings[engine][rk(a)] || {};
    const id = engine === 'claude' ? identities.claude[rk(a)] || {} : r.account || {};
    // true / false once the CLI has answered, null while nothing is known yet.
    const signedIn = engine === 'claude' ? (identities.claude[rk(a)] ? !id.signedOut : null) : (r.account === undefined ? null : !!r.account);
    return { name: a.name, dir: a.dir, key: rk(a), email: id.email || null, plan: id.plan || (r.limits && r.limits.plan) || null,
      ...usage.signInState(a.name, signedIn, id.email), windows: r.windows || {}, reached: !!r.reached, asOf: r.asOf || null, error: r.error || null,
      level: usage.level({ windows: r.windows || {}, reached: r.reached, asOf: r.asOf }, now) };
  });
}

function snapshot() {
  const eng = (e) => ({ active: cfg.accounts[e].active, accounts: accountsOf(e) });
  return { version: 1, updatedAt: Date.now() / 1000, stopAt: cfg.usage.stopAt, claude: eng('claude'), codex: eng('codex') };
}

let lastSnap = '';
function publishUsage() {
  const snap = snapshot();
  const sig = JSON.stringify({ ...snap, updatedAt: 0 });
  try { usage.writeSnapshot(snap); } catch (e) { console.error('usage snapshot', e); }
  if (sig !== lastSnap) { lastSnap = sig; send('usage:update', snap); }
  return snap;
}

function readClaudeUsage() {
  for (const a of cfg.accounts.claude.list) {
    const r = usage.readClaude(a.dir);
    readings.claude[rk(a)] = r.asOf ? { windows: r.windows, asOf: r.asOf } : {};
  }
}

let codexBusy = null;
function refreshCodex() {
  if (codexBusy) return codexBusy;
  codexBusy = Promise.all(cfg.accounts.codex.list.map(async (a) => {
    const r = await usage.queryCodex(a.dir, cliCmd('codex'));
    const prev = readings.codex[rk(a)] || {};
    readings.codex[rk(a)] = r.limits
      ? { windows: r.limits.windows, reached: r.limits.reached, limits: r.limits, account: r.account, asOf: Date.now() / 1000 }
      : { ...prev, account: r.account !== undefined ? r.account : prev.account, error: r.error };
  })).finally(() => { codexBusy = null; });
  return codexBusy;
}

// Ask Claude Code for each signed-in account's usage and record it where the status line does.
let claudeBusy = null;
function refreshClaude() {
  if (claudeBusy) return claudeBusy;
  claudeBusy = Promise.all(cfg.accounts.claude.list.map(async (a) => {
    if ((identities.claude[rk(a)] || {}).signedOut) return;
    const r = await usage.queryClaude(a.dir, cliCmd('claude'));
    if (r.rateLimits) { try { chat.recordUsage(a.dir, r.rateLimits); } catch (e) { console.error('claude usage', e); } }
  })).then(readClaudeUsage).finally(() => { claudeBusy = null; });
  return claudeBusy;
}

async function refreshIdentities() {
  await Promise.all(cfg.accounts.claude.list.map(async (a) => {
    const id = await usage.claudeIdentity(a.dir, cliCmd('claude'));
    if (id) identities.claude[rk(a)] = id;
  }));
}

async function refreshUsage(full) {
  readClaudeUsage();
  if (full) await Promise.all([refreshCodex(), refreshIdentities().then(refreshClaude)]);
  return publishUsage();
}

// Which account a new session uses: the requested one, or (auto) the active one
// while it has headroom and otherwise the account with the most.
const noCoAuthor = () => !cfg.claude || cfg.claude.noCoAuthor !== false;

function launchOn(engine, requested, command) {
  readClaudeUsage();
  const list = accountsOf(engine);
  // A chat started before its account took its email still asks for the old name.
  const asked = requested && requested !== 'auto' ? cfg.accounts[engine].list.find((a) => a.name === requested || (a.aka || []).includes(requested)) : null;
  let chosen = asked ? list.find((a) => a.name === asked.name) : null;
  let info = null;
  if (!chosen) {
    const p = usage.pick(list, cfg.accounts[engine].active, cfg.usage.stopAt);
    chosen = p.account || p.from || list[0];
    info = { switched: !!p.switched, from: p.from && p.from.name, blocked: !!p.blocked };
  }
  if (engine === 'claude' && statusline) { try { usage.writeSettings(statusline, noCoAuthor()); } catch (e) { console.error('claude settings', e); } }
  const l = usage.launch(engine, chosen ? chosen.dir : '', command, engine === 'claude' && statusline ? statusline.settings : null);
  return { ...l, info: { name: chosen ? chosen.name : null, level: chosen ? chosen.level : null, ...(info || {}) } };
}

ipcMain.handle('usage:get', () => snapshot());
ipcMain.handle('usage:refresh', () => refreshUsage(true));
// Config folders on this Mac that are signed in but are no account yet, with who they belong to.
ipcMain.handle('usage:found', async () => {
  const out = { claude: [], codex: [] };
  await Promise.all(Object.keys(out).map((e) => Promise.all(usage.findFolders(e, cfg.accounts[e].list.map((a) => a.dir)).map(async (dir) => {
    const id = e === 'claude' ? await usage.claudeIdentity(dir, cliCmd('claude')) : (await usage.queryCodex(dir, cliCmd('codex'))).account;
    if (id && id.email) out[e].push({ dir, email: id.email, plan: id.plan || null });
  }))));
  return out;
});
ipcMain.handle('usage:setActive', (_e, { engine, name }) => {
  if (!cfg.accounts[engine] || !cfg.accounts[engine].list.some((a) => a.name === name)) return { error: 'Unknown account ' + name };
  cfg.accounts[engine].active = name;
  cfg = config.save(cfg);
  return publishUsage();
});

function startUsage() {
  try { statusline = usage.installStatusline(path.join(__dirname, 'codeome-statusline'), noCoAuthor()); } catch (e) { console.error('statusline', e); }
  refreshUsage(true);
  // Both CLIs are asked every few minutes; between two checks, Claude readings are also
  // files a running session's status line rewrites.
  const dir = path.join(usage.home(), 'usage');
  try { fs.mkdirSync(dir, { recursive: true }); let t = null; fs.watch(dir, () => { clearTimeout(t); t = setTimeout(() => refreshUsage(false), 500); }); } catch {}
  setInterval(() => refreshUsage(false), 30000);
  let lastAsked = Date.now();
  setInterval(() => { if (Date.now() - lastAsked >= (cfg.usage.codexRefreshSeconds || 180) * 1000) { lastAsked = Date.now(); Promise.all([refreshCodex(), refreshClaude()]).then(publishUsage); } }, 15000);
  setInterval(() => refreshIdentities().then(publishUsage), 15 * 60000);
}

// ---------- Claude Code and Codex versions ----------
const updatesFile = () => path.join(app.getPath('userData'), 'updates.json');
// opts: { force, suggest } — see updates.check.
ipcMain.handle('tools:updates', async (_e, opts = {}) => {
  const engines = { codeome: { path: '', version: require('../package.json').version } };
  await Promise.all(['claude', 'codex'].map(async (e) => {
    const bin = await setup.locate(cliCmd(e), loginShell());
    if (!bin) return;
    const r = await run(bin, ['--version'], { timeout: 10000, env: augmentedEnv() });
    const v = updates.semver(r.stdout + ' ' + r.stderr);
    engines[e] = { path: bin, version: v ? v.join('.') : '' };
  }));
  const res = await updates.check({ file: updatesFile(), engines, force: !!opts.force, suggest: !!opts.suggest });
  return { ...res, installed: Object.fromEntries(Object.entries(engines).map(([e, i]) => [e, i.version])) };
});

// ---------- environment detection ----------
ipcMain.handle('env:detect', async () => {
  const tools = ['git', 'gh', 'quarto', 'R', 'Rscript', 'python3', 'rsync', 'ssh', 'sftp', 'tmux', 'claude', 'codex'].concat(cfg.agents.map((a) => a.cmd.split(' ')[0]));
  const out = {};
  await Promise.all(tools.map(async (t) => { out[t] = (await run(loginShell(), ['-l', '-c', `command -v ${t}`], { timeout: 8000 })).code === 0; }));
  const installable = Object.keys(out).filter((t) => !out[t] && setup.RECIPES[t]);
  return { tools: out, installable, recipes: setup.RECIPES, ptyOk: !!pty, ptyError, platform: process.platform, home: os.homedir(), tmp: path.join(os.tmpdir(), 'codeome') };
});

app.whenReady().then(() => {
  cfg = config.load();
  applyProxy();
  app.setName('Codeome');
  // Packaged, the dock icon comes from build/icon.icns; under `npm start` it would be Electron's.
  if (!app.isPackaged && app.dock) app.dock.setIcon(path.join(__dirname, '..', 'build', 'icon.png'));
  buildMenu();
  createWindow();
  startUsage();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', () => { forumHost.disposeAll(); clearCopied(); stopLogins(); if (tunnel) tunnel.stop(); });
app.on('window-all-closed', () => { forumHost.disposeAll(); stopLogins(); if (tunnel) tunnel.stop(); for (const p of ptys.values()) { try { p.kill(); } catch {} } for (const c of chats.values()) c.stop(); if (process.platform !== 'darwin') app.quit(); });
