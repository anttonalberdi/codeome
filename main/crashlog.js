const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_LOG = 1024 * 1024;
let dir = null;
let session = null;

function logPath() {
  try { return dir ? path.join(dir, 'main.log') : null; } catch { return null; }
}

function readTail(logFile, n) {
  try {
    const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    const count = n === undefined ? 60 : Math.max(0, Math.trunc(Number(n)));
    return count ? lines.slice(-count) : [];
  } catch { return []; }
}

function tail(n) {
  return readTail(logPath(), n);
}

function previousRun(previousDir) {
  try {
    const file = path.join(previousDir, 'session.json');
    let previous;
    try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (err) {
      if (err.code === 'ENOENT') return null;
      return { abnormal: true, corrupt: true, tail: readTail(path.join(previousDir, 'main.log'), 60) };
    }
    if (!previous || typeof previous !== 'object' || typeof previous.clean !== 'boolean') {
      return { abnormal: true, corrupt: true, tail: readTail(path.join(previousDir, 'main.log'), 60) };
    }
    let other = false;
    const age = Date.now() - Date.parse(previous.lastBeat);
    if (Number.isInteger(previous.pid) && previous.pid > 0 && previous.pid !== process.pid && age >= 0 && age < 90000) {
      try { process.kill(previous.pid, 0); other = true; } catch {}
    }
    return {
      abnormal: !previous.clean && !other,
      ...(other ? { other: true } : {}),
      lastBeat: previous.lastBeat,
      startedAt: previous.startedAt,
      version: previous.version,
      pid: previous.pid,
      tail: readTail(path.join(previousDir, 'main.log'), 60)
    };
  } catch { return { abnormal: true, corrupt: true, tail: [] }; }
}

function rotate(logFile, bytes) {
  let size = 0;
  try { size = fs.statSync(logFile).size; }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (!size || size + bytes <= MAX_LOG) return;
  for (let i = 3; i >= 1; i--) {
    const from = i === 1 ? logFile : `${logFile}.${i - 1}`;
    const to = `${logFile}.${i}`;
    try { fs.renameSync(from, to); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
}

function append(line) {
  const file = logPath();
  if (!file) return;
  rotate(file, Buffer.byteLength(line));
  fs.appendFileSync(file, line);
}

function safeStringify(value) {
  const seen = new WeakSet();
  try {
    const result = JSON.stringify(value, (key, item) => {
      if (typeof item === 'bigint') return String(item);
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    });
    return result === undefined ? 'null' : result;
  } catch { return '"[Unserializable]"'; }
}

function redact(value) {
  let result = String(value);
  for (const [name, secret] of Object.entries(process.env)) {
    if (/(TOKEN|SECRET|KEY|PASSWORD)/i.test(name) && typeof secret === 'string' && secret.length >= 8) {
      result = result.split(secret).join('[redacted]');
    }
  }
  return result
    .replace(/Bearer\s+\S+/gi, '[redacted]')
    .replace(/\b(?:token|secret|password|passwd|key|authorization|bearer)["']?\s*[=:]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi, '[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/gh[pousr]_[A-Za-z0-9]{10,}/g, '[redacted]');
}

const oneLine = (value) => String(value).replace(/\r?\n|\r/g, ' ⏎ ');

function log(level, msg, extra) {
  try {
    const detail = extra === undefined ? '' : ` ${redact(safeStringify(extra))}`;
    append(`${new Date().toISOString()} [${level}] ${redact(oneLine(msg))}${detail}\n`);
  } catch {}
}

function logError(label, err) {
  try {
    const message = err && typeof err.message === 'string' ? err.message : safeStringify(err);
    const stack = err && typeof err.stack === 'string' ? err.stack : '';
    append(`${new Date().toISOString()} [error] ${redact(oneLine(`${label}: ${message}`))}${stack ? `\n${redact(stack)}` : ''}\n`);
  } catch {}
}

function writeSession(next) {
  const file = path.join(dir, 'session.json');
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

function ownsSession() {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).sessionId === session.sessionId; }
  catch { return false; }
}

function init(opts) {
  try {
    const { dir: nextDir, version } = opts || {};
    fs.mkdirSync(nextDir, { recursive: true });
    dir = nextDir;
    const startedAt = new Date().toISOString();
    session = { sessionId: crypto.randomUUID(), pid: process.pid, version, startedAt, lastBeat: startedAt, clean: false };
    writeSession(session);
    log('info', `start version=${version} pid=${process.pid} sessionId=${session.sessionId}`);
  } catch {}
}

function heartbeat(stats) {
  try {
    if (!session || !ownsSession()) return;
    const extra = stats && typeof stats === 'object' && !Array.isArray(stats) ? stats : {};
    const next = { ...session, stats: extra, lastBeat: new Date().toISOString() };
    if (writeSession(next)) session = next;
  } catch {}
}

function markClean() {
  try {
    if (!session) return;
    const next = { ...session, clean: true };
    if (ownsSession() && writeSession(next)) session = next;
    log('info', 'clean exit');
  } catch {}
}

module.exports = { init, previousRun, log, logError, heartbeat, markClean, tail, logPath };
