const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { isCode } = require('../renderer/js/chat-code');

function validText(value, limit) {
  return typeof value === 'string' && value.length <= limit;
}

function recordKind(file) {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.size >= 512 * 1024) return null;
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
      Object.getPrototypeOf(record) !== Object.prototype) return null;
    if (record.kind === undefined || record.kind === 'files') return 'files';
    return record.kind === 'chats' ? 'chats' : null;
  } catch { return null; }
}

// Valid payloads write available groups; collisions return { ok: true, skipped: [codes] }.
function applyGroups(payload, { isKnownProject } = {}) {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !validText(payload.project, 10240) || !path.isAbsolute(payload.project) ||
      !Array.isArray(payload.groups) || payload.groups.length > 50) return { ok: false };
    const kind = payload.kind === undefined ? 'files' : payload.kind;
    if (kind !== 'files' && kind !== 'chats') return { ok: false };
    const codes = new Set();
    for (const group of payload.groups) {
      if (!group || typeof group !== 'object' || Array.isArray(group) ||
        !isCode(group.code) || codes.has(group.code) || !validText(group.name, 200)) return { ok: false };
      if (kind === 'files' ?
        !Array.isArray(group.files) || group.files.length > 500 ||
          !group.files.every((file) => validText(file, 4096)) :
        !Array.isArray(group.chats) || group.chats.length > 50 ||
          !group.chats.every((chat) => chat && typeof chat === 'object' && !Array.isArray(chat) &&
            isCode(chat.code) && validText(chat.title, 200))) return { ok: false };
      codes.add(group.code);
    }
    if (Buffer.byteLength(JSON.stringify(payload)) > 4 * 1024 * 1024) return { ok: false };
    const at = new Date().toISOString();
    const records = payload.groups.map((group) => ({
      code: group.code,
      text: JSON.stringify({ code: group.code, name: group.name, kind,
        [kind]: kind === 'chats' ? group.chats.filter((chat, index, chats) =>
          chats.findIndex((item) => item.code === chat.code) === index) : group.files, at })
    }));
    if (records.some(({ text }) => Buffer.byteLength(text) >= 512 * 1024)) return { ok: false };

    const project = fs.realpathSync(payload.project);
    if (isKnownProject && !isKnownProject(project)) return { ok: false };
    const codeomeDir = path.join(project, '.codeome');
    const dir = path.join(codeomeDir, 'groups');
    if (!fs.lstatSync(codeomeDir).isDirectory()) return { ok: false };
    try { fs.mkdirSync(dir, { mode: 0o700 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    const safeDir = () => fs.lstatSync(dir).isDirectory() &&
      path.relative(project, fs.realpathSync(dir)) === path.join('.codeome', 'groups');
    if (!safeDir()) return { ok: false };

    const existing = new Map();
    const skipped = new Set();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const code = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : '';
      if (!isCode(code)) continue;
      const oldKind = recordKind(path.join(dir, entry.name));
      existing.set(entry.name, oldKind);
      if (codes.has(code) && oldKind !== kind) skipped.add(code);
    }

    const temps = [];
    try {
      for (const { code, text } of records) {
        if (skipped.has(code)) continue;
        const temp = path.join(dir, `${code}.${randomUUID()}.tmp`);
        const fd = fs.openSync(temp, 'wx', 0o600);
        temps.push({ code, temp });
        try { fs.writeFileSync(fd, text); }
        finally { fs.closeSync(fd); }
      }
      if (!safeDir()) throw new Error('Groups directory changed');
      for (const { code, temp } of temps) {
        const target = path.join(dir, `${code}.json`);
        try {
          fs.lstatSync(target);
          if (recordKind(target) !== kind) {
            skipped.add(code);
            try { fs.unlinkSync(temp); } catch { /* Best effort. */ }
            continue;
          }
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        fs.renameSync(temp, target);
      }
    } catch (e) {
      for (const { temp } of temps) {
        try { fs.unlinkSync(temp); } catch { /* Temp may already have been renamed. */ }
      }
      throw e;
    }
    if (!safeDir()) return { ok: false };
    const now = Date.now();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (existing.get(entry.name) === kind && !codes.has(entry.name.slice(0, -5)) && entry.isFile())
        fs.unlinkSync(path.join(dir, entry.name));
      if (entry.name.endsWith('.tmp') && (entry.isFile() || entry.isSymbolicLink()) &&
        now - fs.lstatSync(path.join(dir, entry.name)).mtimeMs > 60000) fs.unlinkSync(path.join(dir, entry.name));
    }
    return skipped.size ? { ok: true, skipped: [...skipped] } : { ok: true };
  } catch { return { ok: false }; }
}

module.exports = { applyGroups };
