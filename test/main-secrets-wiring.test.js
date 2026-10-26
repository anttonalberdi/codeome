const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const secrets = require('../main/secrets');

const source = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

test('terminal and agent environments place file secrets and send paths only', () => {
  const placed = [];
  const cfg = { secrets: [{ name: 'KEY', kind: 'file', ext: '.p8', terminals: true, agents: true }] };
  const context = { cfg, secrets, config: { getSecret: () => 'private\ncontent' },
    placedSecrets: new Set(), secretFileStore: { place: (meta, value) => {
      placed.push([meta.name, value]); return '/private/KEY.p8';
    } } };
  const { userSecretEnv, SECRET_SCOPE } = vm.runInNewContext(
    section('const SECRET_SCOPE =', 'const HPC_SOURCING =') + '\n({ userSecretEnv, SECRET_SCOPE })', context);
  for (const scope of [SECRET_SCOPE.shell, SECRET_SCOPE['agent-local'], 'agents']) {
    const env = userSecretEnv(scope, '/project');
    assert.equal(env.KEY, '/private/KEY.p8');
    assert.ok(!JSON.stringify(env).includes('private\ncontent'));
  }
  assert.equal(placed.length, 3);
  assert.equal(context.placedSecrets.has('KEY'), true);
});

test('placement failures do not escape local environment or agent prompt build', () => {
  const privateValue = 'private\ncontent';
  const context = { cfg: { secrets: [{ name: 'KEY', kind: 'file', agents: true }] }, secrets,
    config: { getSecret: () => privateValue }, placedSecrets: new Set(), secretFileStore: null };
  const { userSecretEnv } = vm.runInNewContext(
    section('const SECRET_SCOPE =', 'const HPC_SOURCING =') + '\n({ userSecretEnv })', context);
  assert.equal(JSON.stringify(userSecretEnv('agents', '/project')), '{}');
  const info = vm.runInNewContext('(() => {\n' + section('  const secretsInfo = (() => {', '\n  let s;') + '\nreturn secretsInfo; })()', {
    cfg: context.cfg, project: '/project', secrets, userSecretEnv,
    secretsSync: { plan: () => ({ names: [], path: '' }) }, config: context.config
  });
  assert.equal(info.list.length, 0);
  assert.equal(JSON.stringify(info).includes(privateValue), false);
});

test('secret IPC validates file content, keeps replacement kind, and never replies with content', () => {
  const handlers = {}, values = new Map(), placed = [], removed = [];
  const cfg = { secrets: [] };
  const context = { cfg, secrets, placedSecrets: new Set(), COPY_SECONDS: 30,
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    config: { getSecret: (key) => values.get(key) || '', setSecret: (key, value) => {
      if (value) values.set(key, value); else values.delete(key);
    }, hasSecret: (key) => values.has(key) },
    secretFileStore: { place: (meta, value) => { placed.push([meta.name, meta.ext, value]); return '/private/KEY.p8'; }, remove: (name) => removed.push(name) },
    syncAllSecretsQuietly: () => {}, clipboard: { writeText: () => { throw new Error('copied'); } },
    clearCopied: () => {}, setTimeout: () => 1
  };
  vm.runInNewContext('let copied = null;\n' + section("ipcMain.handle('secrets:set'", '// ---------- dialogs & shell ----------'), context);
  const set = (value, kind, ext) => handlers['secrets:set'](null, { name: 'KEY', value, kind, ext });
  assert.equal(set('private\ncontent', 'file', '.p8').ok, true);
  assert.equal(values.get('user:KEY'), 'private\ncontent');
  cfg.secrets.push({ name: 'KEY', kind: 'file', ext: '.p8', agents: true });
  context.placedSecrets.add('KEY');
  assert.equal(set('new\ncontent').ok, true);
  assert.deepEqual(placed, [['KEY', '.p8', 'new\ncontent']]);
  assert.match(set('x', 'text').error, /Remove/);
  assert.ok(set('x\0secret').error);
  assert.ok(set('x'.repeat(65537)).error);
  assert.ok(set('x', 'file', '../bad').error);
  assert.ok(!JSON.stringify(set('new\ncontent')).includes('new\ncontent'));
  assert.match(handlers['secrets:copy'](null, 'KEY').error, /cannot be copied/);
  assert.equal(handlers['secrets:remove'](null, 'KEY').ok, true);
  assert.deepEqual(removed, ['KEY']);
  assert.equal(values.has('user:KEY'), false);
});

