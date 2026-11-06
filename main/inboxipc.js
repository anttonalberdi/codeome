const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const { validInboxSender } = require('./inboxwire');

const CHAT_ID = /^[A-Za-z0-9_-]+$/;
const MESSAGE_ID = /^[0-9]+-[0-9a-f]{8}$/;
const CODE = /^[BCDFGHJKMNPRSTVWXZ]{4}$/;
const valid = (value, pattern, max) => typeof value === 'string' && value.length <= max && pattern.test(value);

function createInboxIpc({ chats, inboxWire, getWindow, loadChat }) {
  function payload(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        !valid(value.chatId, CHAT_ID, 128) || !chats.has(value.chatId)) return null;
    return value;
  }
  function action(fn, validate = () => true) {
    return (event, value) => {
      try {
        if (!validInboxSender(event, getWindow())) return { ok: false, reason: 'invalid' };
        const args = payload(value);
        if (!args || !valid(args.id, MESSAGE_ID, 64) || !validate(args)) return { ok: false, reason: 'invalid' };
        return fn(args);
      } catch { return { ok: false, reason: 'refused' }; }
    };
  }
  const read = (fn) => (event, value) => {
    try {
      if (!validInboxSender(event, getWindow())) return [];
      const args = payload(value);
      return args ? fn(args) : [];
    } catch { return []; }
  };
  const edited = (value) => value === undefined || typeof value === 'string' && Array.from(value).length <= 8000 ||
    value && typeof value === 'object' && !Array.isArray(value) && Array.from(JSON.stringify(value)).length <= 8200;
  const recipients = (value) => value === undefined || Array.isArray(value) && value.length <= 100 &&
    value.every((id) => valid(id, CHAT_ID, 128));
  const cards = (value) => Array.isArray(value) && value.length <= 50 && value.every((item) =>
    item && typeof item === 'object' && !Array.isArray(item) && valid(item.id, MESSAGE_ID, 64) &&
    ['outbox', 'inbox'].includes(item.box));
  return {
    pending: read((args) => inboxWire.pendingFor(args.chatId)),
    status: (event, value) => {
      try {
        if (!validInboxSender(event, getWindow()) || !value || typeof value !== 'object' ||
            !valid(value.chatId, CHAT_ID, 128) || typeof value.project !== 'string' ||
            !path.isAbsolute(value.project) || !cards(value.cards)) return [];
        const session = chats.get(value.chatId);
        if (session ? session.cwd !== value.project : !loadChat(value.project, value.chatId)) return [];
        return inboxWire.statusFor(value.chatId, value.cards, value.project);
      } catch { return []; }
    },
    approve: action((args) => inboxWire.approve(args.chatId, args.id,
      { textHash: args.textHash, edited: args.edited, recipients: args.recipients }),
    (args) => valid(args.textHash, /^[0-9a-f]{64}$/, 64) && edited(args.edited) && recipients(args.recipients)),
    decline: action((args) => inboxWire.decline(args.chatId, args.id)),
    accept: action((args) => inboxWire.accept(args.chatId, args.id)),
    dismiss: action((args) => inboxWire.dismiss(args.chatId, args.id)),
    reply: action((args) => inboxWire.reply(args.chatId, args.id, args.text),
      (args) => typeof args.text === 'string' && Array.from(args.text).length <= 2000),
    setNewChatCode: action((args) => inboxWire.setNewChatCode(args.chatId, args.id, args.code),
      (args) => valid(args.code, CODE, 4))
  };
}

function createOutboxWatcher({ inboxWire, chats, appVersion }) {
  const watchers = new Map();
  const scan = (project) => inboxWire.scan(project);
  function schedule(state, project) {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => scan(project), 150);
  }
  function watch(project) {
    if (watchers.has(project)) return;
    const base = path.join(project, '.codeome', 'outbox');
    try { fs.mkdirSync(base, { mode: 0o700 }); }
    catch (e) { if (e.code !== 'EEXIST') return; }
    try { if (!fs.lstatSync(base).isDirectory()) return; } catch { return; }
    const state = { root: null, dirs: new Map(), timer: null };
    watchers.set(project, state);
    try { state.root = fs.watch(base, () => schedule(state, project)); } catch {}
    try {
      for (const name of fs.readdirSync(base)) {
        if (!CHAT_ID.test(name)) continue;
        const dir = path.join(base, name);
        if (fs.lstatSync(dir).isDirectory()) {
          try { state.dirs.set(name, fs.watch(dir, () => schedule(state, project))); } catch {}
        }
      }
    } catch {}
    if (!state.root && !state.dirs.size) watchers.delete(project);
  }
  function capability(project) {
    if (![...chats.values()].some((session) => session.cwd === project)) return;
    const base = path.join(project, '.codeome');
    if (!fs.lstatSync(base).isDirectory()) return;
    const file = path.join(base, 'inbox-support.json');
    const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ inbox: 1, app: appVersion }), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, file);
    } finally {
      try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  function refresh(project) {
    try { capability(project); } catch { /* The CLI refuses sends if support cannot be recorded. */ }
    const state = watchers.get(project);
    if (state) {
      const base = path.join(project, '.codeome', 'outbox');
      try {
        for (const name of fs.readdirSync(base)) {
          if (!CHAT_ID.test(name) || state.dirs.has(name)) continue;
          const dir = path.join(base, name);
          if (fs.lstatSync(dir).isDirectory()) {
            try { state.dirs.set(name, fs.watch(dir, () => schedule(state, project))); } catch {}
          }
        }
      } catch {}
    } else watch(project);
    scan(project);
  }
  function close() {
    for (const state of watchers.values()) {
      clearTimeout(state.timer);
      state.root?.close();
      for (const watcher of state.dirs.values()) watcher.close();
    }
    watchers.clear();
  }
  return { refresh, watch, close };
}

module.exports = { createInboxIpc, createOutboxWatcher };
