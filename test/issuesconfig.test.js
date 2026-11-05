const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const configPath = require.resolve('../main/config');
let data = '{}';
const originalLoad = Module._load;
Module._load = function (name, parent, ...args) {
  if (name === 'electron') return { app: { getPath: () => '/unused' }, safeStorage: {} };
  if (name === 'fs' && parent && parent.filename === configPath) return { readFileSync: () => data };
  return originalLoad.call(this, name, parent, ...args);
};
let config;
try { config = require('../main/config'); }
finally { Module._load = originalLoad; }

function load(saved) {
  data = JSON.stringify(saved);
  return config.load();
}

test('issue settings have opt-in defaults', () => {
  const cfg = load({});
  assert.deepEqual(cfg.issues, { enabled: false, pollMinutes: 10, model: 'sonnet', notify: true,
    triageCap: 3, authors: 'everyone', label: '' });
  assert.deepEqual(cfg.projectIssues, {});
});

test('issue poll interval and triage cap are clamped', () => {
  const low = load({ issues: { pollMinutes: -1, triageCap: -1 } });
  assert.deepEqual([low.issues.pollMinutes, low.issues.triageCap], [2, 0]);
  const high = load({ issues: { pollMinutes: 99999, triageCap: 99999 } });
  assert.equal(high.issues.pollMinutes, 1440);
  assert.equal(high.issues.triageCap, 20);
});

test('invalid issue setting types fall back to defaults', () => {
  const cfg = load({ issues: { enabled: 'true', pollMinutes: '5', model: 7, notify: 1,
    triageCap: 3.5, authors: 'outsiders', label: 'x'.repeat(101) } });
  assert.deepEqual(cfg.issues, config.DEFAULTS.issues);
  assert.deepEqual(load({ issues: null }).issues, config.DEFAULTS.issues);
  assert.deepEqual(load({ issues: ['invalid'] }).issues, config.DEFAULTS.issues);
  assert.deepEqual(load({ issues: { model: 'x'.repeat(101), label: [] } }).issues,
    config.DEFAULTS.issues);
});

test('project issue entries keep only valid settings', () => {
  const at = '2026-11-05T08:00:00.000Z';
  const cfg = load({ projectIssues: {
    '/projects/alpha': { enabled: true, enabledAt: at, ignored: 'extra' },
    '/projects/beta': { enabled: false, enabledAt: null },
    '/projects/bad-enabled': { enabled: 'yes', enabledAt: at },
    '/projects/bad-time': { enabled: true, enabledAt: '2026-02-30T08:00:00Z' },
    '/projects/missing-time': { enabled: true },
    '/projects/not-object': [],
    relative: { enabled: true, enabledAt: at }
  } });
  assert.deepEqual(cfg.projectIssues, {
    '/projects/alpha': { enabled: true, enabledAt: at },
    '/projects/beta': { enabled: false, enabledAt: null }
  });
  assert.deepEqual(load({ projectIssues: [] }).projectIssues, {});
});

test('loading issue settings leaves existing config values untouched', () => {
  const cfg = load({ chat: { model: 'opus', modelPicked: true },
    forum: { defaultBudget: 5 }, projectLinks: { '/projects/alpha': ['/projects/beta'] },
    issues: { enabled: true, notify: false, authors: 'collaborators', model: 'haiku', label: 'bug' } });
  assert.equal(cfg.chat.model, 'opus');
  assert.equal(cfg.chat.modelPicked, true);
  assert.equal(cfg.forum.defaultBudget, 5);
  assert.deepEqual(cfg.projectLinks, { '/projects/alpha': ['/projects/beta'] });
  assert.deepEqual(cfg.issues, { ...config.DEFAULTS.issues, enabled: true, notify: false,
    authors: 'collaborators', model: 'haiku', label: 'bug' });
});
