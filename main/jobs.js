// Agent jobs recorded by codeome-agent in <project>/.codeome/jobs/<id>/.
const fs = require('fs');
const path = require('path');
const { parseClaudeTranscript, parseCodexEvents } = require('./jobview');

const jobsDir = (project) => path.join(project, '.codeome', 'jobs');
const STALE_MS = 24 * 3600 * 1000;

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function load(project, id) {
  if (!/^[\w.-]+$/.test(id || '') || id === '.' || id === '..') return null;
  try { return JSON.parse(fs.readFileSync(path.join(jobsDir(project), id, 'job.json'), 'utf8')); } catch { return null; }
}

// Same liveness rules as codeome-agent's own list: a running Codex job whose
// wrapper is gone is "lost"; a Claude subagent with no stop event for a day is "stale".
function settle(j) {
  if (j.status !== 'running') return j;
  if (j.engine === 'codex' && !alive(j.pid)) return { ...j, status: 'lost' };
  if (j.engine === 'claude' && Date.now() - Date.parse(j.startedAt) > STALE_MS) return { ...j, status: 'stale' };
  return j;
}

async function list(project) {
  if (!project) return [];
  let names;
  try { names = await fs.promises.readdir(jobsDir(project)); } catch { return []; }
  const jobs = names.filter((n) => !n.startsWith('.')).map((n) => load(project, n)).filter(Boolean).map(settle);
  return jobs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

async function readJsonl(p, parse) {
  try {
    const st = await fs.promises.lstat(p);
    if (!st.isFile()) return { items: [], missing: true };
    const max = 2 * 1024 * 1024;
    const truncated = st.size > max;
    const size = Math.min(st.size, max);
    const fh = await fs.promises.open(p, 'r');
    let data;
    try {
      const buf = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await fh.read(buf, offset, size - offset, st.size - size + offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const tail = buf.subarray(0, offset);
      const firstBreak = truncated ? tail.indexOf(10) : -1;
      data = truncated ? (firstBreak < 0 ? '' : tail.subarray(firstBreak + 1).toString('utf8')) : tail.toString('utf8');
    } finally { await fh.close(); }
    return { items: parse(data), path: p, ...(truncated ? { truncated: true } : {}) };
  } catch { return { items: [], missing: true }; }
}

// part: brief | result | log | transcript | events. Logs are tailed so a long Codex run stays cheap to poll.
async function read(project, id, part) {
  if (part === 'transcript' || part === 'events') {
    const job = load(project, id);
    if (!job) return { error: 'Unknown job ' + id };
    if (part === 'events') return readJsonl(path.join(jobsDir(project), id, 'events.jsonl'), parseCodexEvents);
    const p = job.transcript;
    if (typeof p !== 'string' || !path.isAbsolute(p) || !p.endsWith('.jsonl')) return { items: [], missing: true };
    return readJsonl(p, parseClaudeTranscript);
  }
  const file = { brief: 'brief.md', result: 'result.md', log: 'log.txt' }[part];
  if (!file || !load(project, id)) return { error: 'Unknown job ' + id };
  const p = path.join(jobsDir(project), id, file);
  try {
    const st = await fs.promises.stat(p);
    const max = 256 * 1024;
    if (st.size <= max) return { content: await fs.promises.readFile(p, 'utf8'), path: p };
    const fh = await fs.promises.open(p, 'r');
    try {
      const buf = Buffer.alloc(max);
      await fh.read(buf, 0, max, st.size - max);
      return { content: '…\n' + buf.toString('utf8'), path: p, truncated: true };
    } finally { await fh.close(); }
  } catch { return { content: '', path: p, missing: true }; }
}

function cancel(project, id) {
  const j = load(project, id);
  if (!j) return { error: 'Unknown job ' + id };
  if (j.engine !== 'codex') return { error: 'Claude subagents are stopped from their Claude Code session.' };
  if (!alive(j.pid)) return { error: 'The job is no longer running.' };
  try { process.kill(j.pid, 'SIGTERM'); return { ok: true }; } catch (e) { return { error: e.message }; }
}

// Delete finished job folders (never running ones, never worktrees).
async function clear(project) {
  let n = 0;
  for (const j of await list(project)) {
    if (j.status === 'running') continue;
    await fs.promises.rm(path.join(jobsDir(project), j.id), { recursive: true, force: true });
    n++;
  }
  return { removed: n };
}

module.exports = { list, read, cancel, clear, settle };
