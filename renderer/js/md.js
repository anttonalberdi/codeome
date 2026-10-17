// Minimal Markdown → HTML for agent replies: headings, paragraphs, lists, fenced
// code, block quotes, tables, rules, and inline code / bold / italic / links.
// Everything is escaped first; links that are not http(s) become data-path links
// the chat opens in the editor.
(function () {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Names that read as a file (known extension, no spaces) open in the editor on click.
  const EXT = 'md|markdown|txt|csv|tsv|json|ya?ml|toml|log|py|R|Rmd|qmd|ipynb|js|ts|tsx|jsx|css|html|sh|smk|nf|sql|xml|tex|bib|fa|fasta|fastq|gff|gtf|bed|vcf|tree|nwk|cfg|conf|ini|pdf|png|jpe?g|svg';
  const FILE = new RegExp('^(?:~/|\\.{0,2}/)?[\\w.@+-]+(?:/[\\w.@+-]+)*\\.(?:' + EXT + ')(?:(?:#L|:)\\d+(?:-L?\\d+)?)?$', 'i');
  const BARE = new RegExp('(^|[\\s(])((?:~/|\\.{0,2}/)?[\\w.@+-]+(?:/[\\w.@+-]+)*\\.(?:' + EXT + ')(?:(?:#L|:)\\d+(?:-L?\\d+)?)?)(?=$|[\\s),;:!?]|\\.(?:\\s|$))', 'gi');

  function inline(s) {
    const codes = [];
    const stash = [];
    const hold = (html) => { stash.push(html); return '\u0001' + (stash.length - 1) + '\u0001'; };
    s = s.replace(/`([^`\n]+)`/g, (_m, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
    s = esc(s);
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, text, href) => {
      const raw = href.replace(/&amp;/g, '&');
      return /^https?:\/\//i.test(raw)
        ? `<a href="${esc(raw)}" target="_blank" rel="noopener">${text}</a>`
        : `<a href="#" data-path="${esc(raw)}">${text}</a>`;
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre, url) => pre + hold(`<a href="${url}" target="_blank" rel="noopener">${url}</a>`));
    s = s.replace(/<a [^>]*>.*?<\/a>/g, (a) => hold(a));
    s = s.replace(BARE, (_m, pre, f) => pre + hold(`<a href="#" data-path="${esc(f)}">${esc(f)}</a>`));
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) => FILE.test(codes[i])
      ? `<a href="#" data-path="${esc(codes[i])}"><code>${esc(codes[i])}</code></a>`
      : `<code>${esc(codes[i])}</code>`);
    return s.replace(/\u0001(\d+)\u0001/g, (_m, i) => stash[i]);
  }

  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const isRule = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);

  const COPY_IC = '<svg viewBox="0 0 16 16"><path d="M5.5 5.5h7v8h-7z M3.5 10.5v-8h7" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
  const LAUNCH_IC = '<svg viewBox="0 0 16 16"><path d="M4.5 3l8 5-8 5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  const CHECK_IC = '<svg viewBox="0 0 16 16"><path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

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
        out.push(`<div class="code-block"><span class="code-actions"><button type="button" class="code-launch" title="Launch in a new session" aria-label="Launch in a new session">${LAUNCH_IC}</button><button type="button" class="code-copy" title="Copy to clipboard" aria-label="Copy to clipboard">${COPY_IC}</button></span><pre><code${m[2] ? ` data-lang="${esc(m[2])}"` : ''}>${esc(body.join('\n'))}</code></pre></div>`);
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

  // One delegated handler serves every rendered code block (chat, job results, previews).
  if (typeof document !== 'undefined') document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.code-copy');
    if (!btn) return;
    const code = btn.parentElement.querySelector('pre');
    navigator.clipboard.writeText(code ? code.textContent : '').then(() => {
      btn.innerHTML = CHECK_IC; btn.title = 'Copied';
      setTimeout(() => { btn.innerHTML = COPY_IC; btn.title = 'Copy to clipboard'; }, 1500);
    }, () => App.toast('Could not copy.'));
  });
  if (typeof document !== 'undefined') document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.code-launch');
    if (!btn) return;
    const code = btn.closest('.code-block').querySelector('pre');
    App.views.chat.launchPrompt(code ? code.textContent : '');
  });

  App.md = render;
  App.esc = esc;
})();
