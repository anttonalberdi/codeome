const test = require('node:test');
const assert = require('node:assert');
const { parseWorktrees } = require('../main/worktrees');

test('parses main and linked worktrees', () => {
  const out = 'worktree /projects/app\nHEAD abc123\nbranch refs/heads/main\n\nworktree /projects/app-feature\nHEAD def456\nbranch refs/heads/feature/topic\n';
  assert.deepStrictEqual(parseWorktrees(out), [
    { path: '/projects/app', branch: 'main', head: 'abc123', isMain: true },
    { path: '/projects/app-feature', branch: 'feature/topic', head: 'def456', isMain: false }
  ]);
});

test('detached HEAD has no branch', () => {
  const out = 'worktree /projects/app\nHEAD abc123\nbranch refs/heads/main\n\nworktree /projects/detached\nHEAD def456\ndetached\n';
  assert.deepStrictEqual(parseWorktrees(out)[1], { path: '/projects/detached', branch: null, head: 'def456', isMain: false });
});

test('skips bare and prunable records', () => {
  const out = 'worktree /projects/bare.git\nbare\n\nworktree /projects/linked\nHEAD abc123\nbranch refs/heads/main\n\nworktree /projects/missing\nHEAD def456\nbranch refs/heads/old\nprunable gitdir file points to non-existent location\n';
  assert.deepStrictEqual(parseWorktrees(out), [
    { path: '/projects/linked', branch: 'main', head: 'abc123', isMain: false }
  ]);
});

test('empty input has no worktrees', () => {
  assert.deepStrictEqual(parseWorktrees(''), []);
});

test('keeps spaces in worktree paths', () => {
  const out = 'worktree /projects/my app\nHEAD abc123\nbranch refs/heads/main\n\nworktree /projects/my feature branch\nHEAD def456\nbranch refs/heads/feature\n';
  assert.deepStrictEqual(parseWorktrees(out).map((tree) => tree.path), ['/projects/my app', '/projects/my feature branch']);
});
