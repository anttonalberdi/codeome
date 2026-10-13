// A chat's visible turns and jobs, arranged as a vertical time tree.
(function () {
  const h = App.h;
  const ns = 'http://www.w3.org/2000/svg';
  const rowHeight = 34, laneWidth = 66, trunkX = 150;
  const svgEl = (tag, attrs = {}, value) => {
    const el = document.createElementNS(ns, tag);
    for (const [key, val] of Object.entries(attrs)) el.setAttribute(key, String(val));
    if (value != null) el.textContent = String(value);
    return el;
  };
  const short = (value, limit) => {
    const s = String(value || '').replace(/\s+/g, ' ').trim();
    return s.length > limit ? s.slice(0, limit - 1) + '…' : s;
  };
  const gapLabel = (ms) => ms >= 60 * 60 * 1000 ? `+${Math.round(ms / 3600000)}h` : `+${Math.round(ms / 60000)}m`;
  const dateKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const clock = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const count = (n) => Number.isFinite(n) ? n : 0;
  const tokenTip = (t) => `Input ${App.fmtTokens(t.in)} · Output ${App.fmtTokens(t.out)} · Cache read ${App.fmtTokens(t.cr)} · Cache write ${App.fmtTokens(t.cw)}`;

  function draw(chat, head, scroll) {
    const view = window.OverviewModel.buildOverview(chat);
    const { nodes, edges, boxes, gaps, totals } = view;
    const items = Array.isArray(chat.items) ? chat.items : [];
    const byJob = new Map(items.flatMap((it, i) => it && it.t === 'job' ? [[it.id || `job-${i}`, it]] : []));
    const turns = chat.usage && Number.isFinite(chat.usage.turns) ? chat.usage.turns : nodes.filter((n) => n.kind === 'user').length;
    const hasTokens = !!chat.usage || nodes.some((n) => n.tok);
    head.replaceChildren(
      h('h2', chat.title || 'Chat'),
      h('span', `${turns} ${turns === 1 ? 'turn' : 'turns'}`),
      h('span', `${hasTokens ? App.fmtTokens(totals.in + totals.out + totals.cr + totals.cw) : '–'} tokens`),
      h('span', `${chat.usage ? App.fmtUsd(totals.costUsd) : '–'} cost`));

    if (!nodes.length) { scroll.replaceChildren(h('div.chat-empty', 'No turns to show yet.')); return; }

    const firstInBox = new Set(boxes.filter((b) => b.endRow > b.startRow).map((b) => b.startRow));
    const y = [];
    let bottom = 18, lastDate = null;
    for (const n of nodes) {
      bottom += rowHeight + (gaps[n.row] ? 24 : 0) + (firstInBox.has(n.row) ? 18 : 0);
      if (n.at !== null) {
        const date = dateKey(new Date(n.at));
        if (date !== lastDate) bottom += 14;
        lastDate = date;
      }
      y[n.row] = bottom;
    }
    const height = bottom + 34;
    const x = (lane) => trunkX + lane * laneWidth;
    const labelX = x(view.lanes - 1) + 25;
    const tokenX = labelX + 340;
    const width = tokenX + 80;
    const svg = svgEl('svg', { class: 'ov-tree', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Chat overview time tree' });
    // The app's global svg rule sizes icons at 18px; the tree sets its own size.
    svg.setAttribute('style', `width:${width}px;height:${height}px`);
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const merges = new Map(edges.filter((e) => e.kind === 'merge').map((e) => [e.from, nodeById.get(e.to)]));

    // Boxes sit behind every connection and dot.
    for (const b of boxes) {
      if (b.endRow <= b.startRow) continue;
      const top = y[b.startRow] - 24, end = y[b.endRow - 1] + 17;
      svg.append(svgEl('rect', { class: 'ov-box', x: trunkX - 24, y: top, width: tokenX - trunkX + 14, height: end - top, rx: 8 }));
      svg.append(svgEl('text', { class: 'ov-box-title', x: trunkX - 14, y: top + 14 }, short(b.title || 'Plan', 60)));
    }

    for (const e of edges) {
      const from = nodeById.get(e.from), to = nodeById.get(e.to);
      if (!from || !to) continue;
      const x1 = x(from.lane), x2 = x(to.lane), y1 = y[from.row], y2 = y[to.row];
      if (e.kind === 'main') svg.append(svgEl('path', { class: 'ov-main', d: `M${x1} ${y1} L${x2} ${y2}` }));
      else if (e.kind === 'fork') svg.append(svgEl('path', { class: 'ov-fork', d: `M${x1} ${y1} C${x1} ${y2}, ${x2} ${y1}, ${x2} ${y2}` }));
    }

    for (const n of nodes) {
      if (n.kind !== 'job') continue;
      const target = merges.get(n.id);
      const job = byJob.get(n.id);
      const endedAt = job && Number.isFinite(job.endedAt) ? job.endedAt : null;
      const after = endedAt === null ? null : nodes.find((later) => later.row > n.row && later.at !== null && later.at >= endedAt);
      const live = n.status === 'running';
      const end = target ? y[target.row] - 12 : live ? height - 17 : after ? y[after.row] - 12 : y[n.row] + 18;
      if (end > y[n.row]) svg.append(svgEl('path', { class: 'ov-branch', d: `M${x(n.lane)} ${y[n.row]} V${end}` }));
      if (target) svg.append(svgEl('path', { class: 'ov-merge', d: `M${x(n.lane)} ${end} C${x(n.lane)} ${y[target.row]}, ${x(target.lane)} ${end}, ${x(target.lane)} ${y[target.row]}` }));
      if (live) svg.append(svgEl('circle', { class: 'ov-live-end', cx: x(n.lane), cy: end, r: 5 }));
    }

    lastDate = null;
    for (const n of nodes) {
      const ny = y[n.row], nx = x(n.lane);
      if (gaps[n.row]) svg.append(svgEl('text', { class: 'ov-gap', x: trunkX + 12, y: ny - 22 }, gapLabel(gaps[n.row])));
      if (n.at !== null) {
        const d = new Date(n.at), key = dateKey(d);
        if (key !== lastDate) svg.append(svgEl('text', { class: 'ov-date', x: 12, y: ny - 10 }, d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })));
        svg.append(svgEl('text', { class: 'ov-time', x: 12, y: ny + 4 }, clock(d)));
        lastDate = key;
      }
      const job = n.kind === 'job' ? byJob.get(n.id) : null;
      const item = n.kind === 'job' ? job : items[Number(n.id.slice(5))];
      const full = short(item && (item.t === 'job' ? item.title || item.role || item.engine : item.text) || n.label, 300);
      const cls = n.kind === 'job' ? (job && job.engine === 'codex' ? 'ov-codex' : 'ov-claude') : `ov-${n.kind}`;
      const group = svgEl('g', { class: `ov-node ${cls}${job ? ' ov-clickable' : ''}` });
      if (job) group.setAttribute('data-job-id', n.id);
      group.append(svgEl('circle', { class: 'ov-dot', cx: nx, cy: ny, r: n.kind === 'job' ? 7 : 5 }));
      if (n.kind === 'job' && ['failed', 'cancelled', 'held', 'lost', 'stale'].includes(n.status)) {
        group.append(svgEl('path', { class: 'ov-x', d: `M${nx - 3} ${ny - 3} L${nx + 3} ${ny + 3} M${nx + 3} ${ny - 3} L${nx - 3} ${ny + 3}` }));
      }
      group.append(svgEl('text', { class: 'ov-label', x: labelX, y: ny + 4 }, short(n.label, 52)));
      group.append(svgEl('title', {}, full));
      svg.append(group);
      const tokens = n.tok;
      const amount = tokens ? App.fmtTokens(count(tokens.in) + count(tokens.out)) : '–';
      const token = svgEl('text', { class: 'ov-tokens', x: tokenX, y: ny + 4 }, amount);
      if (tokens) token.append(svgEl('title', {}, tokenTip(tokens)));
      svg.append(token);
    }
    scroll.replaceChildren(svg);
  }

  App.views.overview = {
    open(chat) {
      let redraw = () => {};
      return App.views.editor.openCustom({
        key: 'chat-overview:' + chat.id, title: 'Overview: ' + (chat.title || 'Chat'), badge: 'Agent',
        onActivate: () => redraw(),
        render(el) {
          const head = h('div.ov-head');
          const scroll = h('div.ov-scroll');
          const page = h('div.overview-page', head, scroll);
          scroll.addEventListener('click', (e) => {
            const target = e.target.closest('[data-job-id]');
            if (!target) return;
            const job = chat.items.find((it, i) => it && it.t === 'job' && (it.id || `job-${i}`) === target.getAttribute('data-job-id'));
            if (job) App.views.chat.openJob(job);
          });
          el.append(page);
          redraw = () => draw(chat, head, scroll);
          redraw();
        }
      });
    }
  };
})();
