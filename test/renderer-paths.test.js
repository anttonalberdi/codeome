const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../renderer/js/core.js'), 'utf8');
const App = {};
vm.runInNewContext(source.slice(source.indexOf('App.posix ='), source.indexOf('// ---------- toasts ----------')), { App });

test('local basename, dirname and ext accept Windows and POSIX separators', () => {
  assert.equal(App.basename('C:\\a\\b.txt'), 'b.txt');
  assert.equal(App.dirname('C:\\a\\b.txt'), 'C:\\a');
  assert.equal(App.ext('C:\\a\\b.TXT'), 'txt');
  assert.equal(App.basename('C:/a/b'), 'b');
  assert.equal(App.dirname('C:/a/b'), 'C:/a');
  assert.equal(App.ext('C:/a/b'), '');
  assert.equal(App.basename('\\\\srv\\share\\f'), 'f');
  assert.equal(App.dirname('\\\\srv\\share\\f'), '\\\\srv\\share');
  assert.equal(App.ext('\\\\srv\\share\\f'), '');
  assert.equal(App.basename('/remote/x'), 'x');
  assert.equal(App.dirname('/remote/x'), '/remote');
  assert.equal(App.ext('/remote/x.R'), 'r');
  assert.equal(App.basename('~/x'), 'x');
  assert.equal(App.dirname('~/x'), '~');
  assert.equal(App.ext('~/x.py'), 'py');
});

test('roots and trailing separators keep their root', () => {
  assert.equal(App.basename('/'), '/');
  assert.equal(App.dirname('/'), '/');
  assert.equal(App.basename('C:\\'), 'C:\\');
  assert.equal(App.dirname('C:\\'), 'C:\\');
  assert.equal(App.basename('C:/'), 'C:/');
  assert.equal(App.dirname('C:/'), 'C:/');
  assert.equal(App.ext('C:/'), '');
  assert.equal(App.dirname('C:\\a'), 'C:\\');
  assert.equal(App.dirname('C:/a'), 'C:/');
  assert.equal(App.basename('C:\\a\\b\\'), 'b');
  assert.equal(App.dirname('C:\\a\\b\\'), 'C:\\a');
  assert.equal(App.basename('/remote/x/'), 'x');
  assert.equal(App.dirname('/remote/x/'), '/remote');
  assert.equal(App.ext('/remote/x.TXT/'), 'txt');
  assert.equal(App.dirname('\\\\srv\\share'), '\\\\srv\\share');
});

test('isAbs recognizes local roots without treating ordinary relative paths as absolute', () => {
  for (const p of ['~other/x', '/', '/remote/x', '~', '~/x', 'C:\\', 'C:\\a\\b.txt', 'C:/', 'C:/a/b', '\\\\srv\\share', '\\\\srv\\share\\f']) assert.equal(App.isAbs(p), true, p);
  for (const p of ['', 'x', 'a/b', 'a\\b', 'C:relative']) assert.equal(App.isAbs(p), false, p);
});

test('POSIX helpers keep backslashes as filename characters on remote paths', () => {
  assert.equal(App.posix.basename('/remote/a\\b.txt'), 'a\\b.txt');
  assert.equal(App.posix.dirname('/remote/a\\b.txt'), '/remote');
  assert.equal(App.posix.basename('/remote/x/'), 'x');
  assert.equal(App.posix.dirname('/remote/x/'), '/remote');
  assert.equal(App.posix.basename('/'), '/');
  assert.equal(App.posix.dirname('/'), '/');
});

 test('darwin filenames preserve backslashes', () => {
  App.platform = 'darwin';
  assert.equal(App.basename('/a/b\\c.txt'), 'b\\c.txt');
  assert.equal(App.dirname('/a/b\\c.txt'), '/a');
});
