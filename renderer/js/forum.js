// Moderated, project-scoped discussion between the user and the agent seats.
(function () {
  const h = App.h;
  const F = { snapshot: null, unread: false };
  App.views.forum = F;
  let root, body, header, seatsEl, controlsEl, logEl, handsEl, composeEl, textarea, sendBtn, postErrorEl, picker;
  let loading = false, error = '', demoMode = false, loadSeq = 0, pinned = true;
  const states = new Map();
  const drafts = new Map();
  const localErrors = [];
  const docTypes = /\.(md|markdown|txt|gdoc)$/i;

  const current = () => F.snapshot;
  const seatFor = (id) => current()?.seats.find((seat) => seat.id === id);
  const seatName = (id) => id === 'user' ? 'You' : (seatFor(id)?.name || (id === 'system' ? 'Forum' : id));
  const engineClass = (id) => seatFor(id)?.engine === 'codex' ? 'codex' : (id === 'user' ? 'user' : 'claude');
  const visible = () => !document.hidden && App.currentView === 'agents' && App.views.agents.pane === 'forum';
  const atBottom = () => logEl && logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 40;
  const scrollEnd = () => { if (logEl) logEl.scrollTop = logEl.scrollHeight; };
  const stamp = (at) => at ? h('time.forum-stamp', { datetime: new Date(at).toISOString(), title: new Date(at).toLocaleString() },
    new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : null;

  async function call(promise) {
    try {
      const result = await promise;
      if (result?.error) throw new Error(result.error);
      return result;
    } catch (cause) {
      App.err(cause.message || String(cause));
      return null;
    }
  }

  F.mount = (el) => {
    root = el;
    root.classList.add('forum');
    root.setAttribute('aria-label', 'Forum');
    root.setAttribute('role', 'region');
    body = h('div.forum-body');
    header = h('header.forum-header');
    seatsEl = h('div.forum-seats', { 'aria-label': 'Agent seats' });
    controlsEl = h('div.forum-controls');
    logEl = h('div.forum-log', { role: 'log', 'aria-label': 'Forum discussion', 'aria-live': 'off', onclick: onLinkClick,
      onscroll: () => { if (visible()) pinned = atBottom(); } });
    handsEl = h('div.forum-hands', { 'aria-label': 'Raised hands', 'aria-live': 'polite' });
    textarea = h('textarea.forum-input.chat-input', { rows: '1', placeholder: 'Post to the forum…', 'aria-label': 'Post to the forum',
      oninput: () => { sizeInput(); postErrorEl.textContent = ''; }, onkeydown: (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
      } });
    sendBtn = h('button.btn.primary.forum-send', { type: 'button', onclick: submit, 'aria-label': 'Post to the forum' }, 'Post');
    postErrorEl = h('span.forum-post-error', { role: 'alert' });
    composeEl = h('form.forum-compose', { onsubmit: (event) => { event.preventDefault(); submit(); } },
      handsEl, h('div.forum-compose-row', textarea, sendBtn), postErrorEl);
    picker = h('input', { type: 'file', accept: '.md,.markdown,.txt,.gdoc', hidden: true,
      onchange: async () => {
        const file = picker.files?.[0];
        picker.value = '';
        if (!file || !current()) return;
        if (!docTypes.test(file.name)) return App.err('Choose a .md, .markdown, .txt or .gdoc file.');
        const path = codeome.pathForFile(file);
        if (!path) return App.err('Could not read that file path.');
        await call(codeome.forum.attachDoc(current().id, path));
      } });
    body.append(header, seatsEl, controlsEl, logEl, composeEl, picker);
    root.append(body);
    codeome.forum.onEvent(({ id, event }) => {
      if (demoMode || !current() || id !== current().id) return;
      receive(event);
    });
    App.listen('project', (project) => {
      const closing = !demoMode && current() ? call(codeome.forum.close(current().id)) : null;
      demoMode = false; drafts.clear(); localErrors.length = 0; void loadProject(project, closing);
    });
    App.listen('view', () => { if (visible()) markSeen(); });
    document.addEventListener('visibilitychange', markSeen);
    window.addEventListener('focus', markSeen);
    paint();
    if (App.project) void loadProject(App.project);
  };

  F.show = () => { markSeen(); if (pinned) scrollEnd(); setTimeout(() => { if (current()) textarea?.focus(); }, 0); };
  F.hide = () => {};
  F.demo = (snapshot) => {
    if (!demoMode && current()) void call(codeome.forum.close(current().id));
    demoMode = true;
    loadSeq++;
    loading = false; error = '';
    drafts.clear(); localErrors.length = 0; setUnread(false);
    F.snapshot = { ...snapshot, transcript: [...(snapshot.transcript || [])], seats: [...(snapshot.seats || [])], hands: [...(snapshot.hands || [])] };
    states.clear();
    for (const seat of F.snapshot.seats) states.set(seat.id, seat.state || (seat.muted ? 'muted' : 'idle'));
    pinned = true;
    paint();
    scrollEnd();
  };

  async function loadProject(project, closing = null) {
    const seq = ++loadSeq;
    F.snapshot = null; loading = !!project; error = ''; states.clear();
    setUnread(false);
    paint();
    if (!project) return;
    try {
      if (closing) await closing;
      if (seq !== loadSeq || project !== App.project) return;
      const listed = await codeome.forum.list(project);
      if (listed?.error) throw new Error(listed.error);
      const latest = listed.forums?.[0];
      if (!latest) { if (seq === loadSeq) { loading = false; paint(); } return; }
      const opened = await codeome.forum.open(project, latest.id);
      if (opened?.error) throw new Error(opened.error);
      if (seq !== loadSeq || project !== App.project) { if (opened.forum?.id !== current()?.id) void call(codeome.forum.close(opened.forum.id)); return; }
      install(opened.forum);
    } catch (cause) {
      if (seq !== loadSeq) return;
      loading = false; error = cause.message || String(cause); paint();
    }
  }

  function install(snapshot) {
    const replaced = !demoMode && current()?.id !== snapshot.id ? current()?.id : null;
    loadSeq++;
    drafts.clear(); localErrors.length = 0;
    F.snapshot = { ...snapshot, transcript: [...(snapshot.transcript || [])], seats: [...(snapshot.seats || [])], hands: [...(snapshot.hands || [])] };
    loading = false; error = ''; states.clear();
    for (const seat of F.snapshot.seats) states.set(seat.id, seat.muted ? 'muted' : 'idle');
    setUnread(false);
    pinned = true;
    paint();
    scrollEnd();
    if (replaced) void call(codeome.forum.close(replaced));
  }

  function setUnread(value) {
    if (F.unread === value) return;
    F.unread = value;
    App.emit('forum-unread', value);
  }
  function markSeen() { if (visible()) setUnread(false); }

  function receive(event) {
    const forum = current();
    if (!forum || !event) return;
    switch (event.type) {
      case 'message': {
        if (!event.item) break;
        const item = event.item;
        let saved = forum.transcript.find((entry) => entry.id === item.id);
        const isNew = !saved;
        if (saved) Object.assign(saved, item);
        else { saved = { ...item }; forum.transcript.push(saved); }
        if (event.delta !== undefined) drafts.set(item.id, true);
        else drafts.delete(item.id);
        updateItem(saved);
        if (!visible() && (isNew || event.delta === undefined)) setUnread(true);
        break;
      }
      case 'message-cancelled':
        drafts.delete(event.id);
        forum.transcript = forum.transcript.filter((item) => item.id !== event.id);
        paintTimeline();
        break;
      case 'hand':
        if (event.hand && !forum.hands.some((hand) => hand.id === event.hand.id)) forum.hands.push(event.hand);
        paintHands();
        if (!visible()) setUnread(true);
        break;
      case 'hand-removed':
        forum.hands = forum.hands.filter((hand) => hand.id !== event.handId);
        paintHands();
        break;
      case 'seat': {
        const seat = seatFor(event.seatId);
        if (seat) {
          states.set(seat.id, event.state);
          seat.muted = event.state === 'muted';
          paintSeats(); paintControls(); paintHands();
        }
        break;
      }
      case 'budget':
        forum.budget = event.budget; forum.budgetLimit = event.limit; paintControls();
        break;
      case 'usage':
        forum.usage = event.usage || {}; paintSeats();
        break;
      case 'summary':
        forum.summary = event.summary || ''; forum.summarizedUpTo = event.summarizedUpTo;
        for (const item of forum.transcript) {
          item.summarized = true;
          if (item.id === event.summarizedUpTo) break;
        }
        paintTimeline();
        break;
      case 'doc':
        forum.doc = event.doc || null; paintHeader(); paintSeats();
        if (event.changed) App.toast('Attached document updated.');
        break;
      case 'error': {
        const note = { id: `error-${Date.now()}-${Math.random()}`, at: Date.now(), speaker: event.seatId || 'system', kind: 'note', text: event.error || 'Forum error', error: true };
        localErrors.push(note); updateItem(note);
        if (!visible()) setUnread(true);
        break;
      }
      case 'state': paintControls(); break;
    }
  }

  function paint() {
    if (!root) return;
    body.classList.toggle('is-empty', !current());
    paintHeader();
    paintSeats();
    paintControls();
    paintTimeline();
    paintHands();
    composeEl.hidden = !current();
  }

  function paintHeader() {
    header.replaceChildren();
    const forum = current();
    if (!forum) return;
    const title = h('button.forum-title', { title: 'Rename forum', 'aria-label': `Rename ${forum.title || 'forum'}`, onclick: rename }, forum.title || 'New forum');
    const history = h('button.btn.small', { onclick: (event) => { void openHistory(event.currentTarget); }, 'aria-label': 'Forums history' }, 'Forums');
    header.append(h('div.forum-header-row', title, history));
    const doc = forum.doc;
    header.append(doc ? h('div.forum-document',
      h('span.forum-doc-name', { title: doc.path }, App.basename(doc.path)),
      h('button.btn.small', { onclick: () => App.views.editor.openFile(doc.path), 'aria-label': `Open ${App.basename(doc.path)}` }, 'Open'),
      App.iconBtn('close', `Detach ${App.basename(doc.path)}`, () => { void call(codeome.forum.detachDoc(forum.id)); }))
      : h('button.forum-attach', { onclick: () => picker.click() }, '+ Attach document'));
  }

  async function openHistory(anchor) {
    if (!App.project) return;
    const project = App.project;
    const listed = await call(codeome.forum.list(project));
    if (!listed || project !== App.project) return;
    const items = [{ label: 'New forum', run: newForum }, '-', { header: 'Recent forums' }];
    for (const forum of (listed.forums || []).slice(0, 20)) {
      items.push({ label: forum.title || 'Untitled forum', key: App.fmtAgo(forum.updatedAt), run: () => { void openForum(forum.id); } });
      items.push({ label: `Delete ${forum.title || 'Untitled forum'}`, danger: true, run: () => { void deleteForum(forum); } });
    }
    if (!listed.forums?.length) items.push({ header: 'No forums yet' });
    App.menuAt(anchor, items);
  }

  async function newForum() {
    const project = App.project;
    if (!project) return App.toast('Open a project folder first.');
    const result = await call(codeome.forum.create({ project }));
    if (result?.forum) {
      if (project === App.project) install(result.forum);
      else void call(codeome.forum.close(result.forum.id));
    }
  }
  F.newForum = newForum;
  async function openForum(id) {
    const project = App.project;
    const result = await call(codeome.forum.open(project, id));
    if (result?.forum) {
      if (project === App.project) install(result.forum);
      else void call(codeome.forum.close(result.forum.id));
    }
  }
  async function deleteForum(forum) {
    if (!(await App.confirm('Delete forum?', `Delete “${forum.title || 'Untitled forum'}” and its discussion?`, 'Delete forum', true))) return;
    const project = App.project;
    const result = await call(codeome.forum.delete(project, forum.id));
    if (result && project === App.project) void loadProject(project);
  }
  async function rename() {
    const forum = current();
    if (!forum) return;
    const title = await App.prompt('Rename forum', 'Title', forum.title || '');
    if (!title) return;
    const result = await call(codeome.forum.rename(forum.id, title.slice(0, 80)));
    if (result?.forum && forum === current()) { forum.title = result.forum.title; paintHeader(); }
  }

  function paintSeats() {
    seatsEl.replaceChildren();
    const forum = current();
    if (!forum) return;
    for (const seat of forum.seats) {
      const state = states.get(seat.id) || (seat.muted ? 'muted' : 'idle');
      const usage = forum.usage?.[seat.id] || {};
      const tokenCount = (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.checkTokens || 0);
      const tooltip = `${usage.turns || 0} turns · ${App.fmtTokens(tokenCount)} tokens · ${App.fmtUsd(usage.costUsd || 0)}`;
      let reason = '';
      if (!forum.doc) reason = 'Attach a document to enable editing.';
      else if (forum.doc.kind === 'gdoc' && seat.engine === 'codex') reason = 'Codex cannot edit Google Docs.';
      else if (forum.seats.some((other) => other.id !== seat.id && states.get(other.id) === 'writing')) reason = 'Another seat is writing.';
      else if (seat.muted) reason = 'Unmute this seat before editing.';
      seatsEl.append(h('div.forum-seat.' + (seat.engine === 'codex' ? 'codex' : 'claude'),
        h('span.forum-state.' + state, { title: state, 'aria-label': `${seat.name} ${state}` }),
        h('span.forum-seat-name', seat.name),
        h('span.forum-usage', { title: tooltip, 'aria-label': tooltip, tabindex: '0' }, App.fmtTokens(tokenCount)),
        h('button.forum-seat-action', { title: seat.muted ? `Unmute ${seat.name}` : `Mute ${seat.name}`, 'aria-label': seat.muted ? `Unmute ${seat.name}` : `Mute ${seat.name}`,
          'aria-pressed': String(!!seat.muted), onclick: () => { void call(codeome.forum.mute(forum.id, seat.id, !seat.muted)); } }, seat.muted ? 'Unmute' : 'Mute'),
        h('button.forum-seat-action', { disabled: !!reason, title: reason || `Ask ${seat.name} to edit the document`, 'aria-label': `Ask ${seat.name} to edit the document`,
          onclick: () => { void requestWrite(seat); } }, 'Edit…')));
    }
  }
  async function requestWrite(seat) {
    const forum = current();
    if (!forum) return;
    const instruction = await App.prompt(`Edit document with ${seat.name}`, 'What should be changed?');
    if (!instruction) return;
    await call(codeome.forum.grantWrite(forum.id, seat.id, instruction));
  }

  function paintControls() {
    controlsEl.replaceChildren();
    const forum = current();
    if (!forum) return;
    const limit = Number(forum.budgetLimit) || 0;
    const busy = forum.seats.some((seat) => ['checking', 'speaking', 'writing'].includes(states.get(seat.id)));
    const budgetHelp = 'How many raised hands are allowed without asking, per message. 0 means you approve every turn.';
    controlsEl.append(h('div.forum-stepper', { title: budgetHelp },
      h('span', 'Auto-allow'),
      h('button', { disabled: limit <= 0, 'aria-label': 'Decrease auto-allow rounds', onclick: () => { void changeBudget(limit - 1); } }, '−'),
      h('output', { 'aria-label': 'Auto-allow rounds' }, `${limit} ${limit === 1 ? 'round' : 'rounds'}`),
      h('button', { disabled: limit >= 20, 'aria-label': 'Increase auto-allow rounds', onclick: () => { void changeBudget(limit + 1); } }, '+')),
      h('button.btn.small.forum-stop', { hidden: !busy, disabled: !busy, onclick: () => { void call(codeome.forum.stop(forum.id)); } }, 'Stop'));
  }
  async function changeBudget(n) { const forum = current(); if (forum) await call(codeome.forum.setBudget(forum.id, n)); }

  function renderItem(item) {
    const kind = item.kind || 'message';
    if (kind === 'summary') return summaryNote(item.text);
    if (kind === 'note' || item.error) return h('div.note' + (item.error ? '.error' : ''), item.text);
    const title = h('div.forum-item-head', h('strong.forum-speaker.' + engineClass(item.speaker), seatName(item.speaker)),
      kind === 'write' ? h('span.forum-kind', 'edited the document') : null, stamp(item.at));
    const message = h('div.msg.md' + (drafts.has(item.id) ? '.live' : ''), { html: App.md(item.text || '') });
    return h('article.forum-item.' + engineClass(item.speaker) + (kind === 'write' ? '.write' : ''), { 'data-item-id': item.id }, title, message);
  }
  function summaryNote(text) {
    return h('details.forum-summary', h('summary', 'Earlier discussion summarised'), h('div.msg.md', { html: App.md(text || '') }));
  }
  async function onLinkClick(event) {
    const anchor = event.target.closest('a[data-path]');
    if (!anchor) return;
    event.preventDefault();
    const match = anchor.dataset.path.match(/^(.*?)(?:#L(\d+)(?:-L?\d+)?|:(\d+))?$/);
    if (!match) return;
    let path = decodeURI(match[1]);
    if (!path.startsWith('/') && !path.startsWith('~')) path = App.join(current()?.project || App.project, path);
    const line = Number(match[2] || match[3]) || 0;
    const tab = await App.views.editor.openFile(path.replace(/^~/, App.env.home || '~'));
    const editor = App.views.editor.editor;
    if (tab && line && editor) setTimeout(() => { editor.revealLineInCenter(line); editor.setPosition({ lineNumber: line, column: 1 }); editor.focus(); }, 30);
  }
  function paintTimeline() {
    if (!logEl) return;
    const stick = visible() ? atBottom() : pinned;
    logEl.replaceChildren();
    const forum = current();
    if (!forum) {
      if (loading) logEl.append(h('div.forum-empty', h('span.spinner'), ' Loading forums…'));
      else if (error) logEl.append(h('div.forum-empty', h('p.note.error', error), h('button.btn.small', { onclick: () => { void loadProject(App.project); } }, 'Retry')));
      else logEl.append(h('div.forum-empty', h('h3', 'Start a forum'),
        h('p', 'Post a question. Claude and Codex raise a hand when they have something to add. Allow a turn, or ask a seat to edit an attached document.'),
        h('button.btn.primary', { disabled: !App.project, onclick: newForum }, 'New forum')));
      return;
    }
    const items = forum.transcript || [];
    let summaryPlaced = false;
    for (const item of items) {
      if (item.summarized) {
        if (forum.summary && !summaryPlaced) { logEl.append(summaryNote(forum.summary)); summaryPlaced = true; }
        continue;
      }
      logEl.append(renderItem(item));
    }
    for (const note of localErrors) logEl.append(renderItem(note));
    if (forum.summary && !summaryPlaced) logEl.prepend(summaryNote(forum.summary));
    if (!items.length && !forum.summary) logEl.append(h('div.forum-log-hint', 'Your discussion starts here. Post a message below.'));
    if (stick) scrollEnd();
  }
  function updateItem(item) {
    const stick = visible() ? atBottom() : pinned;
    logEl.querySelector('.forum-log-hint')?.remove();
    const old = [...logEl.querySelectorAll('[data-item-id]')].find((el) => el.dataset.itemId === item.id);
    const next = renderItem(item);
    if (old) old.replaceWith(next); else logEl.append(next);
    if (stick) scrollEnd();
  }

  function paintHands() {
    handsEl.replaceChildren();
    const forum = current();
    if (!forum) return;
    if (!forum.hands.length) handsEl.append(h('p.forum-hands-empty', 'Agents will raise a hand here when they have something to add.'));
    for (const hand of forum.hands) {
      const seat = seatFor(hand.seatId);
      handsEl.append(h('div.forum-hand', h('div.forum-hand-text', h('strong', `${seat?.name || hand.seatId} wants to speak`), ` — ${hand.reason}`),
        h('div.forum-hand-actions',
          h('button.btn.small.primary', { type: 'button', onclick: () => { void call(codeome.forum.allow(forum.id, hand.id)); }, 'aria-label': `Allow ${seat?.name || hand.seatId} to speak` }, 'Allow'),
          h('button.btn.small', { type: 'button', onclick: () => { void call(codeome.forum.dismiss(forum.id, hand.id)); }, 'aria-label': `Dismiss ${seat?.name || hand.seatId}` }, 'Dismiss'))));
    }
    if (forum.seats.some((seat) => states.get(seat.id) === 'checking')) handsEl.append(h('div.forum-thinking', { role: 'status' }, h('span.spinner'), ' Thinking…'));
  }

  function sizeInput() { if (!textarea) return; textarea.style.height = 'auto'; textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px'; }
  async function submit() {
    const forum = current();
    const text = textarea.value.trim();
    if (!forum) return;
    if (!text) { postErrorEl.textContent = 'Write a message before posting.'; textarea.focus(); return; }
    sendBtn.disabled = true;
    const result = await call(codeome.forum.post(forum.id, text));
    sendBtn.disabled = false;
    if (!result) postErrorEl.textContent = 'Could not post. Try again.';
    else if (current()?.id === forum.id) { textarea.value = ''; postErrorEl.textContent = ''; sizeInput(); textarea.focus(); }
  }
})();
