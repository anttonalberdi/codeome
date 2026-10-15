// Shared state and small UI helpers. Every module hangs off window.App.
window.App = {
  cfg: null,
  env: { tools: {} },
  project: null,          // local project folder
  remoteDir: null,        // current folder in the HPC browser
  hpcConnected: false,
  views: {},
  on: {}, // simple event bus
};

App.emit = (ev, data) => (App.on[ev] || []).forEach((f) => { try { f(data); } catch (e) { console.error(e); } });
App.listen = (ev, f) => { (App.on[ev] = App.on[ev] || []).push(f); };

// Element builder: h('div.cls#id', {attrs, onclick}, children...)
App.h = function h(sel, attrs, ...kids) {
  const m = sel.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) for (const part of m[2].match(/[.#][\w-]+/g)) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (k) => {
    if (k == null || k === false) return;
    if (Array.isArray(k)) return k.forEach(add);
    el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  };
  kids.forEach(add);
  return el;
};
const h = App.h;

App.icons = {
  folder: '<svg class="ic" viewBox="0 0 16 16"><path d="M1.5 4h4.5l1.5 1.5h7v8h-13z" fill="currentColor" opacity=".85"/></svg>',
  file: '<svg class="ic" viewBox="0 0 16 16"><path d="M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>',
  up: '<svg viewBox="0 0 16 16"><path d="M8 13V3M4 7l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  history: '<svg viewBox="0 0 16 16"><path d="M3 8a5 5 0 1 0 1.5-3.6M3 2.5V5h2.5M8 5.5V8l2 1.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  refresh: '<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  plus: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  dots: '<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>',
  trash: '<svg viewBox="0 0 16 16"><path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.7 9h5.6l.7-9" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  home: '<svg viewBox="0 0 16 16"><path d="M2.5 7.5 8 3l5.5 4.5V13h-11z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  terminal: '<svg viewBox="0 0 16 16"><path d="m3 4.5 3.5 3.5L3 11.5M8 12h5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  right: '<svg viewBox="0 0 16 16"><path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  left: '<svg viewBox="0 0 16 16"><path d="M13 8H3M7 4 3 8l4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  swap: '<svg viewBox="0 0 16 16"><path d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  bolt: '<svg viewBox="0 0 16 16"><path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>'
};
App.iconBtn = (name, title, onclick, extra = '') => h('button.icon-btn.small' + extra, { title, 'aria-label': title, onclick, html: App.icons[name] });

// ---------- formatting ----------
App.fmtSize = (n) => {
  if (n == null || isNaN(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + ' ' + u[i];
};
App.fmtAgo = (ms) => {
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' d ago';
  return new Date(ms).toLocaleDateString();
};
// 950, 8.4k, 84k, 1.25M
App.fmtTokens = (n) => {
  if (n == null || isNaN(n)) return '–';
  if (n < 1000) return String(Math.round(n));
  if (n < 999500) return (n / 1000).toFixed(n < 9950 ? 1 : 0) + 'k';
  return (n / 1e6).toFixed(n < 9995000 ? 2 : 1) + 'M';
};
App.fmtUsd = (n) => '$' + (n >= 100 ? Math.round(n).toLocaleString() : (n || 0).toFixed(2));
App.basename = (p) => (p || '').replace(/\/+$/, '').split('/').pop() || p;
App.dirname = (p) => { const s = (p || '').replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i <= 0 ? '/' : s.slice(0, i); };
App.join = (a, b) => (a === '/' ? '' : (a || '').replace(/\/+$/, '')) + '/' + b;
App.ext = (p) => { const m = App.basename(p).match(/\.([^.]+)$/); return m ? m[1].toLowerCase() : ''; };

// ---------- toasts ----------
App.toast = (msg, opts = {}) => {
  const el = h('div.toast' + (opts.error ? '.err' : ''), { role: opts.error ? 'alert' : 'status' }, msg);
  if (opts.action) el.append(' ', h('a', { onclick: () => { opts.action.run(); el.remove(); } }, opts.action.label));
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), opts.error ? 9000 : (opts.ms || 3500));
  return el;
};
App.err = (msg) => App.toast(String(msg), { error: true });

// ---------- tooltips ----------
// Codeome-style tooltips replace the native ones: any element with a title (or aria-label, for buttons) shows its text
// after a short hover. The title moves to data-tip so the system tooltip does not also appear.
(function () {
  let tip = null, timer = null, target = null;
  const hide = () => { clearTimeout(timer); timer = null; target = null; if (tip) { tip.remove(); tip = null; } };
  const show = (el, text) => {
    if (!el.isConnected) return;
    tip = document.createElement('div');
    tip.id = 'tip'; tip.className = 'tip'; tip.setAttribute('role', 'tooltip'); tip.textContent = text;
    document.body.append(tip);
    const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
    let top = r.bottom + 6;
    if (top + t.height > innerHeight - 4) top = Math.max(4, r.top - t.height - 6);
    const left = Math.max(4, Math.min(innerWidth - t.width - 4, r.left + r.width / 2 - t.width / 2));
    tip.style.top = top + 'px'; tip.style.left = left + 'px';
  };
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest && e.target.closest('[title], [data-tip], button[aria-label]');
    if (el === target) return;
    hide();
    if (!el) return;
    if (el.hasAttribute('title')) { const t = el.getAttribute('title'); if (t) el.dataset.tip = t; el.removeAttribute('title'); }
    const text = el.dataset.tip || (el.matches('button') ? el.getAttribute('aria-label') : '');
    if (!text) return;
    target = el;
    timer = setTimeout(() => show(el, text), 450);
  });
  for (const ev of ['mousedown', 'keydown', 'wheel', 'blur']) addEventListener(ev, hide, true);
  document.addEventListener('mouseleave', hide);
})();

