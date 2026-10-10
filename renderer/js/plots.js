// Plots: figures drawn in R consoles on this Mac or the HPC. plots.R (in main/r)
// draws them off-screen, saves each page as a recording plus a PNG, and announces
// it with an escape sequence the terminal hands here (OSC 7337). The canvas, fit to
// the panel or a set size in in / cm / mm / px at a dpi, is what new plots are drawn
// at and what exports use. Changing it redraws the plot from its recording in a
// separate R process, so the console is never interrupted.
(function () {
  const h = App.h;
  const P = { list: [], cur: {}, sessions: {}, viewers: [], zoom: 'fit', seq: 0, last: { w: 672, h: 480 } };
  App.views.plots = P;
  const cfg = () => App.cfg.plots;

  // ---------- canvas ----------
  const PER_IN = { in: 1, cm: 2.54, mm: 25.4 };
  P.toIn = (v, unit, dpi) => (unit === 'px' ? v / dpi : v / PER_IN[unit]);
  P.fromIn = (v, unit, dpi) => (unit === 'px' ? v * dpi : v * PER_IN[unit]);
  P.PRESETS = [
    { id: 'fit', label: 'Fit to panel' },
    { id: 'r', label: 'R default · 7 × 7 in', w: 7, h: 7, unit: 'in' },
    { id: 'col1', label: 'Journal, 1 column · 89 mm', w: 89, h: 70, unit: 'mm' },
    { id: 'col15', label: 'Journal, 1.5 columns · 120 mm', w: 120, h: 90, unit: 'mm' },
    { id: 'col2', label: 'Journal, 2 columns · 183 mm', w: 183, h: 110, unit: 'mm' },
    { id: 'slide', label: 'Slide 16:9 · 10 × 5.63 in', w: 10, h: 5.625, unit: 'in' },
    { id: 'square', label: 'Square · 5 × 5 in', w: 5, h: 5, unit: 'in' },
    { id: 'a4', label: 'A4 page · 210 × 297 mm', w: 210, h: 297, unit: 'mm' },
    { id: 'custom', label: 'Custom size' }
  ];
  const FORMATS = [
    { id: 'png', label: 'PNG', raster: true }, { id: 'pdf', label: 'PDF' }, { id: 'svg', label: 'SVG' },
    { id: 'tiff', label: 'TIFF', raster: true }, { id: 'jpeg', label: 'JPEG', raster: true, ext: 'jpg' }, { id: 'eps', label: 'EPS' }
  ];
  const FMT = Object.fromEntries(FORMATS.map((f) => [f.id, f]));
  const extOf = (f) => f.ext || f.id;
  // 3 decimals at most, no trailing zeros: what is written to R and shown in fields.
  P.num = (x, d = 3) => String(Math.round(Number(x) * 10 ** d) / 10 ** d);
  const dpr = () => Math.max(1, Math.min(3, window.devicePixelRatio || 1));

  // The canvas in inches with the export dpi. Fit takes the panel's size at 96 px per inch.
  P.canvas = () => {
    const c = cfg();
    if (c.fit) { const b = P.box(); return { w: b.w / 96, h: b.h / 96, dpi: c.dpi, bg: c.bg }; }
    return { w: P.toIn(c.w, c.unit, c.dpi), h: P.toIn(c.h, c.unit, c.dpi), dpi: c.dpi, bg: c.bg };
  };
  // What the panel shows is the canvas at a resolution that fills it sharply, not the export dpi.
  P.viewRes = (cv, box, ratio, zoom) => {
    if (zoom === 'actual') return Math.round(96 * ratio);
    const fill = Math.min(box.w / cv.w, box.h / cv.h) * ratio;
    return Math.max(24, Math.min(Math.round(fill), Math.round(4 * 96 * ratio)));
  };
  P.key = (v) => `${P.num(v.w)}x${P.num(v.h)}@${Math.round(v.res)}-${v.bg}`;
  const want = () => { const cv = P.canvas(); return { w: cv.w, h: cv.h, bg: cv.bg, res: P.viewRes(cv, P.box(), dpr(), cfg().fit ? 'fit' : P.zoom) }; };
  P.presetOf = (c) => (c.fit ? 'fit' : (P.PRESETS.find((p) => p.w === Number(c.w) && p.h === Number(c.h) && p.unit === c.unit) || { id: 'custom' }).id);

  // The viewer on screen (the tab if it is showing, else the sidebar) sets the fit size.
  P.primary = () => P.viewers.filter((v) => v.stage.isConnected && v.stage.offsetParent).sort((a, b) => b.large - a.large)[0];
  P.box = () => {
    const v = P.primary();
    if (v) { const r = v.stage.getBoundingClientRect(); if (r.width > 40 && r.height > 40) P.last = { w: Math.floor(r.width) - (cfg().fit ? 0 : 24), h: Math.floor(r.height) - (cfg().fit ? 0 : 24) }; }
    return P.last;
  };

  // ---------- messages from R ----------
  // hello;<version>;<session dir>  and  plot;<id>;<replace>;<w>;<h>;<res>;<bg>;<ok>;<session dir>
  P.parseOsc = (data) => {
    const f = String(data).split(';');
    if (f[0] === 'hello' && f.length >= 3) return { type: 'hello', version: Number(f[1]), dir: f.slice(2).join(';') };
    if (f[0] === 'plot' && f.length >= 9) {
      const m = { type: 'plot', id: Number(f[1]), replace: f[2] === '1', w: Number(f[3]), h: Number(f[4]), res: Number(f[5]), bg: f[6], ok: f[7] === '1', dir: f.slice(8).join(';') };
      return Number.isInteger(m.id) && m.id > 0 && m.w > 0 && m.h > 0 ? m : null;
    }
    return null;
  };

  P.osc = (t, data) => {
    const m = P.parseOsc(data);
    if (!m) return;
    const where = /^(hpc|agent-hpc)/.test(t.spec.kind) ? 'hpc' : 'local';
    if (m.type === 'hello') {
      P.sessions[t.id] = { where, dir: m.dir };
      t.plots = true;
      pushCanvas(true);
      return;
    }
    let e = P.list.find((x) => x.tid === t.id && x.dir === m.dir && x.id === m.id);
    if (e && m.replace) { e.rev++; e.view = null; }
    else if (!e) {
      const n = P.list.filter((x) => x.project === t.project).reduce((a, x) => Math.max(a, x.n), 0) + 1;
      e = { uid: ++P.seq, n, tid: t.id, project: t.project, where, dir: m.dir, id: m.id, rev: 0, title: t.title, time: Date.now(), token: 0 };
      P.list.push(e);
    }
    P.cur[t.project] = e;
    if (t.project === App.project && cfg().show !== false) reveal();
    snapshot(e, m);
  };

  // Brings Plots up, unless someone is typing in the sidebar.
  function reveal() {
    if (App.currentView === 'plots') return;
    const a = document.activeElement;
    if (a && a.closest('#sidebar') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    if (P.viewers.some((v) => v.large && v.stage.offsetParent)) return;
    App.setView('plots');
  }

  // The PNG R drew right away; HPC ones are fetched first.
  async function snapshot(e, m) {
    const rev = e.rev;
    let src = m.dir + '/' + m.id + '.png';
    if (m.ok && e.where === 'hpc') { const r = await codeome.preview.fetchRemote(src); src = r.error ? null : r.local; }
    if (rev !== e.rev) return;
    if (m.ok && src) {
      e.snap = { key: P.key(m), src: 'file://' + src + '?v=' + (++P.seq) };
      e.thumb = e.snap.src;
    }
    show(e);
  }

  // Shows the plot at the current canvas, redrawing it from its recording if needed.
  async function show(e) {
    if (!e) return paintAll();
    const v = want(), k = P.key(v);
    if (e.view && e.view.key === k) return paintAll();
    if (e.snap && e.snap.key === k) { e.view = e.snap; e.error = null; return paintAll(); }
    const token = ++e.token;
    e.busy = true; paintAll();
    const r = await codeome.plots.render({ where: e.where, dir: e.dir, id: e.id, rev: e.rev, fmt: 'png', w: v.w, h: v.h, res: v.res, bg: v.bg });
    if (token !== e.token) return;
    e.busy = false;
    if (r.error) e.error = r.error;
    else { e.view = { key: k, src: 'file://' + r.local + '?v=' + (++P.seq) }; e.error = null; if (!e.thumb) e.thumb = e.view.src; }
    paintAll();
  }
  P.current = () => { const e = P.cur[App.project]; return e && P.list.includes(e) ? e : P.visible().slice(-1)[0] || null; };
  P.visible = () => P.list.filter((e) => e.project === App.project);

  // New plots in every session are drawn at the panel's canvas: "w h res bg".
  let canvasTimer = null;
  function pushCanvas(now) {
    clearTimeout(canvasTimer);
    const go = () => {
      const v = want(), text = `${P.num(v.w)} ${P.num(v.h)} ${Math.round(v.res)} ${v.bg}`;
      if (text === P.canvasText) return;
      P.canvasText = text;
      const hosts = new Set(Object.values(P.sessions).map((s) => s.where));
      for (const w of hosts) if (w === 'local' || App.hpcConnected) codeome.plots.canvas(w, text);
    };
    if (now) { P.canvasText = null; go(); } else canvasTimer = setTimeout(go, 300);
  }
  // A canvas change: redraw what is showing and tell the consoles.
  let redrawTimer = null;
  function changed({ save = true, wait = 250 } = {}) {
    if (save) App.saveConfig();
    syncForms(); paintAll();
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => { show(P.current()); pushCanvas(); }, wait);
  }

  // ---------- actions ----------
  P.select = (e) => { if (!e) return; P.cur[App.project] = e; show(e); };
  P.step = (d) => { const vis = P.visible(), i = vis.indexOf(P.current()); P.select(vis[i + d]); };
  P.remove = (e = P.current()) => {
    if (!e) return;
    const vis = P.visible(), i = vis.indexOf(e);
    P.list.splice(P.list.indexOf(e), 1);
    P.cur[App.project] = vis[i + 1] || vis[i - 1] || null;
    show(P.current());
  };
  P.clear = async () => {
    const vis = P.visible();
    if (vis.length > 1 && !(await App.confirm(`Remove all ${vis.length} plots?`, 'They go from this list. The plots in R stay as they are.', 'Remove all', true))) return;
    P.list = P.list.filter((e) => e.project !== App.project);
    delete P.cur[App.project];
    paintAll();
  };

  // Export at the canvas and dpi, to a file picked on this Mac.
  P.export = async (fmtId = cfg().format, e = P.current()) => {
    if (!e) return;
    const f = FMT[fmtId] || FMT.pdf, cv = P.canvas();
    const out = await codeome.dialog.save({ defaultPath: App.join(e.project || '~', `plot-${e.n}.${extOf(f)}`), filters: [{ name: f.label, extensions: [extOf(f)] }] });
    if (!out) return;
    if (cfg().format !== f.id) { cfg().format = f.id; App.saveConfig(); syncForms(); }
    const note = App.toast(`Exporting ${App.basename(out)}…`, { ms: 60000 });
    const r = await codeome.plots.render({ where: e.where, dir: e.dir, id: e.id, rev: e.rev, fmt: f.id, w: cv.w, h: cv.h, res: cv.dpi, bg: cv.bg, out });
    note.remove();
    if (r.error) return App.err('Export failed: ' + r.error);
    App.toast(`Saved ${App.basename(out)}.`, { action: { label: 'Show in Finder', run: () => codeome.shell.reveal(out) } });
    App.emit('local-changed');
  };
  P.copy = async (e = P.current()) => {
    if (!e) return;
    const cv = P.canvas();
    const r = await codeome.plots.render({ where: e.where, dir: e.dir, id: e.id, rev: e.rev, fmt: 'png', w: cv.w, h: cv.h, res: cv.dpi, bg: cv.bg });
    if (r.error) return App.err('Copy failed: ' + r.error);
    const c = await codeome.plots.copy(r.local);
    if (c.error) return App.err(c.error);
    App.toast(`Copied the plot as a ${pixels(cv)} PNG.`);
  };
  const pixels = (cv) => `${Math.round(cv.w * cv.dpi)} × ${Math.round(cv.h * cv.dpi)} px`;

  // R code that saves a plot like the current export settings.
  P.code = (kind, c = cfg(), cv = P.canvas()) => {
    const f = FMT[c.format] || FMT.pdf, file = `plot.${extOf(f)}`;
    const unit = c.fit ? 'in' : c.unit;
    const W = P.num(P.fromIn(cv.w, unit, cv.dpi), 2), H = P.num(P.fromIn(cv.h, unit, cv.dpi), 2);
    const wi = P.num(cv.w, 2), hi = P.num(cv.h, 2);
    const bg = cv.bg === 'transparent' ? ', bg = "transparent"' : '';
    if (kind === 'ggsave') return `ggsave("${file}", width = ${W}, height = ${H}, units = "${unit}"${f.raster ? `, dpi = ${cv.dpi}` : ''}${bg})`;
    const open = {
      png: `png("${file}", width = ${W}, height = ${H}, units = "${unit}", res = ${cv.dpi}${bg})`,
      tiff: `tiff("${file}", width = ${W}, height = ${H}, units = "${unit}", res = ${cv.dpi}, compression = "lzw"${bg})`,
      jpeg: `jpeg("${file}", width = ${W}, height = ${H}, units = "${unit}", res = ${cv.dpi}, quality = 95)`,
      pdf: `pdf("${file}", width = ${wi}, height = ${hi}${bg})`,
      svg: `svg("${file}", width = ${wi}, height = ${hi}${bg})`,
      eps: `postscript("${file}", width = ${wi}, height = ${hi}, horizontal = FALSE, onefile = FALSE, paper = "special"${bg})`
    }[f.id];
    return `${open}\n# ... your plot ...\ndev.off()`;
  };

  P.openTab = () => App.views.editor.openCustom({
    key: 'plots', title: 'Plots', badge: 'R',
    render: (el, tab) => {
      const v = mount(el, { large: true });
      tab.layout = () => v.resized();
      tab.onClose = () => { P.viewers = P.viewers.filter((x) => x !== v); v.ro.disconnect(); changed({ save: false }); };
    },
    onActivate: () => changed({ save: false })
  });

  function moreMenu(v) {
    const e = P.current(), c = cfg();
    return [
      { label: 'Copy image', disabled: !e, run: () => P.copy() },
      { label: 'Copy ggsave() code', run: () => { navigator.clipboard.writeText(P.code('ggsave')); App.toast('Copied: ' + P.code('ggsave')); } },
      { label: `Copy ${FMT[c.format].label} device code`, run: () => { navigator.clipboard.writeText(P.code('device')); App.toast('Copied the device code.'); } },
      '-',
      v.large ? { label: 'Close the tab', run: () => { const t = App.views.editor.tabs.find((x) => x.key === 'plots' && x.project === App.project); if (t) App.views.editor.close(t.id); } }
        : { label: 'Open in a tab', run: () => P.openTab() },
      { label: 'Remove plot', disabled: !e, key: '⌫', run: () => P.remove() },
      { label: 'Remove all plots', disabled: !e, run: () => P.clear() },
      '-',
      { label: (c.capture !== false ? '✓ ' : '') + 'Show plots from new R consoles here', run: () => { c.capture = c.capture === false; App.saveConfig(); } },
      { label: (c.show !== false ? '✓ ' : '') + 'Switch to Plots when a plot is drawn', run: () => { c.show = c.show === false; App.saveConfig(); } }
    ];
  }

  // ---------- viewers: the sidebar view, and optionally a tab ----------
  const ICON = {
    prev: '<svg viewBox="0 0 16 16"><path d="m10 3.5-4.5 4.5 4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    next: '<svg viewBox="0 0 16 16"><path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    swap: '<svg viewBox="0 0 16 16"><path d="M3 5.5h9.5L10 3M13 10.5H3.5L6 13" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    zoom: '<svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m10.2 10.2 3.3 3.3" stroke="currentColor" stroke-width="1.6"/></svg>',
    tab: '<svg viewBox="0 0 16 16"><path d="M9 2.5h4.5V7M13.5 2.5 8 8M11.5 9.5v4h-9v-9h4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>'
  };
  const ibtn = (icon, title, onclick) => h('button.icon-btn.small', { title, 'aria-label': title, onclick, html: ICON[icon] });

  function mount(host, { large = false } = {}) {
    const v = { large };
    v.count = h('span.plot-count');
    v.prev = ibtn('prev', 'Previous plot (←)', () => P.step(-1));
    v.next = ibtn('next', 'Next plot (→)', () => P.step(1));
    v.zoomBtn = ibtn('zoom', 'Actual size / fit', () => { P.zoom = P.zoom === 'fit' ? 'actual' : 'fit'; changed({ save: false, wait: 0 }); });
    const bar = h('div.plot-bar',
      large ? h('b.plot-h', 'Plots') : h('h2.plot-h', 'Plots'), v.prev, v.count, v.next, h('span.grow'), v.zoomBtn,
      large ? null : ibtn('tab', 'Open in a tab', () => P.openTab()),
      App.iconBtn('dots', 'More', (ev) => App.menuAt(ev.currentTarget, moreMenu(v))));
    v.img = h('img', { alt: '', draggable: 'false' });
    v.frame = h('div.plot-frame', v.img);
    v.busy = h('div.plot-busy', { hidden: true }, h('span.spinner'), ' Redrawing…');
    v.msg = h('div.plot-msg', { hidden: true });
    v.stage = h('div.plot-stage', { tabindex: '0', 'aria-label': 'Plot', onkeydown: (ev) => {
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); P.step(-1); }
      else if (ev.key === 'ArrowRight') { ev.preventDefault(); P.step(1); }
      else if (ev.key === 'Backspace' || ev.key === 'Delete') { ev.preventDefault(); P.remove(); }
    }, ondblclick: () => v.zoomBtn.click() }, v.frame, v.busy, v.msg);
    v.thumbs = h('div.plot-thumbs');
    const form = canvasForm(v);
    host.append(h('div.plots-view' + (large ? '.large' : ''), bar, v.stage, form, v.thumbs));
    v.resized = () => { if (cfg().fit || P.zoom === 'fit') changed({ save: false, wait: 350 }); };
    v.ro = new ResizeObserver(() => { if (v.stage.offsetParent) v.resized(); });
    v.ro.observe(v.stage);
    P.viewers.push(v);
    syncForms(); paint(v);
    return v;
  }

  function canvasForm(v) {
    const c = cfg();
    const field = (label, input, cls = '') => h('label.pf' + cls, h('span', label), input);
    v.preset = h('select', { 'aria-label': 'Canvas size', onchange: () => {
      const p = P.PRESETS.find((x) => x.id === v.preset.value), c2 = cfg();
      if (p.id === 'fit') c2.fit = true;
      else if (p.id === 'custom') { if (c2.fit) { const cv = P.canvas(); c2.w = Number(P.num(P.fromIn(cv.w, c2.unit, c2.dpi), 2)); c2.h = Number(P.num(P.fromIn(cv.h, c2.unit, c2.dpi), 2)); } c2.fit = false; }
      else Object.assign(c2, { fit: false, w: p.w, h: p.h, unit: p.unit });
      changed();
    } }, P.PRESETS.map((p) => h('option', { value: p.id }, p.label)));
    const size = (k) => h('input', { type: 'number', min: '0.1', step: 'any', 'aria-label': k === 'w' ? 'Width' : 'Height', oninput: () => {
      const n = Number(v[k].value); if (!(n > 0)) return;
      const c2 = cfg();
      // Typing a size leaves fit: the other side keeps what the panel had.
      if (c2.fit) { const cv = P.canvas(); c2.w = Number(P.num(P.fromIn(cv.w, c2.unit, c2.dpi), 2)); c2.h = Number(P.num(P.fromIn(cv.h, c2.unit, c2.dpi), 2)); c2.fit = false; }
      c2[k] = n; changed({ save: false, wait: 450 });
    }, onchange: () => App.saveConfig() });
    v.w = size('w'); v.h = size('h');
    v.unit = h('select', { 'aria-label': 'Units', onchange: () => {
      const c2 = cfg(), cv = P.canvas();
      c2.unit = v.unit.value;
      // Same physical size in the new unit.
      if (!c2.fit) { c2.w = Number(P.num(P.fromIn(cv.w, c2.unit, c2.dpi), 2)); c2.h = Number(P.num(P.fromIn(cv.h, c2.unit, c2.dpi), 2)); }
      changed();
    } }, ['in', 'cm', 'mm', 'px'].map((u) => h('option', { value: u }, u)));
    const swap = ibtn('swap', 'Swap width and height', () => {
      const c2 = cfg();
      if (c2.fit) return App.toast('Pick a size first: fit follows the panel.');
      [c2.w, c2.h] = [c2.h, c2.w]; changed();
    });
    v.dpi = h('input', { type: 'number', min: '30', max: '2400', step: '1', 'aria-label': 'Resolution in dpi', title: 'Resolution of PNG, TIFF and JPEG exports (and of sizes in px)',
      onchange: () => { const n = Math.round(Number(v.dpi.value)); if (n >= 30 && n <= 2400) { cfg().dpi = n; changed(); } else syncForms(); } });
    v.bg = h('select', { 'aria-label': 'Background', onchange: () => { cfg().bg = v.bg.value; changed(); } },
      h('option', { value: 'white' }, 'White'), h('option', { value: 'transparent' }, 'Transparent'));
    v.fmt = h('select', { 'aria-label': 'Export format', onchange: () => { cfg().format = v.fmt.value; App.saveConfig(); syncForms(); } },
      FORMATS.map((f) => h('option', { value: f.id }, f.label)));
    v.info = h('div.hint.plot-info');
    v.exportBtn = h('button.btn.small.primary', { onclick: () => P.export(v.fmt.value) }, 'Export…');
    return h('div.plot-form',
      h('div.row', v.preset),
      h('div.row.plot-size', field('W', v.w), h('span.x', '×'), field('H', v.h), v.unit, swap),
      h('div.row', field('dpi', v.dpi, '.dpi'), v.bg),
      h('div.row', v.fmt, v.exportBtn, h('button.btn.small', { title: 'Copy as PNG at this size and dpi', onclick: () => P.copy() }, 'Copy')),
      v.info);
  }

  function syncForms() {
    const c = cfg(), cv = P.canvas();
    for (const v of P.viewers) {
      v.preset.value = P.presetOf(c);
      for (const k of ['w', 'h']) {
        if (document.activeElement === v[k] && !c.fit) continue;
        v[k].value = c.fit ? P.num(P.fromIn(cv[k], c.unit, c.dpi), c.unit === 'px' ? 0 : 2) : c[k];
        v[k].classList.toggle('auto', !!c.fit);
      }
      v.unit.value = c.unit; v.bg.value = c.bg; v.fmt.value = c.format;
      if (document.activeElement !== v.dpi) v.dpi.value = c.dpi;
      const f = FMT[c.format] || FMT.pdf;
      v.info.textContent = `${P.num(cv.w, 2)} × ${P.num(cv.h, 2)} in` + (f.raster ? ` · ${pixels(cv)} at ${cv.dpi} dpi` : ' · vector');
    }
  }

  function paintAll() { for (const v of P.viewers) paint(v); }
  function paint(v) {
    const vis = P.visible(), e = P.current(), i = vis.indexOf(e);
    v.count.textContent = vis.length ? `${i + 1} / ${vis.length}` : '';
    v.prev.disabled = i <= 0; v.next.disabled = i < 0 || i >= vis.length - 1;
    v.zoomBtn.hidden = !!cfg().fit;
    v.zoomBtn.classList.toggle('on', P.zoom === 'actual');
    v.stage.classList.toggle('fit', !!cfg().fit);
    v.stage.classList.toggle('actual', !cfg().fit && P.zoom === 'actual');
    v.frame.hidden = !e;
    v.busy.hidden = !(e && e.busy);
    v.msg.hidden = true;
    if (!e) {
      v.msg.hidden = false; v.msg.innerHTML = '';
      v.msg.append(h('b', 'No plots yet'), h('p', cfg().capture === false
        ? 'Showing plots here is off for new R consoles (⋯ menu).'
        : 'Plots drawn in an R console started from Codeome appear here: ⌘↩ in an R script or chunk, or the R console in the terminal panel.'),
      h('button.btn.small', { onclick: () => App.views.terminals.rConsole() }, 'Start R console'));
      v.thumbs.hidden = true;
      return;
    }
    const src = (e.view || e.snap || {}).src;
    if (src && v.img.getAttribute('src') !== src) v.img.src = src;
    if (!src) v.img.removeAttribute('src');
    v.img.title = `Plot ${e.n} · ${e.title}${e.where === 'hpc' ? ' (HPC)' : ''}`;
    if (e.error) { v.msg.hidden = false; v.msg.innerHTML = ''; v.msg.classList.add('err'); v.msg.append(h('b', 'Could not redraw this plot'), h('pre', e.error)); }
    else v.msg.classList.remove('err');
    // The frame has the canvas's shape, fitted into the stage or at actual size (96 px per inch).
    const cv = P.canvas(), c = cfg();
    const r = v.stage.getBoundingClientRect(), pad = c.fit ? 0 : 24;
    let fw, fh;
    if (c.fit) { fw = r.width; fh = r.height; }
    else if (P.zoom === 'actual') { fw = cv.w * 96; fh = cv.h * 96; }
    else { const s = Math.min((r.width - pad) / cv.w, (r.height - pad) / cv.h); fw = cv.w * s; fh = cv.h * s; }
    v.frame.style.width = Math.max(1, Math.floor(fw)) + 'px';
    v.frame.style.height = Math.max(1, Math.floor(fh)) + 'px';
    v.frame.classList.toggle('clear', c.bg === 'transparent');
    v.zoomBtn.title = P.zoom === 'actual' ? 'Fit in the panel' : 'Actual size (as printed)';
    // Thumbnails once there are two plots.
    v.thumbs.hidden = vis.length < 2;
    v.thumbs.innerHTML = '';
    if (vis.length >= 2) for (const x of vis) {
      v.thumbs.append(h('button.plot-thumb' + (x === e ? '.on' : ''), { title: `Plot ${x.n} · ${x.title}`, onclick: () => P.select(x),
        oncontextmenu: (ev) => { ev.preventDefault(); App.menu(ev.clientX, ev.clientY, [{ label: 'Export…', run: () => P.export(cfg().format, x) }, { label: 'Remove', run: () => P.remove(x) }]); } },
        x.thumb ? h('img', { src: x.thumb, alt: '' }) : h('span.spinner'), h('span.n', String(x.n))));
    }
    if (vis.length >= 2) v.thumbs.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  P.init = () => {
    mount(document.querySelector('.view[data-view="plots"]'));
    App.listen('view', (view) => { if (view === 'plots') changed({ save: false, wait: 0 }); });
    // The plots tab coming or going changes which viewer sets the fit size.
    App.listen('tab', () => setTimeout(() => changed({ save: false, wait: 50 })));
    App.listen('project', () => { syncForms(); show(P.current()); });
    // HPC plots need the canvas there too once it is reachable.
    App.listen('hpc', (up) => { if (up) pushCanvas(true); });
  };

  // ---------- R consoles ----------
  // Makes a terminal's R send its plots here: puts the scripts on its host, then sources plots.R.
  P.enable = async (t) => {
    const where = /^(hpc|agent-hpc)/.test(t.spec.kind) ? 'hpc' : 'local';
    const r = await codeome.plots.install(where);
    if (r.error) { App.err('Plots: ' + r.error); return false; }
    if (!t.alive) return false;
    codeome.pty.write(t.id, 'source("~/.cache/codeome/plots.R")\r');
    return true;
  };
})();
