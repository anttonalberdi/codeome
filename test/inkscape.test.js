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

test('the detection result is recorded for the agents, and the kit points them at that file', async () => {
  const home = tmp();
  const bin = fake(tmp(), '1.4.4');
  inkscape.writeStatus(await inkscape.detect({ configured: bin }), home);
  const f = inkscape.statusFile(home);
  assert.strictEqual(f, path.join(home, 'inkscape.json'));
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual([rec.path, rec.version], [bin, '1.4.4']);
  assert.ok(!isNaN(Date.parse(rec.checkedAt)));
  inkscape.writeStatus({ path: '' }, home);
  assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).path, '');
  // The skill, the role and the orchestrator all read the same file.
  const kit = (...p) => fs.readFileSync(path.join(__dirname, '..', 'kit', ...p), 'utf8');
  for (const t of [kit('skills/figures/SKILL.md'), kit('skills/orchestrate/SKILL.md')]) assert.match(t, /inkscape\.json/);
  assert.match(kit('roles/figure-designer.md'), /not installed/);
});

test('CODEOME_HOME moves the status file', () => {
  const old = process.env.CODEOME_HOME; process.env.CODEOME_HOME = '/x/y';
  try { assert.strictEqual(inkscape.statusFile(), '/x/y/inkscape.json'); } finally { if (old === undefined) delete process.env.CODEOME_HOME; else process.env.CODEOME_HOME = old; }
});
