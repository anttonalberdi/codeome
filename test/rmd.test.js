const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// rmd.js is a renderer script; load it with just enough of App around it.
function loadRmd() {
  const App = { views: {}, ext: (p) => { const m = String(p).split('/').pop().match(/\.([^.]+)$/); return m ? m[1].toLowerCase() : ''; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/js/rmd.js'), 'utf8'), { App, window: {} });
  return App.views.rmd;
}
const R = loadRmd();
// Values made in the script's own context have other prototypes; compare them as data.
const plain = (x) => JSON.parse(JSON.stringify(x));

test('R statements span open brackets, pipes and else', () => {
  const lines = [
    'library(dplyr)',
    '',
    'df <- data.frame(',
    '  x = 1:3,  # a comment with a ) in it',
    '  y = c("a", "b)", "c")',
    ')',
    'df %>%',
    '  # filter step',
    '  filter(x > 1) |>',
    '  nrow()',
    'if (TRUE) {',
    '  1',
    '}',
    'else {',
    '  2',
    '}',
    'f <- function(x) x + 1'
  ];
  assert.deepStrictEqual(plain(R.statements(lines)), [[0, 0], [2, 5], [6, 9], [10, 15], [16, 16]]);
});

test('an unfinished string keeps the statement going', () => {
  assert.deepStrictEqual(plain(R.statements(['x <- "a', 'b"', 'y <- 2'])), [[0, 1], [2, 2]]);
});

test('statementAt finds the statement around any of its lines, and none on a blank line', () => {
  const lines = ['a <- 1', '', 'b <- sum(', '  1, 2', ')'];
  const model = { getLineCount: () => lines.length, getLineContent: (n) => lines[n - 1] };
  assert.deepStrictEqual(plain(R.statementAt(model, 4)), { start: 3, end: 5 });
  assert.deepStrictEqual(plain(R.statementAt(model, 1)), { start: 1, end: 1 });
  assert.strictEqual(R.statementAt(model, 2), null);
});

test('chunks are found with their engine and label, closed or not', () => {
  const lines = [
    '---', 'title: x', '---', '',
    '```{r setup, include=FALSE}', 'library(x)', '```', '',
    'Some `r 1+1` prose.', '',
    '```{python}', 'print(1)', '```', '',
    '````{r}', '```', 'still r', '````', '',
    '```{r last}', 'unclosed'
  ];
  const cs = R.parseChunks(lines);
  assert.deepStrictEqual(plain(cs.map((c) => [c.start, c.end, c.engine, c.label, c.closed])), [
    [5, 7, 'r', 'setup', true],
    [11, 13, 'python', '', true],
    [15, 18, 'r', '', true],
    [20, 21, 'r', 'last', false]
  ]);
});

test('Rmd and Quarto files are recognised', () => {
  assert.ok(R.isRmd('/a/report.Rmd'));
  assert.ok(R.isRmd('doc.qmd'));
  assert.ok(!R.isRmd('script.R'));
});
