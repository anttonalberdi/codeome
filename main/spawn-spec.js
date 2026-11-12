const platformTools = require('./platform');
const { q } = require('./util');

function unsupportedHpcPtySpec(spec, { platform = process.platform, env = process.env, cwd } = {}) {
  if (platformTools.hpcSupported(platform) || !(spec.kind.startsWith('hpc-') || ['agent-hpc', 'storage-login'].includes(spec.kind))) return null;
  return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/c', 'echo ' + platformTools.HPC_UNSUPPORTED_MESSAGE], cwd };
}

function localPtySpec(spec, { platform = process.platform, env = process.env, bashPath, cwd } = {}) {
  const sh = platformTools.requireLoginShell({ platform, env, bashPath });
  const execShell = platform === 'win32' ? q(platformTools.toPosixForShell(sh)) : sh;
  switch (spec.kind) {
    case 'shell': return { file: sh, args: ['-l'], cwd };
    case 'task': return { file: sh, args: ['-l', '-c', `${spec.command}; echo; echo "[process exited with $?]"; exec ${execShell} -l`], cwd };
    case 'agent-local': return { file: sh, args: ['-l', '-c', `${spec.command}; exec ${execShell} -l`], cwd };
    case 'console': return { file: sh, args: ['-l', '-c', spec.command], cwd };
    default: return null;
  }
}

module.exports = { localPtySpec, unsupportedHpcPtySpec };
