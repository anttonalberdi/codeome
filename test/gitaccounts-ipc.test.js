const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const github = require('../main/github');
const scratch = require('../main/scratch');
const usage = require('../main/usage');

const source = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

test('config:set keeps main-process GitHub bindings and renderer policy and chat defaults', () => {
  const handlers = {};
  const current = { accounts: {}, gitAccounts: [{ id: 'real' }], projectAccounts: { '/project': 'real' } };
  const context = {
    cfg: current,
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    usage: { ENV_VAR: {} },
    config: { save: (cfg) => cfg },
    applyProxy: () => {}, publishUsage: () => {}, refreshUsage: () => {}
  };
  vm.runInNewContext(section("ipcMain.handle('config:set'", "ipcMain.handle('secret:set'"), context);
  const saved = handlers['config:set'](null, {
    accounts: {}, gitAccounts: [{ id: 'injected', token: 'secret' }], projectAccounts: { '/project': 'injected' },
    policyDefaults: { slurmSubmit: 'never' }, projectChat: { '/project': { model: 'opus' } }
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(saved.gitAccounts)), [{ id: 'real' }]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(saved.projectAccounts)), { '/project': 'real' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(saved.policyDefaults)), { slurmSubmit: 'never' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(saved.projectChat)), { '/project': { model: 'opus' } });
});

function accountHandlers() {
  const handlers = {};
  const secrets = new Map();
  let encrypted = true;
  let validation = { status: 'valid', login: 'octocat', scopes: ['repo'] };
  let gh = { code: 1, stdout: '', stderr: '' };
  let failKey = null;
  const calls = [];
  const events = [];
  const config = {
    secretsEncrypted: () => encrypted,
    getSecret: (key) => secrets.get(key) || '',
    setSecret: (key, value) => { events.push('secret'); if (value) secrets.set(key, value); else secrets.delete(key); },
    save: (cfg) => { events.push('save'); return cfg; }
  };
  const provider = { ...github.PROVIDERS.github, validate: async () => validation };
  const context = {
    cfg: { gitAccounts: [], projectAccounts: {}, openProjects: ['/project'] }, config,
    github: { ...github, provider: (id) => id === 'github' ? provider : github.provider(id) },
    crypto: { randomUUID: () => 'account-1' }, path,
    openRoots: () => ['/project'],
    fetch: () => { throw new Error('Unexpected network request'); },
    run: async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return cmd === 'gh' ? gh : { code: args.includes(failKey) ? 1 : 0, stdout: '', stderr: 'write failed' }; },
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    wrap: (fn) => async (_event, ...args) => { try { return { data: await fn(...args) }; } catch (e) { return { error: String(e.message || e) }; } }
  };
  vm.runInNewContext(section('// ---------- GitHub accounts ----------', '// ---------- Python packages ----------'), context);
  const call = (name, arg) => handlers['gitacct:' + name](null, arg);
  return { call, secrets, calls, events, context, setEncrypted: (value) => { encrypted = value; }, setValidation: (value) => { validation = value; }, setGh: (value) => { gh = value; }, setFailKey: (value) => { failKey = value; } };
}

test('GitHub account IPC keeps tokens private and removal clears bindings', async () => {
  const h = accountHandlers();
  h.setEncrypted(false);
  assert.match((await h.call('add', { provider: 'github', host: 'github.com', token: 'secret' })).error, /encrypted secret storage/);
  assert.strictEqual(h.secrets.size, 0);
  h.setEncrypted(true);
  h.setValidation({ status: 'invalid', login: null, scopes: null });
  assert.ok((await h.call('add', { provider: 'github', host: 'github.com', token: 'secret' })).error);
  assert.strictEqual(h.secrets.size, 0);
  h.setValidation({ status: 'valid', login: 'octocat', scopes: ['repo'], warnings: ['workflow'] });
  const added = await h.call('add', { provider: 'github', host: 'github.com', token: ' secret ' });
  assert.strictEqual(added.data.id, 'account-1');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(added.data.warnings)), ['workflow']);
  assert.strictEqual(h.secrets.get('github:account-1'), 'secret');
  assert.ok(!JSON.stringify(added).includes('secret'));
  await h.call('bind', { root: '/project', id: 'account-1' });
  assert.ok(!JSON.stringify(await h.call('list')).includes('secret'));
  h.setValidation({ status: 'missing-scopes', login: 'octocat', scopes: [] });
  const validated = await h.call('validate', { id: 'account-1' });
  assert.strictEqual(validated.data.status, 'missing-scopes');
  assert.ok(!JSON.stringify(validated).includes('secret'));
  await h.call('remove', { id: 'account-1' });
  assert.deepStrictEqual(h.events.slice(-2), ['save', 'secret']);
  assert.strictEqual(h.secrets.size, 0);
  assert.deepStrictEqual(JSON.parse(JSON.stringify((await h.call('list')).data)), { accounts: [], bindings: {} });
});

