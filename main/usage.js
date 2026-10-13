// Claude and Codex usage limits, per account. Plain Node (no Electron) so it is testable.
//
// An account is an email address, confirmed by signing in. Each keeps its sign-in in
// its own config folder (CLAUDE_CONFIG_DIR for Claude Code, CODEX_HOME for Codex), so
// every signed-in account stays ready and switching never asks again. Codeome picks
// the folder; an empty dir means the CLI's default (~/.claude, ~/.codex).
//   Codex  — `codex app-server` answers account/rateLimits/read live; no tokens touched.
//   Claude — a headless `claude -p` answers the get_usage control request live; no
//            message is sent and no tokens touched. Between two checks, sessions Codeome
//            starts also record what Claude Code hands their status line
//            (codeome-statusline). Both land in ~/.codeome/usage/claude-<account>.json.
// Codeome writes the combined picture to ~/.codeome/usage.json; codeome-agent reads it
// to choose an account for each job and to hold jobs back near a limit.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { augmentedEnv, expandHome, q, run } = require('./util');

const ENV_VAR = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };
const DEFAULT_DIR = { claude: '~/.claude', codex: '~/.codex' };
const STALE_S = 30 * 60; // older readings say nothing about the limit any more

const home = () => process.env.CODEOME_HOME || path.join(os.homedir(), '.codeome');
const nowS = () => Date.now() / 1000;

// The CLI's own default folder is stored as '' so we never set the variable for it:
// Claude Code keys its Keychain entry on CLAUDE_CONFIG_DIR being set at all.
function normDir(engine, dir) {
  const d = String(dir || '').trim().replace(/\/+$/, '');
  if (!d) return '';
  return path.resolve(expandHome(d)) === path.resolve(expandHome(DEFAULT_DIR[engine])) ? '' : d;
}

