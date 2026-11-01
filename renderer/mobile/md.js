// Adapted from renderer/js/md.js: escape first, then add only safe markup.
// Phone links never open desktop file paths. Only http, https, and mailto link.
(function (root) {
  'use strict';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  function safeUrl(value) {
    const raw = String(value).replace(/&amp;/g, '&');
    return /^(?:https?:\/\/|mailto:)/i.test(raw) ? raw : null;
  }
  function visibleHost(value) {
    const raw = value.replace(/&amp;/g, '&');
    if (!/^(?:https?:\/\/)?[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?::\d+)?(?:[/?#][^\s]*)?$/i.test(raw)) return null;
    try { return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase(); }
    catch { return null; }
  }
  function inline(source) {
    const held = [];
    const hold = (html) => { held.push(html); return `\u0001${held.length - 1}\u0001`; };
    let value = esc(String(source ?? '').replace(/\u0001/g, ''));
    value = value.replace(/`([^`\n]+)`/g, (_all, code) => hold(`<code>${code}</code>`));
    value = value.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_all, label, href) => {
      const url = safeUrl(href);
      if (!url) return label;
      let destination = '';
      try { destination = new URL(url).hostname.toLowerCase(); } catch { return label; }
      const shown = visibleHost(label);
      const hostNote = shown && destination && shown !== destination ? ` <small class="link-destination">(${esc(destination)})</small>` : '';
      return hold(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}${hostNote}</a>`);
    });
    value = value.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_all, prefix, url) =>
      prefix + hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`));
    value = value.replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g, (_all, a, b) => `<strong>${a || b}</strong>`);
    value = value.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
    value = value.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    return value.replace(/\u0001(\d+)\u0001/g, (_all, index) => held[Number(index)]);
  }
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((part) => part.trim());
  const isRule = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  function render(source) {
    const lines = String(source ?? '').replace(/\u0001/g, '').replace(/\r/g, '').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      let match;
      if ((match = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/))) {
        const fence = match[1]; const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
        if (i < lines.length) i++;
        out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
        continue;
      }
      if (!line.trim()) { i++; continue; }
      if ((match = line.match(/^(#{1,6})\s+(.*)$/))) {
        const level = Math.min(6, match[1].length + 2);
        out.push(`<h${level}>${inline(match[2])}</h${level}>`); i++; continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (line.includes('|') && i + 1 < lines.length && isRule(lines[i + 1])) {
        const head = cells(line); i += 2; const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push('<div class="md-table"><table><thead><tr>' + head.map((cell) => `<th>${inline(cell)}</th>`).join('') +
          '</tr></thead><tbody>' + rows.map((row) => '<tr>' + head.map((_cell, n) => `<td>${inline(row[n] || '')}</td>`).join('') +
          '</tr>').join('') + '</tbody></table></div>'); continue;
      }
      if (/^\s*>/.test(line)) {
        const body = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${render(body.join('\n'))}</blockquote>`); continue;
      }
      if ((match = line.match(/^\s*([-*+]|\d+[.)])\s+/))) {
        const ordered = /^\d/.test(match[1]); const tag = ordered ? 'ol' : 'ul'; const items = [];
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]))
          items.push(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
        out.push(`<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tag}>`); continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(?:```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[i]))
        para.push(lines[i++]);
      if (!para.length) { i++; continue; }
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    }
    return out.join('');
  }
  const api = { esc, render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MobileMD = api;
})(typeof window !== 'undefined' ? window : globalThis);
