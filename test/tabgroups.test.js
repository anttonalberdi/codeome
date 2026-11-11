const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const groups = require('../renderer/js/tab-groups');
const ChatCode = require('../renderer/js/chat-code');

const a = { code: 'BBBB', name: 'First', ids: ['a', 'b', 'c'] };
const b = { code: 'BBBC', name: 'Second', ids: ['d', 'e'] };

test('selection handles both range directions, a missing anchor, and toggles', () => {
  const ordered = ['a', 'b', 'c', 'd'];
  assert.deepEqual(groups.rangeSelect(ordered, 'b', 'd'), ['b', 'c', 'd']);
  assert.deepEqual(groups.rangeSelect(ordered, 'd', 'b'), ['b', 'c', 'd']);
  assert.deepEqual(groups.rangeSelect(ordered, 'missing', 'c'), ['c']);
  assert.deepEqual(groups.rangeSelect(ordered, 'a', 'missing'), ['missing']);
  const selected = ['a', 'b'];
  assert.deepEqual(groups.toggleSelect(selected, 'c'), ['a', 'b', 'c']);
  assert.deepEqual(groups.toggleSelect(selected, 'a'), ['b']);
  assert.deepEqual(selected, ['a', 'b']);
});

test('creation assigns an unused code, defaults the name, and moves members', () => {
  const original = [a, b];
  const result = groups.createGroup(original, ['b', 'c', 'd', 'd'], ['BBBD']);
  assert.equal(ChatCode.isCode(result.group.code), true);
  assert.equal(new Set(['BBBB', 'BBBC', 'BBBD']).has(result.group.code), false);
  assert.deepEqual(result.group, { code: result.group.code, name: 'Group', ids: ['b', 'c', 'd'] });
  assert.deepEqual(result.groups, [result.group]);
  assert.deepEqual(a, { code: 'BBBB', name: 'First', ids: ['a', 'b', 'c'] });
  assert.deepEqual(b, { code: 'BBBC', name: 'Second', ids: ['d', 'e'] });
  assert.throws(() => groups.createGroup([], [], []), /at least one member/);
  assert.equal(groups.createGroup([], ['a'], new Set(['BBBB']), 'Review').group.name, 'Review');
});

test('adding members moves them between groups and keeps unique ids', () => {
  const result = groups.addToGroup([a, b], 'BBBC', ['b', 'c', 'b', 'e']);
  assert.deepEqual(result, [{ code: 'BBBC', name: 'Second', ids: ['d', 'e', 'b', 'c'] }]);
  assert.deepEqual(a.ids, ['a', 'b', 'c']);
  assert.deepEqual(b.ids, ['d', 'e']);
  assert.throws(() => groups.addToGroup([a], 'NONE', ['z']), /Unknown tab group/);
});

test('removing members dissolves groups left with one member', () => {
  assert.deepEqual(groups.removeFromGroup([a, b], ['b', 'd']),
    [{ code: 'BBBB', name: 'First', ids: ['a', 'c'] }]);
  assert.deepEqual(groups.removeFromGroup([a], ['b', 'c']), []);
  assert.deepEqual(groups.removeFromGroup([a], ['missing']), [a]);
});

test('ungroup, rename, remove tab, and group lookup preserve inputs', () => {
  const original = [a, b];
  assert.deepEqual(groups.ungroup(original, 'BBBB'), [b]);
  assert.deepEqual(groups.renameGroup(original, 'BBBB', 'Renamed'),
    [{ code: 'BBBB', name: 'Renamed', ids: ['a', 'b', 'c'] }, b]);
  assert.equal(groups.groupOf(original, 'e'), b);
  assert.equal(groups.groupOf(original, 'missing'), null);
  assert.deepEqual(groups.removeTab(original, 'd'), {
    groups: [a], dissolved: [{ code: 'BBBC', name: 'Second', ids: ['e'] }]
  });
  assert.deepEqual(groups.removeTab(original, 'b'), {
    groups: [{ code: 'BBBB', name: 'First', ids: ['a', 'c'] }, b], dissolved: []
  });
  assert.deepEqual(groups.removeTab(original, 'missing'), { groups: original, dissolved: [] });
  assert.deepEqual(groups.removeTab([{ code: 'BBBD', name: 'One', ids: ['z'] }], 'z'), {
    groups: [], dissolved: [{ code: 'BBBD', name: 'One', ids: [] }]
  });
  assert.deepEqual(a, { code: 'BBBB', name: 'First', ids: ['a', 'b', 'c'] });
  assert.deepEqual(b, { code: 'BBBC', name: 'Second', ids: ['d', 'e'] });
});

test('layout places each group at its first visible member', () => {
  assert.deepEqual(groups.layout(['x', 'c', 'd', 'a', 'e', 'y'], [a, b]), [
    { type: 'tab', id: 'x' }, { type: 'group', group: a },
    { type: 'group', group: b }, { type: 'tab', id: 'y' }
  ]);
  assert.deepEqual(groups.layout(['x'], [a]), [{ type: 'tab', id: 'x' }]);
});

test('serialise skips tabs without a path and retains group metadata', () => {
  const paths = { a: '/a.R', c: 'hpc:/c.R', d: '/d.py' };
  assert.deepEqual(groups.serialise([a, b], (id) => paths[id] || null), [
    { code: 'BBBB', name: 'First', files: ['/a.R', 'hpc:/c.R'] },
    { code: 'BBBC', name: 'Second', files: ['/d.py'] }
  ]);
  assert.deepEqual(a.ids, ['a', 'b', 'c']);
});

test('renderer exposes the same API through App', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/js/tab-groups.js'), 'utf8');
  const App = { chatCode: ChatCode };
  vm.runInNewContext(source, { App });
  assert.deepEqual(Object.keys(App.tabGroups), Object.keys(groups));
  assert.equal(App.tabGroups.createGroup([], ['a'], []).group.name, 'Group');
});
