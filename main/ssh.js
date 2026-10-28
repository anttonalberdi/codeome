// Everything HPC-side goes through the system `ssh`, so ~/.ssh/config, keys,
// ProxyJump and VPN routing behave exactly as in iTerm2. One master connection
// is opened in the background (login.js answers its prompts through dialogs) and
// all other commands and terminals reuse it via ControlMaster.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { run, q } = require('./util');

const CONTROL_DIR = path.join(os.homedir(), '.ssh', 'codeome-cm');
try { fs.mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 }); } catch {}
const CONTROL_PATH = path.join(CONTROL_DIR, '%C');

function validHost(value) {
  const host = String(value || '').trim();
  return host.length <= 255 && host[0] !== '-' && /^[A-Za-z0-9._@-]+$/.test(host) ? host : '';
}

// Codeome's VPN tunnel: a ProxyCommand used for one host only (see setup.js).
let proxy = { host: '', cmd: '' };
function setProxy(host, cmd) { proxy = { host: host || '', cmd: cmd || '' }; }
function proxyOpts(host) { return proxy.cmd && host === proxy.host ? ['-o', 'ProxyCommand=' + proxy.cmd] : []; }

function muxOpts(host) {
  return ['-o', `ControlPath=${CONTROL_PATH}`, '-o', 'ControlMaster=no', ...proxyOpts(host)];
}

