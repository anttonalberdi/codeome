// Google Docs, Sheets and Slides in the main window. Google Drive for desktop keeps each one on disk as a small
// JSON pointer (.gdoc, .gsheet, .gslides) holding the document id. The real Google editor is loaded in a
// WebContentsView laid over the tab's area, in its own persistent session so the Google sign-in survives restarts.
const { WebContentsView, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const KIND = { gdoc: 'document', gsheet: 'spreadsheets', gslides: 'presentation' };
const PARTITION = 'persist:google';
const views = new Map(); // tab id → WebContentsView

// { docId, url, email } from a pointer file.
function pointer(file) {
  const kind = KIND[path.extname(file).slice(1).toLowerCase()];
  if (!kind) throw new Error('Not a Google Docs, Sheets or Slides file.');
  let d;
  try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Could not read ' + path.basename(file) + '. Is Google Drive for desktop running?'); }
  const docId = String(d.doc_id || '');
  if (!/^[\w-]+$/.test(docId)) throw new Error(path.basename(file) + ' holds no document id.');
  const key = d.resource_key ? '?resourcekey=' + encodeURIComponent(d.resource_key) : '';
  return { docId, url: `https://docs.google.com/${kind}/d/${docId}/edit${key}`, email: d.email || '' };
}

// Google refuses sign-in from browsers it takes for embedded ones, so the view presents itself as the Chrome this
// Electron is built on: Chrome's user agent (which never carries the full version) and Chrome's brand list, which
// Electron reports as plain Chromium. Google also looks for the window.chrome members that Chrome adds to every page
// and Electron leaves out; chromeObject runs in each page before its own scripts.
function chromeIdentity() {
  const full = process.versions.chrome, major = full.split('.')[0];
  const os = { darwin: 'Macintosh; Intel Mac OS X 10_15_7', win32: 'Windows NT 10.0; Win64; x64' }[process.platform] || 'X11; Linux x86_64';
  const brands = (v, grease) => [{ brand: 'Google Chrome', version: v }, { brand: 'Chromium', version: v }, { brand: 'Not_A Brand', version: grease }];
  return {
    userAgent: `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    userAgentMetadata: {
      brands: brands(major, '24'), fullVersionList: brands(full, '24.0.0.0'), fullVersion: full,
      platform: { darwin: 'macOS', win32: 'Windows' }[process.platform] || 'Linux',
      platformVersion: process.platform === 'linux' ? '' : process.getSystemVersion(),
      architecture: process.arch === 'arm64' ? 'arm' : 'x86', bitness: '64', model: '', mobile: false, wow64: false
    }
  };
}

function chromeObject() {
  const t0 = Date.now() / 1000;
  const c = window.chrome = window.chrome || {};
  c.app = c.app || {
    isInstalled: false, getDetails: () => null, getIsInstalled: () => false,
    InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
    RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
  };
  c.csi = c.csi || (() => ({ onloadT: Date.now(), startE: Date.now(), pageT: performance.now(), tran: 15 }));
  c.loadTimes = c.loadTimes || (() => ({
    requestTime: t0, startLoadTime: t0, commitLoadTime: t0, finishDocumentLoadTime: t0, finishLoadTime: t0, firstPaintTime: t0, firstPaintAfterLoadTime: 0,
    navigationType: 'Other', wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'h2'
  }));
}

let ses = null;
function googleSession() {
  if (ses) return ses;
  ses = session.fromPartition(PARTITION);
  ses.setUserAgent(chromeIdentity().userAgent);
  return ses;
}

const isGoogle = (url) => { try { return /(^|\.)google\.com$/.test(new URL(url).hostname); } catch { return false; } };

// send(channel, payload) reports 'gdoc:state' { id, url, title, loading, error? } as the page moves.
function open(win, id, file, send) {
  const p = pointer(file);
  const view = new WebContentsView({ webPreferences: { session: googleSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, plugins: true } });
  view.setVisible(false);
  win.contentView.addChildView(view);
  views.set(id, view);
  const wc = view.webContents;
  // Google's own pop-ups (sign-in, account chooser) stay in the view; any other link opens in the default browser.
  wc.setWindowOpenHandler(({ url }) => { if (isGoogle(url)) wc.loadURL(url); else shell.openExternal(url); return { action: 'deny' }; });
  const report = (error) => send('gdoc:state', { id, url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), error: typeof error === 'string' ? error : '' });
  // The Chrome identity can only be set through the DevTools protocol, which needs a page to talk to: a blank one
  // first. Once set it holds for every page the view visits.
  const cdp = (method, params) => wc.debugger.sendCommand(method, params);
  wc.loadURL('about:blank')
    .then(() => { wc.debugger.attach('1.3'); return cdp('Emulation.setUserAgentOverride', chromeIdentity()); })
    .then(() => cdp('Page.enable'))
    .then(() => cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(${chromeObject})()` }))
    .catch(() => {})
    .then(() => {
      if (wc.isDestroyed()) return;
      for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) wc.on(ev, () => report());
      wc.on('did-fail-load', (_e, code, desc, _url, isMain) => { if (isMain && code !== -3) report(desc || 'Could not load the document.'); });
      wc.loadURL(p.url).catch(() => {});
    });
  return p;
}

// bounds: { x, y, width, height } in window coordinates, or null to hide the view.
function place(id, bounds) {
  const view = views.get(id);
  if (!view) return;
  if (!bounds) return view.setVisible(false);
  view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) });
  view.setVisible(true);
}

function reload(id) { const view = views.get(id); if (view) view.webContents.reload(); }

function close(id, win) {
  const view = views.get(id);
  if (!view) return;
  views.delete(id);
  if (win && !win.isDestroyed()) win.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
}

function closeAll(win) { for (const id of [...views.keys()]) close(id, win); }

module.exports = { pointer, open, place, reload, close, closeAll, PARTITION };