test('text removal skips local files and failed file removal still clears the value', () => {
  const handlers = {}, values = new Map([['user:TEXT', 'text content'], ['user:FILE', 'file content']]);
  const removed = [];
  const placedSecrets = new Set(['FILE']);
  const context = { cfg: { secrets: [{ name: 'TEXT' }, { name: 'FILE', kind: 'file' }] }, secrets, placedSecrets,
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    config: { setSecret: (key, value) => { if (value) values.set(key, value); else values.delete(key); } },
    secretFileStore: { remove: (name) => { removed.push(name); throw new Error('file content'); } },
    syncAllSecretsQuietly: () => {} };
  vm.runInNewContext('let copied = null;\n' + section("ipcMain.handle('secrets:set'", '// ---------- dialogs & shell ----------'), context);
  assert.equal(handlers['secrets:remove'](null, 'TEXT').ok, true);
  assert.equal(values.has('user:TEXT'), false);
  assert.deepEqual(removed, []);
  const result = handlers['secrets:remove'](null, 'FILE');
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes('file content'), false);
  assert.equal(values.has('user:FILE'), false);
  assert.equal(placedSecrets.has('FILE'), false);
  assert.deepEqual(removed, ['FILE']);
});

test('config changes remove a placed file only when no local scope remains or access narrows', () => {
  const handlers = {}, removed = [], placedSecrets = new Set(['KEY']);
  const old = { name: 'KEY', kind: 'file', ext: '.p8', terminals: true, agents: true };
  const context = { cfg: { accounts: {}, secrets: [old], gitAccounts: [], projectAccounts: {} },
    secrets, placedSecrets, secretFileStore: { remove: (name) => removed.push(name) },
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, usage: { ENV_VAR: {} },
    config: { save: (next) => next }, applyProxy: () => {}, publishUsage: () => {},
    syncAllSecretsQuietly: () => {}, mirrorGeneralQuietly: () => {}
  };
  vm.runInNewContext(section("ipcMain.handle('config:set'", "ipcMain.handle('secret:set'"), context);
  const save = (change) => handlers['config:set'](null, { ...context.cfg, secrets: [{ ...context.cfg.secrets[0], ...change }] });
  save({ hpc: true });
  assert.deepEqual(removed, []);
  save({ terminals: false });
  assert.deepEqual(removed, []);
  save({ agents: false });
  assert.deepEqual(removed, ['KEY']);
  save({ projects: ['/project'] });
  assert.deepEqual(removed, ['KEY', 'KEY']);
});

test('config cleanup clears placed state when file removal fails', () => {
  const handlers = {}, placedSecrets = new Set(['KEY']);
  const old = { name: 'KEY', kind: 'file', terminals: true, agents: false };
  const context = { cfg: { accounts: {}, secrets: [old], gitAccounts: [], projectAccounts: {} },
    secrets, placedSecrets, secretFileStore: { remove: () => { throw new Error('private content'); } },
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }, usage: { ENV_VAR: {} },
    config: { save: (next) => next }, applyProxy: () => {}, publishUsage: () => {},
    syncAllSecretsQuietly: () => {}, mirrorGeneralQuietly: () => {}
  };
  vm.runInNewContext(section("ipcMain.handle('config:set'", "ipcMain.handle('secret:set'"), context);
  const result = handlers['config:set'](null, { ...context.cfg, secrets: [{ ...old, terminals: false }] });
  assert.equal(placedSecrets.has('KEY'), false);
  assert.equal(JSON.stringify(result).includes('private content'), false);
});

test('agent secret metadata exposes file kind and quit hooks clean up files', () => {
  const info = vm.runInNewContext('(() => {\n' + section('  const secretsInfo = (() => {', '\n  let s;') + '\nreturn secretsInfo; })()', {
    cfg: { secrets: [{ name: 'KEY', kind: 'file' }] }, project: '/project', secrets,
    userSecretEnv: () => ({ KEY: '/private/KEY' }),
    secretsSync: { plan: () => ({ names: [], path: '' }) }, config: { getSecret: () => '' }
  });
  assert.equal(info.list[0].kind, 'file');
  assert.ok(!JSON.stringify(info).includes('private/KEY'));

  const hooks = {}, cleaned = [];
  vm.runInNewContext(section("app.on('before-quit'", "app.on('window-all-closed'"), {
    app: { on: (name, fn) => { hooks[name] = fn; } }, secretFileStore: { cleanupAll: () => cleaned.push(true) },
    forumHost: { disposeAll: () => {} }, clearCopied: () => {}, stopLogins: () => {}, tunnel: null,
    heartbeatTimer: null, clearInterval: () => {}, flushRendererLogs: () => {}, crashlog: { markClean: () => {} }
  });
  hooks['before-quit']();
  hooks['will-quit']();
  assert.equal(cleaned.length, 2);
  assert.match(source, /app\.whenReady\(\)\.then\(\(\) => \{\s*secretFileStore = createStore\(app\.getPath\('userData'\)\);\s*try \{ secretFileStore\.sweepStale\(\); \} catch \{\}/);
});
