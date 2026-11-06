const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const settings = require('../main/notifysettings');

test('general settings clamp values and discard unknown keys', () => {
  assert.deepEqual(settings.sanitize(null), settings.DEFAULTS);
  const low = settings.sanitize({ minSeconds: 1, events: { finished: false, unknown: false },
    quietHours: { start: '25:99', end: '09:30' }, unknown: true });
  assert.equal(low.minSeconds, 5);
  assert.equal(low.events.finished, false);
  assert.equal(Object.hasOwn(low.events, 'unknown'), false);
  assert.equal(low.quietHours.start, '22:00');
  assert.equal(low.quietHours.end, '09:30');
  assert.equal(Object.hasOwn(low, 'unknown'), false);
  assert.equal(settings.sanitize({ minSeconds: 9999 }).minSeconds, 600);
  assert.equal(settings.sanitize({ minSeconds: 7.5 }).minSeconds, 8);
  assert.equal(settings.sanitize({ minSeconds: 30.5 }).minSeconds, 31);
  assert.equal(settings.sanitize({ minSeconds: Infinity }).minSeconds, 30);
});

test('defaults are deeply frozen while sanitized and effective settings are mutable copies', () => {
  assert.equal(Object.isFrozen(settings.DEFAULTS), true);
  assert.equal(Object.isFrozen(settings.DEFAULTS.events), true);
  assert.equal(Object.isFrozen(settings.DEFAULTS.quietHours), true);
  for (const value of [settings.sanitize(), settings.effective({}, '/work/project')]) {
    value.enabled = false;
    value.events.ask = false;
    value.quietHours.start = '20:00';
    assert.equal(value.enabled, false);
    assert.equal(value.events.ask, false);
    assert.equal(value.quietHours.start, '20:00');
  }
  assert.equal(settings.DEFAULTS.enabled, true);
  assert.equal(settings.DEFAULTS.events.ask, true);
  assert.equal(settings.DEFAULTS.quietHours.start, '22:00');
  const config = fs.readFileSync(path.join(__dirname, '../main/config.js'), 'utf8');
  assert.match(config, /notifications: notifySettings\.sanitize\(\)/);
});

test('sanitizing general settings accepts only booleans', () => {
  const value = settings.sanitize({ enabled: 'false', events: { finished: 'false', ask: 0 },
    onlyUnfocused: 'false', sound: 0, quietHours: { enabled: 'true' } });
  assert.equal(value.enabled, true);
  assert.equal(value.events.finished, true);
  assert.equal(value.events.ask, true);
  assert.equal(value.onlyUnfocused, true);
  assert.equal(value.sound, true);
  assert.equal(value.quietHours.enabled, false);
});

test('project overrides inherit missing fields and discard invalid fields', () => {
  const cfg = { notifications: { sound: false, events: { ask: false }, minSeconds: 60 },
    projectNotify: { '/work/one': { sound: true, events: { ask: true, incoming: false },
      minSeconds: 1, quietHours: { enabled: true, start: '23:00', end: '07:00' }, extra: 'ignored' },
    '/work/empty': { sound: 'yes', events: { other: false }, minSeconds: '10' } } };
  const projects = settings.sanitizeProject(cfg.projectNotify);
  assert.deepEqual(projects['/work/one'], { sound: true, minSeconds: 5,
    events: { ask: true, incoming: false }, quietHours: { enabled: true, start: '23:00', end: '07:00' } });
  assert.equal(Object.hasOwn(projects, '/work/empty'), false);
  assert.deepEqual(settings.effective(cfg, '/work/one'), { enabled: true,
    events: { finished: true, ask: true, approval: true, incoming: false },
    onlyUnfocused: true, minSeconds: 5, sound: true,
    quietHours: { enabled: true, start: '23:00', end: '07:00' } });
  assert.equal(settings.effective(cfg, '/work/missing').sound, false);
  assert.equal(settings.effective(cfg, '/work/missing').events.ask, false);
});

test('prototype keys and excess projects cannot enter sanitized settings', () => {
  const input = JSON.parse('{"__proto__":{"enabled":false},"constructor":{"sound":false},"relative":{"enabled":false},"/work/ok":{"events":{"__proto__":false,"ask":false}},"/work/bad":{"__proto__":{"sound":false}}}');
  const projects = settings.sanitizeProject(input);
  assert.deepEqual(projects, { '/work/ok': { events: { ask: false } } });
  assert.equal({}.enabled, undefined);
  assert.equal({}.sound, undefined);
  const many = Object.fromEntries(Array.from({ length: 510 }, (_, i) => [`/work/${i}`, { enabled: false }]));
  assert.equal(Object.keys(settings.sanitizeProject(many)).length, 500);
});

test('quiet hours use local time across midnight and equal endpoints disable the window', () => {
  const quiet = { enabled: true, start: '22:00', end: '08:00' };
  assert.equal(settings.isQuiet(quiet, new Date(2026, 0, 1, 23, 0)), true);
  assert.equal(settings.isQuiet(quiet, new Date(2026, 0, 2, 7, 59)), true);
  assert.equal(settings.isQuiet(quiet, new Date(2026, 0, 2, 8, 0)), false);
  assert.equal(settings.isQuiet({ ...quiet, end: '22:00' }, new Date(2026, 0, 1, 23, 0)), false);
});

test('fixed labels and body contain only the project basename', () => {
  assert.equal(settings.label('error'), 'agent stopped with an error');
  assert.equal(settings.body('/private/secret/MyProject', 'ask'), 'MyProject: needs your input');
  assert.equal(settings.body('/private/secret/MyProject', 'error', true), 'MyProject: new activity');
  assert.equal(settings.body('/work/line\nname', 'ask'), 'linename: needs your input');
  assert.equal(settings.body('/work/ab\u202Ecd', 'ask'), 'abcd: needs your input');
  assert.equal(settings.body('/work/..', 'ask'), 'Codeome project: needs your input');
  assert.equal(settings.body('/work/' + 'a'.repeat(300), 'ask'), 'a'.repeat(59) + '…: needs your input');
});

test('the browser loads the same settings file used by main', () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  assert.match(html, /<script src="\.\.\/main\/notifysettings\.js"><\/script>/);
  const source = fs.readFileSync(require.resolve('../main/notifysettings'), 'utf8');
  const context = { App: {} };
  vm.runInNewContext(source, context);
  const fixture = { notifications: { minSeconds: 1 }, projectNotify: { '/work/x': { events: { ask: false } } } };
  assert.deepEqual(JSON.parse(JSON.stringify(context.App.notifySettings.effective(fixture, '/work/x'))),
    settings.effective(fixture, '/work/x'));
});
