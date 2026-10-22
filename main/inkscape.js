// Inkscape, used to turn R and Python figures into publication-ready ones (see the figures skill).
// It is a desktop app, so it is usually not on the PATH: look in the Applications folders first.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run } = require('./util');

const MAC_BINARY = 'Contents/MacOS/inkscape';
const OPENABLE = /\.(svg|svgz|pdf|eps|ai|emf|wmf)$/i;

// Where to look, most specific first: the path set in Settings, then the app bundles, then the PATH.
function candidates(configured) {
  const home = os.homedir();
  return [
    configured,
    '/Applications/Inkscape.app/' + MAC_BINARY,
    path.join(home, 'Applications/Inkscape.app', MAC_BINARY),
    '/opt/homebrew/bin/inkscape', '/usr/local/bin/inkscape', '/usr/bin/inkscape', '/snap/bin/inkscape'
  ].filter(Boolean);
}

const isExecutable = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; } };

// A path set in Settings may name the app bundle or the folder it is in; resolve it to the binary.
function resolve(p) {
  if (!p) return '';
  if (p.endsWith('.app')) p = path.join(p, MAC_BINARY);
  return isExecutable(p) ? p : '';
}

// { path, version } or { path: '' } when Inkscape cannot be found. `shell` is the login shell, for the PATH lookup.
async function detect({ configured = '', shell } = {}) {
  let bin = '';
  for (const c of candidates(configured)) { bin = resolve(c); if (bin) break; }
  if (!bin && shell) {
    const r = await run(shell, ['-l', '-c', 'command -v inkscape'], { timeout: 8000 });
    if (r.code === 0) bin = resolve(r.stdout.trim().split('\n').pop());
  }
  if (!bin) return { path: '' };
  const v = await run(bin, ['--version'], { timeout: 15000 });
  const m = /Inkscape\s+(\S+)/.exec(v.stdout || '');
  return { path: bin, version: m ? m[1] : '' };
}

// The app bundle a binary belongs to, or '' when it is not inside one.
const bundle = (bin) => { const i = bin.indexOf('.app/'); return i < 0 ? '' : bin.slice(0, i + 4); };

// The command that opens a file in Inkscape's own window: [command, args].
function openCommand(bin, file, platform = process.platform) {
  const app = bundle(bin);
  if (platform === 'darwin' && app) return ['open', ['-a', app, file]];
  return [bin, [file]];
}

// Codeome records what it found for the agents, which cannot ask the app: { path, version, checkedAt }, path '' when
// Inkscape is missing. It sits in Codeome's own folder (CODEOME_HOME, default ~/.codeome), not in a project.
const statusFile = (home) => path.join(home || process.env.CODEOME_HOME || path.join(os.homedir(), '.codeome'), 'inkscape.json');
function writeStatus(d, home) {
  try {
    const f = statusFile(home);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ path: d.path || '', version: d.version || '', checkedAt: new Date().toISOString() }, null, 2) + '\n');
  } catch { /* the agents then fall back to looking for Inkscape themselves */ }
  return d;
}

module.exports = { statusFile, writeStatus, detect, candidates, resolve, bundle, openCommand, OPENABLE, MAC_BINARY };