// Arguments for the login that creates the shared master (see login.js).
function masterArgs(host) {
  return ['-o', `ControlPath=${CONTROL_PATH}`, '-o', 'ControlMaster=yes', '-o', 'ControlPersist=12h', '-o', 'ConnectTimeout=20',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4', ...proxyOpts(host), '-fN', host];
}

// Arguments for an interactive shell that rides on the master if present.
function shellArgs(host, remoteCmd) {
  const a = ['-o', `ControlPath=${CONTROL_PATH}`, '-o', 'ControlMaster=auto', '-o', 'ControlPersist=12h', ...proxyOpts(host), '-t', host];
  if (remoteCmd) a.push(remoteCmd);
  return a;
}

// An interactive bash for HPC terminals: the usual login files, then colour for what they leave plain
// (ls and grep colours, LS_COLORS, a prompt without escapes). Anything the user set up themselves wins.
const COLOR_RC = String.raw`{
[ -f /etc/profile ] && . /etc/profile
_f=; for _p in ~/.bash_profile ~/.bash_login ~/.profile; do [ -f "$_p" ] && { _f=$_p; break; }; done
if [ -n "$_f" ]; then . "$_f"; elif [ -f ~/.bashrc ]; then . ~/.bashrc; fi
unset _f _p
} 2>/dev/null
[ -n "$CODEOME_CWD" ] && cd "$CODEOME_CWD" 2>/dev/null; unset CODEOME_CWD
[ -z "$LS_COLORS" ] && eval "$(dircolors -b 2>/dev/null)"
alias ls >/dev/null 2>&1 || alias ls='ls --color=auto'
alias grep >/dev/null 2>&1 || alias grep='grep --color=auto'
case "$PS1" in *'\e['*|*'\033['*|*'\[\e'*) ;; *) PS1='\[\e[1;32m\]\u@\h\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]\$ ' ;; esac
`;
// `dir` is a shell-quoted path to start in, applied after the login files (which may cd elsewhere).
const colorShell = (dir) => `${dir ? 'export CODEOME_CWD=' + dir + '; ' : ''}export COLORTERM=truecolor CLICOLOR=1; exec bash --rcfile <(echo ${Buffer.from(COLOR_RC).toString('base64')} | base64 -d) -i`;

async function check(host) {
  if (!host) return { connected: false, reason: 'No HPC host configured' };
  const r = await run('ssh', ['-o', `ControlPath=${CONTROL_PATH}`, '-O', 'check', host], { timeout: 5000 });
  return { connected: r.code === 0, reason: r.code === 0 ? '' : (r.stderr.trim() || 'Not connected') };
}

// A master that died without cleaning up leaves its socket file behind, and the
// next login then logs in but silently skips multiplexing ("ControlSocket ...
// already exists, disabling multiplexing"). Remove every socket nobody answers on.
function clearStaleSockets() {
  let names = [];
  try { names = fs.readdirSync(CONTROL_DIR); } catch { return []; }
  const removed = [];
  for (const n of names) {
    const sock = path.join(CONTROL_DIR, n);
    try { if (!fs.statSync(sock).isSocket()) continue; } catch { continue; }
    const r = spawnSync('ssh', ['-o', `ControlPath=${sock}`, '-O', 'check', 'codeome-stale-check'], { timeout: 5000, encoding: 'utf8' });
    if (r.status !== 0 && /refused|No such file/i.test(r.stderr || '')) {
      try { fs.unlinkSync(sock); removed.push(n); } catch {}
    }
  }
  return removed;
}

async function disconnect(host) {
  return run('ssh', ['-o', `ControlPath=${CONTROL_PATH}`, '-O', 'exit', host], { timeout: 5000 });
}

// Arguments for a non-interactive remote command over the master connection.
const execArgs = (host, cmd, extra = []) => [...muxOpts(host), '-o', 'BatchMode=yes', ...extra, host, cmd];

// Run a remote command non-interactively over the master connection.
async function exec(host, cmd, opts = {}) {
  if (!host) return { code: -1, stdout: '', stderr: 'No HPC host configured' };
  return run('ssh', execArgs(host, cmd), { timeout: opts.timeout || 60000, input: opts.input });
}

// List a remote directory. Uses GNU find (standard on Linux clusters).
async function list(host, dir) {
  const cmd = `cd ${dir === '~' ? '~' : q(dir)} 2>/dev/null && pwd && find . -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n' 2>/dev/null`;
  const r = await exec(host, cmd);
  if (r.code !== 0) return { error: r.stderr.trim() || `Cannot open ${dir}` };
  return parseListing(r.stdout);
}

function parseListing(stdout) {
  const lines = stdout.split('\n');
  const cwd = (lines.shift() || '').trim();
  const entries = [];
  for (const l of lines) {
    if (!l) continue;
    const [type, size, mtime, ...rest] = l.split('\t');
    const name = rest.join('\t');
    entries.push({ name, dir: type === 'd', link: type === 'l', size: Number(size), mtime: Math.round(Number(mtime) * 1000) });
  }
  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  return { cwd, entries };
}

async function readFile(host, p) {
  const r = await exec(host, `cat ${q(p)}`, { timeout: 120000 });
  if (r.code !== 0) return { error: r.stderr.trim() };
  return { content: r.stdout };
}

async function writeFile(host, p, content) {
  const r = await exec(host, `cat > ${q(p)}`, { input: content, timeout: 120000 });
  return r.code === 0 ? { ok: true } : { error: r.stderr.trim() };
}

// rsync/scp transport command that reuses the master connection.
function rsyncSshCommand() {
  return `ssh -o ControlPath=${CONTROL_PATH} -o ControlMaster=no`;
}

// A fresh, non-interactive login (no shared connection) to test that the key works.
function testLogin(host) {
  return run('ssh', ['-o', 'ControlPath=none', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', ...proxyOpts(host), host, 'true'], { timeout: 30000 });
}

// Adds a public key to the HPC's authorized_keys (once); runs in a terminal so a password prompt works.
function copyKeyArgs(host, pub) {
  const k = q(pub.trim());
  const remote = `umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && { grep -qxF ${k} ~/.ssh/authorized_keys || echo ${k} >> ~/.ssh/authorized_keys; } && echo 'Your key is on the HPC.'`;
  return ['-o', `ControlPath=${CONTROL_PATH}`, '-o', 'ControlMaster=no', ...proxyOpts(host), host, remote];
}

// Types the saved HPC password at ssh's first password prompt ("user@host's password:"
// or "(user@host) Password:"), once: a wrong one is not sent again (the terminal asks),
// and later prompts such as a one-time code are left to the person.
function passwordFiller(password, write) {
  let tail = '', done = !password;
  return (data) => {
    if (done) return;
    tail = (tail + data).slice(-300);
    if (/(?:^|[\r\n])[^\r\n]*password:\s*$/i.test(tail)) { done = true; write(password + '\r'); }
  };
}

module.exports = { colorShell, CONTROL_PATH, validHost, setProxy, passwordFiller, proxyOpts, testLogin, copyKeyArgs, masterArgs, shellArgs, check, clearStaleSockets, disconnect, exec, execArgs, list, parseListing, readFile, writeFile, rsyncSshCommand };
