// Small shared helpers for the main process.
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const platformTools = require('./platform');
const { pathListSplit, pathListJoin, shellEnv, toolDirs } = require('./platform');

// Quote a string for a POSIX shell (used for remote commands over ssh).
function q(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// macOS GUI apps get a minimal PATH; add the usual places where Homebrew,
// conda, quarto, R and the agent CLIs live so commands are found.
function augmentedEnv(extra = {}, {
  platform = process.platform, env = process.env,
  home = platform === 'win32' ? env.USERPROFILE || os.homedir() : os.homedir()
} = {}) {
  const isWin = platform === 'win32';
  const extraPaths = isWin ? [
    ...toolDirs({ platform, env }),
    path.win32.join(home, '.local', 'bin'), path.win32.join(home, 'bin'),
    path.win32.join(home, 'miniforge3', 'Scripts'), path.win32.join(home, 'miniforge3'),
    path.win32.join(home, 'miniconda3', 'Scripts'), path.win32.join(home, 'miniconda3'),
    path.win32.join(home, 'anaconda3', 'Scripts'), path.win32.join(home, 'anaconda3'),
    path.win32.join(home, '.npm-global', 'bin'), path.win32.join(home, '.cargo', 'bin')
  ] : toolDirs({ platform: 'darwin', env: { HOME: home } });
  const pathKey = isWin ? Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH' : 'PATH';
  const current = pathListSplit(env[pathKey], platform);
  const seen = new Set();
  const merged = pathListJoin([...current, ...extraPaths].filter(dir => {
    const key = isWin ? dir.toLowerCase() : dir;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }), platform);
  if (!isWin) return { ...env, PATH: merged, LANG: env.LANG || 'en_US.UTF-8', ...extra };

  const result = { ...env, [pathKey]: merged, ...shellEnv(env, platform), ...extra };
  const extraPathKey = Object.keys(extra).filter(key => key.toLowerCase() === 'path').at(-1);
  const pathValue = extraPathKey === undefined ? merged : extra[extraPathKey];
  for (const key of Object.keys(result)) {
    if (key !== pathKey && key.toLowerCase() === 'path') delete result[key];
  }
  result[pathKey] = pathValue;
  return result;
}

// Run a command and collect output. Never throws; resolves {code, stdout, stderr}.
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    let child;
    try {
      const launch = platformTools.isWin && (/\.(cmd|bat)$/i.test(cmd) || /(?:^|[\\/])(claude|codex)(?:\.exe)?$/i.test(cmd)) ? platformTools.cliSpawnSpec(cmd, args) : { file: platformTools.resolveExecutable(cmd, { env: augmentedEnv(opts.env) }), args };
      child = spawn(launch.file, launch.args, { env: augmentedEnv(opts.env), cwd: opts.cwd, windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e.message || e) });
    }
    const timer = opts.timeout ? setTimeout(() => { platformTools.killTree(child, 'SIGKILL'); }, opts.timeout) : null;
    child.stdin.on('error', () => {});
    if (opts.input != null) { child.stdin.write(opts.input); }
    child.stdin.end();
    child.stdout.on('data', (d) => { stdout += d; if (opts.onStdout) opts.onStdout(String(d)); });
    child.stderr.on('data', (d) => { stderr += d; if (opts.onStderr) opts.onStderr(String(d)); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(e.message || e) }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

module.exports = { q, expandHome, augmentedEnv, run };