test('account validation errors leave cached status and addition needs a login', async () => {
  const h = accountHandlers();
  h.setValidation({ status: 'valid', login: null, scopes: null });
  assert.match((await h.call('add', { provider: 'github', host: 'github.com', token: 'secret' })).error, /account login/);
  assert.strictEqual(h.secrets.size, 0);
  h.setValidation({ status: 'valid', login: 'octocat', scopes: ['repo'] });
  await h.call('add', { provider: 'github', host: 'github.com', token: 'secret' });
  const before = JSON.stringify((await h.call('list')).data);
  h.setValidation({ status: 'error', login: null, scopes: null });
  assert.strictEqual((await h.call('validate', { id: 'account-1' })).error, 'Could not reach GitHub. Try again later.');
  assert.strictEqual(JSON.stringify((await h.call('list')).data), before);
  assert.match((await h.call('remove', { id: 1 })).error, /not found/);
  assert.match((await h.call('remove', { id: 'missing' })).error, /not found/);
  assert.ok(h.secrets.has('github:account-1'));
});

test('gh import checks the host and does not return CLI output on failure', async () => {
  const h = accountHandlers();
  assert.ok((await h.call('import-gh', { host: 'host/path' })).error);
  assert.strictEqual(h.calls.length, 0);
  h.setGh({ code: 1, stdout: 'secret', stderr: 'secret' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await h.call('import-gh', { host: 'github.com' }))), { error: 'gh is not signed in for that host.' });
  assert.strictEqual(h.secrets.size, 0);
  assert.deepStrictEqual(Array.from(h.calls[0].args), ['auth', 'token', '--hostname', 'github.com']);
});

test('git identity rejects unsafe values before running a command', async () => {
  const h = accountHandlers();
  for (const name of ['-bad', 'bad\nname', 'bad\rname']) {
    assert.ok((await h.call('identity-set', { root: '/project', name, email: '' })).error);
  }
  assert.strictEqual(h.calls.length, 0);
  for (const name of ['bad\0name', 'x'.repeat(257)]) assert.ok((await h.call('identity-set', { root: '/project', name, email: '' })).error);
  await h.call('identity-set', { root: '/project', name: ' A Name ', email: ' a@example.com ' });
  assert.deepStrictEqual(h.calls.slice(0, 2).map((call) => Array.from(call.args)), [
    ['config', '--local', 'user.name', 'A Name'],
    ['config', '--local', 'user.email', 'a@example.com']
  ]);
  h.setFailKey('user.email');
  assert.match((await h.call('identity-set', { root: '/project', name: 'A', email: 'a@example.com' })).error, /user\.email/);
});

function gitHandlers() {
  const handlers = {};
  const calls = [];
  const cfg = { gitAccounts: [], projectAccounts: {}, openProjects: ['/project'] };
  let token = 'private-token';
  let reply = { code: 0, stdout: '', stderr: '' };
  let runHandler = null;
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args: Array.from(args), opts });
    if (cmd === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: '/project\n', stderr: '' };
    if (cmd === 'git' && args[0] === 'status') return { code: 0, stdout: '## main\n', stderr: '' };
    if (cmd === 'gh' && args[0] === 'auth') return { code: 0, stdout: '', stderr: '' };
    return runHandler ? runHandler(cmd, args, opts) : reply;
  };
  vm.runInNewContext(section('// ---------- Git & GitHub ----------', '// ---------- Zenodo ----------'), {
    cfg, config: { getSecret: () => token }, github, scratch, run, path, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }
  });
  return {
    cfg, calls,
    call: (name, arg) => handlers[name](null, arg),
    setToken: (value) => { token = value; },
    setReply: (value) => { reply = value; },
    setRun: (value) => { runHandler = value; }
  };
}

test('scratch is excluded from Git project roots', async () => {
  const h = gitHandlers();
  const dir = path.join(usage.home(), 'scratch');
  h.cfg.openProjects.push(dir);
  assert.strictEqual((await h.call('git:run', { root: dir, args: ['push', 'origin'] })).error, 'Choose an open project.');
  assert.strictEqual(h.calls.length, 0);
});

