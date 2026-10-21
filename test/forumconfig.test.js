const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forum-config-'));
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { app: { getPath: () => dir }, safeStorage: { isEncryptionAvailable: () => false } };
  return originalLoad.call(this, name, ...args);
};
let config;
try { config = require('../main/config'); }
finally { Module._load = originalLoad; }

test('forum check settings are bounded when saved and loaded', () => {
  const saved = config.save({ ...config.DEFAULTS, forum: { defaultBudget: 99, summaryTokens: 0,
    recentMessages: 99, checkTimeoutMs: 999999, checkEffort: 'unsupported', checkModel: 'x'.repeat(101), codexCheckModel: 7 } });
  assert.deepEqual([saved.forum.defaultBudget, saved.forum.summaryTokens, saved.forum.recentMessages, saved.forum.checkTimeoutMs], [20, 1000, 30, 120000]);
  assert.equal(saved.forum.checkEffort, 'low');
  assert.equal(saved.forum.checkModel, 'haiku');
  assert.equal(saved.forum.codexCheckModel, '');
  const loaded = config.load();
  assert.deepEqual(loaded.forum, saved.forum);
  saved.forum.checkTimeoutMs = -1;
  assert.equal(config.save(saved).forum.checkTimeoutMs, 1000);
});

test('project HPC paths are sanitised on load', () => {
  config.save({ ...config.DEFAULTS, projectHpc: {
    '/projects/alpha': { paths: [' /cluster/a/// ', '/cluster/a', 'relative/path', '~/work/', null] },
    '/projects/beta': { paths: 'wrong' }
  } });
  assert.deepEqual(config.load().projectHpc, { '/projects/alpha': { paths: ['/cluster/a', '~/work'] } });
});
