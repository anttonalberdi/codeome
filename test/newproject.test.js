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

test('instruction answers trim text, normalise checkboxes and reject unknown autonomy', () => {
  assert.deepStrictEqual(plain(P.instructionAnswersFromForm({
    purpose: '  Study bats  ', tools: ' R, Python ', test: '  pytest ', build: '  ',
    run: ' python run.py ', rawDataPath: ' data/raw ', protectRawData: true,
    noCommitData: 'true', hpc: 'false', autonomy: ' small ', noAutoCommit: false,
    noCoAuthor: true, neverDo: '  Delete samples  '
  })), {
    purpose: 'Study bats', tools: 'R, Python', test: 'pytest', build: '',
    run: 'python run.py', rawDataPath: 'data/raw', protectRawData: true,
    noCommitData: true, hpc: false, autonomy: 'small', noAutoCommit: false,
    noCoAuthor: true, neverDo: 'Delete samples'
  });
  const empty = plain(P.instructionAnswersFromForm({ autonomy: 'admin', purpose: 42, hpc: 'on' }));
  assert.strictEqual(empty.autonomy, '');
  assert.strictEqual(empty.purpose, '');
  assert.strictEqual(empty.hpc, false);
});

function wizardHarness(instructions) {
  let focused = null;
  let keydown = null;
  const descendants = (node) => [node, ...(node.children || []).flatMap((child) =>
    typeof child === 'object' ? descendants(child) : [])];
  const h = (selector, attrs, ...kids) => {
    if (attrs == null || typeof attrs !== 'object' || Array.isArray(attrs) || attrs.selector) {
      kids.unshift(attrs); attrs = {};
    }
    const node = {
      selector, children: kids.flat(Infinity).filter((child) => child != null), ...attrs,
      get textContent() { return this._text === undefined ? this.children.map((child) =>
        typeof child === 'object' ? child.textContent : String(child)).join('') : this._text; },
      set textContent(value) { this._text = value; },
      setAttribute(name, value) { this[name] = value; },
      focus() { focused = this; },
      querySelector(tag) { return descendants(this).find((child) => child.selector?.split(/[.#]/)[0] === tag) || null; },
      replaceChildren(...children) { this.children = children; },
      contains(child) { return descendants(this).includes(child); }
    };
    if (selector === 'textarea') node.value = node.textContent;
    if (selector === 'select') node.value = node.children.find((child) => child.selected)?.value || '';
    return node;
  };
  const overlay = h('div#overlay');
  const toasts = [];
  const calls = [];
  const App = { h, views: { projects: {} }, cfg: { author: 'Author' }, project: null, toast: (message) => toasts.push(message) };
  const codeome = {
    project: {
      templates: async () => ({ types: [{ id: 'general', label: 'General' }], licenses: [{ id: 'mit', label: 'MIT' }] }),
      create: async (payload) => { calls.push(['project', payload]); return { dir: '/projects/study' }; }
    },
    instructions: {
      defaults: async (...args) => { calls.push(['defaults', ...args]); return instructions.defaults(); },
      create: async (...args) => { calls.push(['instructions', ...args]); return instructions.create(); }
    }
  };
  const document = {
    getElementById: () => overlay,
    addEventListener: (_name, listener) => { keydown = listener; },
    removeEventListener: () => { keydown = null; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/js/newproject.js'), 'utf8'),
    { App, codeome, document, setTimeout: (callback) => callback() });
  const find = (selector) => descendants(overlay).find((node) => node.selector === selector);
  const button = (label) => descendants(overlay).find((node) => node.selector?.startsWith('button') && node.textContent === label);
  const fieldInput = (label) => {
    const field = descendants(overlay).find((node) => node.selector === 'label.field' && node.children[0]?.textContent === label);
    return field?.children[1];
  };
  return { P: App.views.projects, overlay, toasts, calls, find, button, fieldInput,
    keydown: (event) => keydown(event), focused: () => focused };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function createProjectInWizard(wizard) {
  const result = wizard.P.newProject();
  await flush();
  wizard.button('General').onclick();
  const name = wizard.fieldInput('Project name');
  name.value = 'study'; name.oninput();
  const description = wizard.fieldInput('Description');
  description.value = '  Study bats  '; description.oninput();
  await wizard.find('form#new-project-form').onsubmit({ preventDefault() {} });
  await flush();
  return { result };
}

test('successful project creation opens prefilled instructions and writes the edited answers', async () => {
  const wizard = wizardHarness({
    defaults: () => ({ purpose: 'Study bats', tools: 'R', autonomy: 'plan', noAutoCommit: true }),
    create: () => ({ agentsPath: '/projects/study/AGENTS.md' })
  });
  const { result } = await createProjectInWizard(wizard);
  assert.deepStrictEqual(wizard.calls[1], ['defaults', 'general', '  Study bats  ']);
  assert.strictEqual(wizard.find('h2').textContent, 'Instructions for your agents');
  assert.strictEqual(wizard.fieldInput('What is this project for?').value, 'Study bats');
  assert.strictEqual(wizard.focused(), wizard.fieldInput('What is this project for?'));
  const tools = wizard.fieldInput('Main languages and tools');
  tools.value = ' R, Python '; tools.oninput();
  await wizard.find('form#new-project-instructions-form').onsubmit({ preventDefault() {} });
  assert.strictEqual(await result, '/projects/study');
  assert.deepStrictEqual(plain(wizard.calls[2]), ['instructions', '/projects/study', {
    purpose: 'Study bats', tools: 'R, Python', test: '', build: '', run: '', rawDataPath: '',
    protectRawData: false, noCommitData: false, hpc: false, autonomy: 'plan',
    noAutoCommit: true, noCoAuthor: false, neverDo: ''
  }, 'study']);
  assert.deepStrictEqual(wizard.toasts, ['Created study.', 'AGENTS.md created.']);
});

test('failed defaults still show instructions; write error allows Skip', async () => {
  const wizard = wizardHarness({ defaults: () => ({ error: 'No defaults' }), create: () => ({ error: 'Disk full' }) });
  const { result } = await createProjectInWizard(wizard);
  assert.strictEqual(wizard.fieldInput('What is this project for?').value, '');
  const form = wizard.find('form#new-project-instructions-form');
  await form.onsubmit({ preventDefault() {} });
  assert.strictEqual(wizard.find('div.agent-field-error').textContent, 'Disk full');
  assert.strictEqual(wizard.button('Skip').disabled, false);
  wizard.button('Skip').onclick();
  assert.strictEqual(await result, '/projects/study');
});

test('instruction write disables actions while busy and can be retried', async () => {
  let finish;
  const wizard = wizardHarness({ defaults: () => ({}), create: () => new Promise((resolve) => { finish = resolve; }) });
  const { result } = await createProjectInWizard(wizard);
  const form = wizard.find('form#new-project-instructions-form');
  const first = form.onsubmit({ preventDefault() {} });
  assert.strictEqual(wizard.button('Skip').disabled, true);
  assert.strictEqual(wizard.button('Create AGENTS.md').disabled, true);
  finish({ error: 'Disk full' });
  await first;
  assert.strictEqual(wizard.button('Skip').disabled, false);
  assert.strictEqual(wizard.find('div.agent-field-error').textContent, 'Disk full');
  const second = form.onsubmit({ preventDefault() {} });
  assert.strictEqual(wizard.find('div.agent-field-error').textContent, '');
  finish({ agentsPath: '/projects/study/AGENTS.md' });
  await second;
  assert.strictEqual(await result, '/projects/study');
  assert.strictEqual(wizard.calls.filter(([method]) => method === 'instructions').length, 2);
});

test('Escape after project creation opens the new project without writing instructions', async () => {
  const wizard = wizardHarness({ defaults: () => ({}), create: () => ({ agentsPath: 'unexpected' }) });
  const { result } = await createProjectInWizard(wizard);
  wizard.keydown({ key: 'Escape', preventDefault() {} });
  assert.strictEqual(await result, '/projects/study');
  assert.strictEqual(wizard.calls.filter(([method]) => method === 'instructions').length, 0);
});
