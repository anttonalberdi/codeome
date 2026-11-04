(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { token: null, projects: [], expandedEarlier: new Set(), seen: Object.create(null), loaded: false,
    pending: [], chatId: null, projectKey: null, items: [], hasMore: false,
    loadingOlder: false, firstIndex: null, stream: null, lastEventId: '', imageUrls: new Map(),
    imageObserver: null, reconnect: 1000, refreshing: false, refreshAgain: false };
  const inFlight = new Set();
  const completed = new Set();
  const cardSources = new WeakMap();
  const MAX_SSE_CHARS = 1024 * 1024;
  const SEEN_KEY = 'codeome-phone-seen';
  try {
    const saved = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [id, value] of Object.entries(saved).slice(-500))
        if (Render.validId(id) && Number.isFinite(value) && value > 0) state.seen[id] = value;
    }
  } catch { /* Private storage can be unavailable. */ }
  const errorText = (error) => {
    const code = error?.code || '';
    if (code === 'needs-desktop') return 'This action needs the desktop. You can still deny it here.';
    if (code === 'needs-desktop-mode') return "This chat's mode does not accept messages from the phone. Send from the Mac, or allow it in Settings → Phone companion → Send from phone.";
    if (code === 'truncated') return 'The input was truncated. Allow this on the desktop.';
    if (code === 'already-decided') return 'Already answered on the desktop.';
    if (code === 'rate-limited') return 'Too many requests. Wait a moment and try again.';
    return error?.message || 'Request failed. Try again.';
  };
  function connection(value) { $('connection').textContent = value; }
  function notice(message) { $('notice').textContent = message; $('notice').hidden = !message; }
  function replaceMarkup(target, html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    target.replaceChildren(...Array.from(doc.body.childNodes).map((node) => document.importNode(node, true)));
  }
  function unpaired() {
    state.token = null;
    inFlight.clear(); completed.clear();
    try { localStorage.removeItem('codeome-phone-token'); } catch { /* Private storage can be unavailable. */ }
    state.stream?.abort(); state.stream = null;
    state.chatId = null;
    $('inbox').hidden = true; $('project').hidden = true; $('chat').hidden = true; $('back').hidden = true;
    $('heading').textContent = 'Codeome';
    notice('This phone was unpaired or revoked — scan a new QR code on the Mac.');
    connection('Unpaired');
  }
  async function request(path, options = {}) {
    const headers = { Authorization: `Bearer ${state.token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) };
    const response = await fetch(path, { ...options, headers });
    if (response.status === 401) { unpaired(); throw { code: 'unauthorized' }; }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw { code: body.error, status: response.status, message: `Request failed (${response.status}).` };
    }
    return response;
  }
  async function json(path, options) { return (await request(path, options)).json(); }
  function chatOf(id) { return Render.chatOf(state.projects, id); }
  function names() { return Render.projectLabels(state.projects); }
  function saveSeen(id, updatedAt) {
    const at = Number(updatedAt);
    if (!Number.isFinite(at) || at <= 0 || (state.seen[id] || 0) >= at) return;
    delete state.seen[id]; state.seen[id] = at;
    const keys = Object.keys(state.seen);
    for (const old of keys.slice(0, Math.max(0, keys.length - 500))) delete state.seen[old];
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(state.seen)); } catch { /* Private storage can be unavailable. */ }
  }
  function saveOpenChatSeen() {
    if (state.chatId) saveSeen(state.chatId, Render.openChatSeenAt(state.projects, state.chatId));
  }
  function cardKey(pending) { return `${pending.chatId}/${pending.requestId}`; }
  function syncCards(target, entries, chats, showEmpty = false) {
    if (!entries.length) {
      if (showEmpty) replaceMarkup(target, '<p class="empty">No decisions waiting.</p>');
      else target.replaceChildren();
      return;
    }
    const existing = new Map([...target.querySelectorAll('.decision[data-pending]')]
      .map((card) => [card.dataset.pending, card]));
    let next = target.firstChild;
    for (const entry of entries) {
      const key = cardKey(entry);
      const chat = chats.get(entry.chatId);
      const source = JSON.stringify([entry, chat]);
      let card = existing.get(key);
      if (!card || cardSources.get(card) !== source) {
        const parsed = new DOMParser().parseFromString(Render.renderPending(entry, chat), 'text/html').body.firstElementChild;
        if (!card) card = document.importNode(parsed, true);
        else {
          const pressed = new Set([...card.querySelectorAll('[data-option][aria-pressed="true"]')]
            .map((button) => button.dataset.option));
          const others = new Map([...card.querySelectorAll('[data-other]')]
            .map((input) => [input.dataset.other, input.value]));
          const errors = new Map([...card.querySelectorAll('[data-error]')]
            .map((element) => [element.dataset.error, element.textContent]));
          const decisionError = card.querySelector('.decision-error')?.textContent || '';
          const focused = card.contains(document.activeElement) ? document.activeElement?.dataset.other : null;
          card.replaceChildren(...[...parsed.childNodes].map((node) => document.importNode(node, true)));
          for (const button of card.querySelectorAll('[data-option]'))
            if (pressed.has(button.dataset.option)) button.setAttribute('aria-pressed', 'true');
          for (const input of card.querySelectorAll('[data-other]')) input.value = others.get(input.dataset.other) || '';
          for (const element of card.querySelectorAll('[data-error]')) element.textContent = errors.get(element.dataset.error) || '';
          card.querySelector('.decision-error').textContent = decisionError;
          if (focused != null) card.querySelector(`[data-other="${focused}"]`)?.focus();
        }
        cardSources.set(card, source);
      }
      if (inFlight.has(key)) card.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      if (card !== next) target.insertBefore(card, next);
      next = card.nextSibling;
    }
    while (next) { const stale = next; next = next.nextSibling; stale.remove(); }
  }
  function renderPending() {
    const labels = names();
    const chats = new Map(state.projects.flatMap((project) =>
      [...(project.tabs || []), ...(project.earlier || [])].map((chat) =>
        [chat.id, { ...chat, project: project.path, projectName: labels.get(project.key) || project.name }])));
    const ordered = [...state.pending].sort((a, b) => a.createdAt - b.createdAt);
    syncCards($('pending-list'), ordered, chats, true);
    const pinned = ordered.filter((entry) => entry.chatId === state.chatId);
    syncCards($('chat-pending'), pinned, chats);
  }
  function renderProjects() {
    const labels = names();
    replaceMarkup($('project-list'), state.projects.length ? state.projects.map((project) =>
      Render.renderProjectCard(Render.phoneProject(project, state.seen), labels.get(project.key))).join('') :
      '<p class="empty">No projects yet.</p>');
  }
  function renderProject(project) {
    const labels = names();
    const name = labels.get(project.key) || project.name;
    const heading = $('heading');
    const title = document.createElement('span'); title.className = 'heading-title';
    title.textContent = Render.visibleText(name);
    const path = document.createElement('small'); path.className = 'heading-path';
    path.textContent = Render.visibleText(project.path);
    heading.replaceChildren(title, path);
    const phone = Render.phoneProject(project, state.seen);
    replaceMarkup($('tab-list'), phone.tabs.length ? phone.tabs.map((tab) => Render.renderTabRow(tab)).join('') :
      '<p class="empty">No open tabs.</p>');
    const earlier = Array.isArray(project.earlier) ? project.earlier : [];
    $('earlier-toggle').textContent = `Earlier chats (${earlier.length})`;
    const expanded = state.expandedEarlier.has(project.key);
    $('earlier-toggle').setAttribute('aria-expanded', String(expanded));
    $('earlier-list').hidden = !expanded;
    replaceMarkup($('earlier-list'), earlier.length ? earlier.map((chat) => Render.renderEarlierRow(chat)).join('') :
      '<p class="empty">No earlier chats.</p>');
  }
  function renderChatHeading() {
    const entry = chatOf(state.chatId);
    const chat = entry?.chat;
    const projectData = entry?.project;
    const heading = $('heading');
    const title = document.createElement('span');
    title.className = 'heading-title';
    title.textContent = Render.visibleText(chat?.title || 'Chat');
    const project = document.createElement('small');
    project.className = 'heading-project';
    project.textContent = Render.visibleText(names().get(projectData?.key) || projectData?.name || 'No project');
    heading.replaceChildren(title, project);
    if (projectData?.path) {
      const path = document.createElement('small');
      path.className = 'heading-path';
      path.textContent = Render.visibleText(projectData.path);
      heading.append(path);
    }
    const status = document.createElement('small'); status.className = 'heading-status';
    const tab = entry && !entry.earlier ? Render.phoneProject(projectData, state.seen).tabs.find((item) => item.id === state.chatId) : null;
    status.textContent = Render.visibleText(tab?.label || (entry?.earlier ? 'Earlier chat' : ''));
    heading.append(status);
  }
  async function refreshState() {
    if (!state.token) return;
    if (state.refreshing) { state.refreshAgain = true; return; }
    state.refreshing = true;
    try {
      const data = await json('/api/state');
      saveOpenChatSeen();
      state.projects = Array.isArray(data.projects) ? data.projects : [];
      saveOpenChatSeen();
      state.loaded = true;
      const pending = Array.isArray(data.pending) ? data.pending : [];
      for (const key of completed) if (!pending.some((entry) => cardKey(entry) === key)) completed.delete(key);
      state.pending = pending.filter((entry) => !completed.has(cardKey(entry)));
      renderPending(); renderProjects(); applyRoute();
    } catch (error) { if (state.token) notice(errorText(error)); }
    finally {
      state.refreshing = false;
      if (state.refreshAgain) { state.refreshAgain = false; refreshState(); }
    }
  }
  function nearBottom() { return document.documentElement.scrollHeight - window.innerHeight - window.scrollY < 150; }
  function scrollBottom() { window.scrollTo(0, document.documentElement.scrollHeight); }
  function clearImages() {
    state.imageObserver?.disconnect();
    state.imageUrls.clear();
  }
  async function loadImage(img) {
    const itemId = img.dataset.image;
    if (!Render.validId(itemId) || !Render.validId(state.chatId)) { img.alt = 'Image unavailable'; return; }
    const key = `${state.chatId}/${itemId}`;
    if (state.imageUrls.has(key)) { img.src = state.imageUrls.get(key); return; }
    try {
      const blob = await (await request(`/api/chats/${encodeURIComponent(state.chatId)}/image/${encodeURIComponent(itemId)}`)).blob();
      if (!img.isConnected) return;
      // The server's img-src CSP permits data: but not blob:, so decode the authenticated blob locally.
      const url = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      state.imageUrls.set(key, url); img.src = url;
    } catch { img.alt = 'Image unavailable'; }
  }
  function observeImages() {
    state.imageObserver?.disconnect();
    const imgs = $('log').querySelectorAll('img[data-image]');
    if (!('IntersectionObserver' in window)) { imgs.forEach(loadImage); return; }
    state.imageObserver = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (entry.isIntersecting) { state.imageObserver.unobserve(entry.target); loadImage(entry.target); }
    }), { rootMargin: '200px' });
    imgs.forEach((img) => state.imageObserver.observe(img));
  }
  function renderLog(keepBottom = false) {
    const prefix = state.hasMore ? '<button type="button" class="load-older" id="load-older">Load older</button>' : '';
    replaceMarkup($('log'), prefix + (state.items.length ? state.items.map(Render.renderItem).join('') : '<p class="empty">No messages yet.</p>'));
    observeImages();
    if (keepBottom) requestAnimationFrame(scrollBottom);
  }
  async function loadLog(before) {
    if (!Render.validId(state.chatId)) return;
    const chatId = state.chatId;
    const atBottom = nearBottom();
    const oldHeight = document.documentElement.scrollHeight;
    const oldScroll = window.scrollY;
    try {
      const query = before == null ? '?limit=40' : `?limit=40&before=${before}`;
      const data = await json(`/api/chats/${encodeURIComponent(chatId)}/log${query}`);
      if (state.chatId !== chatId) return;
      if (before == null) {
        const merged = new Map([...state.items, ...data.items].map((item) => [item.i, item]));
        state.items = [...merged.values()].sort((a, b) => a.i - b.i);
      } else {
        const merged = new Map([...data.items, ...state.items].map((item) => [item.i, item]));
        state.items = [...merged.values()].sort((a, b) => a.i - b.i);
      }
      state.hasMore = !!data.hasMore;
      state.firstIndex = state.items[0]?.i ?? null;
      renderLog(before == null && atBottom);
      if (before != null) requestAnimationFrame(() => window.scrollTo(0, document.documentElement.scrollHeight - oldHeight + oldScroll));
    } catch (error) {
      if (state.chatId !== chatId) return;
      if (error.status === 404) {
        $('reply-form').hidden = true;
        replaceMarkup($('log'), '<p class="empty">This chat is no longer available.</p><button type="button" id="chat-unavailable-back">Back</button>');
        return;
      }
      if (state.token) notice(errorText(error));
      if (before == null && !state.items.length) replaceMarkup($('log'), '<p class="empty">Messages unavailable.</p><button type="button" id="reload-log">Retry</button>');
    }
  }
  async function older() {
    if (state.loadingOlder || !state.hasMore || state.firstIndex == null) return;
    state.loadingOlder = true;
    await loadLog(state.firstIndex);
    state.loadingOlder = false;
  }
  async function openChat(chatId) {
    if (!Render.validId(chatId)) { invalidRoute(); return; }
    if (state.chatId !== chatId) { clearImages(); state.items = []; state.hasMore = false; }
    state.chatId = chatId;
    $('inbox').hidden = true; $('project').hidden = true; $('chat').hidden = false; $('back').hidden = false;
    $('back').textContent = '‹ Project';
    $('reply-form').hidden = false;
    renderChatHeading();
    renderPending(); replaceMarkup($('log'), '<p class="empty">Loading messages…</p>'); notice('');
    await loadLog();
    requestAnimationFrame(scrollBottom);
  }
  function showHome() {
    state.chatId = null; clearImages();
    state.projectKey = null;
    $('chat').hidden = true; $('project').hidden = true; $('inbox').hidden = false; $('back').hidden = true;
    $('heading').textContent = 'Codeome'; notice(''); renderPending(); renderProjects();
  }
  function showProject(project) {
    state.chatId = null; state.projectKey = project.key; clearImages();
    $('chat').hidden = true; $('inbox').hidden = true; $('project').hidden = false; $('back').hidden = false;
    $('back').textContent = '‹ Projects';
    notice(''); renderProject(project);
  }
  function invalidRoute() {
    history.replaceState({ codeomeRoute: 'home' }, '', '#/');
    showHome(); notice('That page is unavailable.');
  }
  function navigate(hash) {
    history.pushState({ codeomeRoute: Render.parseRoute(hash).type }, '', hash);
    applyRoute();
  }
  function applyRoute() {
    if (!state.loaded || !state.token) return;
    const route = Render.resolveRoute(location.hash, state.projects);
    if (state.chatId && (route.type !== 'chat' || route.id !== state.chatId)) saveOpenChatSeen();
    if (route.type === 'home' || route.type === 'pair') { showHome(); return; }
    if (route.type === 'invalid') { invalidRoute(); return; }
    if (route.type === 'unknown-project') { invalidRoute(); return; }
    if (route.type === 'project') {
      const project = state.projects.find((entry) => entry.key === route.key);
      if (!project) { invalidRoute(); return; }
      showProject(project); return;
    }
    const entry = route.entry;
    // A direct chat link needs a project history entry for the chat back button.
    if (entry && !history.state?.codeomeRoute) {
      history.replaceState({ codeomeRoute: 'project' }, '', `#/p/${entry.project.key}`);
      history.pushState({ codeomeRoute: 'chat' }, '', `#/c/${encodeURIComponent(route.id)}`);
    }
    state.projectKey = entry?.project.key || null;
    if (state.chatId === route.id) { saveOpenChatSeen(); renderChatHeading(); return; }
    if (entry && !entry.earlier) saveSeen(route.id, entry.chat.updatedAt);
    openChat(route.id);
  }
  function answerValues(card, pending) {
    const questions = pending.input?.questions || [];
    const answers = {};
    let valid = true;
    questions.forEach((question, index) => {
      const selected = [...card.querySelectorAll(`[data-option^="${index}:"][aria-pressed="true"]`)]
        .map((button) => question.options[Number(button.dataset.option.split(':')[1])]?.label).filter(Boolean);
      const other = card.querySelector(`[data-other="${index}"]`)?.value.trim();
      if (other) selected.push(other);
      const fieldError = card.querySelector(`[data-error="${index}"]`);
      if (!selected.length) { valid = false; fieldError.textContent = 'Choose or write an answer.'; }
      else fieldError.textContent = '';
      answers[question.question] = question.multiSelect ? selected : other || selected[0] || '';
    });
    return valid ? answers : null;
  }
  async function decide(card, decision) {
    if (!card || !['allow', 'deny'].includes(decision)) return;
    const pending = state.pending.find((entry) => cardKey(entry) === card.dataset.pending);
    if (!pending || !Render.validId(pending.chatId) || !Render.validId(pending.requestId)) return;
    const key = cardKey(pending);
    if (inFlight.has(key)) return;
    const answers = decision === 'allow' && pending.toolName === 'AskUserQuestion' ? answerValues(card, pending) : undefined;
    if (answers === null) return;
    inFlight.add(key);
    for (const entry of document.querySelectorAll('.decision[data-pending]'))
      if (entry.dataset.pending === key) entry.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    const payload = { chatId: pending.chatId, requestId: pending.requestId, decision,
      ...(answers ? { answers } : {}) };
    try {
      await json('/api/decide', { method: 'POST', body: JSON.stringify(payload) });
      completed.add(key);
      state.pending = state.pending.filter((entry) => cardKey(entry) !== key);
      renderPending();
      await refreshState(); if (state.chatId === pending.chatId) await loadLog();
    } catch (error) {
      for (const entry of document.querySelectorAll('.decision[data-pending]')) {
        if (entry.dataset.pending !== key) continue;
        entry.querySelector('.decision-error').textContent = errorText(error);
        cardSources.delete(entry);
      }
      if (error.code === 'already-decided') { await refreshState(); notice('Already answered on the desktop.'); }
    } finally {
      inFlight.delete(key);
      renderPending();
    }
  }
  async function loadTool(button) {
    const result = button.closest('.tool-detail')?.querySelector('.tool-result');
    if (!result || !Render.validId(state.chatId) || !Render.validId(button.dataset.tool)) return;
    button.disabled = true; result.textContent = 'Loading…';
    try {
      const data = await json(`/api/chats/${encodeURIComponent(state.chatId)}/tool/${encodeURIComponent(button.dataset.tool)}`);
      result.textContent = data.result || (data.truncated ? 'Result was truncated.' : 'No result yet.');
      if (data.truncated) result.textContent += '\n[Result truncated by server]';
    } catch (error) { result.textContent = errorText(error); button.disabled = false; }
  }
  async function connectEvents() {
    if (!state.token) return;
    connection(navigator.onLine ? 'Connecting' : 'Offline');
    const controller = new AbortController(); state.stream = controller;
    let reader;
    try {
      const response = await fetch('/api/events', { headers: { Authorization: `Bearer ${state.token}`,
        ...(state.lastEventId ? { 'Last-Event-ID': state.lastEventId } : {}) }, signal: controller.signal });
      if (response.status === 401) { unpaired(); return; }
      if (!response.ok || !response.body) throw new Error(`Events failed (${response.status})`);
      connection('Live'); state.reconnect = 1000; refreshState();
      reader = response.body.getReader(); const decoder = new TextDecoder();
      let buffer = '', event = { id: '', type: '', data: '' };
      while (state.token && !controller.signal.aborted) {
        const chunk = await reader.read(); if (chunk.done) break;
        const decoded = decoder.decode(chunk.value, { stream: true });
        if (buffer.length + decoded.length > MAX_SSE_CHARS) throw new Error('SSE buffer exceeded limit');
        buffer += decoded;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
          if (!line) {
            if (event.data) {
              if (event.id) state.lastEventId = event.id;
              let data; try { data = JSON.parse(event.data); } catch { data = null; }
              if (data) handleEvent(event.type, data);
            }
            event = { id: '', type: '', data: '' }; continue;
          }
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':'); if (colon < 0) continue;
          const field = line.slice(0, colon); const value = line.slice(colon + 1).replace(/^ /, '');
          if (field === 'id') event.id = value;
          else if (field === 'event') event.type = value;
          else if (field === 'data') {
            if (event.data.length + value.length + 1 > MAX_SSE_CHARS) throw new Error('SSE event exceeded limit');
            event.data += (event.data ? '\n' : '') + value;
          }
        }
      }
    } catch { /* Reconnect below unless the stream was intentionally stopped. */ }
    reader?.cancel().catch(() => {});
    if (controller.signal.aborted || !state.token) return;
    connection(navigator.onLine ? 'Connecting' : 'Offline');
    const wait = state.reconnect; state.reconnect = Math.min(30000, state.reconnect * 2);
    setTimeout(() => { if (state.token && state.stream === controller) connectEvents(); }, wait);
  }
  function handleEvent(type, data) {
    if (type === 'tabs' && data && /^[a-f0-9]{12}$/.test(data.key)) {
      saveOpenChatSeen();
      state.projects = Render.applyTabsEvent(state.projects, data);
      saveOpenChatSeen();
      renderPending(); renderProjects(); applyRoute();
    }
    if (['added', 'decided', 'cancelled', 'chat-started', 'chat-exit'].includes(type)) {
      refreshState(); if (state.chatId && data.chatId === state.chatId) loadLog();
    }
    if (type === 'message-batch' && state.chatId === data.chatId) loadLog();
  }
  async function pair(code) {
    connection('Pairing');
    const label = `Phone · ${navigator.userAgent}`.slice(0, 64);
    try {
      const response = await fetch('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, label }) });
      if (!response.ok) throw new Error(`Pairing failed (${response.status}). Scan a new QR code on the Mac.`);
      const data = await response.json();
      if (typeof data.token !== 'string') throw new Error('Pairing response was invalid.');
      state.token = data.token;
      // A persistent bearer token lets the PWA reconnect without cookies; localStorage is readable by page scripts.
      localStorage.setItem('codeome-phone-token', state.token);
      await refreshState(); connectEvents();
    } catch (error) { notice(error.message || 'Pairing failed. Scan a new QR code on the Mac.'); connection('Unpaired'); }
  }
  document.addEventListener('click', (event) => {
    const target = event.target.closest('button'); if (!target) return;
    if (target.id === 'back' || target.id === 'chat-unavailable-back') {
      if (state.chatId && state.projectKey) history.back();
      else navigate('#/');
      return;
    }
    if (target.id === 'load-older') { older(); return; }
    if (target.id === 'reload-log') { loadLog(); return; }
    if (target.id === 'earlier-toggle') {
      if (state.expandedEarlier.has(state.projectKey)) state.expandedEarlier.delete(state.projectKey);
      else state.expandedEarlier.add(state.projectKey);
      const project = state.projects.find((entry) => entry.key === state.projectKey);
      if (project) renderProject(project);
      return;
    }
    if (target.dataset.project) { navigate(`#/p/${encodeURIComponent(target.dataset.project)}`); return; }
    if (target.dataset.chat) { navigate(`#/c/${encodeURIComponent(target.dataset.chat)}`); return; }
    if (target.dataset.tool) { loadTool(target); return; }
    if (target.dataset.option) {
      const card = target.closest('[data-pending]'); const pending = state.pending.find((entry) => cardKey(entry) === card?.dataset.pending);
      const index = Number(target.dataset.option.split(':')[0]);
      if (!pending?.input?.questions?.[index]?.multiSelect)
        card.querySelectorAll(`[data-option^="${index}:"]`).forEach((button) => button.setAttribute('aria-pressed', 'false'));
      target.setAttribute('aria-pressed', target.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); return;
    }
    if (target.dataset.decision) { decide(target.closest('[data-pending]'), target.dataset.decision); return; }
    if (target.id === 'stop') {
      if (!Render.validId(state.chatId) || !window.confirm('Stop this chat?')) return;
      target.disabled = true;
      json('/api/interrupt', { method: 'POST', body: JSON.stringify({ chatId: state.chatId }) })
        .catch((error) => { $('reply-error').textContent = errorText(error); })
        .finally(() => { target.disabled = false; });
    }
  });
  $('reply-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!Render.validId(state.chatId)) { $('reply-error').textContent = 'Invalid chat ID.'; return; }
    const text = $('reply').value.trim();
    if (!text) { $('reply-error').textContent = 'Write a reply first.'; return; }
    $('reply-error').textContent = ''; $('send').disabled = true;
    try { await json('/api/send', { method: 'POST', body: JSON.stringify({ chatId: state.chatId, text }) });
      $('reply').value = ''; await loadLog(); scrollBottom();
    } catch (error) { $('reply-error').textContent = errorText(error); }
    finally { $('send').disabled = false; }
  });
  let olderTimer;
  window.addEventListener('scroll', () => {
    if (!state.chatId || !state.hasMore || window.scrollY > 120) return;
    clearTimeout(olderTimer); olderTimer = setTimeout(older, 150);
  }, { passive: true });
  $('connection').addEventListener('click', () => location.reload());
  window.addEventListener('offline', () => connection('Offline'));
  window.addEventListener('online', () => { if (state.token) { state.stream?.abort(); connectEvents(); } });
  window.addEventListener('hashchange', applyRoute);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
  let pairCode = null;
  if (location.hash.startsWith('#pair=')) {
    try { pairCode = decodeURIComponent(location.hash.slice(6)); }
    catch { notice('Invalid pairing link. Scan a new QR code on the Mac.'); }
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (pairCode) pair(pairCode);
  else {
    try { state.token = localStorage.getItem('codeome-phone-token'); } catch { state.token = null; }
    if (state.token) { refreshState(); connectEvents(); }
    else unpaired();
  }
})();
