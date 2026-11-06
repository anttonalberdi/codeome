const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { isCode } = require('../renderer/js/chat-code');

const touchedDir = (cwd) => path.join(cwd, '.codeome', 'touched');
// acked maps absolute paths to the last hook acknowledgement time. App writes preserve it.
// updated_at describes writes; a record's mtime is its liveness heartbeat.
const cleanText = (value, limit) => value.slice(0, 10240)
  .replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\u{e0000}-\u{e007f}]/gu, ' ')
  .replace(/\s+/g, ' ').trim().slice(0, limit);
const cleanTitle = (title) => cleanText(title, 80);
const MAX_RECORD_BYTES = 1024 * 1024;
const STATUSES = new Set(['working', 'waiting', 'idle', 'unknown']);

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

function readJSON(file) {
  let fd;
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0));
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
    return { value: JSON.parse(bytes.toString('utf8', 0, count)), mtime: after.mtimeMs / 1000 };
  } catch { return null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

function readRecord(file, chatId) {
  const item = readJSON(file);
  if (!item || !validRecord(item.value, chatId)) return null;
  item.value.title = cleanTitle(item.value.title);
  return { record: item.value, mtime: item.mtime };
}

function statusFields(value) {
  const fields = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    code: isCode(fields.code) ? fields.code : '',
    status: STATUSES.has(fields.status) ? fields.status : 'unknown',
    status_at: Number.isFinite(fields.status_at) ? fields.status_at : 0,
    first_request: typeof fields.first_request === 'string' ? cleanText(fields.first_request, 200) : '',
    plan_title: typeof fields.plan_title === 'string' ? cleanText(fields.plan_title, 200) : '',
    jobs: Array.isArray(fields.jobs) ? fields.jobs.filter((job) => typeof job === 'string')
      .map((job) => cleanText(job, 80)).filter(Boolean).slice(0, 5) : [],
  };
}

function mergeMeta(cwd, record, now = Date.now() / 1000) {
  const dir = touchedDir(cwd);
  const id = record.chat_id;
  const status = statusFields(readJSON(path.join(dir, `${id}.status.json`))?.value);
  const noteFile = readJSON(path.join(dir, `${id}.note.json`))?.value;
  const note = noteFile && typeof noteFile === 'object' && !Array.isArray(noteFile) &&
    typeof noteFile.note === 'string' && Number.isFinite(noteFile.at) && now - noteFile.at <= 86400 ? cleanText(noteFile.note, 200) : '';
  return { ...record, code: status.code, note,
    status: now - status.status_at > 600 ? 'unknown' : status.status,
    status_at: status.status_at, first_request: status.first_request,
    plan_title: status.plan_title, jobs: status.jobs };
}

function readRecords(cwd) {
  let names;
  try { names = fs.readdirSync(touchedDir(cwd)); } catch { return []; }
  return names.filter((name) => name.endsWith('.json') && /^[A-Za-z0-9_-]+$/.test(name.slice(0, -5))).sort().slice(0, 100)
    .map((name) => readRecord(path.join(touchedDir(cwd), name), name.slice(0, -5))).filter(Boolean);
}

function writeAtomic(dir, name, value) {
  const temp = path.join(dir, `${name}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx' });
    fs.renameSync(temp, path.join(dir, `${name}.json`));
  } catch (e) {
    try { fs.unlinkSync(temp); } catch { /* Temp file may not exist. */ }
    throw e;
  }
}

function start(cwd, chatId, meta) {
  try {
    checkChatId(chatId);
    if (!meta || !['claude', 'codex'].includes(meta.engine) || typeof meta.title !== 'string') return null;
    const dir = touchedDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `${chatId}.json`);
    const value = { chat_id: chatId, engine: meta.engine, title: cleanTitle(meta.title),
      updated_at: Date.now() / 1000, files: {} };
    try { fs.writeFileSync(target, JSON.stringify(value), { flag: 'wx' }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    const current = readRecord(target, chatId)?.record;
    if (!current) return null;
    try { writeStatus(cwd, chatId, { code: meta.code, status: 'unknown', jobs: [] }); }
    catch { /* Presence must not interrupt the session. */ }
    return readMeta(cwd, chatId) || current;
  } catch { return null; }
}

function writeStatus(cwd, chatId, fields = {}) {
  checkChatId(chatId);
  const dir = touchedDir(cwd);
  if (!readRecord(path.join(dir, `${chatId}.json`), chatId)) return;
  const previous = statusFields(readJSON(path.join(dir, `${chatId}.status.json`))?.value);
  const update = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};
  for (const key of ['code', 'status', 'first_request', 'plan_title', 'jobs']) {
    if (Object.hasOwn(update, key)) previous[key] = update[key];
  }
  writeAtomic(dir, `${chatId}.status`, statusFields({ ...previous, status_at: Date.now() / 1000 }));
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
  writeAtomic(dir, chatId, value);
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
  return readRecords(cwd).map(({ record }) => mergeMeta(cwd, record));
}

function readMeta(cwd, chatId) {
  checkChatId(chatId);
  const record = readRecord(path.join(touchedDir(cwd), `${chatId}.json`), chatId)?.record;
  return record ? mergeMeta(cwd, record) : null;
}

function conflicts(cwd, chatId, filePath, { ttlSeconds = 1800, now = Date.now() / 1000 } = {}) {
  checkChatId(chatId);
  const file = normalise(cwd, filePath);
  return readRecords(cwd).flatMap(({ record, mtime }) => {
    if (record.chat_id === chatId) return [];
    const touch = record.files[file];
    if (!touch || now - touch.ts >= ttlSeconds || now - mtime >= 120) return [];
    const meta = mergeMeta(cwd, record, now);
    return [{ chat_id: record.chat_id, engine: record.engine, title: meta.title, path: file,
      ts: touch.ts, tool: touch.tool, code: meta.code, note: meta.note }];
  });
}

function clear(cwd, chatId) {
  checkChatId(chatId);
  for (const suffix of ['', '.status', '.note']) {
    try { fs.unlinkSync(path.join(touchedDir(cwd), `${chatId}${suffix}.json`)); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  for (const kind of ['inbox', 'outbox']) {
    try {
      const base = path.join(cwd, '.codeome');
      const parent = path.join(base, kind);
      const dir = path.join(parent, chatId);
      let missing = false;
      for (const part of [base, parent, dir]) {
        try { if (!fs.lstatSync(part).isDirectory()) throw new Error('Unsafe message directory'); }
        catch (e) { if (e.code === 'ENOENT') { missing = true; break; } throw e; }
      }
      if (missing) continue;
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        if (fs.lstatSync(file).isFile()) fs.unlinkSync(file);
      }
      try { fs.rmdirSync(dir); } catch (e) { if (e.code !== 'ENOTEMPTY') throw e; }
    } catch (e) { if (e.message !== 'Unsafe message directory') throw e; }
  }
}

module.exports = { start, writeStatus, readMeta, record, heartbeat, list, conflicts, clear, readJSON };
