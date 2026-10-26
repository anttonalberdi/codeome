const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createStore } = require('../main/secret-files');

function withBase(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-secret-files-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

test('places private files lazily, reuses unchanged content and replaces changed content', (t) => {
  const base = withBase(t);
  const store = createStore(base);
  assert.strictEqual(fs.existsSync(path.join(base, 'secret-files')), false);
  const meta = { name: 'API_KEY', ext: '.p8', filename: '../../original.txt' };
  const file = store.place(meta, 'first\nline');
  assert.strictEqual(path.basename(file), 'API_KEY.p8');
  assert.strictEqual(path.dirname(path.dirname(file)), path.join(base, 'secret-files'));
  assert.strictEqual(fs.statSync(path.join(base, 'secret-files')).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  const first = fs.statSync(file).ino;
  assert.strictEqual(store.place(meta, 'first\nline'), file);
  assert.strictEqual(fs.statSync(file).ino, first);
  assert.strictEqual(store.place(meta, 'second\nline'), file);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'second\nline');
  assert.notStrictEqual(fs.statSync(file).ino, first);
});

test('refuses traversal and invalid file content before creating a directory', (t) => {
  const base = withBase(t);
  const store = createStore(base);
  for (const meta of [{ name: '../x' }, { name: 'GOOD', ext: '.p/../x' }, { name: 'GOOD', ext: 0 }, { name: 'GOOD', ext: null }, { name: 'PATH' }]) {
    assert.throws(() => store.place(meta, 'content'));
  }
  for (const value of ['', 'a\0b', 'x'.repeat(65537), '\ud800']) {
    assert.throws(() => store.place({ name: 'GOOD' }, value));
  }
  assert.throws(() => store.remove('../x'));
  assert.strictEqual(fs.existsSync(path.join(base, 'secret-files')), false);
});

test('refuses a symlinked base or a symlink planted at the target', (t) => {
  const base = withBase(t);
  const outside = withBase(t);
  const link = path.join(base, 'link');
  fs.symlinkSync(outside, link);
  assert.throws(() => createStore(link).place({ name: 'SECRET' }, 'content'));
  assert.deepStrictEqual(fs.readdirSync(outside), []);

  const store = createStore(base);
  const first = store.place({ name: 'FIRST' }, 'content');
  const target = path.join(path.dirname(first), 'SECOND.p8');
  const sentinel = path.join(outside, 'sentinel');
  fs.writeFileSync(sentinel, 'untouched');
  fs.symlinkSync(sentinel, target);
  assert.throws(() => store.place({ name: 'SECOND', ext: '.p8' }, 'content'));
  assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'untouched');
  assert.strictEqual(fs.lstatSync(target).isSymbolicLink(), true);
});

test('remove deletes only the named secret and cleanupAll removes the run directory', (t) => {
  const base = withBase(t);
  const store = createStore(base);
  const a = store.place({ name: 'A', ext: '.p8' }, 'a');
  const b = store.place({ name: 'B' }, 'b');
  const renamed = store.place({ name: 'A', ext: '.pem' }, 'a');
  assert.strictEqual(fs.existsSync(a), false);
  store.remove('A');
  assert.strictEqual(fs.existsSync(renamed), false);
  assert.strictEqual(fs.readFileSync(b, 'utf8'), 'b');
  store.cleanupAll();
  assert.strictEqual(fs.existsSync(path.dirname(b)), false);
  assert.deepStrictEqual(fs.readdirSync(path.join(base, 'secret-files')), []);
});

test('sweepStale removes other runs and leaves the current run alone', (t) => {
  const base = withBase(t);
  const old = createStore(base);
  const oldFile = old.place({ name: 'OLD' }, 'old');
  const current = createStore(base);
  const currentFile = current.place({ name: 'CURRENT' }, 'current');
  current.sweepStale();
  assert.strictEqual(fs.existsSync(path.dirname(oldFile)), false);
  assert.strictEqual(fs.readFileSync(currentFile, 'utf8'), 'current');
  current.cleanupAll();
  current.sweepStale();
  assert.deepStrictEqual(fs.readdirSync(path.join(base, 'secret-files')), []);
});

test('sweepStale removes stray files, unsafe directories and links without following them', (t) => {
  const base = withBase(t);
  const outside = withBase(t);
  const root = path.join(base, 'secret-files');
  const current = createStore(base);
  const keep = current.place({ name: 'CURRENT' }, 'current');
  fs.writeFileSync(path.join(root, '.DS_Store'), 'stray');
  const loose = path.join(root, 'loose');
  fs.mkdirSync(loose, { mode: 0o755 });
  const sentinel = path.join(outside, 'sentinel');
  fs.writeFileSync(sentinel, 'keep');
  fs.symlinkSync(outside, path.join(root, 'link'));
  current.sweepStale();
  assert.deepStrictEqual(fs.readdirSync(root), [path.basename(path.dirname(keep))]);
  assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'keep');
});

test('secret file module loads without process.getuid', (t) => {
  const source = fs.readFileSync(path.join(__dirname, '../main/secret-files.js'), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(source, { module, process: {}, Buffer,
    require: (name) => name === './secrets' ? require('../main/secrets') : require(name) });
  const base = withBase(t);
  const file = module.exports.createStore(base).place({ name: 'KEY' }, 'content');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'content');
});
