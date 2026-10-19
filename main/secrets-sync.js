// Your own secrets that are switched on for the HPC (the `hpc` scope in secrets.js) go to a private
// env file in the HPC home, one per project: ~/.codeome/secrets/<slug>.env (dir 0700, file 0600).
// Plain Node, no Electron. The file travels over ssh's stdin, never in a command line, and nothing
// here logs or returns a value: results carry names and counts only.

const path = require('path');
const crypto = require('crypto');
const { key, nameError, allows } = require('./secrets');

const DIR = '$HOME/.codeome/secrets';

// The project's file name stem: its folder name made safe (lowercase, hyphens between runs of other
// characters) and 8 hex of the path's hash, so same-named folders never share a file.
function slug(project) {
  const p = String(project || '').replace(/[\\/]+$/, '');
  const base = path.basename(p).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'project';
  return base + '-' + hash8(p);
}

// Where the file is on the HPC, as a shell word to use inside double quotes.
const remotePath = (project) => `${DIR}/${slug(project)}.env`;

// Single-quoted for the shell: an embedded ' becomes '\''.
const quote = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";

// The secrets that qualify for the project: hpc on, a valid name, allowed here, a value that fits in
// an env file (no NUL). get(key) reads a value from the store. Returns the file and the names in it.
function build(list, project, get) {
  const names = [], skipped = [], lines = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || !s.hpc || nameError(s.name) || !allows(s, project)) continue;
    const v = get(key(s.name));
    if (!v) continue;
    if (String(v).includes('\0')) { skipped.push(s.name); continue; }
    names.push(s.name);
    lines.push(`export ${s.name}=${quote(v)}`);
  }
  const text = names.length ? ['# Written by Codeome from your secrets (Settings > Secrets). Do not edit or commit.', ...lines, ''].join('\n') : '';
  return { text, names, skipped };
}

// Names only, for showing what a sync would send.
const plan = (list, project, get) => { const b = build(list, project, get); return { names: b.names, skipped: b.skipped, path: remotePath(project).replace('$HOME', '~') }; };

// Syncs of one project run one after another, each reading the secrets as they are when it starts,
// so an older write can never land after a newer write or delete.
const chains = new Map();
function sync(project, deps) {
  const run = (chains.get(project) || Promise.resolve()).then(() => syncNow(project, deps));
  const tail = run.catch(() => {});
  chains.set(project, tail);
  tail.then(() => { if (chains.get(project) === tail) chains.delete(project); });
  return run;
}

// Writes (atomically, 0600) or, when nothing qualifies, deletes the project's file.
// deps: { host, list, get, exec } with exec(host, cmd, { input, timeout }) as in ssh.js, or a
// function returning that, called when the sync starts.
async function syncNow(project, deps) {
  const { host, list, get, exec, track } = typeof deps === 'function' ? deps() : deps;
  const b = build(list, project, get);
  const f = remotePath(project), tmp = f + '.tmp.$$';
  const cmd = b.names.length
    ? `umask 077; mkdir -p "${DIR}" && chmod 700 "$HOME/.codeome" "${DIR}" && cat > "${tmp}" && mv "${tmp}" "${f}" || { rm -f "${tmp}"; exit 1; }`
    : `rm -f "${f}"`;
  // Recorded here, in queue order, so a stale completion cannot forget a newer write.
  const note = (on) => { try { if (track) track(host, project, on); } catch {} };
  if (b.names.length) note(true);
  let r;
  try { r = await exec(host, cmd, b.names.length ? { input: b.text, timeout: 30000 } : { timeout: 30000 }); }
  catch (e) { return { error: 'Could not reach the HPC.' }; }
  if (!r || r.code !== 0) return { error: 'The HPC did not accept the secrets file' + (r && r.stderr ? ': ' + String(r.stderr).trim().split('\n')[0].slice(0, 200) : '.') };
  if (!b.names.length) note(false);
  return { ok: true, count: b.names.length, names: b.names, skipped: b.skipped, removed: !b.names.length };
}

// A shell snippet for the start of an HPC session: load the project's file when it exists, with
// tracing (set -x) switched off meanwhile so a login profile cannot echo the values.
const sourceCmd = (project) => `_cx=; case $- in *x*) _cx=1; set +x;; esac; [ -f "${remotePath(project)}" ] && . "${remotePath(project)}"; [ -n "\${_cx:-}" ] && set -x; unset _cx`;

// A short hash of the project path, to tell same-named folders apart.
const hash8 = (project) => crypto.createHash('sha256').update(String(project || '').replace(/[\\/]+$/, '')).digest('hex').slice(0, 8);

// A short keyed hash of the project's current secret set (names and values), for naming sessions so
// that any change starts a new one. Keyed with a per-install salt: never a bare hash of values.
const tag = (list, project, get, salt) => crypto.createHmac('sha256', salt).update(build(list, project, get).text).digest('hex').slice(0, 8);

module.exports = { tag, hash8, slug, remotePath, quote, build, plan, sync, sourceCmd };
