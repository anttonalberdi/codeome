// Is a newer Claude Code or Codex out? The latest versions are looked up at most once a
// week (or when asked); what was found, and what was already suggested, is kept in a small
// file so a restart neither asks again nor repeats the suggestion.
const fs = require('fs');

const WEEK = 7 * 24 * 3600 * 1000;
const LABEL = { claude: 'Claude Code', codex: 'Codex', codeome: 'Codeome' };
const REPO = 'anttonalberdi/codeome';
const RELEASES = `https://github.com/${REPO}/releases/latest`;
const INSTALL = {
  claude: 'curl -fsSL https://claude.ai/install.sh | bash',
  codex: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'
};
const NPM = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' };
const CASK = { claude: 'claude-code', codex: 'codex' };

const semver = (s) => { const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s || '')); return m ? m.slice(1).map(Number) : null; };
// > 0 when a is newer than b; 0 when either is not a version.
function compare(a, b) {
  const x = semver(a), y = semver(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// How this copy was installed decides how it is updated: from its resolved path.
function installedVia(binPath) {
  let p = binPath || '';
  try { p = fs.realpathSync(p); } catch {}
  if (/\/(Caskroom|Cellar)\//.test(p)) return 'brew';
  if (/\/node_modules\//.test(p)) return 'npm';
  return 'script';
}

function updateCommand(engine, via) {
  if (via === 'brew') return `brew upgrade --cask ${CASK[engine]}`;
  if (via === 'npm') return `npm install -g ${NPM[engine]}@latest`;
  return INSTALL[engine];
}

// null when the address does not exist (a repository with no release yet).
async function json(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Codeome' }, signal: AbortSignal.timeout(15000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}
const LATEST = {
  claude: async () => ((await json('https://registry.npmjs.org/@anthropic-ai/claude-code/latest')) || {}).version,
  codex: async () => ((await json('https://api.github.com/repos/openai/codex/releases/latest')) || {}).tag_name,
  codeome: async () => ((await json(`https://api.github.com/repos/${REPO}/releases/latest`)) || {}).tag_name
};
async function fetchLatest(engine) {
  const v = semver(await LATEST[engine]());
  // A release that is not there (yet) is not a failed lookup.
  return v ? v.join('.') : null;
}

function load(file) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return { checkedAt: 0, latest: {}, suggested: {}, ...s }; } catch { return { checkedAt: 0, latest: {}, suggested: {} }; }
}

// o: file; engines: { claude: { path, version } } for the installed ones; now; force; suggest;
// fetchLatest (replaceable in tests).
// Returns { updates: [{ engine, label, installed, latest, command }], checkedAt, error }.
// With suggest, only updates not yet suggested this week (or newer than the last suggested).
async function check(o) {
  const now = o.now || Date.now();
  const st = load(o.file);
  const get = o.fetchLatest || fetchLatest;
  let error = '';
  if (o.force || now - st.checkedAt >= WEEK) {
    const engines = Object.keys(o.engines);
    const res = await Promise.all(engines.map((e) => get(e).then((v) => [e, v], (err) => { error = String(err.message || err); return [e, null]; })));
    for (const [e, v] of res) if (v) st.latest[e] = v;
    // Only a lookup that worked counts as having checked.
    if (!error) st.checkedAt = now;
  }
  const updates = [];
  for (const [engine, info] of Object.entries(o.engines)) {
    const latest = st.latest[engine];
    if (!latest || !info.version || compare(latest, info.version) <= 0) continue;
    const s = st.suggested[engine];
    if (o.suggest && s && s.version === latest && now - s.at < WEEK) continue;
    // Codeome is not installed by a command: its release page is opened instead.
    updates.push(engine === 'codeome'
      ? { engine, label: LABEL[engine], installed: info.version, latest, url: RELEASES }
      : { engine, label: LABEL[engine], installed: info.version, latest, command: updateCommand(engine, installedVia(info.path)) });
    if (o.suggest) st.suggested[engine] = { version: latest, at: now };
  }
  try { fs.writeFileSync(o.file, JSON.stringify(st)); } catch {}
  return { updates, checkedAt: st.checkedAt, error };
}

module.exports = { WEEK, LABEL, INSTALL, REPO, fetchLatest, semver, compare, installedVia, updateCommand, check };
