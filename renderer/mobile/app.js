(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { token: null, chats: [], groups: [], expandedGroups: new Set(), pending: [], chatId: null, items: [], hasMore: false,
    loadingOlder: false, firstIndex: null, stream: null, lastEventId: '', imageUrls: new Map(),
    imageObserver: null, reconnect: 1000, refreshing: false, refreshAgain: false };
  const inFlight = new Set();
  const completed = new Set();
  const cardSources = new WeakMap();
  const MAX_SSE_CHARS = 1024 * 1024;
  const errorText = (error) => {
    const code = error?.code || '';
    if (code === 'needs-desktop') return 'This action needs the desktop. You can still deny it here.';
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
    $('inbox').hidden = true; $('chat').hidden = true; $('back').hidden = true;
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
      throw { code: body.error, message: `Request failed (${response.status}).` };
    }
    return response;
  }
  async function json(path, options) { return (await request(path, options)).json(); }
  function chatOf(id) { return state.chats.find((chat) => chat.id === id); }
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
    const chats = new Map(state.groups.flatMap((group) => group.chats.map((chat) =>
      [chat.id, { ...chat, projectName: group.name }])));
    const ordered = [...state.pending].sort((a, b) => a.createdAt - b.createdAt);
    syncCards($('pending-list'), ordered, chats, true);
    const pinned = ordered.filter((entry) => entry.chatId === state.chatId);
    syncCards($('chat-pending'), pinned, chats);
  }
  function renderChats() {
    replaceMarkup($('chat-list'), Render.renderChatGroups(state.groups, state.expandedGroups));
  }
  function renderChatHeading() {
    const chat = chatOf(state.chatId);
    const group = state.groups.find((entry) => entry.key === (chat?.project || ''));
    const heading = $('heading');
    const title = document.createElement('span');
    title.className = 'heading-title';
    title.textContent = Render.visibleText(chat?.title || 'Chat');
    const project = document.createElement('small');
    project.className = 'heading-project';
    project.textContent = Render.visibleText(group?.name || 'No project');
    heading.replaceChildren(title, project);
    if (group?.path) {
      const path = document.createElement('small');
      path.className = 'heading-path';
      path.textContent = Render.visibleText(group.path);
      heading.append(path);
    }
  }
  async function refreshState() {
    if (!state.token) return;
    if (state.refreshing) { state.refreshAgain = true; return; }
    state.refreshing = true;
    try {
      const data = await json('/api/state');
      state.chats = Array.isArray(data.chats) ? data.chats : [];
      state.groups = Render.groupChats(state.chats);
      const pending = Array.isArray(data.pending) ? data.pending : [];
      for (const key of completed) if (!pending.some((entry) => cardKey(entry) === key)) completed.delete(key);
      state.pending = pending.filter((entry) => !completed.has(cardKey(entry)));
      renderPending(); renderChats();
      if (state.chatId) renderChatHeading();
      if (!state.chatId) { $('inbox').hidden = false; notice(''); }
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
    if (!Render.validId(chatId)) { notice('Invalid chat ID.'); return; }
    if (state.chatId !== chatId) { clearImages(); state.items = []; state.hasMore = false; }
    state.chatId = chatId;
    $('inbox').hidden = true; $('chat').hidden = false; $('back').hidden = false;
    renderChatHeading();
    renderPending(); replaceMarkup($('log'), '<p class="empty">Loading messages…</p>'); notice('');
    await loadLog();
    requestAnimationFrame(scrollBottom);
  }
  function showInbox() {
    state.chatId = null; clearImages();
    $('chat').hidden = true; $('inbox').hidden = false; $('back').hidden = true;
    $('heading').textContent = 'Codeome'; notice(''); renderPending();
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
    if (target.id === 'back') { showInbox(); return; }
    if (target.id === 'load-older') { older(); return; }
    if (target.id === 'reload-log') { loadLog(); return; }
    if (target.hasAttribute('data-project-more')) {
      state.expandedGroups.add(target.dataset.projectMore); renderChats(); return;
    }
    if (target.dataset.chat) { openChat(target.dataset.chat); return; }
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
  window.addEventListener('offline', () => connection('Offline'));
  window.addEventListener('online', () => { if (state.token) { state.stream?.abort(); connectEvents(); } });
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
