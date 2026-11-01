const { createRegistry } = require('./remote-decisions');
const { createBuffer, fromSaved } = require('./remote-items');
const { EventEmitter } = require('node:events');

function createRemote({ send, loadChat, exitGraceMs = 10 * 60 * 1000, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const registry = createRegistry();
  const buffers = new Map();
  const sessions = new Map();
  const events = new EventEmitter();

  registry.on('decided', ({ requestId, chatId, source, decision, answers }) => {
    buffers.get(chatId)?.markDecided(requestId, decision, source, answers);
    send('chat:decided', { id: chatId, requestId, decision, source, ...(answers ? { answers } : {}) });
  });
  registry.on('cancelled', ({ chatId, requestId }) => buffers.get(chatId)?.cancel(requestId));

  function detach(chatId) {
    const entry = sessions.get(chatId);
    if (entry) {
      if (entry.timer) clearTimer(entry.timer);
      entry.session.off('message', entry.onMessage);
      entry.session.off('exit', entry.onExit);
      sessions.delete(chatId);
    }
    registry.clearChat(chatId, true);
    buffers.delete(chatId);
    events.emit('chat-detached', chatId);
  }

  function attach(session, chatId, { project, engine, role, seed } = {}) {
    if (sessions.has(chatId)) {
      const entry = sessions.get(chatId);
      if (entry.timer) clearTimer(entry.timer);
      entry.session.off('message', entry.onMessage);
      entry.session.off('exit', entry.onExit);
      sessions.delete(chatId);
      for (const record of registry.list(chatId)) buffers.get(chatId)?.cancel(record.requestId);
      registry.clearChat(chatId);
    }
    const buffer = buffers.get(chatId) || (seed && loadChat ? fromSaved(loadChat(project, chatId)) : createBuffer());
    buffers.set(chatId, buffer);
    const onMessage = (message) => {
      buffer.push(message);
      if (message?.type === 'control_request') registry.add(chatId, session, message);
      else if (message?.type === 'control_cancel_request') registry.cancel(chatId, message.request_id);
      events.emit('message', chatId);
    };
    const onExit = () => {
      const entry = sessions.get(chatId);
      if (!entry || entry.session !== session || entry.exited) return;
      entry.exited = true;
      for (const record of registry.list(chatId)) buffer.cancel(record.requestId);
      registry.clearChat(chatId);
      events.emit('chat-exit', chatId);
      entry.timer = setTimer(() => { if (sessions.get(chatId) === entry) detach(chatId); }, exitGraceMs);
      entry.timer?.unref?.();
    };
    session.on('message', onMessage);
    session.on('exit', onExit);
    sessions.set(chatId, { session, onMessage, onExit, project, engine, role });
    events.emit('chat-started', chatId);
    return buffer;
  }

  function respond(chatId, requestId, response, source = 'desktop') {
    const result = registry.answerRaw(chatId, requestId, response, source);
    if (result.ok) return { ok: true };
    if (result.reason === 'already-decided') return { ok: true, already: true };
    if (result.reason === 'chat-mismatch') return { error: 'The request belongs to another chat.' };
    if (result.reason === 'unknown' && (registry.knows(chatId, requestId) || registry.belongsToAnotherChat(chatId, requestId)))
      return { error: 'The session is not running.' };
    if (result.reason !== 'unknown') return { error: result.reason === 'error' ? 'Could not answer the request.' : 'Invalid response.' };
    const entry = sessions.get(chatId);
    if (!entry || entry.exited) return { error: 'The session is not running.' };
    try { entry.session.respond(requestId, response); }
    catch { return { error: 'Could not answer the request.' }; }
    return { ok: true };
  }

  return { attach, detach, registry, buffers, sessions, events, respond,
    recordUser: (chatId, text) => buffers.get(chatId)?.addUser(text, 'desktop') };
}

module.exports = { createRemote };
