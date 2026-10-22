// Agent jobs recorded by codeome-agent in <project>/.codeome/jobs/<id>/.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { parseClaudeTranscript, parseCodexEvents } = require('./jobview');
const kit = require('./kit');

const jobsDir = (project) => path.join(project, '.codeome', 'jobs');
const STALE_MS = 24 * 3600 * 1000;
const resuming = new Set();

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
  if (j.status !== 'running' && j.status !== 'pausing') return j;
  if (j.engine === 'codex' && !alive(j.pid)) return { ...j, status: j.status === 'pausing' && j.session ? 'paused' : 'lost' };
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
  if (!['running', 'pausing'].includes(j.status) || !alive(j.pid)) return { error: 'The job is no longer running.' };
  try { process.kill(j.pid, 'SIGTERM'); return { ok: true }; } catch (e) { return { error: e.message }; }
}

function runnerError(project) {
  const installed = kit.status(project);
  if (!installed.installed || installed.outdated || installed.missing.includes('.codeome/bin/codeome-agent') || installed.modified.includes('.codeome/bin/codeome-agent'))
    return 'Update the agent kit before pausing or resuming Codex jobs.';
  return null;
}

function pause(project, id) {
  const j = load(project, id);
  if (!j) return Promise.resolve({ error: 'Unknown job ' + id });
  if (j.engine !== 'codex') return Promise.resolve({ error: 'Only Codex jobs can be paused.' });
  if (j.status !== 'running' || !alive(j.pid)) return Promise.resolve({ error: 'The job is no longer running.' });
  const outdated = runnerError(project);
  if (outdated) return Promise.resolve({ error: outdated });
  return new Promise((resolve) => execFile('python3', [path.join(project, '.codeome', 'bin', 'codeome-agent'), 'pause', id],
    { cwd: project, encoding: 'utf8', timeout: 5000 }, (e, _out, err) => resolve(e ? { error: err.trim().replace(/^codeome-agent: /, '') || e.message } : { ok: true })));
}

function resume(project, id) {
  const record = load(project, id);
  if (!record) return Promise.resolve({ error: 'Unknown job ' + id });
  const j = settle(record);
  if (j.engine !== 'codex' || j.status !== 'paused' || !j.session || j.resumedBy) return Promise.resolve({ error: 'This Codex job cannot be resumed.' });
  const key = project + '\0' + id;
  if (resuming.has(key)) return Promise.resolve({ error: 'This Codex job is already resuming.' });
  const outdated = runnerError(project);
  if (outdated) return Promise.resolve({ error: outdated });
  const bin = path.join(project, '.codeome', 'bin', 'codeome-agent');
  if (!fs.existsSync(bin)) return Promise.resolve({ error: 'Install the agent kit before resuming this job.' });
  resuming.add(key);
  return new Promise((resolve) => {
    const child = spawn(process.env.SHELL || '/bin/zsh', ['-l', '-c', 'exec "$0" "$@"', 'python3', bin, 'codex', '--resume', j.session, '--title', j.title || j.role],
      { cwd: project, detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
    let resolved = false, done = false;
    const answer = (result) => { if (!resolved) { resolved = true; resolve(result); } };
    const finish = (result) => { if (done) return; done = true; resuming.delete(key); clearInterval(poll); clearTimeout(timeout); answer(result); };
    const check = () => {
      const resumedBy = load(project, id)?.resumedBy;
      if (resumedBy) finish({ ok: true, id: resumedBy });
    };
    const poll = setInterval(check, 100);
    const timeout = setTimeout(() => answer({ error: 'The resumed job is still starting. Check Jobs shortly.' }), 10000);
    child.on('error', (e) => finish({ error: e.message }));
    child.on('exit', () => { check(); if (!done) finish({ error: 'The resumed job did not start. Check the Codex account limit and agent kit.' }); });
    child.stdin.on('error', () => {});
    child.stdin.end('Continue where you left off.');
    child.unref();
  });
}

// Delete finished job folders (never running ones, never worktrees).
async function clear(project) {
  let n = 0;
  for (const j of await list(project)) {
    if (j.status === 'running' || j.status === 'pausing') continue;
    await fs.promises.rm(path.join(jobsDir(project), j.id), { recursive: true, force: true });
    n++;
  }
  return { removed: n };
}

module.exports = { list, read, cancel, pause, resume, clear, settle };
