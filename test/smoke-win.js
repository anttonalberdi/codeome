const platform = require('../main/platform');
const { localPtySpec } = require('../main/spawn-spec');
let output = '';
let child;
let timer;
let finished = false;
function finish(ok) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (child) { try { child.kill(); } catch {} }
  if (ok) console.log('pty ok');
  else console.error(output || 'PTY produced no output');
  process.exit(ok ? 0 : 1);
}
try {
  const pty = require('node-pty');
  const shell = process.platform === 'win32' ? platform.findBash() : platform.loginShell();
  const spec = localPtySpec({ kind: 'console', command: 'echo ok' }, { bashPath: shell, cwd: process.cwd() });
  child = pty.spawn(spec.file, spec.args, {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: spec.cwd,
    env: { ...process.env, ...platform.shellEnv() }
  });
  timer = setTimeout(() => finish(false), 20000);
  child.onData((data) => { output += data; if (output.includes('ok')) finish(true); });
  child.onExit(() => finish(output.includes('ok')));
} catch (error) {
  output += error.stack || error.message;
  finish(false);
}