// ---------- modal dialogs ----------
// fields: [{key, label, type:'text'|'password'|'textarea'|'select'|'check'|'number', value, options, hint, placeholder}]
// closer: called with a function that closes the dialog from outside; it then resolves undefined.
App.modal = ({ title, text, fields = [], ok = 'OK', cancel = 'Cancel', danger = false, body, closer }) => new Promise((resolve) => {
  const ov = document.getElementById('overlay');
  const inputs = {};
  const renderField = (f) => {
    if (f.legend) return h('legend', f.legend);
    let input;
    if (f.type === 'textarea') input = h('textarea', { rows: f.rows || 4, placeholder: f.placeholder || '' }, f.value || '');
    else if (f.type === 'select') { input = h('select', (f.options || []).map((o) => h('option', { value: o.value ?? o, selected: (o.value ?? o) === f.value }, o.label ?? o))); }
    else if (f.type === 'check') { input = h('input', { type: 'checkbox', checked: !!f.value }); inputs[f.key] = input; return h('label.check', input, f.label); }
    else input = h('input', { type: f.type || 'text', value: f.value ?? '', placeholder: f.placeholder || '', spellcheck: 'false', autocomplete: 'off' });
    inputs[f.key] = input;
    return h('label.field', h('span', f.label), input, f.hint ? h('div.hint', f.hint) : null);
  };
  const close = (val) => { ov.hidden = true; ov.innerHTML = ''; document.removeEventListener('keydown', onKey, true); resolve(val); };
  const collect = () => { const o = {}; for (const [k, el] of Object.entries(inputs)) o[k] = el.type === 'checkbox' ? el.checked : el.value; return o; };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(null); }
    if (e.key === 'Enter' && (e.metaKey || e.target.tagName === 'INPUT')) { e.preventDefault(); close(fields.length ? collect() : true); }
  };
  const groups = []; let cur = null;
  for (const f of fields) {
    if (f.legend) { cur = h('fieldset', renderField(f)); groups.push(cur); continue; }
    const el = renderField(f);
    if (f.pair && cur) { /* paired fields share a row */ }
    (cur || (groups.push(cur = h('fieldset')), cur)).append(el);
  }
  const m = h('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', h('h2', title), text ? h('p', text) : null),
    (groups.length || body) ? h('div.body', body || null, groups) : null,
    h('footer',
      cancel ? h('button.btn', { onclick: () => close(null) }, cancel) : null,
      h('button.btn' + (danger ? '.danger' : '.primary'), { onclick: () => close(fields.length ? collect() : true) }, ok)));
  ov.innerHTML = ''; ov.append(m); ov.hidden = false;
  ov.onclick = (e) => { if (e.target === ov) close(null); };
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => { const first = m.querySelector('input,textarea,select') || m.querySelector('footer .btn:last-child'); if (first) first.focus(); }, 0);
  if (closer) closer(() => { if (ov.contains(m)) close(undefined); });
});
// Sign-in dialogs (the VPN tunnel, the HPC login) show one at a time: a new one closes
// the last, and App.closeSignIn(owner) closes the owner's from outside.
let signIn = null;
App.signIn = (owner, opts) => {
  if (signIn && signIn.close) signIn.close();
  const d = { owner };
  signIn = d;
  return App.modal({ ...opts, closer: (c) => { d.close = c; } }).then((v) => { if (signIn === d) signIn = null; return v; });
};
App.closeSignIn = (owner) => { const d = signIn; if (!d || d.owner !== owner) return; signIn = null; if (d.close) d.close(); };
App.prompt = async (title, label, value = '', opts = {}) => {
  const r = await App.modal({ title, ok: opts.ok || 'OK', text: opts.text, fields: [{ key: 'v', label, value, placeholder: opts.placeholder }] });
  return r ? r.v.trim() : null;
};
App.confirm = (title, text, ok = 'Continue', danger = false) => App.modal({ title, text, ok, danger });

