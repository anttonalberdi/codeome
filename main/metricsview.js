// Assemble sampled process trees without depending on Electron or live sessions.
function buildPayload({ items, totals, appMetrics, ncpu, ts = Date.now() }) {
  try {
    if (totals.error) return { error: totals.error };
    const groups = new Map();
    const counted = new Map();
    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    for (const item of items) {
      const sample = totals[item.pid];
      if (!sample?.alive || typeof item.project !== 'string' || !item.project) continue;
      if (!groups.has(item.project)) groups.set(item.project, { project: item.project, items: [], totals: { cpu: 0, rssKb: 0, nproc: 0 } });
      const group = groups.get(item.project);
      const { kind, id, label, pid } = item;
      const { cpu, rssKb, nproc } = sample;
      group.items.push({ kind, id, label, pid, cpu, rssKb, nproc });
      if (!counted.has(item.project)) counted.set(item.project, new Set());
      const seen = counted.get(item.project);
      for (const member of sample.members || [{ pid, cpu, rssKb, nproc }]) {
        if (seen.has(member.pid)) continue;
        seen.add(member.pid);
        group.totals.cpu = group.totals.cpu === null || member.cpu === null ? null : group.totals.cpu + member.cpu;
        group.totals.rssKb += member.rssKb;
        group.totals.nproc += member.nproc ?? 1;
      }
    }
    const projects = [...groups.values()].sort((a, b) => compare(a.project, b.project));
    for (const group of projects) group.items.sort((a, b) => compare(a.kind, b.kind) || compare(a.id, b.id));
    // Electron reports workingSetSize in KB.
    const app = appMetrics.reduce((sum, metric) => ({ cpu: sum.cpu + metric.cpu.percentCPUUsage, rssKb: sum.rssKb + metric.memory.workingSetSize }), { cpu: 0, rssKb: 0 });
    return { ts, ncpu, projects, app };
  } catch (e) { return { error: String(e.message || e) }; }
}

module.exports = { buildPayload };
