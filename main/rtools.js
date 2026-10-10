// R helpers for the Plots and Packages views. The scripts in main/r/ are copied to
// ~/.cache/codeome on this Mac and on the HPC: plots.R is sourced into R consoles,
// render.R redraws a recorded plot at another size or format, packages.R lists
// the R libraries.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ssh = require('./ssh');
const { run, q } = require('./util');

const SCRIPTS = ['plots.R', 'render.R', 'packages.R'];
const LOCAL_DIR = path.join(os.homedir(), '.cache', 'codeome');
const installed = new Set();

// Copies the scripts to the host once per app run (again after a failure).
async function install(where, host) {
  const key = where === 'hpc' ? 'hpc:' + host : 'local';
  if (installed.has(key)) return { ok: true };
  const files = SCRIPTS.map((f) => [f, fs.readFileSync(path.join(__dirname, 'r', f), 'utf8')]);
  if (where === 'hpc') {
    const mk = await ssh.exec(host, 'mkdir -p ~/.cache/codeome/plots');
    if (mk.code !== 0) return { error: mk.stderr.trim() || 'Could not reach the HPC.' };
    for (const [f, text] of files) { const r = await ssh.writeFile(host, '.cache/codeome/' + f, text); if (r.error) return r; }
  } else {
    fs.mkdirSync(path.join(LOCAL_DIR, 'plots'), { recursive: true });
    for (const [f, text] of files) fs.writeFileSync(path.join(LOCAL_DIR, f), text);
  }
  installed.add(key);
  return { ok: true };
}

// The canvas new plots are drawn at: "width height res bg" (inches, dpi).
async function setCanvas(where, host, text) {
  if (where === 'hpc') return ssh.writeFile(host, '.cache/codeome/plots/canvas', text + '\n');
  fs.mkdirSync(path.join(LOCAL_DIR, 'plots'), { recursive: true });
  fs.writeFileSync(path.join(LOCAL_DIR, 'plots', 'canvas'), text + '\n');
  return { ok: true };
}

const FORMATS = ['png', 'pdf', 'svg', 'tiff', 'jpeg', 'eps'];
const num = (x) => String(Math.round(Number(x) * 1000) / 1000);
// Same plot, size and format → same file, so flipping back to a plot needs no redraw.
// rev counts the times R redrew the plot in place, so an older drawing is never reused.
const renderName = (o) => `${o.id}.${o.rev || 0}-${num(o.w)}x${num(o.h)}-${Math.round(o.res)}-${o.bg}.${o.fmt}`;

