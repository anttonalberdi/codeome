// Issue fields come from GitHub. Keep every field as text, including future triage slots.
const IssueCards = (() => {
  const node = (tag, className, value) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (value !== undefined) el.textContent = String(value);
    return el;
  };

  function safeUrl(raw, host) {
    if (!host || typeof raw !== 'string') return null;
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' && !url.username && !url.password && url.host.toLowerCase() === host.toLowerCase() ? url.href : null;
    } catch { return null; }
  }

  const issueChatOptions = (prompt) => ({ send: prompt, mode: 'default' });

  function age(value, now = Date.now()) {
    const elapsed = now - Date.parse(value);
    if (!Number.isFinite(elapsed) || elapsed < 0) return '';
    const minute = Math.floor(elapsed / 60000);
    if (minute < 1) return 'just now';
    if (minute < 60) return `${minute}m ago`;
    const hour = Math.floor(minute / 60);
    if (hour < 24) return `${hour}h ago`;
    const day = Math.floor(hour / 24);
    if (day < 30) return `${day}d ago`;
    return `${Math.floor(day / 30)}mo ago`;
  }

  function button(label, action) {
    const el = node('button', 'btn small', label);
    el.type = 'button';
    el.addEventListener('click', action);
    return el;
  }

  const actionLabels = { none: 'No action needed', reply: 'Reply', fix: 'Quick fix', plan: 'Needs a plan' };
  const sizes = new Set(['trivial', 'small', 'standard', 'large']);

  function workKind(item) {
    if (item.status === 'in-progress') return 'in-progress';
    if (['done', 'dismissed'].includes(item.status)) return 'closed';
    if (item.triaging) return 'triaging';
    if (item.triageStale) return 'stale';
    if (!item.triage) return 'untriaged';
    return Object.hasOwn(actionLabels, item.triage.action) ? item.triage.action : 'unknown';
  }

  function renderTriage(item, { onAssess, assessing, assessError }) {
    const section = node('div', 'issue-triage');
    if (item.triaging || assessing) {
      const pending = button('Assessing…', () => {});
      pending.className = 'btn small issue-assess';
      pending.disabled = true;
      section.setAttribute('aria-live', 'polite');
      section.append(pending);
      return section;
    }
    const triage = item.triage && !item.triageStale && Object.hasOwn(actionLabels, item.triage.action) ? item.triage : null;
    if (triage) {
      const heading = node('div', 'issue-triage-heading');
      heading.append(node('span', `issue-triage-chip ${triage.action}`, actionLabels[triage.action]));
      if (sizes.has(triage.size)) heading.append(node('span', 'issue-triage-size', triage.size));
      section.append(heading, node('span', 'issue-triage-note', 'AI suggestion — unverified'));
      if (triage.summary) section.append(node('p', 'issue-triage-summary', triage.summary));
      const detail = triage.action === 'reply' ? ['Draft reply', triage.draftReply] :
        ['Proposed plan', triage.proposedPlan];
      if (detail[1] && ['reply', 'fix', 'plan'].includes(triage.action)) {
        const expanded = node('details', 'issue-triage-detail');
        expanded.append(node('summary', '', detail[0]), node('pre', 'issue-triage-text', detail[1]));
        section.append(expanded);
      }
    } else {
      if (item.triageStale) section.append(node('span', 'issue-triage-stale', 'Issue changed since assessment'));
      const assess = button(item.triageStale ? 'Re-assess' : 'Assess', () => onAssess(item));
      assess.className = 'btn small issue-assess';
      section.append(assess);
    }
    if (assessError) {
      const error = node('span', 'issue-assess-error', assessError);
      error.setAttribute('role', 'alert');
      section.append(error);
    }
    return section;
  }

  function renderWork(item, opts) {
    const section = node('div', 'issue-work-actions');
    section.setAttribute('aria-live', 'polite');
    const kind = opts.assessing ? 'triaging' : workKind(item);
    if (kind === 'in-progress') {
      section.append(node('span', 'issue-in-progress', 'In progress'));
      if (item.chat && opts.onOpenChat) {
        const open = button('Open chat', () => opts.onOpenChat(item));
        open.className = 'btn small ghost issue-open-chat';
        section.append(open);
      }
    } else if (kind === 'fix' || kind === 'plan' || kind === 'untriaged') {
      const start = button(kind === 'untriaged' ? 'Start work anyway' : 'Start work', () => opts.onStartWork(item, kind === 'untriaged'));
      start.className = kind === 'untriaged' ? 'btn small issue-start' : 'btn small primary issue-start';
      start.title = 'Opens an agent chat that plans this issue and waits for your approval';
      start.disabled = !!opts.starting;
      section.append(start);
    } else if (kind === 'reply' && !opts.posted) {
      const label = node('label', 'issue-reply-label', `Reply to issue #${item.number}`);
      const draft = node('textarea', 'issue-reply-draft');
      draft.rows = 5;
      draft.value = opts.draft === undefined ? String(item.triage.draftReply || '') : opts.draft;
      draft.disabled = !!opts.posting;
      draft.addEventListener('input', () => { opts.onDraft(item, draft.value); });
      label.append(draft);
      const fieldError = node('span', 'issue-reply-error');
      fieldError.setAttribute('role', 'alert');
      const post = button('Post reply', () => {
        const body = draft.value;
        const error = !body.trim() ? 'Write a reply before posting.' : body.length > 65000 ? 'Reply must be at most 65,000 characters.' : '';
        fieldError.textContent = error;
        if (!error) opts.onPostReply(item, body);
      });
      post.className = 'btn small primary issue-post';
      post.disabled = !!opts.posting;
      const discard = button('Discard draft', () => {
        draft.value = String(item.triage.draftReply || '');
        fieldError.textContent = '';
        opts.onDiscardDraft(item);
      });
      discard.disabled = !!opts.posting;
      const buttons = node('div', 'issue-reply-buttons');
      buttons.append(post, discard);
      section.append(label, fieldError, buttons);
    }
    if (opts.posted) {
      section.append(node('span', 'issue-posted', 'Posted'));
      const url = safeUrl(opts.posted, opts.host);
      if (url) {
        const link = node('a', 'issue-posted-link', 'View comment');
        link.href = url;
        link.addEventListener('click', (event) => { event.preventDefault(); opts.onOpen(url); });
        section.append(link);
      }
    }
    if (opts.workError) {
      const error = node('span', 'issue-work-error', opts.workError);
      error.setAttribute('role', 'alert');
      section.append(error);
    }
    return section;
  }

  function render(item, opts) {
    const { host, onOpen, onStatus, onSnooze, onAssess, assessing, assessError } = opts;
    const card = node('article', 'issue-card');
    card.dataset.number = String(item.number);
    const heading = node('div', 'issue-heading');
    heading.append(node('span', 'issue-number', `#${item.number}`), node('span', 'issue-title', item.title || 'Untitled issue'));
    const status = node('span', 'issue-status', item.status || 'new');
    heading.append(status);
    card.append(heading);

    const meta = node('div', 'issue-meta');
    meta.append(node('span', '', item.author || 'Unknown author'));
    const when = age(item.createdAt);
    if (when) meta.append(node('span', '', when));
    card.append(meta);
    if (item.body) card.append(node('p', 'issue-body', item.body));
    if (Array.isArray(item.labels) && item.labels.length) {
      const labels = node('div', 'issue-labels');
      for (const label of item.labels) labels.append(node('span', 'issue-label', label));
      card.append(labels);
    }

    card.append(renderTriage(item, { onAssess, assessing, assessError }), renderWork(item, opts));
    const actions = node('div', 'issue-actions');
    const url = safeUrl(item.url, host);
    if (url) {
      const link = node('a', 'issue-link', 'Open on GitHub');
      link.href = url;
      link.addEventListener('click', (event) => { event.preventDefault(); onOpen(url); });
      actions.append(link);
    }
    if (!['dismissed', 'done'].includes(item.status)) {
      const done = button(workKind(item) === 'none' ? 'Mark done' : 'Done', () => onStatus(item, 'done'));
      if (workKind(item) === 'none') done.className = 'btn small primary issue-mark-done';
      actions.append(button('Dismiss', () => onStatus(item, 'dismissed')),
        button('Snooze', (event) => onSnooze(item, event.currentTarget)), done);
    }
    card.append(actions);
    return card;
  }

  return { render, safeUrl, workKind, issueChatOptions };
})();
if (typeof module !== 'undefined') module.exports = IssueCards;
