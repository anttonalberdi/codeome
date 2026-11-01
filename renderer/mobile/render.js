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
  function projectParts(project) { return text(project).split('/').filter(Boolean); }
  function projectLabels(projects) {
    const result = new Map();
    const entries = Array.isArray(projects) ? projects : [];
    const bases = new Map();
    for (const project of entries) {
      const base = text(project?.name) || projectParts(project?.path).at(-1) || 'No project';
      bases.set(base, (bases.get(base) || 0) + 1);
    }
    for (const project of entries) {
      const parts = projectParts(project?.path);
      const base = text(project?.name) || parts.at(-1) || 'No project';
      result.set(project.key, bases.get(base) > 1 ? `${base} · ${parts.at(-2) || text(project?.path)}` : base);
    }
    const maxDepth = Math.max(3, ...entries.map((project) => projectParts(project?.path).length + 1));
    for (let depth = 3; depth <= maxDepth; depth++) {
      const names = new Map();
      for (const name of result.values()) names.set(name, (names.get(name) || 0) + 1);
      const duplicates = entries.filter((project) => names.get(result.get(project.key)) > 1);
      if (!duplicates.length) break;
      for (const project of duplicates) {
        const parts = projectParts(project.path);
        result.set(project.key, parts.length >= depth ? [text(project.name) || parts.at(-1), ...parts.slice(-depth, -1).reverse()].join(' · ') :
          `${text(project.name) || parts.at(-1) || 'No project'} · ${text(project.path)}`);
      }
    }
    return result;
  }
  const stateLabels = {
    waiting: 'Waiting for you', working: 'Working', ready: 'Reply ready — not seen yet',
    error: 'Stopped with an error — not seen yet', 'error-seen': 'Last turn ended with an error',
    idle: 'Finished; session open', off: 'Session closed'
  };
  function displayedState(tab, seen) {
    const state = Object.hasOwn(stateLabels, tab?.state) ? tab.state : 'off';
    const seenAt = seen && Object.hasOwn(seen, tab.id) ? timestamp(seen[tab.id]) : 0;
    if (seenAt && seenAt >= timestamp(tab.updatedAt)) {
      if (state === 'ready') return 'idle';
      if (state === 'error') return 'error-seen';
    }
    return state;
  }
  function phoneProject(project, seen) {
    const tabs = (Array.isArray(project.tabs) ? project.tabs : []).map((tab) => {
      const state = displayedState(tab, seen);
      return { ...tab, state, label: state === tab.state ? tab.label : stateLabels[state] };
    });
    return { ...project, tabs, counts: { ...project.counts,
      ready: tabs.filter((tab) => tab.state === 'ready').length,
      error: tabs.filter((tab) => tab.state === 'error').length } };
  }
  function parseRoute(hash) {
    if (!hash || hash === '#/' || hash === '#') return { type: 'home' };
    if (hash.startsWith('#pair=')) return { type: 'pair' };
    const match = /^#\/(p|c)\/([^/?#]+)$/.exec(hash);
    if (!match) return { type: 'invalid' };
    let id;
    try { id = decodeURIComponent(match[2]); } catch { return { type: 'invalid' }; }
    if (match[1] === 'p') return /^[a-f0-9]{12}$/.test(id) ? { type: 'project', key: id } : { type: 'invalid' };
    return validId(id) ? { type: 'chat', id } : { type: 'invalid' };
  }
  function chatOf(projects, id) {
    for (const project of projects) {
      const tab = (project.tabs || []).find((entry) => entry.id === id);
      if (tab) return { chat: tab, project, earlier: false };
      const earlier = (project.earlier || []).find((entry) => entry.id === id);
      if (earlier) return { chat: earlier, project, earlier: true };
    }
    return null;
  }
  function resolveRoute(hash, projects) {
    const route = parseRoute(hash);
    if (route.type === 'project') return (projects || []).some((project) => project.key === route.key) ? route :
      { type: 'unknown-project', key: route.key };
    if (route.type === 'chat') return { ...route, entry: chatOf(projects || [], route.id) };
    return route;
  }
  function applyTabsEvent(projects, data) {
    if (!data || typeof data.key !== 'string' || !/^[a-f0-9]{12}$/.test(data.key)) return projects;
    const remaining = projects.filter((project) => project.key !== data.key);
    if (data.removed === true) return remaining;
    remaining.push(data);
    return remaining.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }
  function openChatSeenAt(projects, chatId) {
    if (!chatId) return 0;
    for (const project of projects) {
      const tab = (project.tabs || []).find((entry) => entry.id === chatId);
      if (tab) return timestamp(tab.updatedAt);
    }
    return 0;
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
  function renderProjectCard(project, name, now = Date.now()) {
    const counts = project.counts || {};
    const chips = [['waiting', 'waiting'], ['working', 'working'], ['ready', 'ready'], ['error', 'error'], ['jobs', 'specialists']]
      .map(([key, label]) => count(counts[key]) ? `<span class="marker-chip ${key}">${key === 'jobs' ? '' : `<span class="state-dot ${key}" aria-hidden="true"></span>`}${count(counts[key])} ${label}</span>` : '').join('');
    const recent = relativeTime(project.updatedAt, now);
    return `<button type="button" class="project-card card" data-project="${display(project.key)}"><span class="project-title">${display(name || project.name)}</span><span class="project-path">${display(project.path)}</span>${recent ? `<span class="meta">Last activity ${recent}</span>` : ''}${chips ? `<span class="marker-chips">${chips}</span>` : ''}</button>`;
  }
  function renderTabRow(tab, now = Date.now()) {
    const state = Object.hasOwn(stateLabels, tab.state) ? tab.state : 'off';
    const recent = relativeTime(tab.updatedAt, now);
    const label = tab.label || stateLabels[state];
    return `<button type="button" class="tab-row${tab.active ? ' active' : ''}" data-chat="${display(tab.id)}"${tab.active ? ' aria-current="true"' : ''}><span class="state-dot ${state}" aria-hidden="true"></span><span class="tab-content"><span class="tab-title">${display(tab.title || 'Untitled chat')}</span><span class="tab-label">${display(label)}</span><span class="tab-meta">${count(tab.jobs) ? `<span class="tab-badge">${count(tab.jobs)} specialist${count(tab.jobs) === 1 ? '' : 's'}</span>` : ''}${tab.engine ? `<span class="tab-chip">${display(tab.engine)}</span>` : ''}${tab.role ? `<span class="tab-chip">${display(tab.role)}</span>` : ''}${recent ? `<span class="meta">${recent}</span>` : ''}</span></span></button>`;
  }
  function renderEarlierRow(chat, now = Date.now()) {
    const recent = relativeTime(chat.updatedAt, now);
    return `<button type="button" class="earlier-row" data-chat="${display(chat.id)}"><span>${display(chat.title || 'Untitled chat')}</span>${recent ? `<small class="meta">${recent}</small>` : ''}</button>`;
  }
  function images(item) {
    return (Array.isArray(item.images) ? item.images : []).map((ref) =>
      `<img class="chat-image" data-image="${esc(ref.itemId)}" alt="Chat attachment" loading="lazy">`).join('');
  }
  function stampText(value) {
    const at = timestamp(value);
    if (!at) return '';
    const d = new Date(at);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? time :
      `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
  }
  function stampOf(item) {
    const label = stampText(item.at);
    return label ? `<span class="stamp" title="${esc(new Date(timestamp(item.at)).toLocaleString())}">${esc(label)}</span>` : '';
  }
  function renderItem(item) {
    const type = text(item?.t);
    const id = esc(item?.id || '');
    const knownTypes = ['user', 'text', 'tool', 'job', 'progress', 'note', 'perm', 'ask'];
    const attrs = ` class="item item-${knownTypes.includes(type) ? type : 'unknown'}${type === 'text' && item.live ? ' live' : ''}" data-item-id="${id}"`;
    if (type === 'user') return `<article${attrs}><h3>You</h3><div class="message-text">${esc(item.text)}</div>${
      (Array.isArray(item.files) ? item.files : []).map((file) => `<div class="file">${esc(file)}</div>`).join('')}${images(item)}${stampOf(item)}</article>`;
    if (type === 'text') return `<article${attrs}><h3>Codeome${item.live ? ' · writing' : ''}</h3>${stampOf(item)}<div class="markdown">${md.render(item.text)}</div>${images(item)}</article>`;
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
    const serverPath = typeof pending.project === 'string';
    const projectPath = serverPath ? pending.project : chat?.project || '';
    const serverName = typeof pending.projectName === 'string';
    const projectName = serverName ? (pending.projectName || projectParts(serverPath ? pending.project : '').at(-1) || 'No project') :
      serverPath ? (projectParts(projectPath).at(-1) || 'No project') :
        (chat?.projectName || projectParts(projectPath).at(-1) || 'No project');
    const chatName = (typeof pending.chatTitle === 'string' ? pending.chatTitle : chat?.title) ||
      pending.chatId || 'Untitled chat';
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
  const api = { esc, display, inputText, visibleText, validId, projectLabels, displayedState, phoneProject,
    parseRoute, chatOf, resolveRoute, applyTabsEvent, openChatSeenAt, relativeTime, renderProjectCard,
    renderTabRow, renderEarlierRow, renderItem, renderPending, describeDecision, stateOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Render = api;
})(typeof window !== 'undefined' ? window : globalThis);
