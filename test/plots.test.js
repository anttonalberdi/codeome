const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { parsePackages, isSessionDir, renderName, LOCAL_DIR } = require('../main/rtools');

// plots.js and packages.js are renderer scripts; load them with just enough of App around them.
function load(file) {
  const App = { views: {}, h: () => ({}), cfg: { plots: { fit: false, w: 89, h: 70, unit: 'mm', dpi: 300, bg: 'white', format: 'pdf' } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/js', file), 'utf8'), { App, window: {} });
  return App;
}
const plain = (x) => JSON.parse(JSON.stringify(x));
const A = load('plots.js'), P = A.views.plots;
const K = load('packages.js').views.packages;

test('plot messages from R parse, and junk is ignored', () => {
  assert.deepStrictEqual(plain(P.parseOsc('hello;1;/Users/me/.cache/codeome/plots/20261010-1')), { type: 'hello', version: 1, dir: '/Users/me/.cache/codeome/plots/20261010-1' });
  const m = P.parseOsc('plot;3;1;6.875;4.5;192;transparent;1;/home/u/.cache/codeome/plots/a;b');
  assert.deepStrictEqual(plain(m), { type: 'plot', id: 3, replace: true, w: 6.875, h: 4.5, res: 192, bg: 'transparent', ok: true, dir: '/home/u/.cache/codeome/plots/a;b' });
  assert.strictEqual(P.parseOsc('plot;x;0;7;5;96;white;1;/d'), null);
  assert.strictEqual(P.parseOsc('plot;1;0;0;5;96;white;1;/d'), null);
  assert.strictEqual(P.parseOsc('something else'), null);
});

test('canvas units convert through inches', () => {
  assert.strictEqual(P.toIn(25.4, 'mm', 300), 1);
  assert.strictEqual(P.toIn(2.54, 'cm', 300), 1);
  assert.strictEqual(P.toIn(600, 'px', 300), 2);
  assert.strictEqual(P.fromIn(2, 'px', 150), 300);
  const cv = P.canvas();
  assert.strictEqual(P.num(cv.w), '3.504');
  assert.strictEqual(cv.dpi, 300);
});

test('the view resolution fills the panel, and actual size is 96 px per inch', () => {
  assert.strictEqual(P.viewRes({ w: 7, h: 5 }, { w: 700, h: 700 }, 2, 'fit'), 200);
  assert.strictEqual(P.viewRes({ w: 7, h: 5 }, { w: 700, h: 250 }, 1, 'fit'), 50);
  assert.strictEqual(P.viewRes({ w: 7, h: 5 }, { w: 10, h: 10 }, 1, 'fit'), 24);
  assert.strictEqual(P.viewRes({ w: 7, h: 5 }, { w: 700, h: 700 }, 2, 'actual'), 192);
  // Keys match what R reports back for the same canvas.
  assert.strictEqual(P.key({ w: 3.50393700787, h: 2.7559, res: 85.2, bg: 'white' }), '3.504x2.756@85-white');
});

test('presets are recognised from the settings', () => {
  assert.strictEqual(P.presetOf({ fit: true }), 'fit');
  assert.strictEqual(P.presetOf({ fit: false, w: 183, h: 110, unit: 'mm' }), 'col2');
  assert.strictEqual(P.presetOf({ fit: false, w: 183, h: 111, unit: 'mm' }), 'custom');
});

test('export code matches the canvas', () => {
  const c = { fit: false, w: 89, h: 70, unit: 'mm', dpi: 300, bg: 'white', format: 'png' };
  const cv = { w: 89 / 25.4, h: 70 / 25.4, dpi: 300, bg: 'white' };
  assert.strictEqual(P.code('ggsave', c, cv), 'ggsave("plot.png", width = 89, height = 70, units = "mm", dpi = 300)');
  assert.match(P.code('device', c, cv), /^png\("plot.png", width = 89, height = 70, units = "mm", res = 300\)\n/);
  assert.match(P.code('device', { ...c, format: 'pdf' }, { ...cv, bg: 'transparent' }), /^pdf\("plot.pdf", width = 3.5, height = 2.76, bg = "transparent"\)/);
  assert.strictEqual(P.code('ggsave', { ...c, format: 'jpeg' }, cv), 'ggsave("plot.jpg", width = 89, height = 70, units = "mm", dpi = 300)');
});

test('R libraries and packages parse, skipping .Rprofile output', () => {
  const out = [
    'renv: project activated',
    '@@R\t4.4.1',
    '@@LIB\t1\t/proj/renv/library/macos/R-4.4/aarch64-apple-darwin20',
    '@@LIB\t0\t/opt/R/4.4/lib/R/library',
    '@@PKG\t/opt/R/4.4/lib/R/library\tbase\t4.4.1\tbase\t',
    '@@PKG\t/proj/renv/library/macos/R-4.4/aarch64-apple-darwin20\tvegan\t2.6-8\t\tCRAN',
    '@@PKG\t/proj/renv/library/macos/R-4.4/aarch64-apple-darwin20\tDESeq2\t1.44.0\t\tbioc',
    '@@OLD\t/proj/renv/library/macos/R-4.4/aarch64-apple-darwin20\tvegan\t2.6-8\t2.7-1',
    ''].join('\n');
  const r = parsePackages(out);
  assert.strictEqual(r.r, '4.4.1');
  assert.deepStrictEqual(r.libs.map((l) => [l.writable, l.pkgs.map((p) => p.name)]), [[true, ['DESeq2', 'vegan']], [false, ['base']]]);
  assert.strictEqual(r.libs[0].pkgs[0].source, 'bioc');
  assert.strictEqual(r.old['/proj/renv/library/macos/R-4.4/aarch64-apple-darwin20\tvegan'], '2.7-1');
  assert.strictEqual(K.libLabel(r.libs[0], '/Users/me'), 'Project (renv)');
  assert.strictEqual(K.libLabel(r.libs[1], '/Users/me'), 'System');
  assert.strictEqual(K.libLabel({ path: '/Users/me/Library/R/arm64/4.4/library', pkgs: [] }, '/Users/me'), 'User');
  assert.strictEqual(K.libLabel({ path: '/usr/lib/R/site-library', pkgs: [] }, '/home/u'), 'Site');
});

test('R projects are recognised from their top-level files', () => {
  assert.strictEqual(K.isRProject(['demo.Rproj', 'data']), true);
  assert.strictEqual(K.isRProject(['DESCRIPTION', 'R']), true);
  assert.strictEqual(K.isRProject(['analysis.R']), true);
  assert.strictEqual(K.isRProject(['report.Rmd']), true);
  assert.strictEqual(K.isRProject(['package.json', 'main', 'README.md']), false);
});

test('only plot folders made by plots.R are rendered', () => {
  assert.strictEqual(isSessionDir('local', path.join(LOCAL_DIR, 'plots', '20261010-064655-1')), true);
  assert.strictEqual(isSessionDir('local', path.join(LOCAL_DIR, 'plots', '..', 'x')), false);
  assert.strictEqual(isSessionDir('local', path.join(os.tmpdir(), 'x')), false);
  assert.strictEqual(isSessionDir('hpc', '/home/abc123/.cache/codeome/plots/20261010-1-99'), true);
  assert.strictEqual(isSessionDir('hpc', '/home/abc123/.cache/codeome/plots/a/../../b'), false);
  assert.strictEqual(isSessionDir('hpc', '/tmp/evil'), false);
});

test('rendered files are named by plot, revision and canvas', () => {
  assert.strictEqual(renderName({ id: 3, rev: 2, w: 3.50393, h: 2.7559, res: 300, bg: 'white', fmt: 'png' }), '3.2-3.504x2.756-300-white.png');
  assert.strictEqual(renderName({ id: 1, w: 7, h: 5, res: 96, bg: 'transparent', fmt: 'svg' }), '1.0-7x5-96-transparent.svg');
});
