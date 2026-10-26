const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const vm = require('node:vm');
const { createStore } = require('../main/secret-files');
const secrets = require('../main/secrets');
const sync = require('../main/secrets-sync');
const chat = require('../main/chat');
const ssh = require('../main/ssh');

const pem = '-----BEGIN PRIVATE KEY-----\n"quoted" \'apostrophe\' $HOME `whoami`\né✓\n-----END PRIVATE KEY-----\n';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-adversarial-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('PEM bytes survive local placement; filename is ignored and private modes are enforced', (t) => {
  const base = temp(t);
  const file = createStore(base).place({ name: 'SIGNING_KEY', ext: '.p8', filename: '../../escape' }, pem);
  assert.equal(path.basename(file), 'SIGNING_KEY.p8');
  assert.deepEqual(fs.readFileSync(file), Buffer.from(pem, 'utf8'));
  assert.equal(fs.statSync(path.dirname(path.dirname(file))).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(base, 'escape')), false);
});

test('traversal, long extension, NUL and invalid UTF-8 fail before filesystem writes', (t) => {
  const base = temp(t);
  const store = createStore(base);
  for (const meta of [
    { name: '../x' }, { name: 'X', ext: '.p8/../..' },
    { name: 'X', ext: '.' + 'p'.repeat(17) },
    { name: 'X', ext: '.p8\0outside' }
  ]) assert.throws(() => store.place(meta, pem));
  for (const content of ['', 'x'.repeat(65537), 'a\0b', '\ud800', Buffer.from([0xff])])
    assert.throws(() => store.place({ name: 'X', ext: '.p8' }, content));
  assert.equal(secrets.valueError('file', 'x'.repeat(65536)), '');
  assert.equal(fs.existsSync(path.join(base, 'secret-files')), false);
});

