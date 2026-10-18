// Long-term storage over SFTP (e.g. ERDA). Archive servers often give no shell,
// so everything is an `sftp` batch. Like the HPC, one master connection is opened
// in the background (login.js asks for a password in a dialog) and batches reuse it.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { run, q } = require('./util');
const { CONTROL_PATH } = require('./ssh');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The ssh destination: the login, with the username from Settings in front when one
// is set. ssh splits at the last @, so a username like you@example.org works.
function target(host, user) {
  const h = String(host || '').trim(), u = String(user || '').trim();
  return h && u ? u + '@' + h.slice(h.lastIndexOf('@') + 1) : h;
}

function muxOpts() { return ['-o', `ControlPath=${CONTROL_PATH}`, '-o', 'ControlMaster=no']; }

// Quote a path for an sftp batch line. Inside double quotes glob characters are literal.
function sq(p) {
  if (/[\r\n]/.test(p)) throw new Error('Path contains a line break');
  return '"' + String(p).replace(/[\\"]/g, '\\$&') + '"';
}

// The folders sftp starts from: '' / '~' / '.' all mean the login folder.
const isHome = (dir) => !dir || dir === '~' || dir === '.';

async function batch(host, lines, opts = {}) {
  if (!host) return { code: -1, stdout: '', stderr: 'No storage host configured' };
  return run('sftp', [...muxOpts(), '-b', '-', host], { input: lines.join('\n') + '\n', timeout: opts.timeout || 60000 });
}

// sftp echoes each batch line as "sftp> …"; what is left on stderr is the error.
function errorOf(r, fallback) {
  const msg = r.stderr.split('\n').map((l) => l.trim()).filter((l) => l && !/^Connection closed/.test(l)).slice(-2).join(' ');
  return msg || fallback || `sftp exited with ${r.code}`;
}

// Parses `pwd` + `ls -lan` output. The client formats -n listings itself:
// perms links uid gid size "Mon dd HH:MM" | "Mon dd  YYYY" name
function parseSftpListing(stdout, now = new Date()) {
  const lines = stdout.split('\n');
  let cwd = '';
  const entries = [];
  for (const raw of lines) {
    const l = raw.replace(/\r$/, '');
    const pw = l.match(/^Remote working directory: (.*)$/);
    if (pw) { cwd = pw[1]; continue; }
    if (l.startsWith('sftp> ')) continue;
    const m = l.match(/^([-dlcbps])\S{9}\S*\s+.*?\s(\d+)\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}:\d{2}|\d{4})\s(.*)$/);
    if (!m) continue;
    const [, type, size, mon, day, timeOrYear, name] = m;
    if (name === '.' || name === '..') continue;
    const mi = MONTHS.indexOf(mon);
    let mtime = 0;
    if (mi >= 0) {
      if (timeOrYear.includes(':')) {
        const [hh, mm] = timeOrYear.split(':').map(Number);
        const d = new Date(now.getFullYear(), mi, Number(day), hh, mm);
        // Recent files show a time and no year; a date "in the future" was last year.
        if (d.getTime() > now.getTime() + 86400000) d.setFullYear(d.getFullYear() - 1);
        mtime = d.getTime();
      } else mtime = new Date(Number(timeOrYear), mi, Number(day)).getTime();
    }
    entries.push({ name, dir: type === 'd', link: type === 'l', size: Number(size), mtime });
  }
  entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  return { cwd, entries };
}

async function list(host, dir) {
  const r = await batch(host, [...(isHome(dir) ? [] : [`cd ${sq(dir)}`]), 'pwd', 'ls -lan']);
  if (r.code !== 0) return { error: errorOf(r, `Cannot open ${dir}`) };
  const out = parseSftpListing(r.stdout);
  if (!out.cwd) return { error: 'Unexpected sftp output' };
  return out;
}

function tmpFile(name) {
  const d = path.join(os.tmpdir(), 'codeome-storage');
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '-' + path.basename(name));
}

// Copies a remote file to a local temp file.
async function fetch(host, p, timeout = 10 * 60000) {
  const local = tmpFile(p);
  const r = await batch(host, [`get ${sq(p)} ${sq(local)}`], { timeout });
  return r.code === 0 ? { local } : { error: errorOf(r, 'Download failed') };
}

async function readFile(host, p) {
  const f = await fetch(host, p, 120000);
  if (f.error) return f;
  try {
    const st = fs.statSync(f.local);
    if (st.size > 20 * 1024 * 1024) return { error: 'File larger than 20 MB — download it to open it.' };
    return { content: fs.readFileSync(f.local, 'utf8') };
  } finally { fs.rm(f.local, { force: true }, () => {}); }
}

async function writeFile(host, p, content) {
  const local = tmpFile(p);
  fs.writeFileSync(local, content, 'utf8');
  try {
    const r = await batch(host, [`put ${sq(local)} ${sq(p)}`], { timeout: 120000 });
    return r.code === 0 ? { ok: true } : { error: errorOf(r, 'Upload failed') };
  } finally { fs.rm(local, { force: true }, () => {}); }
}

async function simple(host, line) {
  const r = await batch(host, [line]);
  return r.code === 0 ? { ok: true } : { error: errorOf(r) };
}
const mkdir = (host, p) => simple(host, `mkdir ${sq(p)}`);
const rename = (host, from, to) => simple(host, `rename ${sq(from)} ${sq(to)}`);

// sftp has no recursive rm: walk the tree, then remove files and folders bottom-up.
async function remove(host, p, isDir) {
  if (!isDir) return simple(host, `rm ${sq(p)}`);
  const lines = [];
  const walk = async (dir) => {
    const l = await list(host, dir);
    if (l.error) throw new Error(l.error);
    for (const e of l.entries) {
      const full = dir.replace(/\/+$/, '') + '/' + e.name;
      if (e.dir) await walk(full); else lines.push(`rm ${sq(full)}`);
    }
    lines.push(`rmdir ${sq(dir)}`);
  };
  try { await walk(p); } catch (e) { return { error: e.message }; }
  const r = await batch(host, lines, { timeout: 10 * 60000 });
  return r.code === 0 ? { ok: true } : { error: errorOf(r) };
}

// The batch for a transfer between this Mac and the storage; `progress` turns the
// meter on (batch mode starts with it off) so a pty can report percentages.
function transferBatch(direction, src, destDir) {
  const dest = destDir.replace(/\/?$/, '/');
  return ['progress', direction === 'up' ? `put -R ${sq(src)} ${sq(dest)}` : `get -R ${sq(src)} ${sq(dest)}`].join('\n') + '\n';
}
const transferArgs = (host, batchFile) => [...muxOpts(), '-b', batchFile, host];

// A shell command for the HPC that runs sftp to the storage in a terminal there, so password
// prompts and the progress meter show. Every copy shares one connection to the storage (the
// first opens it, the rest reuse it for 30 minutes): the storage blocks hosts that open many
// connections at once, and this also asks for the password only once.
function hpcCommand(host, direction, src, destDir) {
  const dest = destDir.replace(/\/?$/, '/');
  const line = direction === 'up' ? `put -R ${sq(src)} ${sq(dest)}` : `get -R ${sq(src)} ${sq(dest)}`;
  return `printf '%s\\n' ${q(line)} | sftp -o ControlMaster=auto -o ControlPersist=30m -o ControlPath=/tmp/cm-storage-%C ${q(host)}`;
}

module.exports = { target, sq, isHome, parseSftpListing, list, fetch, readFile, writeFile, mkdir, rename, remove, transferBatch, transferArgs, hpcCommand, errorOf };
