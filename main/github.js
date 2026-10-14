// GitHub account helpers. Tokens are supplied by the caller and never stored here.
const { isIP } = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

// Why a host cannot be used, or null when it can.
function checkHost(host) {
  if (typeof host !== 'string' || !HOST.test(host)) return 'Use a lowercase hostname without a scheme, path, user, or port.';
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')) return 'Use a hostname other than localhost or a local domain.';
  try {
    // URL normalizes alternate IPv4 forms such as 0x7f000001 before isIP checks them.
    if (isIP(new URL('https://' + host).hostname)) return 'Use a DNS hostname, not an IP address.';
  } catch {
    return 'Use a valid DNS hostname.';
  }
  return null;
}

function apiBase(host) {
  const error = checkHost(host);
  if (error) throw new Error('Invalid GitHub host: ' + error);
  return host === 'github.com' ? 'https://api.github.com' : 'https://' + host + '/api/v3';
}

async function validate(token, host, { fetch } = {}) {
  const error = checkHost(host);
  if (error) return { status: 'error', login: null, scopes: null, message: 'Invalid GitHub host: ' + error };
  try {
    const res = await fetch(apiBase(host) + '/user', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Codeome'
      },
      redirect: 'error',
      signal: AbortSignal.timeout(10000)
    });
    // Only 401 means a bad token: a 403 is a rate limit or a block, and must not lock the account.
    if (res.status === 401) return { status: 'invalid', login: null, scopes: null };
    if (res.status !== 200) return { status: 'error', login: null, scopes: null, message: 'GitHub returned HTTP ' + Number(res.status) + '.' };
    const body = await res.json();
    const login = typeof body?.login === 'string' ? body.login : null;
    const header = res.headers.get('X-OAuth-Scopes');
    if (header === null) return { status: 'valid', login, scopes: null };
    const scopes = header.split(',').map((scope) => scope.trim()).filter(Boolean);
    const result = { status: scopes.includes('repo') ? 'valid' : 'missing-scopes', login, scopes };
    if (!scopes.includes('workflow')) result.warnings = ['workflow'];
    return result;
  } catch {
    return { status: 'error', login: null, scopes: null, message: 'Could not validate the GitHub account.' };
  }
}

function envFor(token, host) {
  const error = checkHost(host);
  if (error) throw new Error('Invalid GitHub host: ' + error);
  const env = { CODEOME_GIT_TOKEN: token, CODEOME_GIT_HOST: host, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  if (host === 'github.com') return { GH_TOKEN: token, GITHUB_TOKEN: token, ...env };
  return { GH_ENTERPRISE_TOKEN: token, GH_HOST: host, ...env };
}

function credentialArgs(host) {
  const error = checkHost(host);
  if (error) throw new Error('Invalid GitHub host: ' + error);
  return ['-c', 'credential.helper=', '-c', 'credential.useHttpPath=false', '-c',
    'credential.helper=!f() { [ "$1" = get ] || exit 0; protocol=; host=; while IFS= read -r line && [ -n "$line" ]; do case "$line" in protocol=*) protocol=${line#protocol=};; host=*) host=${line#host=};; esac; done; [ "$protocol" = https ] && [ "$host" = "$CODEOME_GIT_HOST" ] && [ -n "$CODEOME_GIT_TOKEN" ] || exit 0; printf "username=x-access-token\\n"; printf "password=%s\\n" "$CODEOME_GIT_TOKEN"; }; f'];
}

function inProject(root, projects) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !Array.isArray(projects)) return false;
  const real = (value) => { const resolved = path.resolve(value); try { return fs.realpathSync(resolved); } catch { return resolved; } };
  const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
  const resolved = real(root);
  // A folder inside an open project, or the repository that holds one (its toplevel has a .git).
  const holdsRepository = () => { try { return fs.existsSync(path.join(resolved, '.git')); } catch { return false; } };
  return projects.some((project) => typeof project === 'string' && path.isAbsolute(project) &&
    (inside(real(project), resolved) || (inside(resolved, real(project)) && holdsRepository())));
}

