const { run } = require('./util');

// CPU is percent of one core; ps pcpu is a lagged average, not instantaneous.
function parsePs(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+(?:[.,]\d+)?)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const row = { pid: Number(match[1]), ppid: Number(match[2]), cpu: Number(match[3].replace(',', '.')), rssKb: Number(match[4]) };
    if (Number.isSafeInteger(row.pid) && Number.isSafeInteger(row.ppid) && Number.isFinite(row.cpu) && Number.isFinite(row.rssKb)) rows.push(row);
  }
  return rows;
}

function parseWindows(text) {
  const data = JSON.parse(text);
  return (Array.isArray(data) ? data : data === null ? [] : [data]).filter(row =>
    row && Number.isSafeInteger(row.ProcessId) && row.ProcessId >= 0 &&
    Number.isSafeInteger(row.ParentProcessId) && row.ParentProcessId >= 0 &&
    typeof row.WorkingSetSize === 'number' && Number.isFinite(row.WorkingSetSize) && row.WorkingSetSize >= 0
  ).map(row => ({ pid: row.ProcessId, ppid: row.ParentProcessId, cpu: null, rssKb: row.WorkingSetSize / 1024 }));
}

function subtreeTotals(rootPids, rows) {
  const processes = new Map(rows.map(row => [row.pid, row]));
  const children = new Map();
  for (const row of processes.values()) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  const totals = {};
  for (const root of new Set(rootPids)) {
    const total = { cpu: 0, rssKb: 0, nproc: 0, alive: processes.has(root) };
    const pending = total.alive ? [root] : [];
    const seen = new Set();
    while (pending.length) {
      const pid = pending.pop();
      if (seen.has(pid)) continue;
      seen.add(pid);
      const row = processes.get(pid);
      total.cpu = total.cpu === null || row.cpu === null ? null : total.cpu + row.cpu;
      total.rssKb += row.rssKb;
      total.nproc++;
      pending.push(...(children.get(pid) || []));
    }
    // Keep process membership internal; IPC rows retain the existing public shape.
    Object.defineProperty(total, 'members', { value: [...seen].map((pid) => processes.get(pid)) });
    totals[root] = total;
  }
  return totals;
}

// Success returns totals keyed by PID; any command or parsing failure returns {error}.
async function sample(rootPids, { platform = process.platform, env, timeout = platform === 'win32' ? 10000 : 3000, runner = run } = {}) {
  try {
    const windows = platform === 'win32';
    const command = windows ? 'powershell' : 'ps';
    const args = windows ? ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress'] : ['-A', '-o', 'pid=,ppid=,pcpu=,rss='];
    const result = await runner(command, args, { env, timeout });
    if (result.code !== 0) return { error: result.stderr.trim() || `${command} exited with code ${result.code}` };
    return subtreeTotals(rootPids, windows ? parseWindows(result.stdout) : parsePs(result.stdout));
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

module.exports = { parsePs, parseWindows, subtreeTotals, sample };
