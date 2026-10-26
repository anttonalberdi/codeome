const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const S = require('../main/secrets-sync');

const store = { 'user:A_TOKEN': "it's $HOME `id` \"q\"\nline2 é✓", 'user:B': 'bval-9z', 'user:C': 'cval-9z', 'user:BAD': 'x\0y', 'user:PATH': 'pval-9z' };
const get = (k) => store[k] || '';
const list = [
  { name: 'A_TOKEN', hpc: true },
  { name: 'B', hpc: true, projects: ['/p/one'] },
  { name: 'C', hpc: false },
  { name: 'BAD', hpc: true },
  { name: 'PATH', hpc: true },
  { name: '1x', hpc: true }
];

test('slug is lowercase, hyphenated, safe and unique per path', () => {
  assert.match(S.slug('/Users/me/My Project_v2/'), /^my-project-v2-[0-9a-f]{8}$/);
  assert.match(S.slug('/x/../..weird;rm -rf'), /^weird-rm-rf-[0-9a-f]{8}$/);
  assert.match(S.slug('/x/日本'), /^project-[0-9a-f]{8}$/);
  assert.match(S.remotePath('/a/Foo'), /^\$HOME\/\.codeome\/secrets\/foo-[0-9a-f]{8}\.env$/);
  assert.notStrictEqual(S.slug('/a/foo'), S.slug('/b/foo'));
  assert.strictEqual(S.slug('/a/foo/'), S.slug('/a/foo'));
});

test('values are single-quoted and survive a real shell', () => {
  const b = S.build(list, '/p/other', get);
  assert.deepStrictEqual(b.names, ['A_TOKEN']);
  assert.ok(b.text.includes("export A_TOKEN='it'\\''s $HOME `id` \"q\"\nline2 é✓'"));
  const out = execFileSync('sh', ['-c', b.text + '\nprintf %s "$A_TOKEN"'], { encoding: 'utf8' });
  assert.strictEqual(out, store['user:A_TOKEN']);
});

test('filters by project, hpc scope, name and NUL', () => {
  assert.deepStrictEqual(S.build(list, '/p/one', get).names, ['A_TOKEN', 'B']);
  assert.deepStrictEqual(S.build(list, '/p/other', get).names, ['A_TOKEN']);
  assert.deepStrictEqual(S.build(list, '', get).names, ['A_TOKEN']);
  assert.deepStrictEqual(S.build(list, '/p/one', get).skipped, ['BAD']);
  assert.ok(!S.build(list, '/p/one', get).text.includes('\0'));
});

test('sync sends values only on stdin, atomically', async () => {
  const calls = [];
  const exec = async (host, cmd, o) => { calls.push({ host, cmd, o }); return { code: 0, stdout: '', stderr: '' }; };
  const r = await S.sync('/p/One', { host: 'hpc', list, get, exec: exec });
  assert.deepStrictEqual(r, { ok: true, count: 1, names: ['A_TOKEN'], skipped: ['BAD'], removed: false });
  const c = calls[0];
  const f = S.remotePath('/p/One');
  const files = `$HOME/.codeome/secrets/files/${S.slug('/p/One')}`;
  const prune = `rm -rf "${files}".tmp.* "${files}".old.*`;
  const oldCmd = `umask 077; ${prune} && mkdir -p "$HOME/.codeome/secrets" && chmod 700 "$HOME/.codeome" "$HOME/.codeome/secrets" && cat > "${f}.tmp.$$" && mv "${f}.tmp.$$" "${f}" || { rm -f "${f}.tmp.$$"; exit 1; }`;
  assert.strictEqual(c.cmd, `${oldCmd} && rm -rf "$HOME/.codeome/secrets/files/${S.slug('/p/One')}"`);
  assert.match(c.cmd, /\.codeome\/secrets\/one-[0-9a-f]{8}\.env/);
  assert.strictEqual(c.o.input, `# Written by Codeome from your secrets (Settings > Secrets). Do not edit or commit.\nexport A_TOKEN=${S.quote(store['user:A_TOKEN'])}\n`);
  for (const v of Object.values(store)) assert.ok(!c.cmd.includes(v) && !JSON.stringify(r).includes(v));
});

