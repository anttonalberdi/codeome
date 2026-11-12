const childProcess = require('node:child_process');

// Python writes CRLF to Windows text pipes. Keep semantic output assertions
// identical across hosts; POSIX results pass through unchanged.
function normalize(result) {
  if (process.platform === 'win32') {
    for (const key of ['stdout', 'stderr']) {
      if (typeof result[key] === 'string') result[key] = result[key].replace(/\r\n/g, '\n');
    }
  }
  return result;
}

module.exports = { ...childProcess, normalize,
  spawnSync: (file, args, options = {}) => normalize(childProcess.spawnSync(file, args, process.platform === 'win32'
    ? { ...options, env: { ...(options.env || process.env), PYTHONUTF8: '1' } } : options)) };