const GIT_COMMANDS = new Set(['add', 'reset', 'commit', 'pull', 'push', 'fetch', 'checkout', 'restore', 'init', 'stash', 'switch', 'branch', 'tag']);
const GIT_NETWORK_OPTIONS = new Set(['-u', '--set-upstream', '--rebase', '--no-rebase', '--autostash', '--ff-only', '--tags', '--follow-tags', '--prune', '--dry-run', '--force-with-lease', '-v', '--all']);
const GIT_POSITIONAL = /^[A-Za-z0-9._][A-Za-z0-9._/+-]*(:[A-Za-z0-9._/+-]+)?$/;
// Free text (a commit message, a pull request body) may span lines; only NUL is refused.
function checkArgs(args) {
  return Array.isArray(args) && args.every((arg) => typeof arg === 'string' && !arg.includes('\0'));
}
function checkGitArgs(args) {
  if (!checkArgs(args)) return 'Git arguments must be strings without NUL.';
  if (!GIT_COMMANDS.has(args[0])) return 'Not allowed: git ' + args[0];
  if (!['push', 'pull', 'fetch'].includes(args[0])) return null;
  let remote = true;
  for (const arg of args.slice(1)) {
    if (GIT_NETWORK_OPTIONS.has(arg)) continue;
    if (arg.startsWith('-') || !GIT_POSITIONAL.test(arg) || arg.includes('://') || arg.includes('@') ||
        arg.includes('..') || arg.startsWith('.') || arg.includes(':/')) return 'Not allowed: git ' + arg;
    if (remote && (arg.includes('/') || arg.includes(':'))) return 'Not allowed: git remote ' + arg;
    remote = false;
  }
  return null;
}

const GH_COMMANDS = { repo: new Set(['create', 'view']), pr: new Set(['create', 'view', 'list']),
  release: new Set(['create', 'list']), issue: new Set(['list', 'view', 'create']) };
const GH_FLAGS = new Set(['--public', '--private', '--internal', '--source', '--push', '--description',
  '--title', '--body', '--draft', '--notes', '--generate-notes', '--repo', '-R']);
