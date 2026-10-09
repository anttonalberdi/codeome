// Minimal Markdown → HTML for agent replies: headings, paragraphs, lists, fenced
// code, block quotes, tables, rules, and inline code / bold / italic / links.
// Everything is escaped first; links that are not http(s) become data-path links
// the chat opens in the editor.
(function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = esc(s);
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, text, href) => {
      const raw = href.replace(/&amp;/g, '&');
      return /^https?:\/\//i.test(raw)
        ? `<a href="${esc(raw)}" target="_blank" rel="noopener">${text}</a>`
        : `<a href="#" data-path="${esc(raw)}">${text}</a>`;
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${esc(codes[i])}</code>`);
  }

  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const isRule = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);

  function render(src) {
    const lines = String(src || '').replace(/\r/g, '').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      let m;
      if ((m = l.match(/^\s*(```+|~~~+)\s*([\w+-]*)/))) {
        const fence = m[1]; const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
        i++;
        out.push(`<pre><code${m[2] ? ` data-lang="${esc(m[2])}"` : ''}>${esc(body.join('\n'))}</code></pre>`);
        continue;
      }
      if (!l.trim()) { i++; continue; }
      if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { const n = Math.min(6, m[1].length + 2); out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
      if (l.includes('|') && i + 1 < lines.length && isRule(lines[i + 1])) {
        const head = cells(l); i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push('<div class="md-table"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + head.map((_c, k) => `<td>${inline(r[k] || '')}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
        continue;
      }
      if (/^\s*>/.test(l)) {
        const body = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${render(body.join('\n'))}</blockquote>`);
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) { i = list(lines, i, out); continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>|([-*+]|\d+[.)])\s+)/.test(lines[i]) &&
        !(lines[i].includes('|') && i + 1 < lines.length && isRule(lines[i + 1]))) para.push(lines[i++]);
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
    }
    return out.join('');
  }

  // A list and anything indented under its items (nested lists, continuation lines).
  function list(lines, i, out) {
    const indent = lines[i].match(/^\s*/)[0].length;
    const ordered = /^\s*\d+[.)]/.test(lines[i]);
    const start = ordered ? parseInt(lines[i].trim(), 10) : 1;
    const items = [];
    while (i < lines.length) {
      const l = lines[i];
      const m = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (m && m[1].length === indent) { items.push([m[3]]); i++; continue; }
      if (l.trim() && items.length && l.match(/^\s*/)[0].length > indent) { items[items.length - 1].push(l.slice(Math.min(l.match(/^\s*/)[0].length, indent + 2))); i++; continue; }
      if (!l.trim() && i + 1 < lines.length && lines[i + 1].match(/^\s*/)[0].length > indent && items.length) { i++; continue; }
      break;
    }
    const tag = ordered ? 'ol' : 'ul';
    out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>` + items.map((it) => {
      const first = it[0].replace(/^\[( |x)\]\s+/i, (_m, x) => (x === ' ' ? '☐ ' : '☑ '));
      return `<li>${inline(first)}${it.length > 1 ? render(it.slice(1).join('\n')) : ''}</li>`;
    }).join('') + `</${tag}>`);
    return i;
  }

  App.md = render;
  App.esc = esc;
})();
