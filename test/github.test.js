const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const github = require('../main/github');

function response(status, scopes, login = 'octocat') {
  return {
    status,
    headers: { get: (name) => name.toLowerCase() === 'x-oauth-scopes' ? scopes : null },
    json: async () => ({ login })
  };
}

test('provider lookup and API bases', () => {
  assert.strictEqual(github.provider('github'), github.PROVIDERS.github);
  assert.throws(() => github.provider('gitlab'), /Unknown provider.*gitlab/);
  assert.strictEqual(github.provider('github').apiBase('github.com'), 'https://api.github.com');
  assert.strictEqual(github.provider('github').apiBase('ghe.corp.example'), 'https://ghe.corp.example/api/v3');
});

test('GitHub host validation accepts DNS names and rejects unsafe hosts', () => {
  assert.strictEqual(github.checkHost('github.com'), null);
  assert.strictEqual(github.checkHost('ghe.corp.example'), null);
  for (const host of ['http://x', 'https://github.com', 'host/path', 'user@host', 'host:8443', 'host name', 'localhost', 'foo.local', 'foo.localhost', '127.0.0.1', '[::1]', 'EXAMPLE.com']) {
    assert.ok(github.checkHost(host), host);
  }
});

test('classic token with repo scope is valid and validation blocks redirects', async () => {
  const token = 'secret-token';
  let request;
  const result = await github.provider('github').validate(token, 'github.com', {
    fetch: async (...args) => { request = args; return response(200, 'repo, workflow'); }
  });
  assert.deepStrictEqual(result, { status: 'valid', login: 'octocat', scopes: ['repo', 'workflow'] });
  assert.strictEqual(request[0], 'https://api.github.com/user');
  assert.deepStrictEqual(request[1].headers, {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Codeome'
  });
  assert.strictEqual(request[1].method, 'GET');
  assert.strictEqual(request[1].redirect, 'error');
  assert.ok(request[1].signal instanceof AbortSignal);
});

test('a rejected token is invalid, but a 403 is only an error', async () => {
  const check = (status) => github.provider('github').validate('secret', 'github.com', { fetch: async () => response(status, null) });
  assert.deepStrictEqual(await check(401), { status: 'invalid', login: null, scopes: null });
  assert.strictEqual((await check(403)).status, 'error');
});

test('classic token without repo scope is missing scopes and missing workflow warns', async () => {
  const validate = (scopes) => github.provider('github').validate('secret', 'github.com', { fetch: async () => response(200, scopes) });
  assert.deepStrictEqual(await validate('read:user, workflow'), {
    status: 'missing-scopes', login: 'octocat', scopes: ['read:user', 'workflow']
  });
  assert.deepStrictEqual(await validate('repo, read:user'), {
    status: 'valid', login: 'octocat', scopes: ['repo', 'read:user'], warnings: ['workflow']
  });
});

test('fine-grained token without a scope header is valid with unknown scopes', async () => {
  const result = await github.provider('github').validate('secret', 'ghe.corp.example', {
    fetch: async (url) => {
      assert.strictEqual(url, 'https://ghe.corp.example/api/v3/user');
      return response(200, null);
    }
  });
  assert.deepStrictEqual(result, { status: 'valid', login: 'octocat', scopes: null });
});

test('validation errors never include the token', async () => {
  const token = 'secret token';
  const validate = (fetch) => github.provider('github').validate(token, 'github.com', { fetch });
  const failed = await validate(async () => response(500, null));
  const thrown = await validate(async () => { throw new Error('Request contained secret token and secret%20token'); });
  for (const result of [failed, thrown]) {
    assert.strictEqual(result.status, 'error');
    assert.ok(result.message);
    assert.ok(!JSON.stringify(result).includes(token));
    assert.ok(!JSON.stringify(result).includes(encodeURIComponent(token)));
  }
});

