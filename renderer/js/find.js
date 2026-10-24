// Find in the active block (⌘F): the agent chat, previews, file lists, Slurm, Git and the
// rest of the app's own text. Terminals (xterm) and the code editor (Monaco) keep their own
// find bars, which this leaves alone. Matches are painted with the CSS Custom Highlight API,
// so the page's DOM is never modified and live content (a streaming chat) can be re-scanned.
(function () {
  const h = App.h;
  const F = App.find = {};
  const MAX = 2000;
  const hasHL = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';

  let last = null;          // where the user last clicked or focused
  let region = null, ranges = [], cur = 0, restore = null, observer = null, timer = null;
  let bar, input, count;

  document.addEventListener('mousedown', (e) => { if (!bar || !bar.contains(e.target)) last = e.target; }, true);
  document.addEventListener('focusin', (e) => { if (!bar || !bar.contains(e.target)) last = e.target; }, true);

  // The block ⌘F applies to, from where the user last clicked.
  function regionFor(from) {
    const ov = document.getElementById('overlay');
    if (ov && !ov.hidden && ov.childNodes.length) return ov;
    const el = from && from.nodeType === 1 ? from : from && from.parentElement;
    if (el && el.isConnected) {
      const r = el.closest('[data-find-scope], #sidebar .view, #alt-host, #welcome, #titlebar, #projects');
      if (r) return r;
    }
    return document.getElementById('alt-host').hidden ? document.getElementById('sidebar') : document.getElementById('alt-host');
  }

  function textNodes(root) {
    const out = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p || p.closest('script, style, noscript, #find-bar, .xterm, .monaco-editor')) return NodeFilter.FILTER_REJECT;
        return p.checkVisibility && !p.checkVisibility({ visibilityProperty: true }) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n);
    return out;
  }

  function paint() {
    if (!hasHL) return;
    CSS.highlights.delete('find-match'); CSS.highlights.delete('find-current');
    if (!ranges.length) return;
    CSS.highlights.set('find-match', new Highlight(...ranges));
    CSS.highlights.set('find-current', new Highlight(ranges[cur]));
  }

  function show() {
    count.textContent = !input.value ? '' : ranges.length ? (cur + 1) + '/' + (ranges.length >= MAX ? MAX + '+' : ranges.length) : 'No results';
    input.classList.toggle('none', !!input.value && !ranges.length);
    paint();
    const r = ranges[cur];
    if (!r) return;
    let el = r.startContainer.parentElement;
    for (let d = el && el.closest('details:not([open])'); d; d = d.parentElement && d.parentElement.closest('details:not([open])')) d.open = true;
    if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  // Re-scan the region for the query; `keep` holds the current match where it was.
  function scan(keep) {
    ranges = [];
    const q = input.value.toLowerCase();
    if (q && region && region.isConnected) {
      outer: for (const n of textNodes(region)) {
        const t = n.nodeValue.toLowerCase();
        for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + q.length)) {
          const r = document.createRange();
          r.setStart(n, i); r.setEnd(n, i + q.length);
          ranges.push(r);
          if (ranges.length >= MAX) break outer;
        }
      }
    }
    cur = keep ? Math.min(cur, Math.max(0, ranges.length - 1)) : 0;
    if (keep) { paint(); count.textContent = !input.value ? '' : ranges.length ? (cur + 1) + '/' + (ranges.length >= MAX ? MAX + '+' : ranges.length) : 'No results'; input.classList.toggle('none', !!input.value && !ranges.length); }
    else show();
  }

  function step(back) {
    if (!ranges.length) return;
    cur = (cur + (back ? -1 : 1) + ranges.length) % ranges.length;
    show();
  }

  function place() {
    const b = region.getBoundingClientRect();
    const w = bar.offsetWidth || 300;
    bar.style.top = Math.max(4, b.top + 8) + 'px';
    bar.style.left = Math.max(4, Math.min(innerWidth - w - 8, b.right - w - 14)) + 'px';
  }

  function build() {
    input = h('input.find-input', { type: 'text', placeholder: 'Find', spellcheck: false, 'aria-label': 'Find in this block' });
    count = h('span.find-count');
    bar = h('div#find-bar', { hidden: true, role: 'search' },
      input, count,
      h('button.icon-btn.small', { title: 'Previous (⇧Enter)', onclick: () => { step(true); input.focus(); } }, '↑'),
      h('button.icon-btn.small', { title: 'Next (Enter)', onclick: () => { step(false); input.focus(); } }, '↓'),
      h('button.icon-btn.small', { title: 'Close (Esc)', onclick: () => F.close() }, '×'));
    input.addEventListener('input', () => scan(false));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey); }
      else if (e.key === 'Escape') { e.preventDefault(); F.close(); }
      else if (e.metaKey && e.key.toLowerCase() === 'g') { e.preventDefault(); step(e.shiftKey); }
    });
    document.body.append(bar);
  }

  F.open = function (from) {
    if (!bar) build();
    const next = regionFor(from);
    const same = region === next && !bar.hidden;
    if (!same) restore = document.activeElement;
    region = next;
    const sel = String(getSelection() || '').trim();
    if (sel && !sel.includes('\n') && region.contains(getSelection().anchorNode)) input.value = sel;
    bar.hidden = false;
    place();
    if (observer) observer.disconnect();
    observer = new MutationObserver((muts) => {
      if (muts.every((m) => bar.contains(m.target))) return;
      clearTimeout(timer); timer = setTimeout(() => input.value && scan(true), 250);
    });
    observer.observe(region, { childList: true, subtree: true, characterData: true });
    input.focus(); input.select();
    scan(false);
  };

  F.close = function () {
    if (!bar || bar.hidden) return;
    bar.hidden = true;
    if (observer) observer.disconnect();
    clearTimeout(timer);
    ranges = []; region = null;
    if (hasHL) { CSS.highlights.delete('find-match'); CSS.highlights.delete('find-current'); }
    const r = restore; restore = null;
    if (r && r.isConnected && r.focus) r.focus();
  };

  document.addEventListener('keydown', (e) => {
    if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f') return;
    const from = last && last.isConnected ? last : document.activeElement;
    const el = from && from.nodeType === 1 ? from : null;
    // Monaco and xterm have their own find bars.
    if (el && el.closest('.monaco-editor, .xterm') && !(bar && !bar.hidden && bar.contains(document.activeElement))) return;
    e.preventDefault();
    F.open(from);
  }, true);

  // Moving to another view, tab or project leaves the block the bar was searching.
  for (const ev of ['view', 'tab', 'project']) App.listen(ev, () => F.close());
  addEventListener('resize', () => { if (bar && !bar.hidden && region) place(); });
})();