test('Git and gh handlers inject only for bound network commands after allowlist checks', async () => {
  const h = gitHandlers();
  await h.call('git:run', { root: '/project', args: ['push', 'origin'] });
  assert.deepStrictEqual(h.calls.pop().args, ['push', 'origin']);
  await h.call('gh:run', { root: '/project', args: ['repo', 'view'] });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(h.calls.pop().opts.env)), {});

  h.cfg.gitAccounts = [{ id: 'a', provider: 'github', host: 'github.com', login: 'octocat', status: 'valid' }];
  h.cfg.projectAccounts['/project'] = 'a';
  for (const subcommand of ['push', 'pull', 'fetch']) {
    await h.call('git:run', { root: '/project', args: [subcommand, 'origin'] });
    const call = h.calls.pop();
    assert.deepStrictEqual(call.args, [...github.provider('github').credentialArgs('github.com'), subcommand, 'origin']);
    assert.strictEqual(call.opts.env.CODEOME_GIT_TOKEN, 'private-token');
    assert.ok(!JSON.stringify(call.args).includes('private-token'));
  }
  await h.call('git:run', { root: '/project', args: ['commit', '-m', 'message'] });
  const commit = h.calls.pop();
  assert.deepStrictEqual(commit.args, ['commit', '-m', 'message']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(commit.opts.env)), {});
  await h.call('gh:run', { root: '/project', args: ['repo', 'view'] });
  assert.strictEqual(h.calls.pop().opts.env.GH_TOKEN, 'private-token');

  const count = h.calls.length;
  assert.match((await h.call('git:run', { root: '/project', args: ['-c', 'credential.helper=bad', 'push'] })).error, /Not allowed/);
  assert.match((await h.call('gh:run', { root: '/project', args: ['auth', 'token'] })).error, /Not allowed/);
  assert.strictEqual(h.calls.length, count);
});

test('local Git commands work with unusable accounts; network commands and closed roots do not run', async () => {
  const h = gitHandlers();
  h.cfg.gitAccounts = [{ id: 'a', provider: 'github', host: 'github.com', login: 'octocat', status: 'invalid' }];
  h.cfg.projectAccounts['/project'] = 'a';
  assert.strictEqual((await h.call('git:run', { root: '/project', args: ['commit', '-m', 'message'] })).ok, true);
  assert.match((await h.call('git:run', { root: '/project', args: ['push'] })).error, /no longer valid/);
  assert.strictEqual((await h.call('gh:run', { root: '/project', args: ['browse'] })).ok, true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(h.calls.pop().opts.env)), {});
  const count = h.calls.length;
  for (const [name, arg] of [['git:run', { root: '/other', args: ['commit', '-m', 'x'] }],
    ['gh:run', { root: '/project2', args: ['browse'] }], ['git:status', '/other']]) {
    assert.match((await h.call(name, arg)).error, /open project/);
  }
  assert.strictEqual(h.calls.length, count);
});

test('bound command handlers report unusable accounts and redact command output', async () => {
  const h = gitHandlers();
  h.cfg.gitAccounts = [{ id: 'a', provider: 'github', host: 'github.com', login: 'octocat', status: 'valid' }];
  h.cfg.projectAccounts['/project'] = 'a';
  h.setToken('');
  assert.match((await h.call('git:run', { root: '/project', args: ['push'] })).error, /token for octocat@github\.com is missing/);
  assert.match((await h.call('gh:run', { root: '/project', args: ['repo', 'view'] })).error, /token for octocat@github\.com is missing/);
  assert.strictEqual(h.calls.length, 0);
  h.setToken('private-token');
  h.cfg.gitAccounts[0].status = 'invalid';
  assert.match((await h.call('git:run', { root: '/project', args: ['fetch'] })).error, /no longer valid/);
  assert.strictEqual(h.calls.length, 0);
  h.cfg.gitAccounts[0].status = 'valid';

  h.setReply({ code: 0, stdout: 'private-token ', stderr: 'private-token' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await h.call('git:run', { root: '/project', args: ['push'] }))), { ok: true, out: '*** ***' });
  h.setReply({ code: 1, stdout: 'private-token', stderr: 'private-token' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await h.call('gh:run', { root: '/project', args: ['repo', 'view'] }))), { error: '***' });
});

test('git status uses bound enterprise account for gh auth status', async () => {
  const h = gitHandlers();
  const unbound = await h.call('git:status', '/project');
  assert.strictEqual(unbound.account, undefined);
  assert.deepStrictEqual(h.calls.filter((call) => call.cmd === 'gh').pop().args, ['auth', 'status']);

  h.cfg.gitAccounts = [{ id: 'a', provider: 'github', host: 'ghe.corp.example', login: 'octocat', status: 'valid' }];
  h.cfg.projectAccounts['/project'] = 'a';
  const bound = await h.call('git:status', '/project');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(bound.account)), { id: 'a', login: 'octocat', host: 'ghe.corp.example', status: 'valid' });
  assert.ok(!JSON.stringify(bound).includes('private-token'));
  const ghCall = h.calls.filter((call) => call.cmd === 'gh').pop();
  assert.deepStrictEqual(ghCall.args, ['auth', 'status', '--hostname', 'ghe.corp.example']);
  assert.strictEqual(ghCall.opts.env.GH_ENTERPRISE_TOKEN, 'private-token');
  assert.strictEqual(ghCall.opts.env.GH_HOST, 'ghe.corp.example');
});
