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
    replaceChildren(...items) { this.children = [...items]; },
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
    projectLinks: { '/project': [scratch] }, projectPolicy: { [scratch]: { slurmSubmit: 'never' }, '/project': { requirePlan: 'on' } },
    projectChat: { [scratch]: { model: 'opus' }, '/project': { model: 'sonnet' } }, ui: {}
  };
  const App = {
    h: (_selector, _attrs, ...children) => { const el = element(); el.append(...children); return el; },
    cfg, scratchDir: scratch, project: null, remoteDir: null, currentView: 'files', hpcConnected: false,
    isIdeas: (dir) => dir === scratch,
    views: {
      chat: { stats: () => ({ working: 0, waiting: 0, unread: 0 }), closeProject() {} },
      editor: { tabs: [], closeProject: async () => true }, terminals: { list: [], closeProject() {} }, agents: { pane: 'chat' }
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
  assert.deepEqual(cfg.projectPolicy[scratch], { slurmSubmit: 'never' });
  assert.deepEqual(cfg.projectChat[scratch], { model: 'opus' });
  assert.deepEqual(cfg.projectPolicy['/project'], { requirePlan: 'on' });
  assert.deepEqual(Array.from(cfg.openProjects), [scratch]);
  assert.equal(jobCalls, 0);

  await P.switchTo(null);
  await P.openIdeas();
  assert.equal(App.project, scratch);
  assert.equal(cfg.activeProject, scratch);
  assert.deepEqual(cfg.recentFolders, ['/project']);
  await P.close(scratch);
  assert.equal(cfg.projectPolicy[scratch], undefined);
  assert.equal(cfg.projectChat[scratch], undefined);
  assert.deepEqual(cfg.projectChat['/project'], { model: 'sonnet' });
  assert.deepEqual(cfg.projectPolicy['/project'], { requirePlan: 'on' });
});

test('full chat history lists the active Ideas workspace', async () => {
  const scratch = '/codeome/scratch';
  const listed = [];
  let opened, page;
  const App = {
    h: (selector, attrs, ...children) => {
      const el = element(); el.selector = selector;
      if (typeof attrs !== 'object' || Array.isArray(attrs) || attrs?.children) children.unshift(attrs);
      el.append(...children.flat()); return el;
    },
    project: scratch, views: { editor: { openCustom: (options) => { opened = options; page = element(); options.render(page); } } },
    fmtAgo: () => 'just now', isIdeas: (dir) => dir === scratch
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
  const nodes = [];
  const walk = (node) => { if (!node || typeof node !== 'object') return; nodes.push(node); for (const child of node.children || []) walk(child); };
  walk(page);
  assert.ok(nodes.some((node) => node.selector === 'input.hist-check'));
  assert.ok(nodes.some((node) => node.selector === 'button.btn.small' && node.children.includes('Move to project…')));
});

test('Ideas move reconciles a partly moved batch and shows the error', async () => {
  const scratch = '/codeome/scratch', target = '/project';
  const overlay = element();
  const calls = [], errors = [];
  const h = (selector, attrs, ...children) => {
    const el = element(); el.selector = selector;
    if (attrs && typeof attrs === 'object' && !Array.isArray(attrs) && !attrs.children) el.attrs = attrs;
    else children.unshift(attrs);
    el.append(...children.flat());
    if (selector === 'select') el.value = target;
    return el;
  };
  const App = {
    h, project: scratch, scratchDir: scratch, cfg: { localRoot: target }, views: {
      chat: { prepareMove: async (ids) => calls.push(['stop chats', ids]), finishMove: async (dir, ids) => calls.push(['reload chats', dir, ids]) },
      forum: { prepareMove: async (ids) => calls.push(['stop forums', ids]), reload: async () => calls.push(['reload forums']) }
    },
    isIdeas: (dir = scratch) => dir === scratch, basename: path.basename,
    err: (message) => errors.push(message), toast() {}
  };
  const codeome = {
    scratch: { promote: async (args) => { calls.push(['promote', args]); return { error: 'Second chat failed.' }; } },
    chat: { list: async () => [{ id: 'second' }] }, forum: { list: async () => ({ forums: [] }) }
  };
  const document = { getElementById: () => overlay, addEventListener() {}, removeEventListener() {} };
  const source = fs.readFileSync(path.join(__dirname, '../renderer/js/projects.js'), 'utf8');
  vm.runInNewContext(source, { App, codeome, document, setTimeout });
  const P = App.views.projects;
  P.list = [scratch, target];
  P.open = async (dir) => calls.push(['open', dir]);
  const moving = P.moveIdeas({ chats: ['first', 'second'] });
  const nodes = [];
  const walk = (node) => { if (!node || typeof node !== 'object') return; nodes.push(node); for (const child of node.children || []) walk(child); };
  walk(overlay);
  const button = nodes.find((node) => node.selector === 'button.btn.primary');
  button.attrs.onclick();
  const result = await moving;
  assert.deepEqual(Array.from(result.chats), ['first']);
  assert.deepEqual(errors, ['Second chat failed.']);
  assert.ok(calls.some((call) => call[0] === 'reload chats' && call[1] === target && call[2][0] === 'first'));
  assert.ok(calls.some((call) => call[0] === 'open' && call[1] === target));
});
