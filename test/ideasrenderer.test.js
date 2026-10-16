const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element() {
  return {
    children: [], dataset: {}, style: { setProperty() {}, removeProperty() {} },
    classList: { toggle() {}, add() {}, remove() {} },
    append(...items) { this.children.push(...items); },
    contains() { return false; }, querySelector() { return null; }, querySelectorAll() { return []; },
    setAttribute() {}, focus() {}
  };
}

test('Ideas restores as a chat workspace without becoming project metadata', async () => {
  const scratch = '/codeome/scratch';
  const nodes = new Map();
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const cfg = {
    openProjects: [scratch], activeProject: scratch, recentFolders: [scratch, '/project'],
    localRoot: scratch, projectColors: { [scratch]: 120 }, projectGroup: { [scratch]: 'g' },
    projectGroups: [{ id: 'g', name: 'Work', collapsed: false }],
    projectLinks: { '/project': [scratch] }, ui: {}
  };
  const App = {
    h: (_selector, _attrs, ...children) => { const el = element(); el.append(...children); return el; },
    cfg, scratchDir: scratch, project: null, remoteDir: null, currentView: 'files', hpcConnected: false,
    isIdeas: (dir) => dir === scratch,
    views: {
      chat: { stats: () => ({ working: 0, waiting: 0, unread: 0 }) },
      editor: { tabs: [] }, terminals: { list: [] }, agents: { pane: 'chat' }
    },
    icons: { plus: '<svg></svg>' }, basename: (dir) => path.basename(dir),
    dirname: (dir) => path.dirname(dir), tildify: (dir) => dir,
    listen() {}, emit() {}, closePopover() {}, saveConfig: async () => {},
    err: (message) => { throw new Error(message); }
  };
  let jobCalls = 0;
  const codeome = { scratch: { dir: async () => ({ dir: scratch }) }, jobs: { list: async () => { jobCalls++; return []; } } };
  const document = { hidden: false, activeElement: null, getElementById: get };
  const source = fs.readFileSync(path.join(__dirname, '../renderer/js/projects.js'), 'utf8');
  vm.runInNewContext(source, { App, codeome, document, setInterval() {}, requestAnimationFrame() {} });

  const P = App.views.projects;
  P.init();
  await P.restore();
  assert.equal(App.project, scratch);
  assert.equal(get('project-name').textContent, '💡 Ideas');
  assert.equal(cfg.localRoot, null);
  assert.deepEqual(cfg.recentFolders, ['/project']);
  assert.equal(cfg.projectColors[scratch], undefined);
  assert.equal(cfg.projectGroup[scratch], undefined);
  assert.deepEqual(cfg.projectLinks['/project'], []);
  assert.deepEqual(Array.from(cfg.openProjects), [scratch]);
  assert.equal(jobCalls, 0);

  await P.switchTo(null);
  await P.openIdeas();
  assert.equal(App.project, scratch);
  assert.equal(cfg.activeProject, scratch);
  assert.deepEqual(cfg.recentFolders, ['/project']);
});

test('full chat history lists the active Ideas workspace', async () => {
  const scratch = '/codeome/scratch';
  const listed = [];
  let opened;
  const App = {
    h: (_selector, _attrs, ...children) => { const el = element(); el.append(...children); return el; },
    project: scratch, views: { editor: { openCustom: (options) => { opened = options; options.render(element()); } } },
    fmtAgo: () => 'just now'
  };
  const codeome = { chat: {
    onEvent() {},
    onExit() {},
    personas: async () => [],
    list: async (project) => { listed.push(project); return [{ id: 'idea-1', title: 'New research idea', updatedAt: Date.now(), messages: 2 }]; }
  } };
  const source = fs.readFileSync(path.join(__dirname, '../renderer/js/chat.js'), 'utf8');
  vm.runInNewContext(source, { App, codeome, document: {}, setTimeout });

  App.views.chat.openFullHistory();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opened.key, 'chat-history');
  assert.deepEqual(listed, [scratch]);
});
