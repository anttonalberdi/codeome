const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
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
  assert.match(c.cmd, /^umask 077; mkdir -p .*chmod 700.*cat > .*mv /);
  assert.match(c.cmd, /\.codeome\/secrets\/one-[0-9a-f]{8}\.env/);
  assert.ok(c.o.input.includes("export A_TOKEN="));
  for (const v of Object.values(store)) assert.ok(!c.cmd.includes(v) && !JSON.stringify(r).includes(v));
});

test('sync with nothing to send deletes the remote file', async () => {
  const calls = [];
  const exec = async (h, cmd, o) => { calls.push({ cmd, o }); return { code: 0 }; };
  const r = await S.sync('/p/One', { host: 'hpc', list: [{ name: 'C', hpc: false }], get, exec });
  assert.strictEqual(r.removed, true);
  assert.strictEqual(r.count, 0);
  assert.strictEqual(calls[0].cmd, `rm -f "${S.remotePath('/p/One')}"`);
  assert.strictEqual(calls[0].o.input, undefined);
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