test('token environment is host-specific and credential argv contains no token', () => {
  const token = 'secret-token';
  const p = github.provider('github');
  assert.deepStrictEqual(p.envFor(token, 'github.com'), {
    GH_TOKEN: token, GITHUB_TOKEN: token, CODEOME_GIT_TOKEN: token, CODEOME_GIT_HOST: 'github.com', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never'
  });
  assert.deepStrictEqual(p.envFor(token, 'ghe.corp.example'), {
    GH_ENTERPRISE_TOKEN: token, GH_HOST: 'ghe.corp.example', CODEOME_GIT_TOKEN: token, CODEOME_GIT_HOST: 'ghe.corp.example', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never'
  });
  assert.deepStrictEqual(p.credentialArgs('github.com').slice(0, 4), ['-c', 'credential.helper=', '-c', 'credential.useHttpPath=false']);
  assert.ok(!JSON.stringify(p.credentialArgs('github.com')).includes(token));
  assert.throws(() => p.credentialArgs('host:8443'), /host/i);
});

test('redact removes tokens and URL-encoded forms', () => {
  assert.strictEqual(github.redact('plain a b, encoded a%20b, plus x.y', ['a b', 'x.y', '']), 'plain ***, encoded ***, plus ***');
  assert.strictEqual(github.redact(null, ['secret']), '');
});

test('account helpers add, bind, unbind and hide private fields', () => {
  const original = { accounts: [], bindings: {} };
  const added = github.addAccount(original, {
    provider: 'github', host: 'github.com', login: 'octocat', status: 'valid', scopes: ['repo']
  }, 'account-1');
  assert.deepStrictEqual(original, { accounts: [], bindings: {} });
  assert.deepStrictEqual(added.account, {
    id: 'account-1', provider: 'github', host: 'github.com', login: 'octocat',
    status: 'valid', scopes: ['repo'], checkedAt: null
  });
  assert.deepStrictEqual(added.store.accounts, [added.account]);
  assert.throws(() => github.addAccount(original, { provider: 'gitlab', host: 'github.com' }, 'x'), /Unknown provider/);
  assert.throws(() => github.addAccount(original, { provider: 'github', host: 'bad/path' }, 'x'), /host/i);
  assert.throws(() => github.bind(original, '/project', 'missing'), /account/i);
  const bound = github.bind(added.store, '/project', 'account-1');
  assert.strictEqual(github.accountFor(bound, '/project'), added.account);
  assert.strictEqual(github.accountFor(added.store, '/project'), null);
  assert.deepStrictEqual(github.bind(bound, '/project', null).bindings, {});
  assert.deepStrictEqual(github.publicView({ ...added.account, token: 'secret', extra: true }), added.account);
});

test('dangling bindings resolve to null and removal cascades through bindings', () => {
  const account = { id: 'a', provider: 'github', host: 'github.com' };
  const store = { accounts: [account], bindings: { '/one': 'a', '/two': 'a', '/dangling': 'missing' } };
  assert.strictEqual(github.accountFor(store, '/dangling'), null);
  const removed = github.removeAccount(store, 'a');
  assert.deepStrictEqual(removed, { accounts: [], bindings: { '/dangling': 'missing' } });
  assert.deepStrictEqual(store.bindings, { '/one': 'a', '/two': 'a', '/dangling': 'missing' });
});

test('unbound commands get no account environment or credential arguments', () => {
  const ctx = github.contextFor({ accounts: [], bindings: {} }, '/project', () => { throw new Error('Unexpected secret read'); });
  assert.strictEqual(ctx, null);
  assert.deepStrictEqual(github.gitInvocation(ctx, ['push', 'origin', 'main']), { args: ['push', 'origin', 'main'], env: {} });
  assert.deepStrictEqual(github.ghInvocation(ctx, ['repo', 'view']), { args: ['repo', 'view'], env: {} });
});

