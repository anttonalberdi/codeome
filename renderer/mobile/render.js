(function (root) {
  'use strict';
  const md = typeof module !== 'undefined' && module.exports ? require('./md') : root.MobileMD;
  const esc = md.esc;
  const text = (value) => value == null ? '' : String(value);
  const hidden = /[\p{Cf}\p{Cc}\u2028\u2029]/gu;
  function visibleText(value) {
    return text(value).replace(hidden, (char) => char === '\n' || char === '\t' ? char :
      `⟦U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟧`);
  }
  const display = (value) => esc(visibleText(value));
  function hasHidden(value) { return visibleText(value) !== text(value); }
  function validId(value) { return typeof value === 'string' && value !== '.' && value !== '..' &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(value); }
  function inputText(value) {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value ?? {}, null, 2); } catch { return '[Input unavailable]'; }
  }
  function short(value) {
    return text(value).replace(/\s+/g, ' ').slice(0, 100);
  }
  function stateOf(item) {
    if (['pending', 'decided', 'cancelled', 'expired'].includes(item.state)) return item.state;
    return item.decided || item.answers ? 'decided' : item.expired ? 'expired' : 'pending';
  }
  function describeDecision(pending) {
    if (pending?.reason === 'truncated') return { allowDisabled: true, reason: 'Input was truncated. Allow this on the desktop.' };
    if (pending?.needsDesktop || pending?.reason === 'needs-desktop') return { allowDisabled: true, reason: 'This action needs the desktop. You can still deny it here.' };
    return { allowDisabled: false, reason: '' };
  }
  const count = (value) => Math.max(0, Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 0);
  const timestamp = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  function projectParts(project) {
    return project.split('/').filter(Boolean);
  }
  function groupChats(chats) {
    const groups = new Map();
    for (const chat of Array.isArray(chats) ? chats : []) {
      if (!chat || typeof chat !== 'object' || Array.isArray(chat)) continue;
      const path = typeof chat.project === 'string' ? chat.project : '';
      if (!groups.has(path)) groups.set(path, { key: path, name: '', path, chats: [], pending: 0, running: 0, updatedAt: 0 });
      const group = groups.get(path);
      group.chats.push(chat);
      group.pending += count(chat.pending);
      group.running += chat.running ? 1 : 0;
      group.updatedAt = Math.max(group.updatedAt, timestamp(chat.updatedAt));
    }
    const result = [...groups.values()];
    const baseCounts = new Map();
    for (const group of result) {
      if (!group.path) continue;
      const parts = projectParts(group.path);
      const base = parts.at(-1) || '/';
      baseCounts.set(base, (baseCounts.get(base) || 0) + 1);
    }
    for (const group of result) {
      if (!group.path) {
        group.name = 'No project';
      } else {
        const parts = projectParts(group.path);
        const base = parts.at(-1) || '/';
        group.name = baseCounts.get(base) > 1 ? `${base} · ${parts.at(-2) || group.path}` : base;
      }
      group.chats.sort((a, b) => Number(count(b.pending) > 0) - Number(count(a.pending) > 0) ||
        Number(!!b.running) - Number(!!a.running) || timestamp(b.updatedAt) - timestamp(a.updatedAt) ||
        compareText(text(a.id), text(b.id)) || compareText(text(a.title), text(b.title)) ||
        compareText(text(a.engine), text(b.engine)) || compareText(text(a.role), text(b.role)));
    }
    // Projects with the same parent and basename need another ancestor to stay distinguishable.
    const maxDepth = Math.max(3, ...result.map((group) => projectParts(group.path).length + 1));
    for (let depth = 3; depth <= maxDepth; depth++) {
      const names = new Map();
      for (const group of result) names.set(group.name, (names.get(group.name) || 0) + 1);
      const duplicates = result.filter((group) => group.path && names.get(group.name) > 1);
      if (!duplicates.length) break;
      for (const group of duplicates) {
        const parts = projectParts(group.path);
        group.name = parts.length >= depth ? [parts.at(-1), ...parts.slice(-depth, -1).reverse()].join(' · ') :
          `${parts.at(-1) || '/'} · ${group.path}`;
      }
    }
    return result.sort((a, b) => Number(b.pending > 0) - Number(a.pending > 0) ||
      Number(b.running > 0) - Number(a.running > 0) || b.updatedAt - a.updatedAt || compareText(a.key, b.key));
  }
  function relativeTime(value, now) {
    const at = timestamp(value);
    if (!at) return '';
    const seconds = Math.max(0, Math.floor((now - at) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hr ago`;
    return `${Math.floor(hours / 24)} d ago`;
  }
  function renderChatGroups(groups, expanded = new Set(), now = Date.now()) {
    if (!groups.length) return '<p class="empty">No chats yet.</p>';
    return groups.map((group) => {
      const nonRunning = group.chats.filter((chat) => !chat.running);
      const visibleNonRunning = new Set([...nonRunning].sort((a, b) =>
        timestamp(b.updatedAt) - timestamp(a.updatedAt) || compareText(text(a.id), text(b.id))).slice(0, 10));
      const isExpanded = expanded.has(group.key);
      const visible = [];
      for (const chat of group.chats) {
        if (!chat.running && !isExpanded && !visibleNonRunning.has(chat)) continue;
        const pending = count(chat.pending);
        const recent = relativeTime(chat.updatedAt, now);
        visible.push(`<button type="button" class="chat-entry" data-chat="${display(chat.id)}"><strong>${display(chat.title || 'Untitled chat')}</strong><span class="meta">${chat.running ? 'Running' : `Recent${recent ? ` · ${recent}` : ''}`}${pending ? ` · ${pending} pending` : ''}</span></button>`);
      }
      const hiddenCount = isExpanded ? 0 : Math.max(0, nonRunning.length - 10);
      return `<section class="chat-group" aria-label="${display(group.name)}"><header class="chat-group-header"><h3>${display(group.name)}</h3><div class="group-badges">${group.pending ? `<span class="group-badge waiting">${group.pending} waiting</span>` : ''}${group.running ? `<span class="group-badge">${group.running} running</span>` : ''}</div>${group.path ? `<p class="project-path">${display(group.path)}</p>` : ''}</header><div class="group-chats">${visible.join('')}</div>${hiddenCount ? `<button type="button" class="show-more" data-project-more="${display(group.key)}">Show ${hiddenCount} more</button>` : ''}</section>`;
    }).join('');
  }
  function images(item) {
    return (Array.isArray(item.images) ? item.images : []).map((ref) =>
      `<img class="chat-image" data-image="${esc(ref.itemId)}" alt="Chat attachment" loading="lazy">`).join('');
  }
  function renderItem(item) {
    const type = text(item?.t);
    const id = esc(item?.id || '');
    const knownTypes = ['user', 'text', 'tool', 'job', 'progress', 'note', 'perm', 'ask'];
    const attrs = ` class="item item-${knownTypes.includes(type) ? type : 'unknown'}" data-item-id="${id}"`;
    if (type === 'user') return `<article${attrs}><h3>You</h3><div class="message-text">${esc(item.text)}</div>${
      (Array.isArray(item.files) ? item.files : []).map((file) => `<div class="file">${esc(file)}</div>`).join('')}${images(item)}</article>`;
    if (type === 'text') return `<article${attrs}><h3>Codeome${item.live ? ' · writing' : ''}</h3><div class="markdown">${md.render(item.text)}</div>${images(item)}</article>`;
    if (type === 'tool') return `<article${attrs}><details class="tool-detail"><summary>${esc(item.name || 'Tool')}: ${esc(short(inputText(item.input)))}</summary><pre>${esc(inputText(item.input))}</pre><button type="button" data-tool="${id}">Load full result</button><pre class="tool-result" aria-live="polite"></pre></details>${images(item)}</article>`;
    if (type === 'job' || type === 'progress') return `<article${attrs}><details class="tool-detail"><summary>${display(item.title || item.role || 'Job')} · ${esc(item.status || 'running')}</summary><p>${esc(item.engine || '')} ${esc(item.role || '')}</p><button type="button" data-tool="${id}">Load full result</button><pre class="tool-result" aria-live="polite"></pre></details>${images(item)}</article>`;
    if (type === 'note') return `<aside${attrs}><strong>${esc(item.kind || 'Note')}</strong><div>${esc(item.text)}</div></aside>`;
    if (type === 'perm') return `<article${attrs}><h3>${display(item.title || item.tool || 'Permission')}</h3><p class="status">${esc(stateOf(item))}${item.decided ? ` · ${esc(item.decided)}` : ''}</p>${item.reason ? `<p>${display(item.reason)}</p>` : ''}<pre>${display(inputText(item.input))}</pre></article>`;
    if (type === 'ask') return `<article${attrs}><h3>Question · ${esc(stateOf(item))}</h3>${(Array.isArray(item.questions) ? item.questions : []).map((q) =>
      `<section><h4>${display(q.header || '')}</h4><p>${display(q.question)}</p><ul>${(Array.isArray(q.options) ? q.options : []).map((o) =>
        `<li>${display(o.label)}${o.description ? ` — ${display(o.description)}` : ''}</li>`).join('')}</ul>${item.answers && item.answers[q.question] ? `<p>Answer: ${display(item.answers[q.question])}</p>` : ''}</section>`).join('')}</article>`;
    return `<article${attrs}><p>Unsupported item</p></article>`;
  }
  function renderPending(pending, chat) {
    const detail = describeDecision(pending);
    const chatName = chat?.title || 'Untitled chat';
    const projectPath = chat?.project || '';
    const projectName = chat?.projectName || groupChats(chat ? [chat] : [])[0]?.name || 'No project';
    const key = `${pending.chatId}/${pending.requestId}`;
    const question = pending.toolName === 'AskUserQuestion';
    const questions = question && Array.isArray(pending.input?.questions) ? pending.input.questions : [];
    const missingQuestions = question && !questions.length;
    const rawInput = inputText(pending.input);
    // A plain question reads from its options, so the raw JSON is hidden; anything unexpected in it keeps the box.
    const extraKeys = question && pending.input && typeof pending.input === 'object' ? Object.keys(pending.input).filter((key) => !['questions', 'answers', 'metadata'].includes(key)) : [];
    const plainQuestion = question && !missingQuestions && !extraKeys.length;
    const warnings = Array.isArray(pending.warnings) ? pending.warnings : [];
    const shown = [rawInput, projectName, projectPath, chatName, pending.toolName, pending.title, pending.decisionReason,
      ...warnings, ...questions.flatMap((q) => [q.question, q.header,
        ...(Array.isArray(q.options) ? q.options.flatMap((option) => [option.label, option.description]) : [])])];
    const lines = rawInput.split('\n').length;
    const chars = Array.from(rawInput).length;
    const count = `${lines} ${lines === 1 ? 'line' : 'lines'}, ${chars} ${chars === 1 ? 'char' : 'chars'}`;
    return `<article class="decision card" data-pending="${esc(key)}"><p class="eyebrow">${display(projectName)}</p>${projectPath ? `<p class="project-path">${display(projectPath)}</p>` : ''}<h3>${display(chatName)}</h3><p>${display(question ? 'Question from the agent' : pending.toolName || 'Decision')}</p>${
      pending.title ? `<p>${display(pending.title)}</p>` : ''}${pending.decisionReason ? `<p>${display(pending.decisionReason)}</p>` : ''}${
      shown.some(hasHidden) ? '<p class="warning" role="status">contains hidden characters</p>' : ''}${
      warnings.map((warning) => `<p class="warning" role="status">${display(warning)}</p>`).join('')}${
      detail.reason || missingQuestions ? `<p class="warning" role="status">${display(detail.reason || 'Question details unavailable. Answer on the desktop.')}</p>` : ''}${plainQuestion ? '' : `<p class="input-count">${count}</p><pre class="full-input">${display(rawInput)}</pre>`}${
      question ? questions.map((q, index) => `<fieldset data-question="${index}"><legend>${display(q.question)}</legend>${
        q.header ? `<p>${display(q.header)}</p>` : ''}${(Array.isArray(q.options) ? q.options : []).map((option, n) =>
          `<button type="button" class="option" data-option="${index}:${n}" aria-pressed="false">${display(option.label)}${option.description ? `<small>${display(option.description)}</small>` : ''}</button>`).join('')}<label>Other answer (optional)<input data-other="${index}" type="text" autocomplete="off"></label><p class="field-error" data-error="${index}" role="alert"></p></fieldset>`).join('') : ''}<div class="actions"><button type="button" class="primary" data-decision="allow"${detail.allowDisabled || missingQuestions ? ' disabled' : ''}>${question ? 'Submit answers' : 'Allow once'}</button><button type="button" data-decision="deny">Deny</button></div><p class="decision-error" role="alert"></p></article>`;
  }
  const api = { esc, display, inputText, visibleText, validId, groupChats, renderChatGroups, renderItem, renderPending, describeDecision, stateOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Render = api;
})(typeof window !== 'undefined' ? window : globalThis);
