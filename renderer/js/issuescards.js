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

  function render(item, { host, onOpen, onStatus, onSnooze }) {
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

    // Reserved for the triage display (2.3) and start-work controls (3.2).
    card.append(node('div', 'issue-triage'), node('div', 'issue-work-actions'));
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
