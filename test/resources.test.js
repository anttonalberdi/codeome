const test = require('node:test');
const assert = require('node:assert/strict');
const { levels, resolve } = require('../main/resources');
const { policyFor, policyPrompt } = require('../main/policy');

test('resource levels set platform priority and thread limits', () => {
  assert.deepEqual(Object.keys(levels), ['off', 'balanced', 'gentle']);
  const balanced = resolve('balanced', { cores: 8, platform: 'darwin' });
  assert.deepEqual(balanced.prefix, ['taskpolicy', '-b', 'nice', '-n', '10']);
  assert.equal(balanced.threads, 4);
  assert.deepEqual(balanced.env, {
    OMP_NUM_THREADS: '4', MKL_NUM_THREADS: '4', OPENBLAS_NUM_THREADS: '4',
    NUMEXPR_NUM_THREADS: '4', VECLIB_MAXIMUM_THREADS: '4', CODEOME_MAX_CORES: '4'
  });
  const gentle = resolve('gentle', { cores: 12, platform: 'linux' });
  assert.deepEqual(gentle.prefix, ['nice', '-n', '19']);
  assert.equal(gentle.threads, 3);
  assert.deepEqual(Object.values(gentle.env), Array(6).fill('3'));
});

test('resource limits keep at least one thread and ignore unknown levels', () => {
  assert.equal(resolve('balanced', { cores: 1, platform: 'linux' }).threads, 1);
  assert.equal(resolve('gentle', { cores: 3, platform: 'darwin' }).threads, 1);
  assert.equal(resolve('off', { cores: 8, platform: 'darwin' }), null);
  assert.equal(resolve('unexpected', { cores: 8, platform: 'darwin' }), null);
  assert.equal(resolve('balanced', { cores: 8, platform: 'win32' }), null);
  assert.equal(resolve('gentle', { cores: 8, platform: 'win32' }), null);
});

test('local resource policy inherits app defaults and projects can override it', () => {
  const project = '/projects/alpha';
  const cfg = { policyDefaults: { localResources: 'balanced' }, projectPolicy: { [project]: { localResources: 'gentle' } } };
  assert.equal(policyFor(cfg, project).localResources, 'gentle');
  assert.equal(policyFor(cfg, '/projects/beta').localResources, 'balanced');
  cfg.projectPolicy[project].localResources = 'invalid';
  assert.equal(policyFor(cfg, project).localResources, 'balanced');
  cfg.policyDefaults.localResources = 'invalid';
  assert.equal(policyFor(cfg, project).localResources, 'off');
  assert.equal(policyFor({}, project).localResources, 'off');
});

test('the resource prompt applies only when limits are enabled', () => {
  assert.doesNotMatch(policyPrompt({ localResources: 'off' }), /CODEOME_MAX_CORES/);
  assert.doesNotMatch(policyPrompt({ localResources: 'invalid' }), /CODEOME_MAX_CORES/);
  const prompt = policyPrompt({ localResources: 'gentle' });
  assert.match(prompt, /CODEOME_MAX_CORES/);
  assert.match(prompt, /make -jN/);
  assert.match(prompt, /pytest -n/);
  assert.match(prompt, /snakemake --cores/);
  assert.match(prompt, /memory-hungry/);
});