// An account is named by the email address it signs in with.
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const isEmail = (s) => EMAIL.test(String(s || ''));
// The folder a new account gets: ~/.claude-you-example-org.
const folderFor = (engine, email) => `~/.${engine}-${String(email).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;

// What a sign-in check says about an account. signedIn: true / false, or null while
// nothing is known. A sign-in with another address than the account's does not count:
// the account is not used until it is signed in as itself.
function signInState(name, signedIn, email) {
  const mismatch = !!(signedIn && isEmail(name) && email && String(email).toLowerCase() !== name.toLowerCase());
  return { signedIn, mismatch, signedOut: signedIn === false || mismatch };
}

// Config folders in the home folder that are not accounts yet (~/.claude-lab, ~/.codex-work).
// A config folder holds one of these once its CLI has run there.
const FOLDER_MARK = { claude: ['.claude.json', '.credentials.json', 'settings.json'], codex: ['auth.json', 'config.toml'] };
function findFolders(engine, known = [], homeDir = os.homedir()) {
  const have = new Set(known.filter(Boolean).map((d) => accountKey(d)));
  let names = []; try { names = fs.readdirSync(homeDir); } catch {}
  return names.filter((n) => n.startsWith(`.${engine}-`) && FOLDER_MARK[engine].some((m) => fs.existsSync(path.join(homeDir, n, m))))
    .map((n) => path.join(homeDir, n)).filter((d) => !have.has(accountKey(d)))
    .map((d) => (homeDir === os.homedir() ? '~' + d.slice(homeDir.length) : d));
}

// Same rule as codeome-statusline's account_key().
function accountKey(dir) {
  if (!dir) return 'default';
  const abs = expandHome(dir);
  let real; try { real = fs.realpathSync(abs); } catch { real = path.resolve(abs); }
  return real.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// ---------- parsing ----------
// Codex reports up to two windows (primary/secondary); which is which varies by plan,
// so they are told apart by length.
function codexWindows(rl) {
  const out = {};
  for (const w of [rl && rl.primary, rl && rl.secondary]) {
    if (!w || w.usedPercent == null) continue;
    const mins = Number(w.windowDurationMins) || 0;
    out[mins && mins <= 24 * 60 ? 'fiveHour' : 'weekly'] = { pct: Number(w.usedPercent), resetsAt: w.resetsAt || null, minutes: mins || null };
  }
  return out;
}

function claudeWindows(rl) {
  const out = {};
  const pick = (w) => (w && w.used_percentage != null ? { pct: Number(w.used_percentage), resetsAt: w.resets_at || null } : null);
  if (pick(rl && rl.five_hour)) out.fiveHour = pick(rl.five_hour);
  if (pick(rl && rl.seven_day)) out.weekly = pick(rl.seven_day);
  return out;
}

// get_usage's rate_limits → the status line's rate_limits shape, which readClaude() reads.
function claudeUsageLimits(rl) {
  const one = (w) => {
    if (!w || w.utilization == null) return null;
    const t = w.resets_at ? Date.parse(w.resets_at) / 1000 : null;
    return { used_percentage: Number(w.utilization), resets_at: Number.isFinite(t) ? t : null };
  };
  const out = {};
  if (one(rl && rl.five_hour)) out.five_hour = one(rl.five_hour);
  if (one(rl && rl.seven_day)) out.seven_day = one(rl.seven_day);
  return Object.keys(out).length ? out : null;
}

// A window that has reset since the reading is back at zero.
function windowPct(w, now = nowS()) {
  if (!w || w.pct == null) return null;
  return w.resetsAt && w.resetsAt <= now ? 0 : w.pct;
}

// Highest use across the windows, or null when nothing recent is known.
function level(acct, now = nowS()) {
  if (!acct || !acct.asOf || now - acct.asOf > STALE_S) return null;
  if (acct.reached) return 100;
  const ps = [windowPct(acct.windows && acct.windows.fiveHour, now), windowPct(acct.windows && acct.windows.weekly, now)].filter((p) => p != null);
  return ps.length ? Math.max(...ps) : null;
}

// The account new work should use: the preferred one while it has headroom, otherwise
// the known account with the most headroom, otherwise one we know nothing about.
// Accounts that are not signed in are never moved to.
function pick(accounts, preferred, stopAt, now = nowS()) {
  if (!accounts.length) return { account: null };
  const pref = accounts.find((a) => a.name === preferred) || accounts[0];
  const lv = (a) => level(a, now);
  if (!pref.signedOut && (lv(pref) == null || lv(pref) < stopAt)) return { account: pref };
  const others = accounts.filter((a) => a !== pref && !a.signedOut);
  const open = others.filter((a) => lv(a) != null && lv(a) < stopAt).sort((a, b) => lv(a) - lv(b));
  if (open.length) return { account: open[0], switched: true, from: pref };
  const unknown = others.find((a) => lv(a) == null);
  if (unknown) return { account: unknown, switched: true, from: pref };
  // Nothing else to use: a signed-out account with headroom still starts, and the CLI asks to sign in.
  if (lv(pref) == null || lv(pref) < stopAt) return { account: pref };
  return { account: null, blocked: true, from: pref };
}

// ---------- reading ----------
function readClaude(dir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(home(), 'usage', `claude-${accountKey(dir)}.json`), 'utf8'));
    return { windows: claudeWindows(s.rate_limits), asOf: s.at || null };
  } catch { return { windows: {}, asOf: null }; }
}

// One short-lived `codex app-server` per account: initialize, then ask.
function queryCodex(dir, codexCmd = 'codex', timeoutMs = 20000) {
  return new Promise((resolve) => {
    const env = augmentedEnv();
    if (dir) env.CODEX_HOME = expandHome(dir); else delete env.CODEX_HOME;
    let child;
    try { child = spawn(codexCmd, ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] }); } catch (e) { return resolve({ error: String(e.message || e) }); }
    const out = {};
    let buf = '', done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch {} resolve(r); };
    const timer = setTimeout(() => finish(out.limits ? out : { ...out, error: 'Codex did not answer in time' }), timeoutMs);
    child.on('error', (e) => finish({ error: String(e.message || e) }));
    child.on('close', () => finish(out.limits ? out : { ...out, error: out.error || 'Codex exited before answering' }));
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 2) {
          if (m.error) out.error = m.error.message || 'Codex could not read rate limits (signed in?)';
          else {
            const r = m.result || {};
            const rl = (r.rateLimitsByLimitId && r.rateLimitsByLimitId.codex) || r.rateLimits || {};
            out.limits = { windows: codexWindows(rl), reached: !!rl.rateLimitReachedType || r.ordinaryUsageAllowed === false, plan: rl.planType || null };
          }
        }
        if (m.id === 3) { const a = m.result && m.result.account; out.account = a ? { email: a.email || null, plan: a.planType || null } : null; }
        if (out.account !== undefined && (out.limits || out.error)) finish(out);
      }
    });
    // A Codex that cannot start (e.g. a broken install) closes the pipe: EPIPE is reported as an
    // event, not thrown, so it needs a listener or it takes the whole app down.
    child.stdin.on('error', () => {});
    const send = (o) => { try { child.stdin.write(JSON.stringify(o) + '\n'); } catch {} };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codeome', version: '0.1.0' } } });
    send({ jsonrpc: '2.0', method: 'initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read' });
    send({ jsonrpc: '2.0', id: 3, method: 'account/read', params: {} });
  });
}

// One short-lived headless `claude -p` per account, asked for its usage and closed before
// any message is sent. Your settings, hooks and MCP servers are left out of it.
function queryClaude(dir, claudeCmd = 'claude', timeoutMs = 20000) {
  return new Promise((resolve) => {
    const env = augmentedEnv();
    if (dir) env.CLAUDE_CONFIG_DIR = expandHome(dir); else delete env.CLAUDE_CONFIG_DIR;
    let child;
    try {
      fs.mkdirSync(home(), { recursive: true });
      child = spawn(claudeCmd, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config'],
        { env, cwd: home(), stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (e) { return resolve({ error: String(e.message || e) }); }
    let buf = '', done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch {} resolve(r); };
    const timer = setTimeout(() => finish({ error: 'Claude Code did not answer in time' }), timeoutMs);
    child.on('error', (e) => finish({ error: String(e.message || e) }));
    child.on('close', () => finish({ error: 'Claude Code exited before answering' }));
    child.stdin.on('error', () => {});
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        const r = m.type === 'control_response' && m.response;
        if (!r || r.request_id !== 'usage') continue;
        if (r.subtype === 'error') return finish({ error: r.error || 'Claude Code could not read usage' });
        const u = r.response || {};
        const rateLimits = claudeUsageLimits(u.rate_limits);
        finish(rateLimits ? { rateLimits, plan: u.subscription_type || null } : { error: 'Claude Code has no usage for this account (signed in?)' });
      }
    });
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage' } }) + '\n');
  });
}

// Who is signed in to a Claude config folder (email, plan). Never reads credentials.
async function claudeIdentity(dir, claudeCmd = 'claude') {
  const env = {};
  if (dir) env.CLAUDE_CONFIG_DIR = expandHome(dir);
  const r = await run('/bin/sh', ['-c', `${dir ? '' : 'unset CLAUDE_CONFIG_DIR; '}${claudeCmd} auth status --json`], { env, timeout: 15000 });
  try { const s = JSON.parse(r.stdout); return s.loggedIn ? { email: s.email || null, plan: s.subscriptionType || null } : { email: null, plan: null, signedOut: true }; } catch { return null; }
}

// ---------- launching ----------
// Env and command for a session on a given account. Claude sessions also get the
// status line that records usage (passed with --settings, so your files are untouched).
function launch(engine, dir, command, settingsFile) {
  const env = {};
  const unset = [];
  if (dir) env[ENV_VAR[engine]] = expandHome(dir); else unset.push(ENV_VAR[engine]);
  let cmd = command;
  if (engine === 'claude' && settingsFile) cmd = command.replace(/^(\S+)/, `$1 --settings ${q(settingsFile)}`);
  return { env, unset, command: cmd };
}

// Install the status line script and the settings file that points to it.
function installStatusline(scriptSource, noCoAuthor = true) {
  const bin = path.join(home(), 'bin', 'codeome-statusline');
  const settings = path.join(home(), 'claude-settings.json');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const src = fs.readFileSync(scriptSource, 'utf8');
  let cur = null; try { cur = fs.readFileSync(bin, 'utf8'); } catch {}
  if (cur !== src) { fs.writeFileSync(bin, src); fs.chmodSync(bin, 0o755); }
  writeSettings({ bin, settings }, noCoAuthor);
  return { bin, settings };
}

// The settings file passed to Claude with --settings: the status line and, when asked, no
// Claude co-author trailer on commits and no "Generated with Claude Code" line on pull requests.
function writeSettings({ bin, settings }, noCoAuthor) {
  const o = { statusLine: { type: 'command', command: `python3 ${q(bin)}`, padding: 0 } };
  if (noCoAuthor) { o.attribution = { commit: '', pr: '' }; o.includeCoAuthoredBy = false; }
  const want = JSON.stringify(o, null, 2) + '\n';
  let cur = null; try { cur = fs.readFileSync(settings, 'utf8'); } catch {}
  if (cur !== want) fs.writeFileSync(settings, want);
}

// The shared picture codeome-agent reads.
function writeSnapshot(snap) {
  const p = path.join(home(), 'usage.json');
  fs.mkdirSync(home(), { recursive: true });
  fs.writeFileSync(p + '.tmp', JSON.stringify(snap, null, 2) + '\n');
  fs.renameSync(p + '.tmp', p);
  return p;
}

// The models Codex offers this account (its models_cache.json) and its configured default.
function codexModels(dir) {
  const base = expandHome(dir || DEFAULT_DIR.codex);
  let def = null, models = [];
  try { const m = fs.readFileSync(path.join(base, 'config.toml'), 'utf8').match(/^model\s*=\s*"([^"]+)"/m); if (m) def = m[1]; } catch {}
  try {
    const c = JSON.parse(fs.readFileSync(path.join(base, 'models_cache.json'), 'utf8'));
    models = (Array.isArray(c.models) ? c.models : []).filter((m) => m && m.slug && m.visibility !== 'hide').map((m) => ({ id: m.slug, label: m.display_name || m.slug }));
  } catch {}
  return { default: def, models };
}

module.exports = { codexModels, isEmail, folderFor, signInState, findFolders, ENV_VAR, DEFAULT_DIR, STALE_S, home, normDir, accountKey, codexWindows, claudeWindows, claudeUsageLimits, windowPct, level, pick, readClaude, queryCodex, queryClaude, claudeIdentity, launch, installStatusline, writeSettings, writeSnapshot };
