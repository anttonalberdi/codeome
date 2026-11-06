const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const configPath = require.resolve('../main/config');
let data = '{}';
const originalLoad = Module._load;
Module._load = function (name, parent, ...args) {
  if (name === 'electron') return { app: { getPath: () => '/unused' }, safeStorage: {} };
  if (name === 'fs' && parent && parent.filename === configPath) return {
    readFileSync: () => data, writeFileSync: (_file, value) => { data = value; },
    mkdirSync: () => {}, chmodSync: () => {}
  };
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
    triageCap: 3, dailyTriageCap: 30, autoTriageOutsiders: true, authors: 'everyone', label: '' });
  assert.deepEqual(cfg.projectIssues, {});
});

test('issue poll interval and triage caps are clamped', () => {
  const low = load({ issues: { pollMinutes: -1, triageCap: -1, dailyTriageCap: -1 } });
  assert.deepEqual([low.issues.pollMinutes, low.issues.triageCap, low.issues.dailyTriageCap], [2, 0, 0]);
  const high = load({ issues: { pollMinutes: 99999, triageCap: 99999, dailyTriageCap: 99999 } });
  assert.equal(high.issues.pollMinutes, 1440);
  assert.equal(high.issues.triageCap, 20);
  assert.equal(high.issues.dailyTriageCap, 500);
});

test('invalid issue setting types fall back to defaults', () => {
  const cfg = load({ issues: { enabled: 'true', pollMinutes: '5', model: 7, notify: 1,
    triageCap: 3.5, dailyTriageCap: '10', autoTriageOutsiders: 'false', authors: 'outsiders', label: 'x'.repeat(101) } });
  assert.deepEqual(cfg.issues, config.DEFAULTS.issues);
  assert.deepEqual(load({ issues: null }).issues, config.DEFAULTS.issues);
  assert.deepEqual(load({ issues: ['invalid'] }).issues, config.DEFAULTS.issues);
  assert.deepEqual(load({ issues: { model: 'x'.repeat(101), label: [] } }).issues,
    config.DEFAULTS.issues);
});

test('issue model rejects option-like and malformed names', () => {
  for (const model of ['--model', '-sonnet', 'bad name', 'bad\nname', ''])
    assert.equal(load({ issues: { model } }).issues.model, 'sonnet');
  assert.equal(load({ issues: { model: 'claude-sonnet-4.5/2026:latest' } }).issues.model,
    'claude-sonnet-4.5/2026:latest');
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

test('notification settings load and save discard invalid and prototype fields', () => {
  const saved = load(JSON.parse('{"notifications":{"minSeconds":1,"quietHours":{"start":"25:99"},"events":{"ask":false,"unknown":false,"__proto__":false}},"projectNotify":{"/work/a":{"enabled":false,"minSeconds":9999,"events":{"incoming":false,"unknown":true}},"__proto__":{"enabled":false}}}'));
  assert.equal(saved.notifications.minSeconds, 5);
  assert.equal(saved.notifications.quietHours.start, '22:00');
  assert.deepEqual(saved.notifications.events, { finished: true, ask: false, approval: true, incoming: true });
  assert.deepEqual(saved.projectNotify, { '/work/a': { enabled: false, minSeconds: 600, events: { incoming: false } } });
  saved.notifications.minSeconds = 9999;
  saved.notifications.events.unknown = false;
  saved.projectNotify['/work/a'].minSeconds = 1;
  saved.projectNotify['/work/a'].extra = true;
  config.save(saved);
  const roundTrip = config.load();
  assert.equal(roundTrip.notifications.minSeconds, 600);
  assert.equal(Object.hasOwn(roundTrip.notifications.events, 'unknown'), false);
  assert.deepEqual(roundTrip.projectNotify['/work/a'], { enabled: false, minSeconds: 5, events: { incoming: false } });
});
