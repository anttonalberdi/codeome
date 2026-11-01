const { createRegistry } = require('./remote-decisions');
const { createBuffer, fromSaved } = require('./remote-items');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const TAB_STATES = new Set(['waiting', 'working', 'ready', 'error', 'error-seen', 'idle', 'off']);
function validateTabsPayload(payload, knownProjects, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).length !== 2 ||
      typeof payload.project !== 'string' || !payload.project ||
      ![...knownProjects].some((project) => typeof project === 'string' && project && path.resolve(project) === path.resolve(payload.project)) ||
      !Array.isArray(payload.tabs) || payload.tabs.length > 50) return false;
  const ids = new Set();
  for (const tab of payload.tabs) {
    if (!tab || typeof tab !== 'object' || Array.isArray(tab) ||
        Object.keys(tab).length !== 9 ||
        typeof tab.id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(tab.id) || ids.has(tab.id) ||
        typeof tab.title !== 'string' || tab.title.length > 200 ||
        typeof tab.label !== 'string' || tab.label.length > 100 ||
        !TAB_STATES.has(tab.state) || !Number.isInteger(tab.jobs) || tab.jobs < 0 || tab.jobs > 1000 ||
        !['claude', 'codex'].includes(tab.engine) || typeof tab.role !== 'string' || tab.role.length > 100 ||
        typeof tab.active !== 'boolean' || !Number.isSafeInteger(tab.updatedAt)) return false;
    tab.updatedAt = Math.max(0, Math.min(tab.updatedAt, now + 86400000));
    ids.add(tab.id);
  }
  return true;
}

function createRemote({ send, loadChat, exitGraceMs = 10 * 60 * 1000, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
  const registry = createRegistry();
  const buffers = new Map();
  const sessions = new Map();
  const events = new EventEmitter();
  const tabs = new Map();

  function setTabs(project, summary) {
    if (!validateTabsPayload({ project, tabs: summary }, new Set([project]), now())) return false;
    project = path.resolve(project);
    tabs.set(project, { tabs: summary.map((tab) => ({ ...tab })), receivedAt: now() });
    events.emit('tabs', project);
    return true;
  }
  function clearTabs() {
    const projects = [...tabs.keys()];
    tabs.clear();
    for (const project of projects) events.emit('tabs', project);
  }

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
    events.emit('chat-detached', chatId, entry?.project);
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
      const entry = sessions.get(chatId);
      if (entry) {
        entry.lastActivityAt = now();
        if (message?.type === 'result') { entry.busy = false; entry.lastOutcome = message.is_error ? 'error' : ''; }
        else if (message?.type === 'user' || message?.type === 'assistant' || message?.type === 'text_delta') entry.busy = true;
      }
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
    sessions.set(chatId, { session, onMessage, onExit, project, engine, role, busy: false, lastOutcome: '', lastActivityAt: now() });
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

  return { attach, detach, registry, buffers, sessions, events, tabs, setTabs, clearTabs, respond,
    recordUser: (chatId, text, source = 'desktop') => {
      buffers.get(chatId)?.addUser(text, source);
      const entry = sessions.get(chatId);
      if (entry) { entry.busy = true; entry.lastOutcome = ''; entry.lastActivityAt = now(); events.emit('message', chatId); }
    } };
}

module.exports = { createRemote, validateTabsPayload };
