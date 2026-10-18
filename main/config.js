// Settings stored as JSON in the app's user-data folder; tokens are encrypted
// with the macOS Keychain via Electron's safeStorage.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, safeStorage } = require('electron');

const DEFAULTS = {
  localRoot: path.join(os.homedir()),
  projectsDir: '',         // where a project cloned from a git URL gets its folder; '' is ~/Codeome
  hpc: {
    host: '',              // an alias from ~/.ssh/config, or user@login.cluster.org
    remoteRoot: '~',       // starting folder on the HPC
    agentRoot: '',         // where agents put the projects they run on the HPC, one folder each; '' leaves it to them
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
  // Claude Code sessions started by Codeome: leave Claude's co-author trailer and "Generated with
  // Claude Code" line out of commits and pull requests (passed with --settings; your files are untouched).
  claude: { noCoAuthor: true },
  // Your own secrets, by name: { name, note, terminals, agents, projects }. The values are in the
  // Keychain-encrypted store; see secrets.js for where each is set as an environment variable.
  secrets: [],
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
  // model: the orchestrator's Claude model; '' uses the command's own. modelPicked: chosen in Settings.
  // effort: its effort level (low … max); '' leaves it to the model.
  // quick: messages sent often, listed under the button beside the message box.
  // codexModel/codexEffort: the same for chats on Codex ('' leaves them to Codex).
  // suggest: show clickable replies (a small model call) under a question that offers none.
  // contextWarnAt: a chat suggests starting a new one once its context window is this full (%).
  chat: { model: 'sonnet', modelPicked: false, effort: '', codexModel: '', codexEffort: '', quick: ['Commit, push and deploy'], contextWarnAt: 70, suggest: true },
  forum: { defaultBudget: 0, summaryTokens: 6000, recentMessages: 8, checkModel: 'haiku', codexCheckModel: '', checkEffort: 'low', checkTimeoutMs: 30000 },
  chatTabs: {},           // project → { open: [chat ids], active } for the chat tabs
  openProjects: [],       // project cards in the left column, in order
  projectColors: {},      // project → hue (0–359) of its card and title-bar tag; picked when first opened
  projectGroups: [],      // groups of cards, in order: { id, name, collapsed }
  projectGroup: {},       // project → id of its group; kept when the project is closed
  scratchpads: {},        // project → the text of its scratchpad, shown when no file is open
  projectLinks: {},       // project → [projects connected to it]; both ways, kept when a project is closed
  gitAccounts: [],        // GitHub account metadata; tokens stay in the encrypted secret store
  projectAccounts: {},    // project → GitHub account id; kept when the project is closed
  showHidden: true,       // list dotfiles (.gitignore, .readthedocs.yaml…) in the file views
  activeProject: null,
  projectViews: {},       // project → { view, pane } it was left on; restored when switching back or reopening
  // panes: the Files view's sections (local / remote / storage) → { title, collapsed, weight };
  // pkgPanes: the same for the Packages view (python / r), plus shown: true|false for R;
  // transfer: the Transfer view → { left, right: { host, dirs }, queueH, parallel }.
  ui: { projectsCollapsed: false, panes: {}, pkgPanes: {}, slurmPanes: {}, gitPanes: {}, transfer: {} },
  recentFolders: [],
  transferFavs: { local: [], remote: [], storage: [] }  // favourite folders of the Transfer view, per host
};

function file(name) { return path.join(app.getPath('userData'), name); }

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = deepMerge(base[k], over[k]);
  return out;
}

function forumSettings(value) {
  const forum = deepMerge(DEFAULTS.forum, value);
  for (const [key, lo, hi] of [['defaultBudget', 0, 20], ['summaryTokens', 1000, 50000], ['recentMessages', 2, 30], ['checkTimeoutMs', 1000, 120000]]) {
    const n = Number(forum[key]);
    forum[key] = Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : DEFAULTS.forum[key];
  }
  if (!['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(forum.checkEffort)) forum.checkEffort = 'low';
  for (const key of ['checkModel', 'codexCheckModel'])
    if (typeof forum[key] !== 'string' || forum[key].length > 100) forum[key] = DEFAULTS.forum[key];
  return forum;
}

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(file('config.json'), 'utf8'));
    // An empty model saved before Sonnet became the default was never a choice.
    if (saved.chat && saved.chat.model === '' && !saved.chat.modelPicked) delete saved.chat.model;
    const cfg = deepMerge(DEFAULTS, saved);
    cfg.forum = forumSettings(cfg.forum);
    return cfg;
  }
  catch { return JSON.parse(JSON.stringify(DEFAULTS)); }
}

function save(cfg) {
  cfg.forum = forumSettings(cfg.forum);
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(file('config.json'), JSON.stringify(cfg, null, 2));
  return cfg;
}

function readSecrets() {
  let buf;
  try {
    buf = fs.readFileSync(file('secrets.bin'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8'));
}

function setSecret(key, value) {
  const s = readSecrets();
  if (value) s[key] = value; else delete s[key];
  const json = JSON.stringify(s);
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json);
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(file('secrets.bin'), data, { mode: 0o600 });
}

function getSecret(key) { try { return readSecrets()[key] || ''; } catch { return ''; } }
function hasSecret(key) { return !!getSecret(key); }
function secretsEncrypted() { return safeStorage.isEncryptionAvailable(); }

module.exports = { load, save, getSecret, setSecret, hasSecret, secretsEncrypted, DEFAULTS };