test('bound Git network commands use per-call credentials without putting the token in argv', () => {
  const token = 'private-token-value';
  const account = { id: 'a', provider: 'github', host: 'github.com', login: 'octocat', status: 'valid' };
  const ctx = github.contextFor({ accounts: [account], bindings: { '/project': 'a' } }, '/project', (key) => {
    assert.strictEqual(key, 'github:a');
    return token;
  });
  assert.strictEqual(ctx.account, account);
  for (const subcommand of ['push', 'pull', 'fetch']) {
    const invocation = github.gitInvocation(ctx, [subcommand, 'origin']);
    assert.deepStrictEqual(invocation.args, [...ctx.args, subcommand, 'origin']);
    assert.deepStrictEqual(invocation.env, ctx.env);
    assert.strictEqual(invocation.env.CODEOME_GIT_TOKEN, token);
    assert.ok(!JSON.stringify(invocation.args).includes(token));
  }
  for (const subcommand of ['commit', 'checkout', 'add', 'remote']) {
    assert.deepStrictEqual(github.gitInvocation(ctx, [subcommand, 'arg']), { args: [subcommand, 'arg'], env: {} });
  }
  assert.deepStrictEqual(github.ghInvocation(ctx, ['repo', 'view']), { args: ['repo', 'view'], env: { ...ctx.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: 'cat', NO_COLOR: '1' } });
  assert.deepStrictEqual(github.ghInvocation(ctx, ['browse']), { args: ['browse'], env: {} });
});

test('git network argument checks accept app calls and reject transport commands', () => {
  for (const args of [['push'], ['push', '-u', 'origin', 'feature/topic'], ['pull', '--rebase', '--autostash'],
    ['fetch', '--prune', 'origin'], ['add', '-A'], ['commit', '-m', 'message'], ['reset', '-q', '--', 'file'], ['init', '-b', 'main']]) {
    assert.strictEqual(github.checkGitArgs(args), null, args.join(' '));
  }
  for (const args of [['push', '-c', 'core.sshCommand=evil'], ['push', '--upload-pack=evil'], ['push', '--receive-pack=evil'],
    ['fetch', '--exec=evil'], ['push', '--config=evil'], ['push', '--template=evil'], ['push', '-o', 'evil'],
    ['push', '--push-option=evil'], ['fetch', '--recurse-submodules=on-demand'], ['push', 'https://evil.example/x'],
    ['push', 'evil.example:x'], ['push', '/tmp/repo'], ['push', 'foo/bar'], ['push', 'github.com@evil.example'],
    ['push', 'github.com.evil.example:repo'], ['push', 'origin\n'], ['commit', 1], null]) {
    assert.ok(github.checkGitArgs(args), JSON.stringify(args));
  }
});

test('gh argument checks allow app calls and reject executable commands and hosted repositories', () => {
  for (const args of [['browse'], ['repo', 'create', 'name', '--private', '--source', '.', '--push', '--description', 'text'],
    ['repo', 'view'], ['pr', 'create', '--title', 'title', '--body', 'text', '--draft'], ['pr', 'view'], ['pr', 'list'],
    ['release', 'create', 'v1', '--title', 'title', '--generate-notes'], ['release', 'list'],
    ['issue', 'list'], ['issue', 'view', '1'], ['issue', 'create', '--title', 'title', '--body', 'body'],
    ['repo', 'view', '--repo', 'owner/name']]) assert.strictEqual(github.checkGhArgs(args), null, args.join(' '));
  for (const args of [['repo', 'clone', 'name'], ['run', 'list'], ['pr', 'checkout', '1'], ['extension', 'exec'],
    ['alias', 'set'], ['api', '/user'], ['auth', 'token'], ['config', 'set'], ['repo', 'view', '--repo', 'evil.example/owner/name'],
    ['repo', 'view', '-R', 'https://evil.example/owner/name'], ['repo', 'view', '--repo=evil.example/owner/name'],
    ['browse', '--repo', 'owner/name'], ['pr', 'create', '--title', 'bad\ntext'], ['repo', 1], {}]) {
    assert.ok(github.checkGhArgs(args), JSON.stringify(args));
  }
});

