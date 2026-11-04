// Recent edit collisions shown in chat tabs and notices; never saved with transcripts.
const ChatCollisions = (() => {
  const TTL_MS = 30 * 60 * 1000;
  const LIMIT = 5;

  const recent = (collisions = [], now = Date.now()) => collisions.filter((c) => c.at <= now && now - c.at < TTL_MS);

  function add(collisions, message, now = Date.now()) {
    if (typeof message.path !== 'string' || !message.path) return recent(collisions, now);
    const others = Array.isArray(message.others) ? message.others : [];
    return [{ path: message.path, others, at: now },
      ...recent(collisions, now).filter((c) => c.path !== message.path)].slice(0, LIMIT);
  }

  function displayPath(path, project) {
    return project && path.startsWith(project.replace(/\/$/, '') + '/')
      ? path.slice(project.replace(/\/$/, '').length + 1) : path;
  }

  function line(collision, project) {
    const notes = [];
    const others = collision.others.map((other) => {
      const name = other.title || String(other.chat_id || '').slice(0, 8) || 'another chat';
      const engine = other.engine === 'codex' ? 'Codex' : other.engine === 'claude' ? 'Claude' : other.engine || 'chat';
      const note = typeof other.note === 'string' ? other.note.replace(/\s+/g, ' ').trim() : '';
      const shortNote = note.length > 80 ? note.slice(0, 79) + '…' : note;
      if (shortNote) notes.push(shortNote);
      return `${other.code ? `${other.code} ` : ''}${name} (${engine})`;
    });
    return `Also edited by ${others.join(', ') || 'another chat'}: ${displayPath(collision.path, project)}`
      + (notes.length ? ` — note: ${notes.join('; ')}` : '');
  }

  const countText = (count) => `${count} collision${count === 1 ? '' : 's'}`;
  return { TTL_MS, recent, add, displayPath, line, countText };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ChatCollisions;
if (typeof App !== 'undefined') App.chatCollisions = ChatCollisions;
