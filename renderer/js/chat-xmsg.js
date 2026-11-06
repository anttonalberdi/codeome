// Plain-text helpers for cross-chat cards. Never feed message content to Markdown.
const ChatXmsg = (() => {
  const sections = [
    ['goal', 'Goal'], ['context', 'Context'], ['constraints', 'Constraints'],
    ['acceptance_check', 'Acceptance check'], ['out_of_scope', 'Out of scope']
  ];
  const plain = (value) => (typeof value === 'string' ? value : '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Co}\u00ad\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2800\u3164\ufe00-\ufe0f\uffa0\ufff9-\ufffb\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu, (ch) => ch === '\n' ? '\n' : ' ');

  function briefParts(brief) {
    return Object.fromEntries(sections.filter(([key]) => typeof brief?.[key] === 'string')
      .map(([key]) => [key, plain(brief[key])]));
  }

  function editedBrief(parts) {
    return sections.filter(([key]) => plain(parts[key]).trim())
      .map(([key, label]) => `## ${label}\n${plain(parts[key]).trim()}`).join('\n');
  }

  const rank = { pending: 0, approved: 1, delivered: 2, read: 3 };
  function receipt(item, event) {
    if (!item || !event || item.id !== event.id || !event.status) return false;
    if (['declined', 'expired', 'dismissed', 'undeliverable'].includes(item.status)) return false;
    if (['declined', 'expired', 'dismissed', 'undeliverable'].includes(event.status)) item.status = event.status;
    else if (Object.hasOwn(rank, event.status) && (rank[event.status] >= (rank[item.status] ?? -1))) item.status = event.status;
    else return false;
    if (event.to?.code) item.readBy = plain(event.to.code);
    return true;
  }
  return { sections, plain, briefParts, editedBrief, receipt };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ChatXmsg;
if (typeof App !== 'undefined') App.chatXmsg = ChatXmsg;
