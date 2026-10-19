// Your own secrets (Settings → Secrets): access tokens and the like, each named as the
// environment variable it becomes. Plain Node, no Electron: the values live in the
// Keychain-encrypted store (config.js) under key(name), and the settings keep only
// { name, note, terminals, agents, hpc, projects } for each.
//   terminals — set in terminals, tasks and consoles started on this Mac
//   agents    — set in the agent chat and in agent sessions on this Mac
//   projects  — the project folders whose processes get it; left out, every project does
//   hpc       — written to the project's private env file on the HPC (secrets-sync.js); off unless set
// Only secrets with hpc on are sent to the HPC, and only as that file.

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// Variables the shell, the loader or Codeome's own account switching depend on.
const RESERVED = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|LANG|PWD|TMPDIR|CLAUDE_CONFIG_DIR|CODEX_HOME|NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$|^(DYLD|LD)_/;

const key = (name) => 'user:' + name;

// Why a name cannot be used, or '' when it can.
function nameError(name) {
  if (typeof name !== 'string' || !NAME.test(name)) return 'Use letters, digits and underscores, starting with a letter, as in GITHUB_TOKEN.';
  if (RESERVED.test(name)) return name + ' is used by the system or by Codeome itself.';
  return '';
}

// Whether a process of this project gets the secret. One outside any project gets only
// the secrets open to every project.
const allows = (s, project) => !Array.isArray(s.projects) || (!!project && s.projects.includes(project));

// The variables for one kind of process in a project. get(key) reads a value from the store.
function envFor(list, scope, get, project) {
  const env = {};
  if (scope !== 'terminals' && scope !== 'agents') return env;
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || !s[scope] || nameError(s.name) || !allows(s, project)) continue;
    const v = get(key(s.name));
    if (v) env[s.name] = v;
  }
  return env;
}

module.exports = { key, nameError, allows, envFor };
