const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const u = require('../main/updates');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-upd-')), 'updates.json');

test('semver finds a version in CLI output and release tags', () => {
  assert.deepStrictEqual(u.semver('2.1.287 (Claude Code)'), [2, 1, 287]);
  assert.deepStrictEqual(u.semver('codex-cli 0.162.1'), [0, 162, 1]);
  assert.deepStrictEqual(u.semver('rust-v0.162.1'), [0, 162, 1]);
  assert.strictEqual(u.semver('nothing'), null);
});

test('compare orders numerically, not as text', () => {
  assert.ok(u.compare('0.162.1', '0.99.0') > 0);
  assert.ok(u.compare('2.1.9', '2.1.10') < 0);
  assert.strictEqual(u.compare('x', '1.0.0'), 0);
});

test('update command follows how the CLI was installed', () => {
  assert.match(u.updateCommand('claude', 'script'), /claude\.ai\/install\.sh/);
  assert.match(u.updateCommand('codex', 'script'), /chatgpt\.com\/codex\/install\.sh/);
  assert.strictEqual(u.updateCommand('codex', 'brew'), 'brew upgrade --cask codex');
  assert.match(u.updateCommand('claude', 'npm'), /npm install -g @anthropic-ai\/claude-code/);
});

test('looks up at most once a week and suggests an update once', async () => {
  const file = tmp();
  let calls = 0;
  const fetchLatest = async (e) => { calls++; return e === 'claude' ? '2.2.0' : '0.1.0'; };
  const engines = { claude: { path: '/x/claude', version: '2.1.0' }, codex: { path: '/x/codex', version: '0.1.0' } };
  const t0 = Date.now();
  let r = await u.check({ file, engines, now: t0, suggest: true, fetchLatest });
  assert.deepStrictEqual(r.updates.map((x) => x.engine), ['claude']);
  assert.strictEqual(calls, 2);
  // Same week: no new lookup, and not suggested again.
  r = await u.check({ file, engines, now: t0 + 1000, suggest: true, fetchLatest });
  assert.strictEqual(calls, 2);
  assert.strictEqual(r.updates.length, 0);
  // Asking without suggest still lists it (Settings).
  r = await u.check({ file, engines, now: t0 + 1000, fetchLatest });
  assert.strictEqual(r.updates.length, 1);
  // A week on: looked up again and suggested again.
  r = await u.check({ file, engines, now: t0 + u.WEEK + 1, suggest: true, fetchLatest });
  assert.strictEqual(calls, 4);
  assert.strictEqual(r.updates.length, 1);
});

test('a failed lookup is not counted as a check', async () => {
  const file = tmp();
  const r = await u.check({ file, engines: { claude: { path: '', version: '1.0.0' } }, now: Date.now(), fetchLatest: async () => { throw new Error('offline'); } });
  assert.strictEqual(r.error, 'offline');
  assert.strictEqual(r.checkedAt, 0);
});

test('Codeome itself is offered its release page, not a command; no release yet is no error', async () => {
  const file = tmp();
  const engines = { codeome: { path: '', version: '0.3.2' } };
  let r = await u.check({ file, engines, now: Date.now(), suggest: true, fetchLatest: async () => '0.4.0' });
  assert.strictEqual(r.updates[0].latest, '0.4.0');
  assert.match(r.updates[0].url, /github\.com\/anttonalberdi\/codeome\/releases/);
  assert.strictEqual(r.updates[0].command, undefined);
  r = await u.check({ file: tmp(), engines, now: Date.now(), force: true, fetchLatest: async () => null });
  assert.deepStrictEqual(r.updates, []);
  assert.strictEqual(r.error, '');
});
