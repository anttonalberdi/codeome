// HPC setup: Codeome's own VPN tunnel, the ssh key, and the tools they need.
// The tunnel is OpenConnect (the Cisco AnyConnect protocol) handing its traffic to
// ocproxy, which serves it as a SOCKS5 proxy on 127.0.0.1. It changes none of the
// Mac's routes or DNS and needs no admin rights; only ssh connections to the HPC
// host go through it (see ssh.setProxy).
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, q, expandHome } = require('./util');

const DEFAULT_PORT = 11080;

function portOf(v) {
  const p = Number(v && v.port);
  return Number.isInteger(p) && p > 1023 && p < 65536 ? p : DEFAULT_PORT;
}

// Extra command-line options, split on spaces as a shell would; quotes keep a value
// together, also inside a word (--authgroup="Staff").
function splitArgs(s) {
  const out = [];
  for (const word of String(s || '').match(/(?:"[^"]*"|'[^']*'|[^\s"']+)+/g) || []) {
    out.push(word.replace(/"([^"]*)"|'([^']*)'/g, (_, d, q1) => d ?? q1));
  }
  return out;
}

// The openconnect command line. It asks for the password and second factor itself.
function tunnelArgs(v, ocproxy = 'ocproxy') {
  if (!v || !v.server) throw new Error('Set the VPN server in Settings → HPC.');
  return ['--protocol=anyconnect', ...(v.user ? ['--user=' + v.user] : []),
    '--script-tun', '--script', `${q(ocproxy)} -D ${portOf(v)} -k 30`, ...splitArgs(v.args), v.server];
}
const tunnelCommand = (v) => 'exec ' + ['openconnect', ...tunnelArgs(v)].map(q).join(' ');

// ssh's ProxyCommand for the HPC host: through the tunnel while it runs, otherwise
// direct (on campus, or with Cisco Secure Client on), so one setting works everywhere.
function proxyCommand(port) {
  return `/bin/sh -c 'if nc -z -G 2 127.0.0.1 ${port} 2>/dev/null; then exec nc -X 5 -x 127.0.0.1:${port} "$0" "$1"; else exec nc "$0" "$1"; fi' %h %p`;
}

function portOpen(port, timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

// ---------- tools ----------
// Where a command lives: on Codeome's PATH (which adds Homebrew's), else the login shell's.
async function locate(tool, shell) {
  const r = await run('/usr/bin/which', [tool], { timeout: 5000 });
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  const l = await run(shell, ['-l', '-c', `command -v ${q(tool)}`], { timeout: 8000 });
  return l.code === 0 ? l.stdout.trim().split('\n').pop() : '';
}

// How to install what Codeome looks for. Most come from Homebrew; git comes with Apple's command-line tools.
const RECIPES = {
  openconnect: { formula: 'openconnect', label: 'OpenConnect', why: "Codeome's VPN tunnel" },
  ocproxy: { formula: 'ocproxy', label: 'ocproxy', why: "Codeome's VPN tunnel" },
  rsync: { formula: 'rsync', label: 'rsync', why: 'Copies to and from the HPC' },
  tmux: { formula: 'tmux', label: 'tmux', why: 'Terminal sessions' },
  gh: { formula: 'gh', label: 'GitHub CLI', why: 'GitHub' },
  python3: { formula: 'python', label: 'Python', why: 'Python on this Mac' },
  quarto: { cask: 'quarto', label: 'Quarto', why: 'Rendering reports' },
  R: { cask: 'r', label: 'R', why: 'The R console' },
  Rscript: { cask: 'r', label: 'R', why: 'Rendering R Markdown' },
  git: { command: 'xcode-select --install', label: 'Git', why: 'Version control' },
  ssh: { command: 'xcode-select --install', label: 'OpenSSH', why: 'Every HPC connection' }
};
const BREW_INSTALL = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

// One command that installs the given tools; null when none has a recipe.
function installCommand(tools) {
  const known = [...new Set(tools)].filter((t) => RECIPES[t]);
  if (!known.length) return null;
  const formulae = [...new Set(known.map((t) => RECIPES[t].formula).filter(Boolean))];
  const casks = [...new Set(known.map((t) => RECIPES[t].cask).filter(Boolean))];
  const other = [...new Set(known.map((t) => RECIPES[t].command).filter(Boolean))];
  const parts = [];
  if (formulae.length) parts.push('brew install ' + formulae.join(' '));
  if (casks.length) parts.push('brew install --cask ' + casks.join(' '));
  parts.push(...other);
  return { command: parts.join(' && '), brew: formulae.length + casks.length > 0, labels: [...new Set(known.map((t) => RECIPES[t].label))] };
}

// ---------- ssh login ----------
// The settings ssh would use for a host, from `ssh -G`.
function parseSshG(text) {
  const o = { identityFiles: [] };
  for (const line of String(text).split('\n')) {
    const i = line.indexOf(' ');
    if (i < 0) continue;
    const k = line.slice(0, i), v = line.slice(i + 1).trim();
    if (k === 'user') o.user = v;
    else if (k === 'hostname') o.hostname = v;
    else if (k === 'port') o.port = Number(v);
    else if (k === 'identityfile') o.identityFiles.push(v);
    else if (k === 'proxyjump' && v !== 'none') o.proxyJump = v;
    else if (k === 'proxycommand' && v !== 'none') o.proxyCommand = v;
  }
  return o;
}

async function resolveHost(host) {
  const r = await run('ssh', ['-G', host], { timeout: 5000 });
  return r.code === 0 ? parseSshG(r.stdout) : { error: r.stderr.trim() || 'ssh could not read the settings for ' + host };
}

// The first key ssh would offer that exists here, or where to make one.
function findKey(identityFiles) {
  const files = identityFiles && identityFiles.length ? identityFiles : ['~/.ssh/id_ed25519'];
  for (const f of files) {
    const p = expandHome(f);
    if (fs.existsSync(p) && fs.existsSync(p + '.pub')) return { exists: true, path: f };
  }
  return { exists: false, path: files.find((f) => /id_ed25519$/.test(f)) || files[0] };
}

// Why a non-interactive login failed, in terms of what to do next.
function classifyLogin(code, stderr) {
  if (code === 0) return 'ok';
  const e = String(stderr);
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(e)) return 'hostkey';
  if (/Permission denied|Too many authentication failures/i.test(e)) return 'auth';
  if (/Could not resolve|nodename nor servname|timed out|No route to host|Connection refused|Network is unreachable|closed by UNKNOWN|kex_exchange_identification/i.test(e)) return 'network';
  return 'other';
}

// Cisco Secure Client's server list, offered as suggestions for the VPN server.
function ciscoServers() {
  const dirs = ['/opt/cisco/secureclient/vpn/profile', '/opt/cisco/anyconnect/profile'];
  const out = new Set();
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d).filter((n) => n.endsWith('.xml')); } catch { continue; }
    for (const n of names) {
      try { for (const m of fs.readFileSync(path.join(d, n), 'utf8').matchAll(/<HostAddress>\s*([^<\s]+)\s*<\/HostAddress>/g)) out.add(m[1]); } catch {}
    }
  }
  return [...out];
}

// Everything the HPC checklist in Settings shows.
async function status(cfg, shell) {
  const v = cfg.hpc.vpn || {};
  const tunnel = v.mode === 'tunnel';
  const [brew, openconnect, ocproxy, up, login] = await Promise.all([
    locate('brew', shell), locate('openconnect', shell), locate('ocproxy', shell),
    tunnel ? portOpen(portOf(v)) : false,
    cfg.hpc.host ? resolveHost(cfg.hpc.host) : null
  ]);
  const key = findKey(login && login.identityFiles);
  return { brew: !!brew, tools: { openconnect: !!openconnect, ocproxy: !!ocproxy }, tunnel: { on: tunnel, up, port: portOf(v) },
    login, key, ciscoServers: ciscoServers(), home: os.homedir() };
}

module.exports = { DEFAULT_PORT, portOf, splitArgs, tunnelArgs, tunnelCommand, proxyCommand, portOpen, locate, RECIPES, BREW_INSTALL, installCommand,
  parseSshG, resolveHost, findKey, classifyLogin, ciscoServers, status };
