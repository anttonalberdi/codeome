function parseWorktrees(porcelainText) {
  const worktrees = [];
  for (const [index, block] of porcelainText.split(/\r?\n\r?\n/).entries()) {
    const lines = block.split(/\r?\n/);
    if (!lines[0].startsWith('worktree ') || lines.some((line) => line === 'bare' || line.startsWith('prunable'))) continue;
    const head = lines.find((line) => line.startsWith('HEAD '));
    const branch = lines.find((line) => line.startsWith('branch refs/heads/'));
    worktrees.push({
      path: lines[0].slice('worktree '.length),
      branch: lines.includes('detached') || !branch ? null : branch.slice('branch refs/heads/'.length),
      head: head ? head.slice('HEAD '.length) : null,
      isMain: index === 0
    });
  }
  return worktrees;
}

module.exports = { parseWorktrees };
