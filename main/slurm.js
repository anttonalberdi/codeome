// Slurm queries over the shared SSH connection.
const ssh = require('./ssh');
const { q } = require('./util');

const SQ_FMT = '%i|%j|%T|%M|%l|%D|%C|%R|%P|%V|%Z';
const SQ_FIELDS = ['id', 'name', 'state', 'elapsed', 'limit', 'nodes', 'cpus', 'reason', 'partition', 'submitted', 'workdir'];
const SACCT_FIELDS = ['id', 'name', 'state', 'elapsed', 'exitcode', 'start', 'end', 'partition', 'maxrss', 'alloccpus', 'workdir'];

function parsePipe(stdout, fields) {
  return stdout.split('\n').filter((l) => l.trim()).map((l) => {
    const parts = l.split('|');
    const o = {};
    fields.forEach((f, i) => { o[f] = (parts[i] || '').trim(); });
    return o;
  });
}

async function queue(host) {
  const r = await ssh.exec(host, `squeue -u "$USER" --noheader -o ${q(SQ_FMT)}`);
  if (r.code !== 0) return { error: r.stderr.trim() || 'squeue failed' };
  return { jobs: parsePipe(r.stdout, SQ_FIELDS) };
}

async function history(host, days = 3) {
  const fmt = 'JobID,JobName%60,State,Elapsed,ExitCode,Start,End,Partition,MaxRSS,AllocCPUS,WorkDir%200';
  const r = await ssh.exec(host, `sacct -u "$USER" -S now-${Number(days) || 3}days --noheader -P -o ${fmt}`);
  if (r.code !== 0) return { error: r.stderr.trim() || 'sacct failed' };
  // Keep the allocation line per job; fold MaxRSS up from the .batch step.
  const rows = parsePipe(r.stdout, SACCT_FIELDS);
  const jobs = new Map();
  for (const row of rows) {
    const base = row.id.split('.')[0];
    if (!row.id.includes('.')) jobs.set(base, row);
    else if (jobs.has(base) && row.maxrss && !jobs.get(base).maxrss) jobs.get(base).maxrss = row.maxrss;
  }
  return { jobs: [...jobs.values()].reverse() };
}

// Find StdOut/StdErr paths from scontrol (works while the job is known to slurmctld).
async function details(host, id) {
  const r = await ssh.exec(host, `scontrol show job ${q(id)} 2>/dev/null`);
  const text = r.stdout || '';
  const get = (k) => { const m = text.match(new RegExp(`\\b${k}=(\\S+)`)); return m ? m[1] : ''; };
  return { text, stdout: get('StdOut'), stderr: get('StdErr'), workdir: get('WorkDir'), command: get('Command') };
}

async function tail(host, file, lines = 400) {
  const r = await ssh.exec(host, `tail -n ${Number(lines) || 400} ${q(file)}`);
  if (r.code !== 0) return { error: r.stderr.trim() };
  return { content: r.stdout };
}

async function cancel(host, id) {
  const r = await ssh.exec(host, `scancel ${q(id)}`);
  return r.code === 0 ? { ok: true } : { error: r.stderr.trim() };
}

async function submit(host, scriptPath) {
  const dir = scriptPath.replace(/\/[^/]*$/, '') || '~';
  const r = await ssh.exec(host, `cd ${q(dir)} && sbatch ${q(scriptPath)}`);
  return r.code === 0 ? { ok: true, message: r.stdout.trim() } : { error: r.stderr.trim() };
}

async function partitions(host) {
  const r = await ssh.exec(host, `sinfo --noheader -o '%P|%a|%l|%D|%C'`);
  if (r.code !== 0) return { error: r.stderr.trim() };
  return { partitions: parsePipe(r.stdout, ['name', 'avail', 'timelimit', 'nodes', 'cpus']) };
}

// Nodes that can't take work: their CPUs don't count as available.
const OFFLINE = /DOWN|DRAIN|FAIL|NOT_RESPONDING|MAINT|FUTURE|POWER|INVAL|UNKNOWN|\*/;

// Per-partition totals from `scontrol show node -o` (one line per node), plus the cluster
// as a whole (a node in two partitions counts once there). Memory is in MB.
function parseNodes(stdout) {
  const blank = (name) => ({ name, nodes: 0, offline: 0, cpus: 0, cpusUsed: 0, mem: 0, memUsed: 0, gpus: 0, gpusUsed: 0, pendingJobs: 0, pendingCpus: 0 });
  const parts = new Map(), total = blank('');
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('NodeName=')) continue;
    const get = (k) => { const m = line.match(new RegExp(`\\b${k}=(\\S+)`)); return m ? m[1] : ''; };
    const num = (k) => Number(get(k)) || 0;
    const gpu = (k) => { const m = get(k).match(/gres\/gpu=(\d+)/); return m ? Number(m[1]) : 0; };
    const off = OFFLINE.test(get('State'));
    const names = get('Partitions').split(',').filter(Boolean);
    for (const o of [total, ...names.map((n) => parts.get(n) || parts.set(n, blank(n)).get(n))]) {
      o.nodes++;
      if (off) { o.offline++; continue; }
      o.cpus += num('CPUTot'); o.cpusUsed += num('CPUAlloc');
      o.mem += num('RealMemory'); o.memUsed += num('AllocMem');
      o.gpus += gpu('CfgTRES'); o.gpusUsed += gpu('AllocTRES');
    }
  }
  return { partitions: [...parts.values()], total };
}

// What the cluster has and what is taken, with the jobs waiting on each partition.
async function resources(host) {
  const r = await ssh.exec(host, `scontrol show node -o; echo @@pending; squeue --noheader -r -t PD -o '%P|%C'`);
  const [nodes, pending = ''] = r.stdout.split('@@pending');
  const res = parseNodes(nodes);
  if (!res.total.nodes) return { error: r.stderr.trim() || 'scontrol failed' };
  const by = Object.fromEntries(res.partitions.map((p) => [p.name, p]));
  for (const row of parsePipe(pending, ['partition', 'cpus'])) {
    // A job waiting on several partitions counts on each of them.
    for (const name of row.partition.split(',')) if (by[name]) { by[name].pendingJobs++; by[name].pendingCpus += Number(row.cpus) || 0; }
  }
  return res;
}

module.exports = { resources, parseNodes, queue, history, details, tail, cancel, submit, partitions, parsePipe, SQ_FIELDS, SACCT_FIELDS };