test('sync with nothing to send deletes the remote file', async () => {
  const calls = [];
  const exec = async (h, cmd, o) => { calls.push({ cmd, o }); return { code: 0 }; };
  const r = await S.sync('/p/One', { host: 'hpc', list: [{ name: 'C', hpc: false }], get, exec });
  assert.strictEqual(r.removed, true);
  assert.strictEqual(r.count, 0);
  const files = `$HOME/.codeome/secrets/files/${S.slug('/p/One')}`;
  assert.strictEqual(calls[0].cmd, `rm -rf "${files}".tmp.* "${files}".old.* && rm -f "${S.remotePath('/p/One')}" && rm -rf "${files}"`);
  assert.strictEqual(calls[0].o.input, undefined);
});

test('file secrets use framed stdin, paths in env, and content in the tag', async () => {
  const content = 'first line\n"quoted" and \'apostrophe\'\nlast line';
  const second = 'another\nfile';
  const entries = [{ name: 'SIGNING_KEY', kind: 'file', ext: '.p8', hpc: true }, { name: 'CERT', kind: 'file', hpc: true }, { name: 'B', hpc: true }];
  const read = (k) => k === 'user:SIGNING_KEY' ? content : k === 'user:CERT' ? second : get(k);
  const project = '/p/One';
  const built = S.build(entries, project, read);
  const file = `$HOME/.codeome/secrets/files/${S.slug(project)}/SIGNING_KEY.p8`;
  assert.deepStrictEqual(built.names, ['SIGNING_KEY', 'CERT', 'B']);
  assert.ok(built.text.includes(`export SIGNING_KEY="${file}"\n`));
  assert.ok(!built.text.includes(content));
  assert.deepStrictEqual(S.plan(entries, project, read), { names: built.names, skipped: [], path: S.remotePath(project).replace('$HOME', '~') });
  const calls = [];
  const result = await S.sync(project, { host: 'hpc', list: entries, get: read, exec: async (h, cmd, o) => { calls.push({ cmd, o }); return { code: 0 }; } });
  assert.strictEqual(result.count, 3);
  assert.strictEqual(calls.length, 1);
  const encoded = Buffer.from(content).toString('base64');
  const secondEncoded = Buffer.from(second).toString('base64');
  assert.strictEqual(calls[0].o.input, `SIGNING_KEY.p8 ${encoded}\nCERT ${secondEncoded}\n---\n${built.text}`);
  assert.strictEqual(calls[0].o.timeout, 30000);
  assert.ok(!calls[0].o.input.includes(content));
  assert.ok(!calls[0].cmd.includes(content) && !calls[0].cmd.includes(encoded) && !calls[0].cmd.includes(second) && !calls[0].cmd.includes(secondEncoded));
  assert.notStrictEqual(S.tag(entries, project, read, Buffer.from('salt')), S.tag(entries, project, (k) => k === 'user:SIGNING_KEY' ? content + '\nrotated' : read(k), Buffer.from('salt')));
});

test('invalid file content and extension are skipped by name', () => {
  const entries = [
    { name: 'NUL_FILE', kind: 'file', hpc: true },
    { name: 'BIG_FILE', kind: 'file', hpc: true },
    { name: 'INVALID_FILE', kind: 'file', hpc: true },
    { name: 'EMPTY_FILE', kind: 'file', hpc: true },
    { name: 'BAD_EXT', kind: 'file', ext: '.p/8', hpc: true }
  ];
  const values = { 'user:NUL_FILE': 'a\0b', 'user:BIG_FILE': 'x'.repeat(65537), 'user:INVALID_FILE': '\ud800', 'user:EMPTY_FILE': '', 'user:BAD_EXT': 'valid' };
  const built = S.build(entries, '/p', (k) => values[k]);
  assert.deepStrictEqual(built.names, []);
  assert.deepStrictEqual(built.skipped, ['NUL_FILE', 'BIG_FILE', 'INVALID_FILE', 'EMPTY_FILE', 'BAD_EXT']);
  assert.strictEqual(built.text, '');
});

