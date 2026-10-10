// Small shared helpers for the main process.
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

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
function augmentedEnv(extra = {}) {
  const home = os.homedir();
  const extraPaths = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin',
    path.join(home, '.local/bin'), path.join(home, 'bin'),
    path.join(home, 'miniforge3/bin'), path.join(home, 'miniconda3/bin'), path.join(home, 'anaconda3/bin'),
    path.join(home, '.npm-global/bin'), path.join(home, '.cargo/bin'),
    '/Applications/quarto/bin', '/Library/Frameworks/R.framework/Resources/bin',
    '/usr/bin', '/bin', '/usr/sbin', '/sbin'
  ];
  const current = (process.env.PATH || '').split(':').filter(Boolean);
  const merged = [...new Set([...current, ...extraPaths])].join(':');
  return { ...process.env, PATH: merged, LANG: process.env.LANG || 'en_US.UTF-8', ...extra };
}

// Run a command and collect output. Never throws; resolves {code, stdout, stderr}.
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { env: augmentedEnv(opts.env), cwd: opts.cwd });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e.message || e) });
    }
    const timer = opts.timeout ? setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, opts.timeout) : null;
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
