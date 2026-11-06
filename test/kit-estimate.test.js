const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const source = path.join(__dirname, '..', 'kit', 'bin', 'codeome-agent');

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-estimate-'));
  const bin = path.join(root, '.codeome', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.copyFileSync(source, path.join(bin, 'codeome-agent'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(root, args) {
  return spawnSync('python3', ['-B', path.join(root, '.codeome', 'bin', 'codeome-agent'), ...args],
    { cwd: root, encoding: 'utf8', env: { ...process.env, CODEOME_HOME: path.join(root, 'home') } });
}

function history(root, data) {
  fs.writeFileSync(path.join(root, '.codeome', 'jobs', '.progress-history.json'), JSON.stringify(data));
}

function job(root, id, seconds, overrides = {}) {
  const dir = path.join(root, '.codeome', 'jobs', id);
  fs.mkdirSync(dir, { recursive: true });
  const start = Date.now() - 20000 - Number(id.replace(/\D/g, '') || 0) * 1000;
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ id, role: 'implementer', engine: 'codex',
    status: 'done', startedAt: new Date(start).toISOString(), endedAt: new Date(start + seconds * 1000).toISOString(), ...overrides }));
  return dir;
}

test('estimate reports no history, normalises stage IDs and rejects invalid totals', (t) => {
  const root = project(t);
  const empty = run(root, ['estimate', '--stage', 'build']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, 'no estimate yet\n');
  assert.deepEqual(JSON.parse(run(root, ['estimate', '--stage', 'build', '--json']).stdout),
    { seconds: null, lo: null, hi: null, runs: 0, source: 'none', scaled: false, key: 'build', fallback: false });
  for (const [id, expected] of [['bad/path', 'bad-path'], ['bad..key', 'bad-key'], ['bad\nkey', 'bad-key'], ['', 'stage']]) {
    const r = run(root, ['estimate', '--stage', id, '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).key, expected);
  }
  for (const total of ['-1', 'NaN', 'Infinity']) {
    const r = run(root, ['estimate', '--stage', 'build', '--total', total]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--total/);
  }
  assert.notEqual(run(root, ['estimate', '--engine', 'codex', '--stage', 'build']).status, 0);
});

test('stage estimates read legacy numbers, scale totals, and use parser fallback', (t) => {
  const root = project(t);
  fs.mkdirSync(path.join(root, '.codeome', 'jobs'), { recursive: true });
  history(root, { build: [60, 120, 180], scaled: [{ s: 10, t: 10 }, { s: 20, t: 10 }, { s: 30, t: 10 }],
    vitest: [40, 50, 60] });
  const estimate = (id, total) => JSON.parse(run(root, ['estimate', '--stage', id, '--total', String(total), '--json']).stdout);
  assert.deepEqual(estimate('build', 20),
    { seconds: 120, lo: 60, hi: 180, runs: 3, source: 'history', scaled: false, key: 'build', fallback: false });
  assert.deepEqual(estimate('scaled', 10),
    { seconds: 20, lo: 10, hi: 30, runs: 3, source: 'history', scaled: true, key: 'scaled', fallback: false });
  assert.equal(estimate('scaled', 20).seconds, 40);
  assert.match(run(root, ['estimate', '--stage', 'scaled', '--total', '20']).stdout,
    /^~40s \(range 20s-1m, 3 runs, history, scaled\)\n$/);
  assert.deepEqual([estimate('vitest:unit-tests', 1).key, estimate('vitest:unit-tests', 1).fallback], ['vitest', true]);
  assert.match(run(root, ['estimate', '--stage', 'vitest:unit-tests']).stdout, /parser-level history\)\n$/);
  assert.deepEqual([estimate('custom:unit-tests', 1).key, estimate('custom:unit-tests', 1).fallback], ['custom:unit-tests', false]);
  assert.deepEqual([estimate('vitest:Unit-Tests', 1).key, estimate('vitest:Unit-Tests', 1).fallback], ['vitest:Unit-Tests', false]);
  history(root, { vitest: [40], 'vitest:unit-tests': [90] });
  assert.deepEqual([estimate('vitest:unit-tests', 1).seconds, estimate('vitest:unit-tests', 1).fallback], [90, false]);
});

test('zero and unsafe scaled totals use finite unscaled history', (t) => {
  const root = project(t);
  fs.mkdirSync(path.join(root, '.codeome', 'jobs'), { recursive: true });
  history(root, { scaled: [{ s: 10, t: 1 }, { s: 20, t: 1 }, { s: 30, t: 1 }],
    tiny: [{ s: 10, t: 1e-300 }, { s: 20, t: 1e-300 }, { s: 30, t: 1e-300 }] });
  for (const [key, total] of [['scaled', '0'], ['scaled', '1000000000'], ['tiny', '10']]) {
    const result = run(root, ['estimate', '--stage', key, '--total', total, '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /NaN|Infinity/);
    assert.deepEqual([JSON.parse(result.stdout).seconds, JSON.parse(result.stdout).scaled], [20, false]);
  }
  for (const total of ['1000000001', '9'.repeat(400)]) {
    const result = run(root, ['estimate', '--stage', 'scaled', '--total', total, '--json']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--total/);
    assert.doesNotMatch(result.stderr, /Traceback/);
  }
});

test('stage estimates keep the last ten runs and exclude a large outlier', (t) => {
  const root = project(t);
  fs.mkdirSync(path.join(root, '.codeome', 'jobs'), { recursive: true });
  history(root, { recent: Array.from({ length: 12 }, (_, i) => i + 1), outlier: [10, 10, 10, 10, 1000] });
  const recent = JSON.parse(run(root, ['estimate', '--stage', 'recent', '--json']).stdout);
  assert.deepEqual([recent.seconds, recent.runs], [7.5, 10]);
  const outlier = JSON.parse(run(root, ['estimate', '--stage', 'outlier', '--json']).stdout);
  assert.deepEqual([outlier.seconds, outlier.runs], [10, 4]);
});

test('role estimate uses recent successful jobs and drops outliers and unsafe records', (t) => {
  const root = project(t);
  job(root, 'job-1', 300);
  job(root, 'job-2', 360);
  job(root, 'job-3', 480);
  job(root, 'job-4', 540);
  job(root, 'job-5', 10000);
  job(root, 'job-6', 100, { status: 'failed' });
  job(root, 'job-7', 100, { engine: 'claude' });
  job(root, 'job-8', 100, { endedAt: null });
  const linked = path.join(root, '.codeome', 'jobs', 'linked');
  fs.mkdirSync(linked);
  fs.symlinkSync(path.join(root, '.codeome', 'jobs', 'job-1', 'job.json'), path.join(linked, 'job.json'));
  const huge = path.join(root, '.codeome', 'jobs', 'huge');
  fs.mkdirSync(huge);
  fs.writeFileSync(path.join(huge, 'job.json'), ' '.repeat(1024 * 1024 + 1));
  const result = run(root, ['estimate', '--role', 'implementer', '--engine', 'codex', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),
    { seconds: 420, lo: 330, hi: 510, runs: 4, source: 'history', scaled: false, key: 'role:implementer:codex', fallback: false });
  assert.equal(run(root, ['estimate', '--role', 'implementer', '--engine', 'codex']).stdout,
    '~7m (range 5m 30s-8m 30s, 4 runs, history)\n');
  assert.equal(JSON.parse(run(root, ['estimate', '--role', 'missing', '--json']).stdout).seconds, null);
});

test('role estimate scans only the 300 newest job records', (t) => {
  const root = project(t);
  for (let i = 0; i < 300; i++) job(root, `job-${i}`, 60, { status: 'failed' });
  job(root, 'job-301', 60);
  const result = JSON.parse(run(root, ['estimate', '--role', 'implementer', '--json']).stdout);
  assert.deepEqual([result.seconds, result.runs], [null, 0]);
});