test('remote script round-trips file content and prunes files on text-only and empty sync', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-sync-'));
  const project = '/p/One';
  let content = 'line one\n"double" \'single\' $HOME `literal`\n';
  const entries = [{ name: 'SIGNING_KEY', kind: 'file', ext: '.p8', hpc: true }, { name: 'B', hpc: true }];
  const read = (k) => k === 'user:SIGNING_KEY' ? content : get(k);
  const run = async (current) => S.sync(project, { host: 'local', list: current, get: read, exec: async (h, cmd, o) => {
    execFileSync('sh', ['-c', cmd], { input: o.input, env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    return { code: 0 };
  } });
  const fileDir = path.join(home, '.codeome', 'secrets', 'files', S.slug(project));
  const filePath = path.join(fileDir, 'SIGNING_KEY.p8');
  const envPath = path.join(home, '.codeome', 'secrets', `${S.slug(project)}.env`);
  try {
    assert.strictEqual((await run(entries)).ok, true);
    assert.strictEqual(fs.readFileSync(filePath, 'utf8'), content);
    assert.strictEqual(fs.statSync(fileDir).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(envPath).mode & 0o777, 0o600);
    assert.ok(fs.readFileSync(envPath, 'utf8').includes(`export SIGNING_KEY="$HOME/.codeome/secrets/files/${S.slug(project)}/SIGNING_KEY.p8"`));
    assert.strictEqual(execFileSync('sh', ['-c', `. "$HOME/.codeome/secrets/${S.slug(project)}.env"; printf '%s' "$SIGNING_KEY"`], { env: { ...process.env, HOME: home }, encoding: 'utf8' }), filePath);
    for (const suffix of ['tmp.stale', 'old.stale']) {
      const stale = fileDir + '.' + suffix;
      fs.mkdirSync(stale);
      fs.writeFileSync(path.join(stale, 'leftover'), 'stale');
    }
    content = 'rotated\n"again"\n';
    assert.strictEqual((await run(entries)).ok, true);
    assert.strictEqual(fs.readFileSync(filePath, 'utf8'), content);
    assert.strictEqual(fs.existsSync(fileDir + '.tmp.stale'), false);
    assert.strictEqual(fs.existsSync(fileDir + '.old.stale'), false);
    assert.strictEqual((await run([{ ...entries[0], ext: '.pem' }, entries[1]])).ok, true);
    assert.strictEqual(fs.existsSync(filePath), false);
    assert.strictEqual(fs.readFileSync(path.join(fileDir, 'SIGNING_KEY.pem'), 'utf8'), content);
    fs.mkdirSync(fileDir + '.tmp.stale');
    fs.mkdirSync(fileDir + '.old.stale');
    assert.strictEqual((await run(entries.slice(1))).ok, true);
    assert.strictEqual(fs.existsSync(fileDir), false);
    assert.strictEqual(fs.existsSync(fileDir + '.tmp.stale'), false);
    assert.strictEqual(fs.existsSync(fileDir + '.old.stale'), false);
    assert.strictEqual(fs.existsSync(envPath), true);
    fs.mkdirSync(fileDir + '.tmp.stale');
    fs.mkdirSync(fileDir + '.old.stale');
    assert.strictEqual((await run([])).ok, true);
    assert.strictEqual(fs.existsSync(envPath), false);
    assert.strictEqual(fs.existsSync(fileDir), false);
    assert.strictEqual(fs.existsSync(fileDir + '.tmp.stale'), false);
    assert.strictEqual(fs.existsSync(fileDir + '.old.stale'), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a failed env swap restores the previous file directory and removes the stage', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-sync-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = '/p/rollback';
  const list = [{ name: 'KEY', kind: 'file', hpc: true }];
  let content = 'original';
  const execute = async (_host, command, options) => {
    try {
      execFileSync('sh', ['-c', command], { input: options.input, env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
      return { code: 0 };
    } catch { return { code: 1 }; }
  };
  const deps = (exec) => ({ host: 'local', list, get: () => content, exec });
  const dir = path.join(home, '.codeome', 'secrets', 'files', S.slug(project));
  const env = path.join(home, '.codeome', 'secrets', S.slug(project) + '.env');
  assert.strictEqual((await S.sync(project, deps(execute))).ok, true);
  const oldEnv = fs.readFileSync(env, 'utf8');
  content = 'replacement';
  const failed = await S.sync(project, deps((host, command, options) => {
    const swap = `mv "$_cx_env" "${S.remotePath(project)}"`;
    assert.ok(command.includes(swap));
    return execute(host, command.replace(swap, 'false'), options);
  }));
  assert.ok(failed.error);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'KEY'), 'utf8'), 'original');
  assert.strictEqual(fs.readFileSync(env, 'utf8'), oldEnv);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(dir)), [S.slug(project)]);
});