test('project paths require containment and absolute roots', () => {
  const projects = ['/a/proj'];
  for (const root of ['/a/proj', '/a/proj/repo']) assert.strictEqual(github.inProject(root, projects), true, root);
  // An ancestor that is not a repository (a home directory, the filesystem root) is refused.
  for (const root of ['/a', '/', '/a/proj2', '/a/proj/../proj2', '../proj', 'proj', null]) assert.strictEqual(github.inProject(root, projects), false, String(root));
});

test('an ancestor of a project is accepted only when it is the repository toplevel', () => {
  const base = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'codeome-proj-'));
  try {
    const project = path.join(base, 'repo', 'sub');
    fs.mkdirSync(project, { recursive: true });
    assert.strictEqual(github.inProject(path.join(base, 'repo'), [project]), false);
    fs.mkdirSync(path.join(base, 'repo', '.git'));
    assert.strictEqual(github.inProject(path.join(base, 'repo'), [project]), true);
    assert.strictEqual(github.inProject(base, [project]), false);
    // a symlink pointing outside the project does not pass as inside it
    const outside = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'codeome-out-'));
    fs.symlinkSync(outside, path.join(project, 'link'));
    assert.strictEqual(github.inProject(path.join(project, 'link'), [project]), false);
    fs.rmSync(outside, { recursive: true, force: true });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('gh positionals cannot carry a host, a second slash, a path or release assets', () => {
  for (const args of [['repo', 'view', 'evil.example.com/o/r'], ['repo', 'view', 'a/b/c'], ['repo', 'view', '../x'],
    ['release', 'create', 'v1', '/Users/me/.ssh/id_rsa'], ['release', 'create', 'v1', 'dist/a.zip'], ['release', 'create'],
    ['repo', 'create', 'x', '--source=/Users/me/other'], ['repo', 'create', 'x', '--source', '../other'],
    ['pr', 'view', 'evil.example.com/o/r/pull/1']]) assert.notStrictEqual(github.checkGhArgs(args), null, args.join(' '));
  for (const args of [['repo', 'create', 'org/name', '--private', '--source', '.', '--push'], ['release', 'create', 'v1.2.3', '--generate-notes'],
    ['issue', 'view', '12'], ['pr', 'view', 'feature/x']]) assert.strictEqual(github.checkGhArgs(args), null, args.join(' '));
});

test('bound accounts with missing tokens or invalid status block commands', () => {
  const account = { id: 'a', provider: 'github', host: 'github.com', login: 'octocat', status: 'valid' };
  const store = { accounts: [account], bindings: { '/project': 'a' } };
  assert.throws(() => github.contextFor(store, '/project', () => ''),
    /The token for octocat@github\.com is missing\. Add the account again in Settings → Git & GitHub\./);
  assert.throws(() => github.contextFor({ ...store, accounts: [{ ...account, status: 'invalid' }] }, '/project', () => 'token'),
    /The GitHub account octocat@github\.com is no longer valid\. Re-validate it in Settings → Git & GitHub\./);
  assert.throws(() => github.contextFor({ ...store, accounts: [] }, '/project', () => 'token'), /account bound to this project is missing/);
  for (const status of ['error', 'missing-scopes']) {
    assert.strictEqual(github.contextFor({ ...store, accounts: [{ ...account, status }] }, '/project', () => 'token').account.status, status);
  }
});

test('enterprise account context uses enterprise gh environment', () => {
  const account = { id: 'a', provider: 'github', host: 'ghe.corp.example', login: 'octocat', status: 'valid' };
  const ctx = github.contextFor({ accounts: [account], bindings: { '/project': 'a' } }, '/project', () => 'private-token');
  assert.strictEqual(ctx.env.GH_ENTERPRISE_TOKEN, 'private-token');
  assert.strictEqual(ctx.env.GH_HOST, 'ghe.corp.example');
  assert.strictEqual(ctx.env.GH_TOKEN, undefined);
  assert.strictEqual(ctx.env.GITHUB_TOKEN, undefined);
});

