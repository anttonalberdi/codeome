// Session statistics: what the agent chats used over the last days (main/stats.js), in
// a tab. Every finished turn is kept in ~/.codeome/stats/turns.jsonl on this Mac.
(function () {
  const h = App.h;
  const S = {};
  App.views.stats = S;
  const RANGES = [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last year']];
  const tok = App.fmtTokens;
  const per = (a, k) => (a.turns ? a[k] / a.turns : 0);

  S.open = () => {
    let reload = () => {};
    return App.views.editor.openCustom({
      key: 'stats', title: 'Session statistics', badge: 'Agent', onActivate: () => reload(),
      render: (el) => {
        let days = Number(localStorage.getItem('codeome.stats.days')) || 30;
        const body = h('div.stats-page');
        reload = async () => {
          const r = await codeome.stats.get(days);
          body.innerHTML = '';
          body.append(...(r.error ? [h('div.note.error', r.error)] : draw(r)));
        };
        el.append(h('div.toolbar.st-bar',
          h('span.hint.grow', 'Token use of the agent chats · kept on this Mac only'),
          h('select', { 'aria-label': 'Period', onchange: (e) => { days = Number(e.target.value); try { localStorage.setItem('codeome.stats.days', days); } catch {} reload(); } },
            RANGES.map(([v, label]) => h('option', { value: v, selected: v === days }, label))),
          h('button.btn.small', { onclick: () => reload() }, 'Refresh')), body);
        reload();
      }
    });
  };

  // cols: [label, 'n' for a number column | 'wide' | '']; rows: cells in the same order.
  function table(cols, rows) {
    return h('table.st-table',
      h('thead', h('tr', cols.map(([label, cls]) => h('th' + (cls ? '.' + cls : ''), label)))),
      h('tbody', rows.map((r) => h('tr', r.map((c, i) => h('td' + (cols[i][1] ? '.' + cols[i][1] : ''), c))))));
  }
  const bar = (v, max) => h('span.u-bar', h('i', { style: { width: (max ? Math.max(1, v / max * 100) : 0) + '%' } }));
  const sec = (title, hint, ...kids) => h('div.st-sec', h('h3', title), hint ? h('p.hint', hint) : null, ...kids);
  const tile = (value, label, title) => h('div.st-tile', { title }, h('b', value), h('span', label));

  // What the numbers say about when to start a new chat.
  function notes(r, k) {
    const out = [];
    const merge = (a, b) => ({ turns: a.turns + b.turns, [k]: a[k] + b[k] });
    const low = merge(r.fill[0], r.fill[1]), high = merge(r.fill[2], r.fill[3]);
    const show = (v) => (k === 'costUsd' ? App.fmtUsd(v) : tok(v) + ' tokens');
    if (low.turns >= 5 && high.turns >= 5 && per(low, k) > 0) {
      const x = per(high, k) / per(low, k);
      out.push(x >= 1.15
        ? `A turn that starts with the context more than half full uses ${x.toFixed(1)}× as much as one that starts below half (${show(per(high, k))} against ${show(per(low, k))} a turn). A new chat for each new task keeps turns at the cheaper end.`
        : `Turns in full chats use about as much as turns in fresh ones here (${show(per(high, k))} against ${show(per(low, k))} a turn), so chat length is not what drives your use.`);
    } else out.push('Once there are at least five turns both below and above half-full context, this compares what a turn uses in each.');
    const t = r.total;
    if (t.compacted) out.push(`${t.compacted} of ${t.sessions} chats filled their context window and were summarised to make room.`);
    if (t.tokens) out.push(`${Math.round(t.cacheRead / t.tokens * 100)}% of the tokens were read from the cache: the conversation so far, sent again with each request.`);
    return out;
  }

  function draw(r) {
    const t = r.total;
    if (!t.turns) return [h('div.chat-empty', h('h3', 'Nothing recorded in this period'), h('p', 'From now on, every turn of an agent chat is counted here: its tokens, how full the context was, and how long it took.'))];
    // Without Claude Code's price figure, tokens are compared instead.
    const k = t.costUsd > 0 ? 'costUsd' : 'tokens';
    const amount = (a) => (k === 'costUsd' ? App.fmtUsd(a.costUsd) : tok(a.tokens));
    const price = 'At API list prices. On a subscription nothing is charged; the figure weighs cached and new tokens the way your limits do.';
    const head = k === 'costUsd' ? 'At API prices' : 'Tokens';
    const max = (list, f) => Math.max(0, ...list.map(f));
    const fillMax = max(r.fill, (f) => per(f, k)), dayMax = max(r.byDay, (d) => d[k]);
    return [
      h('div.st-tiles',
        tile(String(t.sessions), t.sessions === 1 ? 'chat' : 'chats'),
        tile(String(t.turns), `turns · ${(t.turns / t.sessions).toFixed(1)} a chat`),
        tile(tok(t.tokens), 'tokens processed', `New input ${tok(t.input)} · written to the cache ${tok(t.cacheWrite)} · read from the cache ${tok(t.cacheRead)} · replies ${tok(t.output)}. Subagents are counted; Codex jobs are not.`),
        tile(tok(t.output), 'tokens of replies'),
        k === 'costUsd' ? tile(App.fmtUsd(t.costUsd), 'at API prices', price) : null),
      sec('What this says', null, h('ul.st-notes', notes(r, k).map((x) => h('li', x)))),
      sec('By how full the context was', 'Where the turn started, as a share of the context window.',
        table([['Context at the start', ''], ['Turns', 'n'], ['Tokens a turn', 'n'], [head + ' a turn', 'n'], ['', '']],
          r.fill.map((f) => [`${f.from}–${f.to}%`, String(f.turns), f.turns ? tok(per(f, 'tokens')) : '–', f.turns ? (k === 'costUsd' ? App.fmtUsd(per(f, k)) : tok(per(f, k))) : '–', bar(per(f, k), fillMax)]))),
      sec('By day', null,
        table([['Day', ''], ['Turns', 'n'], ['Tokens', 'n'], ['Replies', 'n'], [head, 'n'], ['', '']],
          r.byDay.map((d) => [new Date(d.day + 'T12:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }), String(d.turns), tok(d.tokens), tok(d.output), amount(d), bar(d[k], dayMax)]))),
      sec('By project', null,
        table([['Project', 'wide'], ['Chats', 'n'], ['Turns', 'n'], ['Tokens', 'n'], [head, 'n']],
          r.byProject.map((p) => [h('span', { title: App.tildify(p.project) }, App.basename(p.project)), String(p.sessions), String(p.turns), tok(p.tokens), amount(p)]))),
      sec('Chats', r.sessions.length > 50 ? 'The 50 used most recently.' : null,
        table([['Chat', 'wide'], ['Project', ''], ['Turns', 'n'], ['Tokens', 'n'], [head, 'n'], ['Fullest', 'n'], ['Summarised', 'n'], ['Last used', '']],
          r.sessions.slice(0, 50).map((s) => [s.title || h('span.hint', 'Deleted chat'), App.basename(s.project), String(s.turns), tok(s.tokens), amount(s),
            s.peakPct == null ? '–' : s.peakPct + '%', s.compactions ? String(s.compactions) + '×' : '', App.fmtAgo(s.last)]))),
      h('div.hint', 'Kept in ' + App.tildify(r.file) + ', one line a turn. Terminal sessions and Codex jobs are not counted.')
    ];
  }
})();
