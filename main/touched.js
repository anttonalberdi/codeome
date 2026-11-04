const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const touchedDir = (cwd) => path.join(cwd, '.codeome', 'touched');
// acked maps absolute paths to the last hook acknowledgement time. App writes preserve it.
// updated_at describes writes; a record's mtime is its liveness heartbeat.
const cleanTitle = (title) => title.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
const MAX_RECORD_BYTES = 1024 * 1024;

function cappedAcked(acked) {
  if (!acked || typeof acked !== 'object' || Array.isArray(acked)) return {};
  return Object.fromEntries(Object.entries(acked).filter(([file, ts]) => path.isAbsolute(file) && Number.isFinite(ts))
    .sort((a, b) => b[1] - a[1]).slice(0, 200));
}

function checkChatId(chatId) {
  if (typeof chatId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(chatId)) throw new Error('Invalid chat ID');
}

function normalise(cwd, filePath) {
  let current = path.resolve(cwd, filePath);
  const missing = [];
  while (true) {
    try { return path.join(fs.realpathSync(current), ...missing.reverse()); }
    catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = path.dirname(current);
      if (parent === current) throw e;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function validRecord(record, chatId) {
  return record && typeof record === 'object' && !Array.isArray(record) &&
    record.chat_id === chatId && (record.engine === 'claude' || record.engine === 'codex') &&
    typeof record.title === 'string' && Number.isFinite(record.updated_at) &&
    record.files && typeof record.files === 'object' && !Array.isArray(record.files) &&
    Object.entries(record.files).every(([file, touch]) => path.isAbsolute(file) &&
      touch && typeof touch === 'object' && !Array.isArray(touch) &&
      Number.isFinite(touch.ts) && typeof touch.tool === 'string');
}

function readRecord(file, chatId) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return null;
    const bytes = Buffer.allocUnsafe(stat.size);
    let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    const after = fs.fstatSync(fd);
    if (after.size > MAX_RECORD_BYTES || count !== after.size) return null;
    const record = JSON.parse(bytes.toString('utf8', 0, count));
    if (!validRecord(record, chatId)) return null;
    record.title = cleanTitle(record.title);
    return { record, mtime: after.mtimeMs / 1000 };
  } catch { return null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

function readRecords(cwd) {
  let names;
  try { names = fs.readdirSync(touchedDir(cwd)); } catch { return []; }
  return names.filter((name) => name.endsWith('.json') && /^[A-Za-z0-9_-]+$/.test(name.slice(0, -5))).sort().slice(0, 100)
    .map((name) => readRecord(path.join(touchedDir(cwd), name), name.slice(0, -5))).filter(Boolean);
}

function writeRecord(dir, chatId, value) {
  const temp = path.join(dir, `${chatId}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx' });
    fs.renameSync(temp, path.join(dir, `${chatId}.json`));
  } catch (e) {
    try { fs.unlinkSync(temp); } catch { /* Temp file may not exist. */ }
    throw e;
  }
}

function record(cwd, chatId, meta, filePath, tool) {
  checkChatId(chatId);
  if (!meta || !['claude', 'codex'].includes(meta.engine) || typeof meta.title !== 'string') throw new Error('Invalid chat metadata');
  if (typeof tool !== 'string') throw new Error('Invalid tool');
  const file = normalise(cwd, filePath);
  const dir = touchedDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const existing = readRecord(path.join(dir, `${chatId}.json`), chatId)?.record;
  const now = Date.now() / 1000;
  const files = { ...(existing?.files || {}), [file]: { ts: now, tool } };
  const oldest = Object.entries(files).sort((a, b) => a[1].ts - b[1].ts);
  for (const [name] of oldest.slice(0, Math.max(0, oldest.length - 200))) delete files[name];
  const title = cleanTitle(meta.title) || cleanTitle(existing?.title || '');
  const value = { chat_id: chatId, engine: meta.engine, title, updated_at: now, files };
  if (existing?.acked) value.acked = cappedAcked(existing.acked);
  writeRecord(dir, chatId, value);
  return value;
}

function heartbeat(cwd, chatId) {
  checkChatId(chatId);
  const file = path.join(touchedDir(cwd), `${chatId}.json`);
  try {
    if (fs.statSync(file).isFile()) {
      const now = new Date();
      fs.utimesSync(file, now, now);
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

function list(cwd) {
  return readRecords(cwd).map(({ record }) => record);
}

function conflicts(cwd, chatId, filePath, { ttlSeconds = 1800, now = Date.now() / 1000 } = {}) {
  checkChatId(chatId);
  const file = normalise(cwd, filePath);
  return readRecords(cwd).flatMap(({ record, mtime }) => {
    if (record.chat_id === chatId) return [];
    const touch = record.files[file];
    if (!touch || now - touch.ts >= ttlSeconds || now - mtime >= 120) return [];
    return [{ chat_id: record.chat_id, engine: record.engine, title: record.title, path: file, ts: touch.ts, tool: touch.tool }];
  });
}

function clear(cwd, chatId) {
  checkChatId(chatId);
  try { fs.unlinkSync(path.join(touchedDir(cwd), `${chatId}.json`)); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}

module.exports = { record, heartbeat, list, conflicts, clear };