test('host validation rejects hostile and malformed names before credential setup', () => {
  const invalid = [
    'GitHub.com', 'ghe.Example.org', 'github.com.', '0x7f000001', '2130706433',
    '127.1', '[::1]', '::1', '169.254.169.254', '10.0.0.5', 'a b',
    'ghe.example.org/evil', 'ghe.example.org:443', 'ghe.example.org?x=1',
    'ghe.example.org#x', '$(touch x).example.org', 'ghe;example.org',
    `${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(62)}`,
    '', null, undefined, 0, 42, NaN
  ];
  const provider = github.provider('github');
  for (const host of invalid) {
    assert.ok(github.checkHost(host), `checkHost accepted ${String(host)}`);
    assert.throws(() => provider.credentialArgs(host), /Invalid GitHub host/, String(host));
    assert.throws(() => provider.envFor('fake-token', host), /Invalid GitHub host/, String(host));
  }
  for (const host of ['github.com', 'ghe.corp.example', 'git-hub.example.co.uk', 'xn--mnchen-3ya.example']) {
    assert.strictEqual(github.checkHost(host), null, host);
    assert.doesNotThrow(() => provider.credentialArgs(host), host);
    assert.doesNotThrow(() => provider.envFor('fake-token', host), host);
  }
});

test('git credential fill returns the token only to its HTTPS host', (t) => {
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 3000 });
  if (probe.error?.code === 'ENOENT') return t.skip('git is not on PATH');
  assert.ifError(probe.error);
  assert.strictEqual(probe.status, 0, probe.stderr);

  const token = 'ghp_TESTTOKEN_' + randomBytes(12).toString('hex');
  const env = { ...process.env, ...github.provider('github').envFor(token, 'github.com') };
  const args = [...github.provider('github').credentialArgs('github.com'), 'credential', 'fill'];
  assert.ok(!JSON.stringify(args).includes(token));
  const options = { encoding: 'utf8', input: 'protocol=https\nhost=github.com\n\n', timeout: 3000 };
  const filled = spawnSync('git', args, { ...options, env });
  assert.ifError(filled.error);
  assert.strictEqual(filled.status, 0, filled.stderr);
  assert.match(filled.stdout, /^username=x-access-token$/m);
  assert.ok(filled.stdout.split('\n').includes(`password=${token}`));

  for (const input of ['protocol=https\nhost=evil.example\n\n', 'protocol=https\nhost=gitlab.com\n\n',
    'protocol=https\nhost=github.com.evil.example\n\n', 'protocol=http\nhost=github.com\n\n']) {
    const rejected = spawnSync('git', args, { ...options, input, env });
    assert.ifError(rejected.error);
    assert.ok(!/^password=/m.test(rejected.stdout), input);
    assert.ok(!rejected.stdout.includes(token), input);
  }

  const withoutToken = { ...env };
  delete withoutToken.CODEOME_GIT_TOKEN;
  const empty = spawnSync('git', args, { ...options, env: withoutToken });
  assert.ifError(empty.error);
  assert.ok(!empty.stdout.includes(token));
});

