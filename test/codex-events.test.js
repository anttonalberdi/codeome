const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const kit = require('../main/kit');

const fixture = path.join(__dirname, 'fixtures', 'codex-events.jsonl');

function project() {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-codex-events-'));
  kit.install(p);
  return p;
}

function stub(projectDir, fail = false) {
  const bin = path.join(projectDir, 'fake-codex');
  fs.writeFileSync(bin, `#!/usr/bin/env python3
import json, os, sys
argv = sys.argv[1:]
sys.stdin.read()
json.dump(argv, open(os.path.join(${JSON.stringify(projectDir)}, 'argv.json'), 'w'))
print('Codex diagnostic', file=sys.stderr)
if ${fail ? 'True' : 'False'}:
    print(json.dumps({'type': 'error', 'detail': 'usage limit reached'}))
    print('unstructured diagnostic')
    sys.exit(3)
sys.stdout.write(open(${JSON.stringify(fixture)}).read())
open(argv[argv.index('-o') + 1], 'w').write('## Status\\ndone — fake')
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function run(projectDir, bin, args = ['--role', 'implementer']) {
  return spawnSync('python3', [path.join(projectDir, '.codeome/bin/codeome-agent'), 'codex', ...args], {
    cwd: projectDir, input: 'Test structured output.', encoding: 'utf8',
    env: { ...process.env, CODEOME_HOME: path.join(projectDir, '.codeome-home'), CODEOME_CODEX: bin },
  });
}

function latestJob(projectDir) {
  const jobsDir = path.join(projectDir, '.codeome/jobs');
  const id = fs.readdirSync(jobsDir).filter((name) => !name.startsWith('.')).sort().at(-1);
  const dir = path.join(jobsDir, id);
  return { dir, job: JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8')) };
}

test('Codex JSONL is saved, mirrored, and its thread id becomes the session', () => {
  const p = project();
  const bin = stub(p);
  const r = run(p, bin);
  assert.strictEqual(r.status, 0, r.stderr);
  const { dir, job } = latestJob(p);
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  const log = fs.readFileSync(path.join(dir, 'log.txt'), 'utf8');
  const argv = JSON.parse(fs.readFileSync(path.join(p, 'argv.json'), 'utf8'));
  assert.ok(argv.includes('--json'));
  assert.strictEqual(events, fs.readFileSync(fixture, 'utf8'));
  assert.match(log, /\[command\] \/bin\/zsh -lc 'echo hi'/);
  assert.match(log, /\[exit 0\] hi/);
  assert.match(log, /\[codex\] ok/);
  assert.match(log, /Codex diagnostic/);
  assert.strictEqual(job.session, '01a142ca-a0ef-7c33-b0b7-f30907b0cd62');
  assert.strictEqual(job.status, 'done');
  assert.match(r.stdout, /done — fake/);

  const resumed = run(p, bin, ['--resume', job.session]);
  assert.strictEqual(resumed.status, 0, resumed.stderr);
  const resumeArgv = JSON.parse(fs.readFileSync(path.join(p, 'argv.json'), 'utf8'));
  assert.deepStrictEqual(resumeArgv.slice(0, 3), ['exec', 'resume', job.session]);
  assert.ok(resumeArgv.includes('--json'));
});

test('failed Codex JSONL is saved and a non-JSON line remains readable', () => {
  const p = project();
  const r = run(p, stub(p, true));
  assert.strictEqual(r.status, 1);
  const { dir, job } = latestJob(p);
  assert.strictEqual(job.status, 'failed');
  assert.strictEqual(job.exitCode, 3);
  assert.strictEqual(job.limitHit, true);
  assert.match(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'), /usage limit reached.*\nunstructured diagnostic/s);
  const log = fs.readFileSync(path.join(dir, 'log.txt'), 'utf8');
  assert.match(log, /\[error\]/);
  assert.doesNotMatch(log, /usage limit reached/);
  assert.match(log, /unstructured diagnostic/);
  assert.match(r.stdout, /unstructured diagnostic/);
});
