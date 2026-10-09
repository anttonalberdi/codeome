// Everything HPC-side goes through the system `ssh`, so ~/.ssh/config, keys,
// ProxyJump and VPN routing behave exactly as in iTerm2. One master connection
// is opened interactively (password/OTP prompts work in a terminal tab) and all
// background commands reuse it via ControlMaster.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { run, q } = require('./util');

const CONTROL_DIR = path.join(os.homedir(), '.ssh', 'codeome-cm');
try { fs.mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 }); } catch {}
const CONTROL_PATH = path.join(CONTROL_DIR, '%C');

function muxOpts() {
  return ['-o', `ControlPath=${CONTROL_PATH}`, '-o', 'ControlMaster=no'];
}

// Arguments for the interactive login that creates the shared master.
function masterArgs(host) {
  return ['-o', `ControlPath=${CONTROL_PATH}`, '-o', 'ControlMaster=yes', '-o', 'ControlPersist=12h',
    '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4', '-fN', host];
}

// Arguments for an interactive shell that rides on the master if present.
function shellArgs(host, remoteCmd) {
  const a = ['-o', `ControlPath=${CONTROL_PATH}`, '-o', 'ControlMaster=auto', '-o', 'ControlPersist=12h', '-t', host];
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
  return run('ssh', [...muxOpts(), '-o', 'BatchMode=yes', host, cmd], { timeout: opts.timeout || 60000, input: opts.input });
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

module.exports = { CONTROL_PATH, masterArgs, shellArgs, check, disconnect, exec, list, parseListing, readFile, writeFile, rsyncSshCommand };
