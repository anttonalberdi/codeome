// File secrets are materialized only when a process needs their paths. One store is shared
// by the app's sessions, so a running session can keep using the file after another starts.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { nameError, extError, valueError } = require('./secrets');

const uid = process.getuid ? process.getuid() : -1;

function lstat(file) {
  try { return fs.lstatSync(file); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function directory(file, privateDir = false) {
  const stat = lstat(file);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || (uid !== -1 && (stat.uid !== uid || (privateDir && (stat.mode & 0o077))))) {
    throw new Error('Unsafe secret directory.');
  }
}

function ensureDirectory(file) {
  if (!lstat(file)) fs.mkdirSync(file, { mode: 0o700 });
  directory(file, true);
}

function fileStat(file) {
  const stat = lstat(file);
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || (uid !== -1 && (stat.uid !== uid || (stat.mode & 0o077))))) {
    throw new Error('Unsafe secret file.');
  }
  return stat;
}

function sameContent(file, content) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (uid !== -1 && (stat.uid !== uid || (stat.mode & 0o077)))) throw new Error('Unsafe secret file.');
    const old = fs.readFileSync(fd);
    const next = Buffer.from(content, 'utf8');
    return crypto.createHash('sha256').update(old).digest('hex') === crypto.createHash('sha256').update(next).digest('hex');
  } finally { fs.closeSync(fd); }
}

function createStore(baseDir) {
  const base = path.resolve(baseDir);
  const root = path.join(base, 'secret-files');
  const run = path.join(root, crypto.randomBytes(16).toString('hex'));
  const placed = new Map();

  function checkRoot() {
    directory(base);
    if (lstat(root)) directory(root, true);
  }

  function checkRun() {
    checkRoot();
    ensureDirectory(root);
    ensureDirectory(run);
  }

  function place(meta, content) {
    const name = meta && meta.name;
    const ext = meta && meta.ext !== undefined ? meta.ext : '';
    const badName = nameError(name);
    if (badName) throw new Error(badName);
    const badExt = extError(ext);
    if (badExt) throw new Error(badExt);
    const badValue = valueError('file', content);
    if (badValue) throw new Error(badValue);

    checkRun();
    const file = path.join(run, name + ext);
    const previous = placed.get(name);
    if (previous && previous !== file) fileStat(previous);
    if (!fileStat(file) || !sameContent(file, content)) {
      const tmp = path.join(run, name + ext + '.' + crypto.randomBytes(16).toString('hex') + '.tmp');
      try {
        fs.writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        fs.renameSync(tmp, file);
      } finally {
        if (lstat(tmp)) fs.unlinkSync(tmp);
      }
    }
    if (previous && previous !== file && lstat(previous)) fs.unlinkSync(previous);
    placed.set(name, file);
    return file;
  }

  function remove(name) {
    const badName = nameError(name);
    if (badName) throw new Error(badName);
    checkRoot();
    if (!lstat(root) || !lstat(run)) return;
    directory(run, true);
    const file = placed.get(name);
    if (!file) return;
    if (fileStat(file)) fs.unlinkSync(file);
    placed.delete(name);
  }

  function cleanupAll() {
    checkRoot();
    if (!lstat(root) || !lstat(run)) return;
    directory(run, true);
    fs.rmSync(run, { recursive: true });
    placed.clear();
  }

  function sweepStale() {
    checkRoot();
    if (!lstat(root)) return;
    for (const entry of fs.readdirSync(root)) {
      if (entry === path.basename(run)) continue;
      try { fs.rmSync(path.join(root, entry), { recursive: true, force: true }); } catch {}
    }
  }

  return { place, remove, cleanupAll, sweepStale };
}

module.exports = { createStore };