test('recorded git and gh flows redact hostile command output and keep stored accounts private', async () => {
  const token = 'ghp_TESTTOKEN_' + randomBytes(12).toString('hex');
  const account = {
    id: 'account-1', provider: 'github', host: 'github.com', login: 'octocat',
    status: 'valid', scopes: ['repo'], checkedAt: null
  };
  const store = github.bind(github.addAccount({ accounts: [], bindings: {} }, account, account.id).store, '/project', account.id);
  const ctx = github.contextFor(store, '/project', (key) => {
    assert.strictEqual(key, 'github:account-1');
    return token;
  });
  const calls = [];
  const run = async (cmd, argv, options) => {
    calls.push({ cmd, argv: [...argv], env: options.env });
    return { code: cmd === 'git' ? 0 : 1, stdout: `remote said ${token}`, stderr: `hostile stderr ${token}` };
  };
  const gitCall = github.gitInvocation(ctx, ['push', 'origin', 'main']);
  const ghCall = github.ghInvocation(ctx, ['repo', 'view']);
  const results = await Promise.all([
    run('git', gitCall.args, { env: gitCall.env }),
    run('gh', ghCall.args, { env: ghCall.env })
  ]);
  const returned = results.map((result) => result.code === 0
    ? { ok: true, out: (github.redact(result.stdout, [token]) + github.redact(result.stderr, [token])).trim() }
    : { error: (github.redact(result.stderr, [token]) || github.redact(result.stdout, [token])).trim() });

  assert.deepStrictEqual(calls.map((call) => call.cmd), ['git', 'gh']);
  assert.ok(calls.every((call) => !JSON.stringify(call.argv).includes(token)));
  assert.ok(calls.every((call) => call.env.CODEOME_GIT_TOKEN === token));
  assert.ok(results.every((result) => result.stderr.includes(token)));
  assert.ok(!JSON.stringify(returned).includes(token));
  assert.ok(!JSON.stringify(store).includes(token));
  assert.ok(!JSON.stringify(github.publicView({ ...account, token })).includes(token));
});

test('special project keys and unicode paths bind without inherited-property confusion', () => {
  const account = { id: 'account-1', provider: 'github', host: 'github.com', login: 'octocat', status: 'valid' };
  const paths = ['__proto__', 'constructor', 'toString', '/a path/with spaces', '/projekter/München/研究'];
  let store = { accounts: [account], bindings: {} };
  for (const project of paths) {
    store = github.bind(store, project, account.id);
    assert.ok(Object.hasOwn(store.bindings, project), project);
    assert.strictEqual(github.accountFor(store, project), account, project);
    assert.strictEqual(github.contextFor(store, project, () => 'fake-token').account, account, project);
  }
  const unbound = github.bind(store, '__proto__', null);
  assert.strictEqual(github.accountFor(unbound, '__proto__'), null);
  assert.strictEqual(github.contextFor(unbound, '__proto__', () => { throw new Error('secret read'); }), null);
  for (const project of paths.slice(1)) assert.strictEqual(github.accountFor(unbound, project), account, project);
  assert.throws(() => github.bind(store, '/other', 'unknown'), /Account does not exist/);
  assert.throws(() => github.bind(store, '/other', 1), /string or null/);
  assert.throws(() => github.addAccount(store, account, account.id), /unique/);
  const inherited = { accounts: [account], bindings: {} };
  for (const key of ['__proto__', 'constructor', 'toString']) {
    assert.strictEqual(github.accountFor(inherited, key), null);
    assert.strictEqual(github.contextFor(inherited, key, () => { throw new Error('secret read'); }), null);
  }
  assert.strictEqual(github.accountFor({ accounts: [{ id: null }], bindings: {} }, 'constructor'), null);
});

test('dangling binding blocks context and removing an account clears all its projects', () => {
  const a = { id: 'a', provider: 'github', host: 'github.com', login: 'one', status: 'valid' };
  const b = { id: 'b', provider: 'github', host: 'github.com', login: 'two', status: 'valid' };
  const store = {
    accounts: [a, b],
    bindings: { '/one': 'a', '/two': 'a', '/three': 'a', '/other': 'b', '/dangling': 'removed' }
  };
  assert.strictEqual(github.accountFor(store, '/dangling'), null);
  assert.throws(() => github.contextFor(store, '/dangling', () => { throw new Error('secret read'); }), /account bound to this project is missing/);
  const removed = github.removeAccount(store, 'a');
  assert.deepStrictEqual(removed.accounts, [b]);
  assert.deepStrictEqual(removed.bindings, { '/other': 'b', '/dangling': 'removed' });
  assert.strictEqual(github.accountFor(removed, '/other'), b);
});

