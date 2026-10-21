const test = require('node:test');
const assert = require('node:assert/strict');
const { matches } = require('../renderer/js/slurm-scope');

test('project tag matches a job outside saved folders', () => {
  assert.equal(matches({ comment: 'codeome:project-12345678', workdir: '/elsewhere' }, 'codeome:project-12345678', ['/a/b'], '/current'), true);
  assert.equal(matches({ comment: 'codeome:other-12345678', workdir: '/elsewhere' }, 'codeome:project-12345678', ['/a/b'], '/current'), false);
});

test('saved folders match workdirs by path component', () => {
  assert.equal(matches({ workdir: '/a/b' }, 'tag', ['/a/b'], '/current'), true);
  assert.equal(matches({ workdir: '/a/b/jobs' }, 'tag', ['/a/b'], '/current'), true);
  assert.equal(matches({ workdir: '/other/job' }, 'tag', ['/a/b', '/other'], '/current'), true);
  assert.equal(matches({ workdir: '/a/bc/job' }, 'tag', ['/a/b'], '/current'), false);
  assert.equal(matches({ workdir: '/current/job' }, 'tag', ['/a/b'], '/current'), false);
  assert.equal(matches({ workdir: '/home/u/work/job' }, 'tag', ['~/work'], '/current', '/home/u'), true);
  assert.equal(matches({ workdir: '/home/other/work/job' }, 'tag', ['~/work'], '/current', '/home/u'), false);
});

test('current HPC folder is used when there are no saved folders', () => {
  assert.equal(matches({ workdir: '/current/job' }, 'tag', [], '/current'), true);
  assert.equal(matches({ workdir: '/current2/job' }, 'tag', [], '/current'), false);
  assert.equal(matches({ workdir: '/anywhere' }, 'tag', [], '~'), true);
  assert.equal(matches({ workdir: '/anywhere' }, 'tag', [], ''), true);
});
