const fs = require('fs');
const os = require('os');
const path = require('path');

function isWinPlatform(platform = process.platform) { return platform === 'win32'; }
function isMacPlatform(platform = process.platform) { return platform === 'darwin'; }

function hpcSupported(platform = process.platform) { return platform !== 'win32'; }
const HPC_UNSUPPORTED_MESSAGE = 'HPC connections are not yet supported on Windows.';

const isWin = isWinPlatform();
const isMac = isMacPlatform();

function pathListSplit(str, platform = process.platform) {
  return (str || '').split(isWinPlatform(platform) ? ';' : ':').filter(Boolean);
}

function pathListJoin(arr, platform = process.platform) {
  return arr.join(isWinPlatform(platform) ? ';' : ':');
}

// Resolve only trusted absolute PATH entries; never search the child's cwd.
function resolveExecutable(name, { platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (!isWinPlatform(platform) || /[\\/:]/.test(name)) return name;
  const value = (key) => env[Object.keys(env).find(k => k.toLowerCase() === key.toLowerCase())] || '';
  const extensions = path.win32.extname(name) ? [''] : (value('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(e => /^\.[a-z0-9]+$/i.test(e));
  for (let dir of pathListSplit(value('PATH'), platform)) {
    dir = dir.replace(/^"(.*)"$/, '$1');
    if (!/^(?:[a-z]:[\\/]|\\\\)/i.test(dir)) continue;
    for (const ext of extensions) {
      const candidate = path.win32.join(dir, name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return name;
}

function isAbsoluteProject(p, platform = process.platform) {
  return typeof p === 'string' && (p.startsWith('/') || (isWinPlatform(platform) && path.win32.isAbsolute(p)));
}

let cachedPython;
function runtimePython() {
  if (cachedPython === undefined) cachedPython = findPython();
  return cachedPython;
}

function findBash({ platform = process.platform, env = process.env, exists = fs.existsSync, override } = {}) {
  if (!isWinPlatform(platform)) return null;

  const candidates = [];
  if (override) candidates.push(override);
  if (env.ProgramFiles) candidates.push(path.win32.join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'));
  if (env['ProgramFiles(x86)']) candidates.push(path.win32.join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'));
  if (env.LOCALAPPDATA) candidates.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));

  for (const dir of pathListSplit(env.PATH || env.Path || env.path, platform)) {
    const absolute = dir.replace(/^"(.*)"$/, '$1');
    if (/^(?:[a-z]:[\\/]|\\\\)/i.test(absolute)) candidates.push(path.win32.join(absolute, 'bash.exe'));
  }

  for (const candidate of candidates) {
    if (/[\\/](?:System32|WindowsApps)[\\/]bash\.exe$/i.test(candidate)) continue;
    if (exists(candidate)) return candidate;
  }
  return null;
}

// A probe may be asynchronous (setup checks through the login shell).
function findPython({ platform = process.platform, env = process.env, probe = (file, args) => require('child_process').spawnSync(file, args, { env, encoding: 'utf8', timeout: 8000, windowsHide: true }) } = {}) {
  if (!isWinPlatform(platform)) return { file: 'python3', args: [] };
  const candidates = [{ file: 'python3', args: [] }, { file: 'python', args: [] }, { file: 'py', args: ['-3'] }];
  function next(i) {
    if (i === candidates.length) return null;
    const candidate = candidates[i];
    const accept = (r) => r && (r.status ?? r.code) === 0 && /^Python 3\./m.test((r.stdout || '') + (r.stderr || '')) ? candidate : next(i + 1);
    try {
      const result = probe(candidate.file, [...candidate.args, '--version'], { env });
      return result && typeof result.then === 'function' ? result.then(accept, () => next(i + 1)) : accept(result);
    } catch { return next(i + 1); }
  }
  return next(0);
}

function loginShell({ platform = process.platform, env = process.env, bashPath } = {}) {
  return isWinPlatform(platform) ? (bashPath === undefined ? findBash({ platform, env }) : bashPath) : env.SHELL || '/bin/zsh';
}

function requireLoginShell(options) {
  const shell = loginShell(options);
  if (!shell) throw new Error('Git for Windows is required. Install Git for Windows to use its bash shell.');
  return shell;
}

function killTree(child, signal = 'SIGTERM', { platform = process.platform, group = false, env = process.env, spawn = require('child_process').spawn } = {}) {
  if (isWinPlatform(platform)) {
    if (!Number.isInteger(child.pid) || child.pid <= 4) return Promise.resolve(false);
    const file = path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'taskkill.exe');
    const kill = (force) => new Promise(resolve => {
      const killer = spawn(file, ['/pid', String(child.pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true });
      killer.on('error', () => resolve(false));
      killer.on('close', code => resolve(code === 0));
    });
    if (signal === 'SIGKILL') return kill(true);
    return kill(false).then(graceful => new Promise(resolve => setTimeout(resolve, 500)).then(() => kill(true)).then(forced => graceful || forced));
  }
  if (group && child.pid) { try { process.kill(-child.pid, signal); return; } catch {} }
  try { child.kill(signal); } catch {}
}

// Git bash's virtual roots must be resolved by that shell, not by replacing slashes.
function fromPosixForShell(p, platform = process.platform, convert) {
  if (!isWinPlatform(platform)) return p;
  if (/^\/[a-z]\//i.test(p)) return p.replace(/^\/([a-z])\//i, (_, drive) => drive.toUpperCase() + ':\\').replace(/\//g, '\\');
  if (!p.startsWith('/')) return p;
  const convertPath = convert || ((value) => require('child_process').execFileSync(requireLoginShell(), ['-l', '-c', 'cygpath -w -- "$0"', value], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim());
  return convertPath(p);
}

function cliSpawnSpec(bin, args, { platform = process.platform, env = process.env, bashPath, shell, prefix = [], login = true } = {}) {
  if (!login && !isWinPlatform(platform)) return { file: bin, args };
  const file = isWinPlatform(platform) ? requireLoginShell({ platform, env, bashPath }) : shell || requireLoginShell({ platform, env });
  const command = prefix.length ? `exec ${prefix.join(' ')} "$0" "$@"` : 'exec "$0" "$@"';
  // Keep a native drive path: with MSYS_NO_PATHCONV, shebang Node cannot open /c/... .
  return { file, args: ['-l', '-c', command, isWinPlatform(platform) ? bin.replace(/\\/g, '/') : bin, ...args] };
}


function shellEnv(env = process.env, platform = process.platform) {
  return isWinPlatform(platform) ? { CHERE_INVOKING: '1', MSYS_NO_PATHCONV: '1' } : {};
}

function toPosixForShell(p) {
  if (!p) return p;
  if (p.startsWith('\\\\')) return p.replace(/\\/g, '/');
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (drive) return '/' + drive[1].toLowerCase() + '/' + drive[2].replace(/\\/g, '/');
  return p;
}

function toolDirs({ platform = process.platform, env = process.env } = {}) {
  if (isMacPlatform(platform)) {
    const home = env.HOME || os.homedir();
    return [
      '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin',
      path.posix.join(home, '.local/bin'), path.posix.join(home, 'bin'),
      path.posix.join(home, 'miniforge3/bin'), path.posix.join(home, 'miniconda3/bin'), path.posix.join(home, 'anaconda3/bin'),
      path.posix.join(home, '.npm-global/bin'), path.posix.join(home, '.cargo/bin'),
      '/Applications/quarto/bin', '/Library/Frameworks/R.framework/Resources/bin',
      '/usr/bin', '/bin', '/usr/sbin', '/sbin'
    ];
  }
  if (!isWinPlatform(platform)) return [];

  const dirs = [];
  if (env.ProgramFiles) {
    dirs.push(path.win32.join(env.ProgramFiles, 'Git', 'usr', 'bin'));
    dirs.push(path.win32.join(env.ProgramFiles, 'Git', 'cmd'));
  }
  if (env.APPDATA) dirs.push(path.win32.join(env.APPDATA, 'npm'));
  if (env.LOCALAPPDATA) {
    dirs.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'usr', 'bin'));
    dirs.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd'));
    dirs.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'nodejs'));
    dirs.push(path.win32.join(env.LOCALAPPDATA, 'Volta', 'bin'));
  }
  if (env.NVM_SYMLINK) dirs.push(env.NVM_SYMLINK);
  return dirs;
}

module.exports = {
  hpcSupported, HPC_UNSUPPORTED_MESSAGE, isWin, isMac, isWinPlatform, isMacPlatform,
  resolveExecutable, isAbsoluteProject, runtimePython, findBash, findPython, loginShell, requireLoginShell, killTree, cliSpawnSpec, fromPosixForShell, shellEnv, toPosixForShell,
  pathListSplit, pathListJoin, toolDirs
};
