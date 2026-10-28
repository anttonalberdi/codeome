// Runtime progress from jobs.list, reduced to values a job card can display.
const Progress = (() => {
  const STALL_SECONDS = 120;
  const finite = (value) => Number.isFinite(value) ? value : null;
  const timestamp = (value) => {
    if (typeof value === 'number') return finite(value);
    if (value == null || value === '') return null;
    const at = value instanceof Date ? value.getTime() : Date.parse(value);
    return finite(at);
  };

  function progressView(progress, now, options = {}) {
    if (!progress || !Array.isArray(progress.stages) || !progress.stages.length) return null;
    const at = timestamp(now);
    const updatedAt = timestamp(progress.updatedAt);
    let current = -1, doneCount = 0, stalled = false;
    const stages = progress.stages.map((entry, index) => {
      const stage = entry || {};
      const { id, label, state, kind, unit } = stage;
      const done = finite(stage.done), total = finite(stage.total), baselineSeconds = finite(stage.baselineSeconds);
      const pct = done !== null && total !== null && total > 0 ? Math.max(0, Math.min(100, done / total * 100)) : null;
      const startedAt = timestamp(stage.startedAt);
      const running = state === 'running' && (options.status == null || options.status === 'running' || options.status === 'pausing');
      const end = stage.endedAt ? timestamp(stage.endedAt) : running ? at : null;
      const elapsedSeconds = startedAt !== null && end !== null ? (end - startedAt) / 1000 : null;
      if (running && current === -1) current = index;
      if (state === 'done') doneCount++;
      const stageUpdatedAt = timestamp(stage.updatedAt);
      const lastUpdate = stageUpdatedAt !== null ? stageUpdatedAt : updatedAt;
      const stageStalled = running && at !== null && lastUpdate !== null && (at - lastUpdate) / 1000 > STALL_SECONDS;
      if (stageStalled) stalled = true;
      let etaSeconds = null;
      if (running && elapsedSeconds !== null) {
        if (pct !== null && done > 0) etaSeconds = finite(Math.max(0, elapsedSeconds / done * (total - done)));
        else if (baselineSeconds !== null) etaSeconds = finite(Math.max(0, baselineSeconds - elapsedSeconds));
      }
      return { id, label, state: state === 'running' && !running ? 'stopped' : state, kind, pct, done, total, unit, elapsedSeconds, baselineSeconds, etaSeconds, stalled: stageStalled };
    });
    // Only the first running stage contributes partial progress.
    const overallPct = (doneCount + (current === -1 ? 0 : (stages[current].pct || 0) / 100)) / stages.length * 100;
    return { stages, current, doneCount, total: stages.length, overallPct, stalled };
  }

  return { progressView, STALL_SECONDS };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Progress;
if (typeof App !== 'undefined') App.progress = Progress;
