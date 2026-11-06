const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('closing Ideas removes its project notification override with other overrides', async () => {
  const ideas = '/projects/ideas';
  let saves = 0;
  const App = {
    h: () => ({}), views: {
      terminals: { list: [], closeProject() {} },
      editor: { closeProject: async () => true },
      chat: { stats: () => ({ working: 0, waiting: 0 }), closeProject() {} }
    },
    cfg: { projectPolicy: { [ideas]: { slurmSubmit: 'never' } },
      projectChat: { [ideas]: { mode: 'plan' } }, projectNotify: { [ideas]: { enabled: false } }, openProjects: [] },
    project: null, isIdeas: (dir) => dir === ideas,
    saveConfig: async () => { saves++; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/js/projects.js'), 'utf8'), { App });
  await App.views.projects.close(ideas);
  assert.equal(Object.hasOwn(App.cfg.projectPolicy, ideas), false);
  assert.equal(Object.hasOwn(App.cfg.projectChat, ideas), false);
  assert.equal(Object.hasOwn(App.cfg.projectNotify, ideas), false);
  assert.equal(saves, 1);
});
