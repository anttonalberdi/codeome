// Forum snapshots live beside, but never inside, saved agent chats. Each project
// gets a stable folder name from its basename and absolute path hash. Writes use
// a temporary file and rename so a crash cannot leave a partial snapshot.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const usage = require('./usage');

const validId = (id) => /^[0-9a-f-]{36}$/.test(id || '');
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || 'project';
const folder = (project) => path.join(usage.home(), 'forums',
  safeName(path.basename(project)) + '-' + crypto.createHash('sha1').update(path.resolve(project)).digest('hex').slice(0, 10));
const file = (project, id) => path.join(folder(project), id + '.json');

function save(project, snapshot) {
  if (!project || !snapshot || !validId(snapshot.id)) throw new Error('Bad forum');
  const previous = load(project, snapshot.id);
  const record = { ...snapshot, project, createdAt: snapshot.createdAt || (previous && previous.createdAt) || Date.now(),
    updatedAt: Date.now(), kind: 'forum' };
  fs.mkdirSync(folder(project), { recursive: true });
  const target = file(project, snapshot.id);
  fs.writeFileSync(target + '.tmp', JSON.stringify(record));
  fs.renameSync(target + '.tmp', target);
  return record;
}

function load(project, id) {
  if (!project || !validId(id)) return null;
  try {
    const record = JSON.parse(fs.readFileSync(file(project, id), 'utf8'));
    return record.kind === 'forum' && record.id === id && record.project === project ? record : null;
  } catch { return null; }
}

function list(project) {
  if (!project) return [];
  let names; try { names = fs.readdirSync(folder(project)); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const record = load(project, name.slice(0, -5));
    if (!record) continue;
    out.push({ id: record.id, title: record.title || 'Untitled forum', seats: record.seats || [],
      messages: (record.transcript || []).filter((item) => item.kind === 'message').length,
      updatedAt: record.updatedAt || 0, doc: record.doc || null });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function remove(project, id) {
  if (!project || !validId(id)) throw new Error('Bad forum');
  try { fs.unlinkSync(file(project, id)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ok: true };
}

module.exports = { validId, folder, save, load, list, remove };