test('git invocation matches exact subcommands and preserves caller arguments', () => {
  const ctx = { args: ['-c', 'credential.helper=fake'], env: { CODEOME_GIT_TOKEN: 'fake-token' } };
  for (const subcommand of ['push', 'pull', 'fetch']) {
    const args = [subcommand, 'origin', { nested: ['main'] }];
    const original = structuredClone(args);
    const invocation = github.gitInvocation(ctx, args);
    assert.deepStrictEqual(invocation.args, [...ctx.args, ...original]);
    assert.notStrictEqual(invocation.args, args);
    assert.deepStrictEqual(args, original);
  }
  for (const args of [['pushx', 'origin'], [' push', 'origin'], [], [0, 'origin'], [null, 'origin'], [{ command: 'push' }, 'origin']]) {
    const original = structuredClone(args);
    assert.deepStrictEqual(github.gitInvocation(ctx, args), { args, env: {} });
    assert.deepStrictEqual(args, original);
  }
});

test('validation handles rejected requests, malformed JSON, and scope-header edges without leaking tokens', async () => {
  const token = 'ghp_TESTTOKEN_' + randomBytes(12).toString('hex');
  const validate = (fetch) => github.provider('github').validate(token, 'github.com', { fetch });
  const networkFailure = await validate(async () => { throw new Error(`request failed for ${token}`); });
  assert.deepStrictEqual(networkFailure, {
    status: 'error', login: null, scopes: null, message: 'Could not validate the GitHub account.'
  });
  const malformed = await validate(async () => ({
    status: 200, headers: { get: () => 'repo' },
    json: async () => { throw new SyntaxError(`invalid JSON near ${token}`); }
  }));
  assert.strictEqual(malformed.status, 'error');
  assert.ok(!JSON.stringify(malformed).includes(token));
  assert.deepStrictEqual(await validate(async () => response(200, ' workflow, repo ')), {
    status: 'valid', login: 'octocat', scopes: ['workflow', 'repo']
  });
  assert.deepStrictEqual(await validate(async () => response(200, '')), {
    status: 'missing-scopes', login: 'octocat', scopes: [], warnings: ['workflow']
  });
  // A rate-limit 403 is an error, not an invalid token, so it never blocks the account.
  const limited = await validate(async () => response(403, null));
  assert.strictEqual(limited.status, 'error');
  assert.ok(!JSON.stringify(limited).includes('secret'));
});

test('static smoke guard for the account bridge and main-process secret reads', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../main/preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
  const start = preload.indexOf('  gitAccounts: {');
  assert.ok(start >= 0);
  const end = preload.indexOf('\n  },', start);
  assert.ok(end > start);
  const bridge = preload.slice(start, end);
  const methods = [...bridge.matchAll(/^\s+([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]);
  assert.ok(methods.length > 0);
  assert.ok(methods.every((method) => !/token|secret|get.?secret/i.test(method)), methods.join(', '));

  const secretReads = main.split('\n').filter((line) => line.includes("getSecret('github:"));
  assert.strictEqual(secretReads.length, 1);
  assert.ok(secretReads.every((line) => !/\breturn\b/.test(line)));
  const accountHandlers = main.slice(main.indexOf('// ---------- GitHub accounts ----------'), main.indexOf('// ---------- Python packages ----------'));
  assert.ok(accountHandlers.includes(secretReads[0].trim()));
});

test('free text may span lines and start with a dash, as the app sends it', () => {
  assert.strictEqual(github.checkGitArgs(['commit', '-m', 'Subject\n\nBody line']), null);
  assert.strictEqual(github.checkGhArgs(['pr', 'create', '--title', 'title', '--body', 'one\ntwo\n- three']), null);
  assert.strictEqual(github.checkGhArgs(['release', 'create', 'v1', '--title', 'v1', '--notes', '- fixed a bug\n- another']), null);
  assert.strictEqual(github.checkGhArgs(['pr', 'create', '--title', 'a\nb']) === null, false);
  assert.strictEqual(github.checkGhArgs(['pr', 'create', '--body', 'a\0b']) === null, false);
  assert.strictEqual(github.checkGitArgs(['push', 'origin', 'a\nb']) === null, false);
});
