const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const App = { views: {}, h: () => ({}) };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/js/packages.js'), 'utf8'), { App });
const P = App.views.packages;
const plain = (x) => JSON.parse(JSON.stringify(x));

test('R scaffold creates a project file and starter only when selected', () => {
  const result = plain(P.rScaffold('field study', { rproj: true, rmd: true, gitignore: false }, []));
  assert.deepStrictEqual(result.files.map((f) => f.name), ['field study.Rproj', 'analysis.Rmd']);
  assert.match(result.files[0].content, /^Version: 1\.0\nRestoreWorkspace: No\nSaveWorkspace: No\n/);
  assert.match(result.files[1].content, /title: "field study analysis"/);
  assert.deepStrictEqual(result.skipped, []);
});

test('R scaffold keeps existing files and appends only missing ignore entries', () => {
  const before = '# existing\n.Rhistory\ncustom/';
  const result = plain(P.rScaffold('study', { rproj: true, rmd: true, gitignore: true },
    ['study.Rproj', 'analysis.Rmd', '.gitignore'], before));
  assert.deepStrictEqual(result.skipped, ['study.Rproj', 'analysis.Rmd']);
  assert.deepStrictEqual(result.files.map((f) => f.name), ['.gitignore']);
  assert.strictEqual(result.files[0].content,
    '# existing\n.Rhistory\ncustom/\n.Rproj.user\n.RData\nrenv/library\n');
});

test('R scaffold leaves a complete gitignore alone', () => {
  const result = plain(P.rScaffold('study', { gitignore: true }, ['.gitignore'],
    '.Rproj.user/\n.Rhistory\n.RData\nrenv/library/\n'));
  assert.deepStrictEqual(result.files, []);
  assert.deepStrictEqual(result.skipped, ['.gitignore (entries already present)']);
});

test('R scaffold deduplicates rooted entries with trailing whitespace and preserves CRLF', () => {
  const before = '/.Rproj.user/  \r\n/.Rhistory\t\r\n.RData  \r\n# keep';
  const result = plain(P.rScaffold('study', { gitignore: true }, ['.gitignore'], before));
  assert.deepStrictEqual(result.files, [{ name: '.gitignore', content: before + '\r\nrenv/library\r\n' }]);
  const complete = plain(P.rScaffold('study', { gitignore: true }, ['.gitignore'],
    before + '\r\n/renv/library/  \r\n'));
  assert.deepStrictEqual(complete.files, []);
});

test('R scaffold appends to empty and unterminated gitignore files', () => {
  const entries = '.Rproj.user\n.Rhistory\n.RData\nrenv/library\n';
  const empty = plain(P.rScaffold('study', { gitignore: true }, [], ''));
  assert.deepStrictEqual(empty.files, [{ name: '.gitignore', content: entries }]);
  const unterminated = plain(P.rScaffold('study', { gitignore: true }, ['.gitignore'], '# notes'));
  assert.deepStrictEqual(unterminated.files, [{ name: '.gitignore', content: '# notes\n' + entries }]);
});

test('R scaffold plans every file when all four setup options are selected', () => {
  const result = plain(P.rScaffold('study', { rproj: true, renv: true, gitignore: true, rmd: true }, []));
  assert.deepStrictEqual(result.files.map((f) => f.name), ['study.Rproj', 'analysis.Rmd', '.gitignore']);
  assert.deepStrictEqual(result.skipped, []);
});
