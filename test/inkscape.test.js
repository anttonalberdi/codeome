const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const inkscape = require('../main/inkscape');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-ink-'));
const fake = (dir, version = '1.4.4') => {
  const bin = path.join(dir, 'Inkscape.app/Contents/MacOS/inkscape');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!/bin/sh\necho "Inkscape ${version} (abc, 2026-01-01)"\n`, { mode: 0o755 });
  return bin;
};

test('a configured path may name the binary or the app bundle, and must be executable', () => {
  const d = tmp(); const bin = fake(d);
  assert.strictEqual(inkscape.resolve(bin), bin);
  assert.strictEqual(inkscape.resolve(path.join(d, 'Inkscape.app')), bin);
  assert.strictEqual(inkscape.resolve(path.join(d, 'missing')), '');
  assert.strictEqual(inkscape.resolve(d), '');
  assert.strictEqual(inkscape.resolve(''), '');
});

test('detect uses the configured path first and reads the version', async () => {
  const bin = fake(tmp(), '9.9.9');
  assert.deepStrictEqual(await inkscape.detect({ configured: bin }), { path: bin, version: '9.9.9' });
});

test('detect reports a missing Inkscape as an empty path', async () => {
  const r = await inkscape.detect({ configured: path.join(tmp(), 'nope') });
  if (r.path) return; // Inkscape really is installed on this machine
  assert.deepStrictEqual(r, { path: '' });
});

test('files open through the app bundle on macOS and directly elsewhere', () => {
  const bin = '/Applications/Inkscape.app/Contents/MacOS/inkscape';
  assert.deepStrictEqual(inkscape.openCommand(bin, '/p/fig.svg', 'darwin'), ['open', ['-a', '/Applications/Inkscape.app', '/p/fig.svg']]);
  assert.deepStrictEqual(inkscape.openCommand('/usr/bin/inkscape', '/p/fig.svg', 'darwin'), ['/usr/bin/inkscape', ['/p/fig.svg']]);
  assert.deepStrictEqual(inkscape.openCommand(bin, '/p/fig.svg', 'linux'), [bin, ['/p/fig.svg']]);
});

test('only figure formats can be opened', () => {
  for (const f of ['a.svg', 'a.PDF', 'a.eps', 'a.emf', 'a.svgz']) assert.ok(inkscape.OPENABLE.test(f), f);
  for (const f of ['a.png', 'a.R', 'a.svg.sh', 'svg']) assert.ok(!inkscape.OPENABLE.test(f), f);
});
