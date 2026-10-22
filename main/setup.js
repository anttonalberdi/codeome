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

// The openconnect command line. vpn.js answers its prompts.
function tunnelArgs(v, ocproxy = 'ocproxy') {
  if (!v || !v.server) throw new Error('Set the VPN server in Settings → HPC.');
  return ['--protocol=anyconnect', ...(v.user ? ['--user=' + v.user] : []),
    '--script-tun', '--script', `${q(ocproxy)} -D ${portOf(v)} -k 30`, ...splitArgs(v.args), v.server];
}
const tunnelCommand = (v) => 'exec ' + ['openconnect', ...tunnelArgs(v)].map(q).join(' ');

// ssh's ProxyCommand for the HPC host: through the tunnel while it runs, otherwise
// direct (on campus, or with Cisco Secure Client on), so one setting works everywhere.
// It ignores SIGHUP: the login's ssh -f leaves it in the login terminal's process group,
// and the hangup when that tab ends would otherwise take the shared connection with it.
function proxyCommand(port) {
  return `/bin/sh -c 'trap "" HUP; if nc -z -G 2 127.0.0.1 ${port} 2>/dev/null; then exec nc -X 5 -x 127.0.0.1:${port} "$0" "$1"; else exec nc "$0" "$1"; fi' %h %p`;
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

// ---------- VPN test ----------
// "host", "host:port" or "user@host:port"; a ProxyJump list gives its first hop.
function hostPort(s, port = 22) {
  const hop = String(s || '').split(',')[0].trim().replace(/^.*@/, '');
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(hop);
  return m && m[1] ? { host: m[1], port: m[2] ? Number(m[2]) : port } : null;
}

// What tells whether the HPC network is reachable: through the tunnel, the login itself;
// otherwise the check host from Settings, else the first host ssh connects to for the login
// (its ProxyJump, or the login itself).
async function vpnTarget(cfg) {
  const tunnel = (cfg.hpc.vpn || {}).mode === 'tunnel';
  if (!tunnel && cfg.hpc.vpnCheckHost) return hostPort(cfg.hpc.vpnCheckHost);
  if (!cfg.hpc.host) return null;
  const login = await resolveHost(cfg.hpc.host);
  if (login.error) return null;
  if (!tunnel && login.proxyJump) {
    // The jump host may itself be an alias in ~/.ssh/config; a port in the ProxyJump wins.
    const hop = hostPort(login.proxyJump, 0);
    const j = hop && await resolveHost(hop.host);
    return hop && { host: j && !j.error ? j.hostname : hop.host, port: hop.port || (j && j.port) || 22 };
  }
  return { host: login.hostname, port: login.port || 22 };
}

// Why a probe failed: dns (the name only resolves on the VPN), refused, unreachable or other.
// Through the tunnel nc reports the SOCKS reply code instead (4: host unreachable, 5: refused).
function classifyProbe(code, stderr) {
  if (code === 0) return 'ok';
  const e = String(stderr);
  if (/getaddrinfo|nodename nor servname|Name or service not known|SOCKS error 4/i.test(e)) return 'dns';
  if (/refused|SOCKS error 5/i.test(e)) return 'refused';
  if (/timed out|No route to host|Network is unreachable|SOCKS error [36]/i.test(e) || code === null) return 'unreachable';
  return 'other';
}

// Opens a TCP connection to host:port and closes it, through the tunnel when socksPort is given.
async function probe(host, port, socksPort = 0) {
  const via = socksPort ? ['-X', '5', '-x', '127.0.0.1:' + socksPort] : [];
  const r = await run('nc', ['-v', '-z', '-G', '5', '-w', '5', ...via, host, String(port)], { timeout: 12000 });
  return { result: classifyProbe(r.code, r.stderr), detail: r.stderr.trim().split('\n').pop() || '' };
}

// The HPC setup's VPN test: ok | dns | refused | unreachable | other | notunnel | nohost.
async function testVpn(cfg) {
  const v = cfg.hpc.vpn || {};
  const tunnel = v.mode === 'tunnel';
  const target = await vpnTarget(cfg);
  if (!target) return { result: 'nohost', tunnel };
  if (tunnel && !(await portOpen(portOf(v)))) return { result: 'notunnel', tunnel, ...target };
  return { ...(await probe(target.host, target.port, tunnel ? portOf(v) : 0)), tunnel, ...target };
}

// Whether the tunnel carries traffic yet, asked every second while it signs in. ocproxy's
// port opens a moment before the VPN's routes and DNS work, and an ssh started in that gap
// is closed at once ("Connection closed by UNKNOWN port 65535"). So the HPC login has to
// answer through it; once the port has been open for `patience` ms the tunnel counts as up
// anyway (the login may be down, or no host is set yet).
function tunnelReady(cfg, patience = 20000, d = { portOpen, vpnTarget, probe }) {
  let since = 0;
  return async () => {
    const port = portOf(cfg.hpc.vpn);
    if (!(await d.portOpen(port))) { since = 0; return false; }
    since = since || Date.now();
    const t = await d.vpnTarget(cfg);
    if (!t || (await d.probe(t.host, t.port, port)).result === 'ok') return true;
    return Date.now() - since > patience;
  };
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
const { INSTALL: INSTALL_CLI } = require('./updates');
const RECIPES = {
  openconnect: { formula: 'openconnect', label: 'OpenConnect', why: "Codeome's VPN tunnel" },
  ocproxy: { formula: 'ocproxy', label: 'ocproxy', why: "Codeome's VPN tunnel" },
  rsync: { formula: 'rsync', label: 'rsync', why: 'Copies to and from the HPC' },
  tmux: { formula: 'tmux', label: 'tmux', why: 'Terminal sessions' },
  gh: { formula: 'gh', label: 'GitHub CLI', why: 'GitHub' },
  python3: { formula: 'python', label: 'Python', why: 'Python on this Mac' },
  quarto: { cask: 'quarto', label: 'Quarto', why: 'Rendering reports' },
  R: { cask: 'r', label: 'R', why: 'The R console' },
  inkscape: { cask: 'inkscape', label: 'Inkscape', why: 'Publication-ready figures' },
  Rscript: { cask: 'r', label: 'R', why: 'Rendering R Markdown' },
  claude: { command: INSTALL_CLI.claude, label: 'Claude Code', why: 'Claude chats, subagents and sign-in' },
  codex: { command: INSTALL_CLI.codex, label: 'Codex', why: 'Codex chats, jobs and sign-in' },
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

// ---------- the HPC login wizard ----------
// Adds a Host block to ~/.ssh/config so the login can be set up from a form. It only ever
// appends: an alias that is already defined is refused, and nothing existing is rewritten.
const SAFE = /^[A-Za-z0-9._-]+$/;
const SAFE_HOP = /^[A-Za-z0-9._@:\[\]-]+$/;
function hostBlock({ alias, hostname, user, port, proxyJump, identityFile }) {
  alias = String(alias || '').trim(); hostname = String(hostname || '').trim(); user = String(user || '').trim();
  proxyJump = String(proxyJump || '').trim(); identityFile = String(identityFile || '').trim();
  if (!SAFE.test(alias)) throw new Error('Use letters, digits, dots, dashes or underscores in the short name.');
  if (!SAFE.test(hostname)) throw new Error('Enter the cluster’s address, e.g. login.cluster.example.org.');
  if (user && !SAFE.test(user)) throw new Error('The username has characters ssh logins do not use.');
  if (proxyJump && !SAFE_HOP.test(proxyJump)) throw new Error('The jump host should look like user@host or host.');
  const n = port === '' || port == null ? 22 : Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('The port should be a number between 1 and 65535.');
  if (identityFile && /[\s"'\\]/.test(identityFile)) throw new Error('The key path cannot contain spaces or quotes.');
  return ['Host ' + alias, '  HostName ' + hostname, ...(user ? ['  User ' + user] : []), ...(n !== 22 ? ['  Port ' + n] : []),
    ...(proxyJump ? ['  ProxyJump ' + proxyJump] : []), ...(identityFile ? ['  IdentityFile ' + identityFile] : [])].join('\n') + '\n';
}

function addHost(spec, file = path.join(os.homedir(), '.ssh', 'config')) {
  const block = hostBlock(spec);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const alias = String(spec.alias).trim().toLowerCase();
  const taken = cur.split('\n').some((l) => {
    const m = /^\s*Host\s+(.+?)\s*$/i.exec(l);
    return m && m[1].split(/\s+/).some((a) => a.toLowerCase() === alias);
  });
  if (taken) throw new Error(`~/.ssh/config already has a login called ${spec.alias}. Pick another short name.`);
  fs.appendFileSync(file, (cur && !cur.endsWith('\n\n') ? (cur.endsWith('\n') ? '\n' : '\n\n') : '') + '# Added by Codeome\n' + block, { mode: 0o600 });
  return { alias: spec.alias.trim() };
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

module.exports = { DEFAULT_PORT, portOf, splitArgs, tunnelArgs, tunnelCommand, proxyCommand, portOpen, tunnelReady, hostPort, vpnTarget, classifyProbe, probe, testVpn, locate, RECIPES, BREW_INSTALL, installCommand,
  parseSshG, hostBlock, addHost, resolveHost, findKey, classifyLogin, ciscoServers, status };
