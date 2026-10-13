// Turn a saved chat into the rows and connections used by the overview view.
(function () {
  const time = (value) => Number.isFinite(value) ? value : null;
  const number = (value) => Number.isFinite(value) ? value : 0;
  const firstLine = (value, limit) => String(value || '').split(/\r?\n/, 1)[0].replace(/^#+\s*/, '').trim().slice(0, limit);
  // The orchestrate gates are asked with AskUserQuestion; they are told apart by "Gate 1" / "Gate 2" in the header or the question.
  const question = (it, header) => {
    const re = new RegExp('\\b' + header.replace(/\s+/, '\\s*') + '\\b', 'i');
    return (Array.isArray(it.questions) ? it.questions : []).find((q) => q && (re.test(q.header || '') || re.test(q.question || '')));
  };

  function approved(it, q) {
    if (!it.answers || !q) return false;
    const answer = it.answers[q.question];
    return typeof answer === 'string' && answer.trim() !== '' && !/^(change|cancel|deny|denied|reject|leave|no\b)/i.test(answer.trim());
  }

  function totals(chat, items) {
    const total = { in: 0, out: 0, cr: 0, cw: 0, costUsd: 0 };
    if (chat.usage) {
      const u = chat.usage;
      total.in = number(u.input); total.out = number(u.output);
      total.cr = number(u.cacheRead); total.cw = number(u.cacheWrite);
      total.costUsd = number(u.costUsd);
    } else {
      for (const it of items) if (it && it.tok) {
        for (const k of ['in', 'out', 'cr', 'cw']) total[k] += number(it.tok[k]);
      }
    }
    return total;
  }

  function buildOverview(chat) {
    chat = chat || {};
    const items = Array.isArray(chat.items) ? chat.items : [];
    const nodes = [], edges = [], boxes = [], gaps = {};
    const main = [], jobs = [], before = [0];
    let previousMain = null, previousAt = null;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it && (it.t === 'user' || it.t === 'text' || it.t === 'job')) {
        const job = it.t === 'job';
        const at = job ? (time(it.startedAt) ?? time(it.at)) : time(it.at);
        const label = job ? firstLine(it.title || it.role || it.engine || 'Job', 80)
          : firstLine(it.text, 80) || (it.t === 'user' && Array.isArray(it.files) && it.files.length ? `${it.files.length} file(s)` : it.t === 'user' ? 'User' : 'Agent');
        const node = { id: job ? (it.id || `job-${i}`) : `item-${i}`, lane: 0, row: nodes.length,
          kind: job ? 'job' : it.t === 'user' ? 'user' : 'agent', at, label, tok: it.tok || null };
        if (job && it.status) node.status = it.status;
        if (at !== null && previousAt !== null && at - previousAt > 5 * 60 * 1000) gaps[node.row] = at - previousAt;
        previousAt = at;
        nodes.push(node);
        if (job) jobs.push({ index: i, item: it, node, fork: previousMain });
        else {
          if (previousMain) edges.push({ from: previousMain.id, to: node.id, kind: 'main' });
          previousMain = node;
          main.push({ index: i, node });
        }
      }
      before.push(nodes.length);
    }

    const occupied = [];
    for (const job of jobs) {
      const { item, node, index } = job;
      const endedAt = time(item.endedAt);
      const ended = endedAt !== null && item.status !== 'running';
      const merge = ended && !['failed', 'cancelled', 'held', 'lost', 'stale'].includes(item.status)
        ? main.find((m) => m.index > index && m.node.at !== null && m.node.at >= endedAt)
        : null;
      let lane = 1;
      while (occupied[lane] > node.row) lane++;
      node.lane = lane;
      if (job.fork) edges.push({ from: job.fork.id, to: node.id, kind: 'fork' });
      if (merge) edges.push({ from: node.id, to: merge.node.id, kind: 'merge' });
      const endNode = ended && !merge ? nodes.find((n) => n.row > node.row && n.at !== null && n.at >= endedAt) : null;
      occupied[lane] = merge ? merge.node.row : endNode ? endNode.row : Infinity;
    }

    // Row bounds are half-open: a hidden approval begins at the next visible row.
    let open = null;
    const close = (end) => {
      if (!open) return;
      const startRow = before[open.start], endRow = before[end];
      const lanes = Math.max(1, ...nodes.slice(startRow, endRow).map((n) => n.lane + 1));
      boxes.push({ startRow, endRow, title: open.title, lanes });
      open = null;
    };
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it) continue;
      if (open && ((open.type === 'native' && it.t === 'user') ||
        (open.type === 'gate' && (question(it, 'Gate 2') || it.t === 'user')))) {
        close(it.t === 'user' ? i : i + 1);
      }
      const native = it.t === 'perm' && it.tool === 'ExitPlanMode' && it.decided === 'allow';
      const gate = it.t === 'ask' && question(it, 'Gate 1');
      if (native || (gate && approved(it, gate))) {
        close(i);
        open = { start: i + 1, type: native ? 'native' : 'gate',
          title: firstLine(native ? it.input && it.input.plan : gate.question, 60) };
      }
    }
    close(items.length);

    return { lanes: Math.max(1, ...nodes.map((n) => n.lane + 1)), nodes, edges, boxes,
      totals: totals(chat, items), gaps };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { buildOverview };
  if (typeof window !== 'undefined') window.OverviewModel = { buildOverview };
})();
