// Everything HPC-side goes through the system `ssh`, so ~/.ssh/config, keys,
// ProxyJump and VPN routing behave exactly as in iTerm2. One master connection
// is opened in the background (login.js answers its prompts through dialogs) and
// all other commands and terminals reuse it via ControlMaster.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { run, q } = require('./util');

const CONTROL_DIR = path.join(os.homedir(), '.ssh', 'codeome-cm');
try { fs.mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 }); } catch {}
const CONTROL_PATH = path.join(CONTROL_DIR, '%C');

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

async function check(host) {
  if (!host) return { connected: false, reason: 'No HPC host configured' };
  const r = await run('ssh', ['-o', `ControlPath=${CONTROL_PATH}`, '-O', 'check', host], { timeout: 5000 });
  return { connected: r.code === 0, reason: r.code === 0 ? '' : (r.stderr.trim() || 'Not connected') };
}

async function disconnect(host) {
  return run('ssh', ['-o', `ControlPath=${CONTROL_PATH}`, '-O', 'exit', host], { timeout: 5000 });
}

// Run a remote command non-interactively over the master connection.
async function exec(host, cmd, opts = {}) {
  if (!host) return { code: -1, stdout: '', stderr: 'No HPC host configured' };
  return run('ssh', [...muxOpts(host), '-o', 'BatchMode=yes', host, cmd], { timeout: opts.timeout || 60000, input: opts.input });
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

module.exports = { CONTROL_PATH, setProxy, passwordFiller, proxyOpts, testLogin, copyKeyArgs, masterArgs, shellArgs, check, disconnect, exec, list, parseListing, readFile, writeFile, rsyncSshCommand };
