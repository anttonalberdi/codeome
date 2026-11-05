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
      if (item.triageStale) section.append(node('span', 'issue-triage-stale', 'Suggestion out of date'));
      const assess = button('Assess', () => onAssess(item));
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

  function render(item, { host, onOpen, onStatus, onSnooze, onAssess, assessing, assessError }) {
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

    // Start-work controls (3.2) use the following reserved container.
    card.append(renderTriage(item, { onAssess, assessing, assessError }), node('div', 'issue-work-actions'));
    const actions = node('div', 'issue-actions');
    const url = safeUrl(item.url, host);
    if (url) {
      const link = node('a', 'issue-link', 'Open on GitHub');
      link.href = url;
      link.addEventListener('click', (event) => { event.preventDefault(); onOpen(url); });
      actions.append(link);
    }
    if (!['dismissed', 'done'].includes(item.status)) {
      actions.append(button('Dismiss', () => onStatus(item, 'dismissed')),
        button('Snooze', (event) => onSnooze(item, event.currentTarget)),
        button('Done', () => onStatus(item, 'done')));
    }
    card.append(actions);
    return card;
  }

  return { render, safeUrl };
})();
if (typeof module !== 'undefined') module.exports = IssueCards;
