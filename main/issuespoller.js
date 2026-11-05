// Serial issue polling with a per-project cooldown and error backoff.
function createIssuesPoller({ store, poll, getConfig, projects, onChange = () => {}, onError = () => {},
  triageHook = async () => {}, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  const lastAttempt = new Map();
  const backoff = new Map();
  const errors = new Map();
  const pending = new Map();
  let queue = Promise.resolve();
  let timer = null;
  let running = false;

  function enabled(project) {
    const cfg = getConfig();
    return !!cfg?.issues?.enabled && cfg.projectIssues?.[project]?.enabled === true && projects().includes(project);
  }

  function lastError(project) { return errors.get(project) || null; }

  function reset(project) {
    lastAttempt.delete(project);
    backoff.delete(project);
    errors.delete(project);
  }

  async function reportError(project, error) {
    const clean = { code: String(error?.code || 'poll_failed'), message: String(error?.message || 'Could not fetch GitHub issues.') };
    if (Number.isFinite(error?.retryAfterMs)) clean.retryAfterMs = Math.min(60 * 60000, Math.max(0, error.retryAfterMs));
    const previous = errors.get(project);
    errors.set(project, clean);
    const old = backoff.get(project);
    const delay = clean.retryAfterMs ?? Math.min((old?.delay || 15000) * 2, 60 * 60000);
    backoff.set(project, { until: now() + delay, delay: clean.retryAfterMs === undefined ? delay : 0 });
    if (!previous || previous.code !== clean.code || previous.message !== clean.message) {
      try { await onError(project, clean); } catch {}
    }
  }

  async function run(project, force) {
    try {
      if (!enabled(project)) return null;
      const at = now();
      if (at < (backoff.get(project)?.until || 0) ||
          at - (lastAttempt.get(project) ?? -Infinity) < (force ? 5000 : 30000)) return null;
      lastAttempt.set(project, at);
      const result = await poll(project, store.pollState(project), getConfig().issues);
      if (!enabled(project) || result === null || result === undefined) return null;
      if (result.error) { await reportError(project, result.error); return result; }
      errors.delete(project);
      backoff.delete(project);
      const changes = store.applyPoll(project, result);
      if (changes.added.length || changes.reopened.length) {
        try { await onChange(project, changes); } catch {}
      }
      if (changes.added.length) {
        try { await triageHook(project, changes.added); } catch {}
      }
      return changes;
    } catch {
      await reportError(project, { code: 'poll_failed', message: 'Could not poll GitHub issues.' });
      return null;
    }
  }

  function refresh(project, { force = false } = {}) {
    try {
      if (project === undefined || project === null) return Promise.all(projects().map((entry) => refresh(entry, { force })));
      if (!enabled(project)) return Promise.resolve(null);
      if (pending.has(project)) return pending.get(project);
      const task = queue.then(() => run(project, force));
      queue = task.then(() => {}, () => {});
      pending.set(project, task);
      task.then(() => { if (pending.get(project) === task) pending.delete(project); },
        () => { if (pending.get(project) === task) pending.delete(project); });
      return task;
    } catch { return Promise.resolve(null); }
  }

  function schedule() {
    if (!running) return;
    const minutes = Number(getConfig()?.issues?.pollMinutes);
    timer = setTimer(() => {
      timer = null;
      Promise.resolve(refresh()).then(schedule, schedule);
    }, Math.max(2, Number.isFinite(minutes) ? minutes : 10) * 60000);
  }

  function start() {
    if (running) return;
    running = true;
    refresh();
    schedule();
  }

  function stop() {
    running = false;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  return { start, stop, refresh, reset, lastError };
}

module.exports = { createIssuesPoller };