// ---------- popup menus ----------
App.menu = (x, y, items) => {
  const pop = document.getElementById('menu-pop');
  pop.innerHTML = '';
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { pop.append(h('hr')); continue; }
    if (it.header) { pop.append(h('div.mh', it.header)); continue; }
    pop.append(h('button' + (it.danger ? '.danger' : ''), { disabled: it.disabled, onclick: () => { hide(); it.run(); } }, h('span', it.label), it.key ? h('span.k', it.key) : null));
  }
  pop.hidden = false;
  const r = pop.getBoundingClientRect();
  pop.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  pop.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  const first = pop.querySelector('button'); if (first) first.focus();
  const hide = () => { pop.hidden = true; document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', key, true); };
  const outside = (e) => { if (!pop.contains(e.target)) hide(); };
  const key = (e) => {
    if (e.key === 'Escape') hide();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const bs = [...pop.querySelectorAll('button:not([disabled])')]; const i = bs.indexOf(document.activeElement);
      bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length].focus();
    }
  };
  setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', key, true); });
};
// above: open over the element, with the right edges aligned (for buttons at the bottom of a panel).
App.menuAt = (el, items, above) => {
  const r = el.getBoundingClientRect();
  App.menu(r.left, r.bottom + 4, items);
  if (!above) return;
  const pop = document.getElementById('menu-pop'), p = pop.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.right - p.width, innerWidth - p.width - 8)) + 'px';
  pop.style.top = Math.max(8, r.top - p.height - 4) + 'px';
};

// ---------- popovers ----------
// A panel under an anchor, or over it where there is no room below; Escape or a click
// outside closes it. Only one at a time.
App.popover = (anchor, content, label) => {
  App.closePopover();
  const pop = h('div.popover', { role: 'dialog', 'aria-label': label || '' }, content);
  document.body.append(pop);
  let at = anchor;
  const place = () => {
    if (!at.isConnected) return; // the anchor was rebuilt under us: stay where we are
    const r = at.getBoundingClientRect(), { width: w, height: ph } = pop.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
    pop.style.top = (r.bottom + 6 + ph > innerHeight - 8 && r.top - ph - 6 >= 8 ? r.top - ph - 6 : r.bottom + 6) + 'px';
  };
  place();
  const outside = (e) => { if (!pop.contains(e.target) && !at.contains(e.target)) close(); };
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); if (at.isConnected) at.focus(); } };
  function close() { pop.remove(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', key, true); if (App.pop === p) App.pop = null; }
  const p = { pop, anchor, close, set: (c) => { pop.innerHTML = ''; pop.append(c); place(); }, reanchor: (el) => { at = el; place(); } };
  setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', key, true); });
  App.pop = p;
  setTimeout(() => { const f = pop.querySelector('button,select,input'); if (f) f.focus(); });
  return p;
};
App.closePopover = () => { if (App.pop) App.pop.close(); };

// "in 42 min", "in 3 h 10 min", "Tue 09:00"
App.fmtReset = (epochS) => {
  if (!epochS) return '';
  const s = epochS - Date.now() / 1000;
  if (s <= 0) return 'now';
  if (s < 3600) return 'in ' + Math.max(1, Math.round(s / 60)) + ' min';
  if (s < 20 * 3600) return 'in ' + Math.floor(s / 3600) + ' h ' + Math.round(s % 3600 / 60) + ' min';
  return new Date(epochS * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
};
App.tildify = (p) => (App.env.home && p && p.startsWith(App.env.home) ? '~' + p.slice(App.env.home.length) : p);
// A path for a shell command: ~ becomes $HOME so it expands inside quotes.
App.shPath = (p) => (/^~(\/|$)/.test(p) ? '"$HOME' + p.slice(1).replace(/(["\\$`])/g, '\\$1') + '"' : App.shq(p));

// ---------- misc ----------
App.saveConfig = async () => { App.cfg = await codeome.config.set(App.cfg); App.emit('config', App.cfg); };
// The HPC as the user named it (Settings → HPC, or the title of its files pane); its login until then.
App.hpcName = () => ((App.cfg.ui.panes || {}).remote || {}).title || App.cfg.hpc.host;
App.requireHpc = () => {
  if (!App.cfg.hpc.host) { App.toast('Set your HPC host in Settings first.', { action: { label: 'Open Settings', run: () => App.views.settings.open() } }); return false; }
  if (!App.hpcConnected) { App.toast('Not connected to the HPC.', { action: { label: 'Connect', run: () => App.connectHpc() } }); return false; }
  return true;
};
// Quote a string for a POSIX shell.
App.shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
App.safeName = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
