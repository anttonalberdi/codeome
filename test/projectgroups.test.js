const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const writes = [], prompts = [], toasts = [], checked = [];
  const valid = new Set(['/projects/alpha', '/projects/beta', '/projects/gamma', '/projects/ideas']);
  const nodes = {
    'project-btn': { classList: { toggle() {} }, style: { setProperty() {}, removeProperty() {} }, setAttribute() {} },
    'project-name': { textContent: '' },
    'project-links': { innerHTML: '', append() {} }
  };
  const App = {
    h: () => ({}), views: { projects: {}, agents: { pane: 'chat' } },
    cfg: { openProjects: [], projectGroups: [], projectGroup: {}, savedGroups: {}, projectLinks: {}, projectColors: {}, recentFolders: [] },
    project: null, scratchDir: '/projects/ideas', currentView: 'files',
    basename: (dir) => path.basename(dir), tildify: (dir) => dir,
    isIdeas: (dir) => dir === '/projects/ideas',
    closePopover() {}, emit() {}, toast: (message) => toasts.push(message),
    modal: async (opts) => { prompts.push(opts); return null; },
    confirm: async (...args) => { checked.push(args); return true; },
    saveConfig: async () => { writes.push(JSON.parse(JSON.stringify(App.cfg))); }
  };
  const codeome = { local: { list: async (dir) => valid.has(dir) ? { cwd: dir, entries: [] } : { error: 'ENOENT' } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/js/projects.js'), 'utf8'),
    { App, codeome, document: { getElementById: (id) => nodes[id], title: '', hidden: true } });
  return { App, P: App.views.projects, writes, prompts, toasts, checked, valid };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test('saved groups capture open projects, ask before overwrite, and can be renamed or deleted', async () => {
  const { App, P, writes, checked } = load();
  P.list = ['/projects/alpha', '/projects/ideas', '/projects/beta'];
  assert.equal(await P.saveGroup('Study', P.list), true);
  assert.deepEqual(plain(App.cfg.savedGroups.Study), ['/projects/alpha', '/projects/beta']);
  P.list = ['/projects/beta'];
  App.confirm = async () => false;
  assert.equal(await P.saveGroup('Study'), false);
  assert.deepEqual(plain(App.cfg.savedGroups.Study), ['/projects/alpha', '/projects/beta']);
  App.confirm = async (...args) => { checked.push(args); return true; };
  assert.equal(await P.saveGroup('Study'), true);
  assert.deepEqual(plain(App.cfg.savedGroups.Study), ['/projects/beta']);
  assert.equal(checked.length, 1);
  assert.equal(await P.renameGroup('Study', 'Field work'), true);
  assert.equal(Object.hasOwn(App.cfg.savedGroups, 'Study'), false);
  assert.deepEqual(plain(App.cfg.savedGroups['Field work']), ['/projects/beta']);
  assert.equal(await P.deleteGroup('Field work'), true);
  assert.deepEqual(plain(App.cfg.savedGroups), {});
  assert.deepEqual(writes.at(-1).savedGroups, {});
});

test('loading adds missing members, activates the first available one, and reports missing folders', async () => {
  const { App, P, prompts, toasts } = load();
  P.list = ['/projects/gamma']; App.project = '/projects/gamma';
  App.cfg.savedGroups.Study = ['/projects/alpha', '/projects/missing', '/projects/beta'];
  App.cfg.projectLinks['/projects/alpha'] = ['/projects/beta'];
  assert.deepEqual(plain(await P.loadGroup('Study')), ['/projects/alpha', '/projects/beta']);
  assert.deepEqual(plain(P.list), ['/projects/gamma', '/projects/alpha', '/projects/beta']);
  assert.equal(App.project, '/projects/alpha');
  assert.deepEqual(plain(App.cfg.openProjects), plain(P.list));
  assert.equal(prompts.length, 0);
  assert.match(toasts[0], /\/projects\/missing/);
});

test('manual open without closed links does not prompt', async () => {
  const { App, P, prompts } = load();
  await P.open('/projects/alpha');
  assert.equal(prompts.length, 0);
  App.cfg.projectLinks['/projects/beta'] = ['/projects/alpha'];
  await P.open('/projects/beta');
  assert.equal(prompts.length, 0);
});

test('startup restore does not prompt for linked projects', async () => {
  const { App, P, prompts } = load();
  P.list = ['/projects/alpha'];
  App.cfg.activeProject = '/projects/alpha';
  App.cfg.projectLinks['/projects/alpha'] = ['/projects/beta'];
  await P.restore();
  assert.equal(prompts.length, 0);
  assert.deepEqual(plain(P.list), ['/projects/alpha']);
});

test('link prompt opens only checked existing folders and keeps the original project active', async () => {
  const { App, P, prompts } = load();
  App.cfg.projectLinks['/projects/alpha'] = ['/projects/beta', '/projects/gamma'];
  App.modal = async (opts) => { prompts.push(opts); return { p0: true, p1: false }; };
  await P.open('/projects/alpha');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].ok, 'Open selected');
  assert.deepEqual(plain(prompts[0].fields.map((field) => field.value)), [true, true]);
  assert.deepEqual(plain(P.list), ['/projects/alpha', '/projects/beta']);
  assert.equal(App.project, '/projects/alpha');
});

test('missing linked folders are omitted, and an empty result does not prompt', async () => {
  const { App, P, prompts } = load();
  App.cfg.projectLinks['/projects/alpha'] = ['/projects/missing'];
  await P.open('/projects/alpha');
  assert.equal(prompts.length, 0);
  App.cfg.projectLinks['/projects/beta'] = ['/projects/missing', '/projects/gamma'];
  await P.open('/projects/beta');
  assert.equal(prompts.length, 1);
  assert.deepEqual(plain(prompts[0].fields.map((field) => field.label)), ['/projects/gamma']);
  assert.deepEqual(plain(P.list), ['/projects/alpha', '/projects/beta']);
});