// Redraws plot <id> of a session (a folder plots.R made). Without `out` the result
// goes to a cache and its local path comes back.
// rcmd: the R console command from Settings, tried when the session's own Rscript
// can't start (say, an HPC module R that needs its module loaded).
async function render(o, { host, cacheDir, rcmd, shell }) {
  if (!FORMATS.includes(o.fmt)) return { error: 'Unknown format ' + o.fmt };
  if (!/^\d+$/.test(String(o.id)) || !/^\d*$/.test(String(o.rev ?? ''))) return { error: 'Bad plot id' };
  if (!(o.w > 0 && o.h > 0 && o.res > 0) || o.w * o.res > 60000 || o.h * o.res > 60000) return { error: 'The canvas is too large or empty.' };
  if (!isSessionDir(o.where, o.dir)) return { error: 'Not a Codeome plot folder: ' + o.dir };
  const args = [o.dir, String(o.id), o.fmt, num(o.w), num(o.h), String(Math.round(o.res)), o.bg === 'transparent' ? 'transparent' : 'white'];
  if (o.where === 'hpc') {
    const remoteOut = `${o.dir}/${renderName(o)}`;
    const local = o.out || path.join(cacheDir, crypto.createHash('sha1').update(o.dir).digest('hex').slice(0, 12) + '-' + renderName(o));
    if (!o.out && fs.existsSync(local)) return { local };
    const a = [...args, remoteOut].map(q).join(' ');
    const cmd = `rs=$(head -n 1 ${q(o.dir + '/session')} 2>/dev/null); [ -x "$rs" ] || rs=Rscript; "$rs" --vanilla "$HOME/.cache/codeome/render.R" ${a}`
      + (rcmd ? ` || { s=$?; if [ $s -ge 126 ]; then ${rcmd} --vanilla -s -f "$HOME/.cache/codeome/render.R" --args ${a}; else exit $s; fi; }` : '');
    const r = await ssh.exec(host, `bash -lc ${q(cmd)}`, { timeout: 180000 });
    if (r.code !== 0) return { error: rError(r) };
    const cp = await run('scp', ['-o', `ControlPath=${ssh.CONTROL_PATH}`, '-o', 'ControlMaster=no', `${host}:${remoteOut}`, local], { timeout: 10 * 60000 });
    if (cp.code !== 0) return { error: cp.stderr.trim() };
    return { local };
  }
  const local = o.out || path.join(o.dir, renderName(o));
  if (!o.out && fs.existsSync(local)) return { local };
  let rscript = 'Rscript';
  try { const first = fs.readFileSync(path.join(o.dir, 'session'), 'utf8').split('\n')[0]; if (first && fs.existsSync(first)) rscript = first; } catch {}
  let r = await run(rscript, ['--vanilla', path.join(LOCAL_DIR, 'render.R'), ...args, local], { timeout: 180000 });
  if ((r.code < 0 || r.code >= 126) && rcmd && shell) {
    r = await run(shell, ['-l', '-c', `${rcmd} --vanilla -s -f ${q(path.join(LOCAL_DIR, 'render.R'))} --args ${[...args, local].map(q).join(' ')}`], { timeout: 180000 });
  }
  if (r.code !== 0) return { error: rError(r) };
  return { local };
}
// Plot folders come from terminal output, which any program can write to: only
// folders plots.R makes are accepted.
function isSessionDir(where, dir) {
  if (typeof dir !== 'string' || dir.split('/').includes('..')) return false;
  if (where === 'hpc') return /^\/.+\/\.cache\/codeome\/plots\/[\w.-]+$/.test(dir);
  return path.dirname(path.resolve(dir)) === path.join(LOCAL_DIR, 'plots');
}

// The useful part of an R failure: the error lines, not the whole log.
function rError(r) {
  const text = (r.stderr || r.stdout || '').trim();
  const i = text.lastIndexOf('Error');
  return (i >= 0 ? text.slice(i) : text).split('\n').slice(0, 6).join('\n') || 'R exited with code ' + r.code;
}

// ---------- packages ----------
function parsePackages(stdout) {
  const out = { r: '', libs: [], old: {} };
  const byPath = {};
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('@@')) continue;
    const f = line.slice(2).split('\t');
    if (f[0] === 'R') out.r = f[1];
    else if (f[0] === 'LIB') { const lib = { path: f.slice(2).join('\t'), writable: f[1] === '1', pkgs: [] }; byPath[lib.path] = lib; out.libs.push(lib); }
    else if (f[0] === 'PKG' && byPath[f[1]]) byPath[f[1]].pkgs.push({ name: f[2], version: f[3], priority: f[4] || '', source: f[5] || '' });
    else if (f[0] === 'OLD') out.old[f[1] + '\t' + f[2]] = f[4];
  }
  for (const l of out.libs) l.pkgs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return out;
}

// rcmd: the R console command from Settings; cwd matters for renv and .Rprofile.
async function listPackages({ where, rcmd, cwd, outdated, host, shell }) {
  const extra = outdated ? ' --args outdated' : '';
  let r;
  if (where === 'hpc') {
    const dir = cwd && cwd !== '~' ? `cd ${q(cwd)} 2>/dev/null; ` : '';
    r = await ssh.exec(host, `bash -lc ${q(`${dir}${rcmd} -s -f "$HOME/.cache/codeome/packages.R"${extra}`)}`, { timeout: 180000 });
  } else r = await run(shell, ['-l', '-c', `${rcmd} -s -f ${q(path.join(LOCAL_DIR, 'packages.R'))}${extra}`], { cwd, timeout: 180000 });
  const parsed = parsePackages(r.stdout);
  if (!parsed.libs.length) return { error: rError(r) || 'R printed no libraries.' };
  return parsed;
}

module.exports = { install, setCanvas, render, renderName, isSessionDir, parsePackages, listPackages, FORMATS, LOCAL_DIR };