test('a failed sync reports no values', async () => {
  const exec = async () => ({ code: 1, stderr: 'permission denied\nmore' });
  const r = await S.sync('/p', { host: 'h', list, get, exec });
  assert.match(r.error, /permission denied/);
  const t = await S.sync('/p', { host: 'h', list, get, exec: async () => { throw new Error(store['user:B']); } });
  assert.ok(!JSON.stringify(t).includes('bval-9z'));
});

test('plan lists names and the path only', () => {
  const p = S.plan(list, '/p/one', get);
  assert.deepStrictEqual(p, { names: ['A_TOKEN', 'B'], skipped: ['BAD'], path: S.remotePath('/p/one').replace('$HOME', '~') });
});

test('syncs of one project run in order and the last state wins', async () => {
  const log = [];
  let list2 = [{ name: 'B', hpc: true }];
  const mk = (delay) => async (h, cmd, o) => { await new Promise((r) => setTimeout(r, delay)); log.push(o && o.input ? 'write' : 'delete'); return { code: 0 }; };
  const first = S.sync('/p/q', { host: 'h', list: list2, get, exec: mk(30) });
  const second = S.sync('/p/q', () => ({ host: 'h', list: [], get, exec: mk(0) }));
  await Promise.all([first, second]);
  assert.deepStrictEqual(log, ['write', 'delete']);
});

test('the source step switches tracing off and back on', () => {
  const out = execFileSync('bash', ['-c', 'set -x; ' + S.sourceCmd('/nope') + '; echo "$-"'], { encoding: 'utf8' });
  assert.match(out, /x/);
  const cmd = S.sourceCmd('/p');
  assert.ok(cmd.indexOf('set +x') < cmd.indexOf('. "') && cmd.indexOf('. "') < cmd.indexOf('set -x'));
});

test('the source step survives set -u in sh and bash', () => {
  for (const sh of ['sh', 'bash']) {
    assert.strictEqual(execFileSync(sh, ['-u', '-c', S.sourceCmd('/nope') + '; echo ok'], { encoding: 'utf8' }).trim(), 'ok');
    assert.strictEqual(execFileSync(sh, ['-u', '-c', 'set -x; ' + S.sourceCmd('/nope') + '; echo ok'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 'ok');
  }
});

test('the tracker is told in queue order and the session tag follows the secrets', async () => {
  const seen = [];
  const track = (h, p, on) => seen.push(on);
  const exec = async (h, c, o) => { await new Promise((r) => setTimeout(r, o && o.input ? 30 : 0)); return { code: 0 }; };
  await Promise.all([S.sync('/p/t', { host: 'h', list, get, exec, track }), S.sync('/p/t', { host: 'h', list: [], get, exec, track })]);
  assert.deepStrictEqual(seen, [true, false]);
  const salt = Buffer.from('salt');
  const t1 = S.tag(list, '/p/one', get, salt);
  assert.match(t1, /^[0-9a-f]{8}$/);
  assert.notStrictEqual(t1, S.tag(list, '/p/one', (k) => (k === 'user:A_TOKEN' ? 'other' : get(k)), salt));
  assert.notStrictEqual(t1, S.tag(list, '/p/one', get, Buffer.from('salt2')));
  assert.notStrictEqual(t1, S.tag([], '/p/one', get, salt));
});
