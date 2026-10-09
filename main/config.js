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
    useTmux: true          // run remote agent sessions inside tmux so they survive disconnects
  },
  agents: [
    { name: 'Claude Code', cmd: 'claude' },
    { name: 'Codex', cmd: 'codex' }
  ],
  python: { local: 'python3', remote: 'python3' },
  zenodo: { sandbox: false },
  editor: { fontSize: 13, theme: 'auto' },
  slurm: { refreshSeconds: 20, historyDays: 3 },
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
