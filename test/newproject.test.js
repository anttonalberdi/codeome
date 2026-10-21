const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const templates = require('../main/templates');

const App = { views: { projects: {} }, h: () => ({}) };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/js/newproject.js'), 'utf8'), { App });
const P = App.views.projects;
const plain = (value) => JSON.parse(JSON.stringify(value));

test('new project defaults use git identity when available and otherwise stay blank', () => {
  assert.deepStrictEqual(plain(P.newProjectDefaults()), {
    name: '', description: '', author: '', email: '', license: 'mit', git: true
  });
  assert.deepStrictEqual(plain(P.newProjectDefaults({ author: 'Configured', email: 'cfg@example.org' },
    { effectiveName: 'Git User', effectiveEmail: 'git@example.org' })), {
    name: '', description: '', author: 'Git User', email: 'git@example.org', license: 'mit', git: true
  });
});

test('live name validation agrees with the backend for each template', () => {
  const names = ['', 'study', 'my.study', 'my-study', 'class', '3tools', '.hidden', 'bad/name', ' spaced ', 'a'.repeat(101)];
  for (const { id } of templates.TYPES) {
    for (const name of names) assert.strictEqual(P.newProjectNameError(id, name), templates.validateName(id, name), `${id}: ${name}`);
  }
});

test('licensed projects require an author in the wizard', () => {
  assert.match(P.newProjectAuthorError('mit', '  '), /author/);
  assert.strictEqual(P.newProjectAuthorError('mit', 'Ada'), null);
  assert.strictEqual(P.newProjectAuthorError('none', ''), null);
});

test('create payload keeps the folder name and trims optional details', () => {
  assert.deepStrictEqual(plain(P.newProjectPayload('r-package', {
    name: 'fieldPkg', description: '  An analysis  ', author: '  A Researcher ',
    email: ' a@example.org ', license: 'none', git: false
  })), {
    type: 'r-package', name: 'fieldPkg', opts: {
      description: 'An analysis', author: 'A Researcher', email: 'a@example.org', license: 'none', git: false
    }
  });
});