const GH_REPO = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)?$/;
const GH_WORD = /^[A-Za-z0-9_#][A-Za-z0-9._/#+-]*$/;
const GH_SINGLE_LINE = new Set(['--source', '--description', '--title', '--repo', '-R']);
const GH_VALUE_FLAGS = new Set(['--source', '--description', '--title', '--body', '--notes', '--repo', '-R']);
function checkGhArgs(args) {
  if (!checkArgs(args)) return 'GitHub arguments must be strings without NUL.';
  if (args[0] === 'browse') return args.length === 1 ? null : 'Not allowed: gh browse arguments';
  if (!Object.hasOwn(GH_COMMANDS, args[0]) || !GH_COMMANDS[args[0]].has(args[1])) return 'Not allowed: gh ' + args.slice(0, 2).join(' ');
  let positionals = 0;
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    const [flag, attached] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    if (arg.startsWith('-')) {
      if (!GH_FLAGS.has(flag)) return 'Not allowed: gh ' + arg;
      if (attached !== null && !GH_VALUE_FLAGS.has(flag)) return 'Not allowed: gh ' + arg;
      if (GH_VALUE_FLAGS.has(flag)) {
        const value = attached === null ? args[++i] : attached;
        // A value may start with '-' (a markdown bullet); gh takes the next argument as the value anyway.
        if (value === undefined) return 'Missing value for gh ' + flag;
        if (GH_SINGLE_LINE.has(flag) && /[\r\n]/.test(value)) return 'Not allowed: gh ' + flag + ' on several lines';
        if ((flag === '--repo' || flag === '-R') && !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(value)) return 'Not allowed: gh repository';
        if (flag === '--source' && value !== '.') return 'Not allowed: gh --source must be the project folder';
      }
    } else {
      positionals++;
      if (/[:@\r\n]/.test(arg) || arg.includes('://') || arg.includes('..')) return 'Not allowed: gh ' + arg;
      // gh reads [HOST/]OWNER/REPO, so a repository positional may carry at most one slash and never a host.
      if (args[0] === 'repo' && !GH_REPO.test(arg)) return 'Not allowed: gh repository ' + arg;
      if (args[0] !== 'repo' && !GH_WORD.test(arg)) return 'Not allowed: gh ' + arg;
      if (args[0] !== 'repo' && (arg.match(/\//g) || []).length >= 2 && arg.split('/')[0].includes('.')) return 'Not allowed: gh ' + arg;
    }
  }
  // After the tag, release create takes asset file paths: the app attaches none.
  if (args[0] === 'release' && args[1] === 'create' && positionals !== 1) return 'Not allowed: gh release create takes one tag';
  return null;
}

function redact(text, tokens) {
  if (typeof text !== 'string') return '';
  const values = (Array.isArray(tokens) ? tokens : []).filter((token) => typeof token === 'string' && token.length)
    .flatMap((token) => [token, encodeURIComponent(token)]).sort((a, b) => b.length - a.length);
  for (const value of values) text = text.replaceAll(value, '***');
  return text;
}

const PROVIDERS = { github: { id: 'github', apiBase, validate, envFor, credentialArgs } };

function provider(id) {
  if (!Object.hasOwn(PROVIDERS, id)) throw new Error('Unknown provider: ' + id);
  return PROVIDERS[id];
}

function addAccount(store, details, id) {
  provider(details.provider);
  const error = checkHost(details.host);
  if (error) throw new Error('Invalid GitHub host: ' + error);
  if (!id || store.accounts.some((account) => account.id === id)) throw new Error('Account id must be unique and non-empty.');
  const { host, login, status, scopes, checkedAt = null } = details;
  const account = { id, provider: details.provider, host, login, status, scopes, checkedAt };
  return { store: { ...store, accounts: [...store.accounts, account] }, account };
}

function removeAccount(store, id) {
  return {
    ...store,
    accounts: store.accounts.filter((account) => account.id !== id),
    bindings: Object.fromEntries(Object.entries(store.bindings).filter(([, accountId]) => accountId !== id))
  };
}

function bind(store, projectDir, id) {
  if (id !== null && typeof id !== 'string') throw new Error('Account id must be a string or null.');
  if (id !== null && !store.accounts.some((account) => account.id === id)) throw new Error('Account does not exist: ' + id);
  const bindings = { ...store.bindings };
  if (id === null) delete bindings[projectDir];
  else Object.defineProperty(bindings, projectDir, { value: id, writable: true, enumerable: true, configurable: true });
  return { ...store, bindings };
}

function accountFor(store, projectDir) {
  if (!Object.hasOwn(store.bindings, projectDir)) return null;
  const id = store.bindings[projectDir];
  return store.accounts.find((account) => account.id === id) || null;
}

function contextFor(store, root, getSecret) {
  if (!Object.hasOwn(store.bindings, root)) return null;
  const account = accountFor(store, root);
  if (!account) throw new Error('The GitHub account bound to this project is missing. Choose an account in Settings → Git & GitHub.');
  const name = account.login + '@' + account.host;
  if (account.status === 'invalid') throw new Error('The GitHub account ' + name + ' is no longer valid. Re-validate it in Settings → Git & GitHub.');
  const token = getSecret('github:' + account.id);
  if (!token) throw new Error('The token for ' + name + ' is missing. Add the account again in Settings → Git & GitHub.');
  const adapter = provider(account.provider);
  return { account, env: adapter.envFor(token, account.host), args: adapter.credentialArgs(account.host) };
}

function gitInvocation(ctx, args) {
  if (!ctx || !['push', 'pull', 'fetch'].includes(args[0])) return { args, env: {} };
  return { args: [...ctx.args, ...args], env: ctx.env };
}

function ghInvocation(ctx, args) {
  return { args, env: ctx && args[0] !== 'browse' ? { ...ctx.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', NO_COLOR: '1' } : {} };
}

function publicView(account) {
  const { id, provider, host, login, status, scopes, checkedAt } = account;
  return { id, provider, host, login, status, scopes, checkedAt };
}

module.exports = { PROVIDERS, provider, checkHost, inProject, checkGitArgs, checkGhArgs, redact, addAccount, removeAccount, bind, accountFor, contextFor, gitInvocation, ghInvocation, publicView };