test('planted run, target and base links cannot redirect placement', (t) => {
  const base = temp(t);
  const outside = temp(t);
  const sentinel = path.join(outside, 'sentinel');
  fs.writeFileSync(sentinel, 'untouched');
  const baseLink = path.join(base, 'base-link');
  fs.symlinkSync(outside, baseLink);
  assert.throws(() => createStore(baseLink).place({ name: 'KEY' }, pem), /Unsafe secret directory/);

  const store = createStore(base);
  const first = store.place({ name: 'FIRST' }, pem);
  const target = path.join(path.dirname(first), 'SECOND.p8');
  fs.symlinkSync(sentinel, target);
  assert.throws(() => store.place({ name: 'SECOND', ext: '.p8' }, pem), /Unsafe secret file/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');

  const run = path.dirname(first);
  const parked = run + '.parked';
  fs.renameSync(run, parked);
  fs.symlinkSync(outside, run);
  assert.throws(() => store.place({ name: 'THIRD' }, pem), /Unsafe secret directory/);
  assert.equal(fs.existsSync(path.join(outside, 'THIRD')), false);
});

test('loose permissions are rejected and a new store sweeps a crashed run', (t) => {
  const base = temp(t);
  const crashed = createStore(base);
  const file = crashed.place({ name: 'KEY' }, pem);
  fs.chmodSync(file, 0o644);
  assert.throws(() => crashed.place({ name: 'KEY' }, pem), /Unsafe secret file/);
  fs.chmodSync(file, 0o600);
  fs.chmodSync(path.dirname(file), 0o755);
  assert.throws(() => crashed.place({ name: 'OTHER' }, pem), /Unsafe secret directory/);
  fs.chmodSync(path.dirname(file), 0o700);

  const next = createStore(base);
  next.sweepStale();
  assert.equal(fs.existsSync(file), false);
  const current = next.place({ name: 'CURRENT' }, pem);
  next.sweepStale();
  assert.deepEqual(fs.readFileSync(current), Buffer.from(pem));
});

test('legacy text values remain text; removing local access deletes a placed file', (t) => {
  const base = temp(t);
  const store = createStore(base);
  const entries = [{ name: 'LEGACY', terminals: true, agents: true },
    { name: 'SIGNING_KEY', kind: 'file', ext: '.p8', terminals: true, agents: true }];
  const get = (key) => key === 'user:LEGACY' ? 'plain-text' : pem;
  const terminal = secrets.envFor(entries, 'terminals', get, '/project', store.place);
  assert.equal(terminal.LEGACY, 'plain-text');
  assert.deepEqual(fs.readFileSync(terminal.SIGNING_KEY), Buffer.from(pem));
  const agents = secrets.envFor(entries, 'agents', get, '/project', store.place);
  assert.equal(agents.SIGNING_KEY, terminal.SIGNING_KEY);
  entries[1].terminals = false;
  entries[1].agents = false;
  store.remove('SIGNING_KEY');
  assert.equal(fs.existsSync(terminal.SIGNING_KEY), false);
  assert.deepEqual(secrets.envFor(entries, 'terminals', get, '/project', store.place), { LEGACY: 'plain-text' });
});

test('HPC script preserves PEM bytes, keeps prior files on a failed stage, and rotates the tag', async (t) => {
  const home = temp(t);
  const project = '/p/signer';
  const entry = { name: 'SIGNING_KEY', kind: 'file', ext: '.p8', hpc: true };
  const list = [entry];
  let content = pem;
  const get = () => content;
  const exec = async (_host, command, options) => {
    assert.equal(command.includes(content), false);
    assert.equal(command.includes(Buffer.from(content).toString('base64')), false);
    const argv = ssh.execArgs('local', command);
    assert.equal(argv.some((arg) => arg.includes(content) || arg.includes(Buffer.from(content).toString('base64'))), false);
    try {
      execFileSync('sh', ['-c', command], { input: options.input, env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
      return { code: 0 };
    } catch (error) { return { code: 1, stderr: String(error.stderr) }; }
  };
  const deps = () => ({ host: 'local', list, get, exec });
  const filename = path.join(home, '.codeome', 'secrets', 'files', sync.slug(project), 'SIGNING_KEY.p8');
  const salt = Buffer.from('fixed-test-salt');
  const firstTag = sync.tag(list, project, get, salt);
  assert.equal((await sync.sync(project, deps)).ok, true);
  assert.deepEqual(fs.readFileSync(filename), Buffer.from(pem));
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(filename)).mode & 0o777, 0o700);

  content = pem.replace('é✓', 'rotated');
  assert.notEqual(sync.tag(list, project, get, salt), firstTag);
  const failed = await sync.sync(project, () => ({ ...deps(), exec: async (host, command, options) =>
    exec(host, command, { ...options, input: 'SIGNING_KEY.p8 !!!\n---\n' + sync.build(list, project, get).text }) }));
  assert.ok(failed.error);
  assert.deepEqual(fs.readFileSync(filename), Buffer.from(pem));
  assert.equal((await sync.sync(project, deps)).ok, true);
  assert.deepEqual(fs.readFileSync(filename), Buffer.from(content));
});

test('config.json and agent prompt contain metadata, never PEM contents', (t) => {
  const userData = temp(t);
  const resolved = require.resolve('../main/config');
  const originalLoad = Module._load;
  Module._load = function (name, parent, ...args) {
    if (name === 'electron' && parent && parent.filename === resolved)
      return { app: { getPath: () => userData }, safeStorage: { isEncryptionAvailable: () => false } };
    return originalLoad.call(this, name, parent, ...args);
  };
  let config;
  try { delete require.cache[resolved]; config = require('../main/config'); }
  finally { Module._load = originalLoad; delete require.cache[resolved]; }
  config.save({ ...config.DEFAULTS, secrets: [{ name: 'SIGNING_KEY', kind: 'file', ext: '.p8', value: pem, note: 'safe note' }] });
  const saved = fs.readFileSync(path.join(userData, 'config.json'), 'utf8');
  assert.equal(saved.includes(pem.split('\n')[0]), false);
  assert.equal(saved.includes('"value"'), false);
  const prompt = chat.secretsPrompt({ list: [{ name: 'SIGNING_KEY', kind: 'file', local: true, hpc: true, value: pem, note: pem }] });
  assert.equal(prompt.includes(pem.split('\n')[0]), false);
  assert.match(prompt, /never print, cat, copy, log or commit/);
});

test('IPC replies omit content and the real file stays until both local scopes are off', (t) => {
  const base = temp(t);
  const store = createStore(base);
  const main = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
  const section = (start, end) => main.slice(main.indexOf(start), main.indexOf(end, main.indexOf(start)));
  const handlers = {};
  const placedSecrets = new Set(['SIGNING_KEY']);
  const context = {
    cfg: { accounts: {}, secrets: [{ name: 'SIGNING_KEY', kind: 'file', ext: '.p8', terminals: true, agents: true }], gitAccounts: [], projectAccounts: {} },
    secrets, placedSecrets, secretFileStore: store,
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    usage: { ENV_VAR: {} }, config: { save: (value) => value, setSecret: () => {}, getSecret: () => pem },
    applyProxy: () => {}, publishUsage: () => {}, syncAllSecretsQuietly: () => {}, mirrorGeneralQuietly: () => {},
    clipboard: { writeText: () => { throw new Error('copied'); } }, clearCopied: () => {}, setTimeout: () => 1, COPY_SECONDS: 30
  };
  vm.runInNewContext(section("ipcMain.handle('config:set'", "ipcMain.handle('secret:set'"), context);
  vm.runInNewContext('let copied = null;\n' + section("ipcMain.handle('secrets:set'", '// ---------- dialogs & shell ----------'), context);
  const first = store.place(context.cfg.secrets[0], pem);
  const replaced = handlers['secrets:set'](null, { name: 'SIGNING_KEY', value: pem + 'rotated' });
  assert.equal(replaced.ok, true);
  assert.equal(JSON.stringify(replaced).includes('-----BEGIN PRIVATE KEY-----'), false);
  assert.equal(fs.readFileSync(first, 'utf8'), pem + 'rotated');
  const copy = handlers['secrets:copy'](null, 'SIGNING_KEY');
  assert.equal(JSON.stringify(copy).includes('-----BEGIN PRIVATE KEY-----'), false);

  handlers['config:set'](null, { ...context.cfg, secrets: [{ ...context.cfg.secrets[0], terminals: false }] });
  assert.equal(fs.existsSync(first), true);
  handlers['config:set'](null, { ...context.cfg, secrets: [{ ...context.cfg.secrets[0], agents: false }] });
  assert.equal(fs.existsSync(first), false);
});

test('rejected local content and thrown ssh errors omit the secret from messages', async (t) => {
  const store = createStore(temp(t));
  let message = '';
  try { store.place({ name: 'KEY' }, 'sensitive\0suffix'); }
  catch (error) { message = error.message; }
  assert.ok(message);
  assert.equal(message.includes('sensitive'), false);
  const result = await sync.sync('/p/thrown', { host: 'hpc',
    list: [{ name: 'SIGNING_KEY', kind: 'file', ext: '.p8', hpc: true }], get: () => pem,
    exec: async () => { const error = new Error('transport timed out: ' + pem); error.code = 'ETIMEDOUT'; throw error; } });
  assert.ok(result.error);
  assert.equal(JSON.stringify(result).includes('-----BEGIN PRIVATE KEY-----'), false);
});

test('remote stderr echoed from ssh must never enter the sync reply', async () => {
  const project = '/p/stderr';
  const list = [{ name: 'SIGNING_KEY', kind: 'file', ext: '.p8', hpc: true }];
  const reply = await sync.sync(project, { host: 'hpc', list, get: () => pem,
    exec: async () => ({ code: 1, stderr: pem }) });
  assert.equal(JSON.stringify(reply).includes(pem.split('\n')[0]), false);
});
