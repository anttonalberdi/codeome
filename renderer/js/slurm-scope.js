const SlurmScope = (() => {
  const inside = (workdir, dir, home) => {
    if (home && (dir === '~' || dir.startsWith('~/'))) dir = home.replace(/\/+$/, '') + dir.slice(1);
    const root = (dir || '').replace(/\/+$/, '') || (dir === '/' ? '/' : '');
    return !!root && (workdir === root || (root === '/' && workdir.startsWith('/')) || workdir.startsWith(root + '/'));
  };

  const matches = (job, tag, paths, fallback, home) => {
    if (tag && job.comment === tag) return true;
    if (!home && Array.isArray(paths) && paths.some((d) => d === '~' || d.startsWith('~/'))) return true;
    const dirs = Array.isArray(paths) && paths.length ? paths : [fallback];
    if ((!paths || !paths.length) && (!fallback || fallback === '~')) return true;
    return dirs.some((dir) => inside(job.workdir || '', dir, home));
  };

  return { matches };
})();

if (typeof module !== 'undefined') module.exports = SlurmScope;
