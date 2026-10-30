const os = require('os');

const levels = {
  off: null,
  balanced: { nice: 10, divisor: 2 },
  gentle: { nice: 19, divisor: 4 }
};

function resolve(level, { cores = os.cpus().length, platform = process.platform } = {}) {
  const setting = Object.hasOwn(levels, level) ? levels[level] : null;
  if (!setting) return null;
  if (platform === 'win32') return null; // no nice/taskpolicy; local agent sessions are Unix-only
  const threads = Math.max(1, Math.floor(cores / setting.divisor));
  const count = String(threads);
  return {
    prefix: [...(platform === 'darwin' ? ['taskpolicy', '-b'] : []), 'nice', '-n', String(setting.nice)],
    env: {
      OMP_NUM_THREADS: count, MKL_NUM_THREADS: count, OPENBLAS_NUM_THREADS: count,
      NUMEXPR_NUM_THREADS: count, VECLIB_MAXIMUM_THREADS: count, CODEOME_MAX_CORES: count
    },
    threads
  };
}

module.exports = { levels, resolve };
