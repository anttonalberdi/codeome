// Settings stored as JSON in the app's user-data folder; tokens are encrypted
// with the macOS Keychain via Electron's safeStorage.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, safeStorage } = require('electron');

const DEFAULTS = {
  localRoot: path.join(os.homedir()),
  hpc: {
    host: '',              // an alias from ~/.ssh/config, or user@login.cluster.org
    remoteRoot: '~',       // starting folder on the HPC
    vpnCheckHost: '',      // optional host to probe to tell whether the VPN is up
    useTmux: true,         // run remote agent sessions inside tmux so they survive disconnects
    // How the HPC's network is reached. system: campus, or a VPN for the whole Mac (Cisco Secure Client);
    // tunnel: Codeome's own OpenConnect tunnel, used only for its connections to the HPC.
    vpn: { mode: 'system', server: '', user: '', port: 11080, args: '' }
  },
  // Long-term storage reached over SFTP, e.g. ERDA (io.erda.dk); it needs no shell.
  storage: {
    host: '',              // an alias from ~/.ssh/config, a host name, or user@io.erda.dk
    user: '',              // the username, e.g. you@example.org; '' uses the login or ~/.ssh/config
    root: '',              // starting folder; '' is the login folder
    hpcHost: ''            // how the HPC reaches it for direct copies; '' uses host
  },
  // The R console: a command on this Mac, and one on the HPC (e.g. "module load R && R …").
  r: { local: 'R --no-save --quiet', remote: 'R --no-save --quiet' },
  // The Plots view: capture plots from R consoles, and the canvas they are drawn and exported at.
  // fit: draw at the size of the panel; otherwise w × h in `unit` (in, cm, mm, px) at dpi.
  plots: { capture: true, show: true, fit: true, w: 7, h: 5, unit: 'in', dpi: 300, bg: 'white', format: 'pdf' },
  agents: [
    { name: 'Claude Code', cmd: 'claude' },
    { name: 'Codex', cmd: 'codex' }
  ],
  python: { local: 'python3', remote: 'python3' },
  zenodo: { sandbox: false },
  editor: { fontSize: 13, theme: 'auto' },
  slurm: { refreshSeconds: 20, historyDays: 3 },
  // An account is { name, dir }: name is the email it signs in with, dir its config folder
  // (CLAUDE_CONFIG_DIR / CODEX_HOME), chosen by Codeome; '' is the CLI's default. The CLI's
  // own folder starts as 'Default' and takes its email once it is signed in.
  accounts: {
    claude: { active: 'Default', list: [{ name: 'Default', dir: '' }] },
    codex: { active: 'Default', list: [{ name: 'Default', dir: '' }] }
  },
  // Agent jobs are held back once the 5-hour or weekly limit passes this percentage.
  usage: { stopAt: 90, codexRefreshSeconds: 180 },
  // model: the orchestrator's Claude model; '' uses the command's own.
  // quick: messages sent often, listed under the button beside the message box.
  chat: { model: '', quick: ['Commit, push and deploy'] },
  chatTabs: {},           // project → { open: [chat ids], active } for the chat tabs
  openProjects: [],       // project cards in the left column, in order
  projectColors: {},      // project → hue (0–359) of its card and title-bar tag; picked when first opened
  activeProject: null,
  // panes: the Files view's sections (local / remote / storage) → { title, collapsed, weight };
  // pkgPanes: the same for the Packages view (python / r), plus shown: true|false for R;
  // transfer: the Transfer view → { left, right: { host, dirs }, queueH, parallel }.
  ui: { projectsCollapsed: false, panes: {}, pkgPanes: {}, transfer: {} },
  recentFolders: []
};

function file(name) { return path.join(app.getPath('userData'), name); }

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = deepMerge(base[k], over[k]);
  return out;
}

function load() {
  try { return deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(file('config.json'), 'utf8'))); }
  catch { return JSON.parse(JSON.stringify(DEFAULTS)); }
}

function save(cfg) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(file('config.json'), JSON.stringify(cfg, null, 2));
  return cfg;
}

function readSecrets() {
  try {
    const buf = fs.readFileSync(file('secrets.bin'));
    return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8'));
  } catch { return {}; }
}

function setSecret(key, value) {
  const s = readSecrets();
  if (value) s[key] = value; else delete s[key];
  const json = JSON.stringify(s);
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json);
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(file('secrets.bin'), data, { mode: 0o600 });
}

function getSecret(key) { return readSecrets()[key] || ''; }
function hasSecret(key) { return !!readSecrets()[key]; }

module.exports = { load, save, getSecret, setSecret, hasSecret, DEFAULTS };
