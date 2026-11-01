const { EventEmitter } = require('events');

const copy = (value) => value === undefined ? undefined : structuredClone(value);

function validAnswers(input, answers) {
  const questions = input && input.questions;
  if (!Array.isArray(questions) || !questions.length || !answers || typeof answers !== 'object' || Array.isArray(answers)) return false;
  if (Object.keys(answers).length !== questions.length) return false;
  return questions.every((question) => {
    const key = question && question.question;
    if (typeof key !== 'string' || !Object.hasOwn(answers, key)) return false;
    const value = answers[key];
    if (typeof value === 'string') return !!value.trim();
    return !!question.multiSelect && Array.isArray(value) && value.length > 0 &&
      value.every((item) => typeof item === 'string' && !!item.trim());
  });
}

function createRegistry({ now = Date.now } = {}) {
  const registry = new EventEmitter();
  const pending = new Map();
  const decided = new Map();
  const known = new Map();
  const keyOf = (chatId, requestId) => `${chatId}\0${requestId}`;
  function remember(map, key) {
    map.delete(key);
    map.set(key, true);
    while (map.size > 2000) map.delete(map.keys().next().value);
  }

  function commit(key, requestId, entry, response, decision, source, answers) {
    try { entry.session.respond(requestId, response); }
    catch { return { ok: false, reason: 'error' }; }
    pending.delete(key);
    remember(decided, key);
    registry.emit('decided', { requestId, chatId: entry.record.chatId, source, decision, ...(answers ? { answers: copy(answers) } : {}) });
    return { ok: true, record: copy(entry.record) };
  }

  registry.add = (chatId, session, controlRequest) => {
    const request = controlRequest && controlRequest.request;
    if (!request || request.subtype !== 'can_use_tool') return null;
    const requestId = controlRequest.request_id;
    const key = keyOf(chatId, requestId);
    const existing = pending.get(key);
    if (existing) {
      existing.session = session;
      Object.assign(existing.record, { toolName: request.tool_name, input: copy(request.input),
        title: request.title, decisionReason: request.decision_reason,
        permissionSuggestions: copy(request.permission_suggestions) });
      return copy(existing.record);
    }
    const record = {
      requestId, chatId, toolName: request.tool_name, input: copy(request.input),
      title: request.title, decisionReason: request.decision_reason,
      permissionSuggestions: copy(request.permission_suggestions), createdAt: now()
    };
    decided.delete(key);
    remember(known, key);
    pending.set(key, { record, session });
    registry.emit('added', copy(record));
    return copy(record);
  };

  registry.cancel = (chatId, requestId) => {
    const key = keyOf(chatId, requestId);
    const entry = pending.get(key);
    if (!entry) return registry.belongsToAnotherChat(chatId, requestId) ? { ok: false, reason: 'chat-mismatch' } : undefined;
    pending.delete(key);
    registry.emit('cancelled', copy(entry.record));
  };

  registry.clearChat = (chatId, forget = false) => {
    for (const [key, entry] of pending) {
      if (entry.record.chatId === chatId) pending.delete(key);
    }
    if (forget) for (const map of [known, decided])
      for (const key of map.keys()) if (key.startsWith(`${chatId}\0`)) map.delete(key);
    registry.emit('cleared', chatId);
  };

  registry.list = (chatId) => [...pending.values()]
    .filter((entry) => chatId === undefined || entry.record.chatId === chatId)
    .map((entry) => copy(entry.record));
  registry.knows = (chatId, requestId) => known.has(keyOf(chatId, requestId));
  registry.wasDecided = (chatId, requestId) => decided.has(keyOf(chatId, requestId));
  registry.belongsToAnotherChat = (chatId, requestId) => [...pending.keys(), ...known.keys(), ...decided.keys()]
    .some((key) => key.endsWith(`\0${requestId}`) && key !== keyOf(chatId, requestId));

  registry.answer = (chatId, requestId, answer, source) => {
    const key = keyOf(chatId, requestId);
    if (decided.has(key)) return { ok: false, reason: 'already-decided' };
    const entry = pending.get(key);
    if (!entry) return { ok: false, reason: registry.belongsToAnotherChat(chatId, requestId) ? 'chat-mismatch' : 'unknown' };
    if (!answer || typeof answer !== 'object' || !['desktop', 'phone'].includes(source)) return { ok: false, reason: 'invalid' };
    const { record } = entry;
    let response, decision, answers;
    if (answer.deny === true && answer.allow !== true && answer.answers === undefined &&
        (answer.message === undefined || typeof answer.message === 'string')) {
      response = { behavior: 'deny', message: answer.message || 'The user declined this.' };
      decision = 'deny';
    } else if (record.toolName === 'AskUserQuestion' && answer.answers !== undefined &&
        answer.allow !== true && answer.deny !== true && validAnswers(record.input, answer.answers)) {
      answers = Object.fromEntries(Object.entries(answer.answers).map(([question, value]) => [question, Array.isArray(value) ? value.join(', ') : value]));
      response = { behavior: 'allow', updatedInput: { ...copy(record.input), answers: copy(answers) } };
      decision = 'answered';
    } else if (record.toolName !== 'AskUserQuestion' && answer.allow === true &&
        answer.deny !== true && answer.answers === undefined) {
      response = { behavior: 'allow', updatedInput: copy(record.input) };
      if (source === 'desktop' && answer.updatedPermissions !== undefined) response.updatedPermissions = copy(answer.updatedPermissions);
      decision = 'allow';
    } else return { ok: false, reason: 'invalid' };

    return commit(key, requestId, entry, response, decision, source, answers);
  };

  registry.answerRaw = (chatId, requestId, response, source) => {
    const key = keyOf(chatId, requestId);
    if (decided.has(key)) return { ok: false, reason: 'already-decided' };
    const entry = pending.get(key);
    if (!entry) return { ok: false, reason: registry.belongsToAnotherChat(chatId, requestId) ? 'chat-mismatch' : 'unknown' };
    if (source !== 'desktop' || !response || typeof response !== 'object' ||
        !['allow', 'deny'].includes(response.behavior)) return { ok: false, reason: 'invalid' };
    const decision = response.behavior === 'deny' ? 'deny' : entry.record.toolName === 'AskUserQuestion' ? 'answered' : 'allow';
    const answers = decision === 'answered' ? response.updatedInput?.answers : undefined;
    return commit(key, requestId, entry, response, decision, source, answers);
  };

  return registry;
}

module.exports = { createRegistry };
