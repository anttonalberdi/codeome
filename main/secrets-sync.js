// Your own secrets that are switched on for the HPC (the `hpc` scope in secrets.js) go to a private
// env file in the HPC home, one per project: ~/.codeome/secrets/<slug>.env (dir 0700, file 0600).
// Plain Node, no Electron. The file travels over ssh's stdin, never in a command line, and nothing
// here logs or returns a value: results carry names and counts only.

const path = require('path');
const crypto = require('crypto');
const { key, kindOf, extError, valueError, nameError, allows } = require('./secrets');

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

// The secrets that qualify for the project: hpc on, a valid name, allowed here, and valid content.
// get(key) reads a value from the store. File contents stay separate from the env text.
function build(list, project, get) {
  const names = [], skipped = [], lines = [], files = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || !s.hpc || nameError(s.name) || !allows(s, project)) continue;
    const v = get(key(s.name));
    if (kindOf(s) === 'file') {
      if (extError(s.ext) || valueError('file', v)) { skipped.push(s.name); continue; }
      const filename = s.name + (s.ext || '');
      files.push({ filename, content: v });
      lines.push(`export ${s.name}="$HOME/.codeome/secrets/files/${slug(project)}/${filename}"`);
    } else {
      if (!v) continue;
      if (String(v).includes('\0')) { skipped.push(s.name); continue; }
      lines.push(`export ${s.name}=${quote(v)}`);
    }
    names.push(s.name);
  }
  const text = names.length ? ['# Written by Codeome from your secrets (Settings > Secrets). Do not edit or commit.', ...lines, ''].join('\n') : '';
  return { text, names, skipped, files };
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
  const filesDir = `${DIR}/files/${slug(project)}`;
  const prune = `rm -rf "${filesDir}".tmp.* "${filesDir}".old.*`;
  const fileCmd = [
    `umask 077; case $- in *x*) set +x;; esac`,
    `mkdir -p "${DIR}/files" && chmod 700 "$HOME/.codeome" "${DIR}" "${DIR}/files" && ${prune} || exit 1`,
    `_cx_stage="${filesDir}.tmp.$$"; _cx_old="${filesDir}.old.$$"; _cx_env="${tmp}"; _cx_swapped=`,
    `mkdir "$_cx_stage" && {`,
    `_cx_ok=`,
    `while IFS= read -r _cx_line; do`,
    `if [ "$_cx_line" = "---" ]; then _cx_ok=1; break; fi`,
    `case "$_cx_line" in *' '*) ;; *) break;; esac`,
    `_cx_name=\${_cx_line%% *}; _cx_data=\${_cx_line#* }`,
    `case "$_cx_name" in ''|.*|*[!A-Za-z0-9_.]*|*..*) break;; esac`,
    `base64 -d > "$_cx_stage/$_cx_name" <<_CX_B64 || break`,
    `$_cx_data`,
    `_CX_B64`,
    `done`,
    `[ "$_cx_ok" = 1 ] && rm -f "$_cx_env" && cat > "$_cx_env" && { mv "${filesDir}" "$_cx_old" 2>/dev/null || :; } && [ ! -e "${filesDir}" ] && [ ! -L "${filesDir}" ] && mv "$_cx_stage" "${filesDir}" && _cx_swapped=1 && mv "$_cx_env" "${f}" && { rm -rf "$_cx_old" || :; }`,
    `} || { if [ -n "$_cx_swapped" ]; then rm -rf "${filesDir}"; fi; if [ -e "$_cx_old" ] || [ -L "$_cx_old" ]; then mv "$_cx_old" "${filesDir}"; fi; rm -rf "$_cx_stage"; rm -f "$_cx_env"; exit 1; }`
  ].join('\n');
  const cmd = b.files.length
    ? fileCmd
    : b.names.length
      ? `umask 077; ${prune} && mkdir -p "${DIR}" && chmod 700 "$HOME/.codeome" "${DIR}" && cat > "${tmp}" && mv "${tmp}" "${f}" || { rm -f "${tmp}"; exit 1; } && rm -rf "${filesDir}"`
      : `${prune} && rm -f "${f}" && rm -rf "${filesDir}"`;
  // Recorded here, in queue order, so a stale completion cannot forget a newer write.
  const note = (on) => { try { if (track) track(host, project, on); } catch {} };
  if (b.names.length) note(true);
  let r;
  const input = b.files.length ? b.files.map((file) => `${file.filename} ${Buffer.from(file.content, 'utf8').toString('base64')}\n`).join('') + `---\n${b.text}` : b.text;
  try { r = await exec(host, cmd, b.names.length ? { input, timeout: 30000 } : { timeout: 30000 }); }
  catch (e) { return { error: 'Could not reach the HPC.' }; }
  if (!r || r.code !== 0) {
    // The first line of the remote's complaint helps, unless it echoes back what was sent.
    const why = r && r.stderr ? String(r.stderr).trim().split('\n')[0].slice(0, 200) : '';
    const sent = input + b.files.map((file) => file.content).join('\n');
    const echoed = why.split(/\s+/).some((w) => w.length >= 8 && sent.includes(w));
    return { error: 'The HPC did not accept the secrets file' + (why && !echoed ? ': ' + why : '.') };
  }
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
function tag(list, project, get, salt) {
  const b = build(list, project, get);
  const h = crypto.createHmac('sha256', salt).update(b.text);
  for (const file of b.files) h.update('\0').update(file.filename).update('\0').update(file.content);
  return h.digest('hex').slice(0, 8);
}

module.exports = { tag, hash8, slug, remotePath, quote, build, plan, sync, sourceCmd };
