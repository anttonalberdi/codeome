// IPC host for moderated forums. Electron supplies ipcMain and the sender, while
// this module owns live Forum instances, account-bound checks, and saved snapshots.
// Dependencies are injected so the whole channel surface can be tested in Node.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const usage = require('./usage');
const scratch = require('./scratch');
const { Forum } = require('./forum');
const { oneShot } = require('./oneshot');
const defaultStore = require('./forumstore');

const DEFAULT_SEATS = [{ id: 'claude-1', engine: 'claude', name: 'Claude' }, { id: 'codex-1', engine: 'codex', name: 'Codex' }];
const LIMITS = { defaultBudget: [0, 20], summaryTokens: [1000, 50000], recentMessages: [2, 30] };
const validId = defaultStore.validId;
const clamp = (value, [lo, hi]) => Math.max(lo, Math.min(hi, Math.floor(Number(value) || lo)));

function createHost(deps) {
  const { getCfg, send, makeAgentSession, claudeCmd, codexCmd, launchOn, stats } = deps;
  const store = deps.store || defaultStore;
  const call = deps.oneShot || oneShot;
  const forumFactory = deps.forumFactory || ((options) => new Forum(options));
  const forums = new Map();
  const timers = new Map();
  const idleTimers = new Map();
  const listeners = new Map();
  const idleMs = deps.idleMs ?? 600000;

  function projectPath(project) {
    if (typeof project !== 'string' || !project || !fs.existsSync(project) || !fs.statSync(project).isDirectory()) throw new Error('Project folder not found.');
    return path.resolve(project);
  }
  function forumId(id) { if (!validId(id)) throw new Error('Bad forum id.'); return id; }
  function textValue(value) {
    if (typeof value !== 'string' || value.length > 20000) throw new Error('Text must be at most 20,000 characters.');
    return value;
  }
  function shortText(value, max, label) {
    if (typeof value !== 'string' || value.length > max) throw new Error(`${label} must be a string of at most ${max} characters.`);
    return value;
  }
  function settings(overrides = {}) { return { ...(getCfg().forum || {}), ...overrides }; }
  function save(forum) {
    const record = store.save(forum.project, { ...forum.snapshot(), settings: forum.settingsOverrides || {}, createdAt: forum.createdAt });
    forum.createdAt = record.createdAt;
    return record;
  }
  function flush(id) {
    if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); }
    const forum = forums.get(id);
    if (forum) save(forum);
  }
  function schedule(id) {
    if (!forums.has(id)) return;
    if (timers.has(id)) clearTimeout(timers.get(id));
    const timer = setTimeout(() => { timers.delete(id); try { flush(id); } catch (error) { console.error('forum save', error); } }, 800);
    timer.unref();
    timers.set(id, timer);
  }
  function touch(id) {
    if (idleTimers.has(id)) clearTimeout(idleTimers.get(id));
    const timer = setTimeout(() => {
      idleTimers.delete(id);
      const forum = forums.get(id);
      if (forum && (forum.active || forum.controllers?.size)) touch(id);
      else closeForum(id);
    }, idleMs);
    timer.unref(); idleTimers.set(id, timer);
  }
  function watch(forum) {
    const listener = (event) => {
      send('forum:event', { id: forum.id, event });
      touch(forum.id);
      if (event.type !== 'error' && !(event.type === 'message' && event.delta !== undefined)) schedule(forum.id);
    };
    forum.on('event', listener);
    listeners.set(forum.id, listener);
    forums.set(forum.id, forum);
    touch(forum.id);
  }
  function unwatch(forum) {
    const listener = listeners.get(forum.id);
    if (listener) forum.off('event', listener);
    listeners.delete(forum.id);
    if (timers.has(forum.id)) { clearTimeout(timers.get(forum.id)); timers.delete(forum.id); }
    if (idleTimers.has(forum.id)) { clearTimeout(idleTimers.get(forum.id)); idleTimers.delete(forum.id); }
    forums.delete(forum.id);
  }
  function closeForum(id) {
    const forum = forums.get(id);
    if (!forum) return;
    forum.stop();
    try { flush(id); } catch (error) { console.error('forum save', error); }
    unwatch(forum); forum.dispose();
  }
  function live(id) {
    const forum = forums.get(forumId(id));
    if (!forum) throw new Error('Forum is not open.');
    touch(id);
    return forum;
  }
  function makeForum(data, overrides = {}) {
    const id = data.id, project = data.project;
    const forum = forumFactory({ id, project, title: data.title, seats: data.seats, settings: settings(overrides),
      makeSession: (seat) => {
        const session = makeAgentSession(seat, project);
        const resumed = !!seat.started;
        let completed = false, exited = false;
        const complete = () => { if (exited) return; completed = true; if (!seat.started) { seat.started = true; schedule(id); } };
        session.on('message', (message) => { if (message.type === 'result') complete(); });
        session.on('exit', () => {
          exited = true;
          if (resumed && !completed) { seat.started = false; seat.sessionId = crypto.randomUUID(); schedule(id); }
        });
        session.on('turn', (turn) => {
          if (exited) return;
          complete();
          if (scratch.isScratch(project)) return;
          try { stats.record({ at: Date.now(), ...turn, session: seat.sessionId, project, account: seat.account, engine: seat.engine, forum: id, seat: seat.id }); }
          catch (error) { console.error('forum stats', error); }
        });
        return session;
      },
      check: (seat, prompt, signal) => {
        const cfg = forum.settings;
        fs.mkdirSync(usage.home(), { recursive: true });
        return call(seat.engine, { prompt, signal, bin: seat.bin, dir: seat.dir, cwd: usage.home(),
          model: seat.engine === 'claude' ? cfg.checkModel : cfg.codexCheckModel,
          effort: cfg.checkEffort, timeoutMs: cfg.checkTimeoutMs, strictMcp: true });
      } });
    forum.settingsOverrides = { ...overrides };
    forum.createdAt = data.createdAt || Date.now();
    return forum;
  }
  function prepareSeats(requested) {
    const source = requested == null ? DEFAULT_SEATS : requested;
    if (!Array.isArray(source) || !source.length) throw new Error('A forum needs at least one seat.');
    const seen = new Set();
    return source.map((input, index) => {
      if (!input || !['claude', 'codex'].includes(input.engine)) throw new Error('Unknown seat engine.');
      const id = input.id || `${input.engine}-${index + 1}`;
      if (seen.has(id)) throw new Error('Duplicate seat id.');
      seen.add(id);
      const command = input.engine === 'claude' ? claudeCmd() : codexCmd();
      const account = launchOn(input.engine, 'auto', command).info.name;
      const entries = (((getCfg().accounts || {})[input.engine] || {}).list || []);
      const selected = entries.find((entry) => entry.name === account);
      const name = input.name === undefined ? input.engine : shortText(input.name, 80, 'Seat name');
      const persona = input.persona === undefined ? '' : shortText(input.persona, 500, 'Seat persona');
      return { id, engine: input.engine, name, persona, muted: !!input.muted,
        sessionId: crypto.randomUUID(), account, bin: String(command).trim().split(/\s+/)[0], dir: selected ? selected.dir || '' : '' };
    });
  }
  function overridesOf(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Bad forum settings.');
    const out = {};
    for (const key of Object.keys(input)) {
      if (!LIMITS[key]) throw new Error('Unknown forum setting ' + key + '.');
      out[key] = clamp(input[key], LIMITS[key]);
    }
    return out;
  }
  const reply = (fn) => async (_event, input) => {
    try { return await fn(input); } catch (error) { return { error: String(error.message || error) }; }
  };

  function register(ipcMain) {
    ipcMain.handle('forum:create', reply(({ project, title, seats, docFile } = {}) => {
      project = projectPath(project);
      const forum = makeForum({ id: crypto.randomUUID(), project, title: title === undefined ? 'New forum' : shortText(title, 200, 'Forum title'), seats: prepareSeats(seats) });
      watch(forum);
      try {
        if (docFile) {
          if (!path.isAbsolute(docFile)) throw new Error('Document path must be absolute.');
          forum.attachDoc(docFile);
        }
        save(forum);
      } catch (error) {
        unwatch(forum); forum.dispose();
        throw error;
      }
      return { ok: true, forum: forum.snapshot() };
    }));
    ipcMain.handle('forum:open', reply(({ project, id } = {}) => {
      project = projectPath(project); forumId(id);
      const existing = forums.get(id);
      if (existing) {
        if (existing.project !== project) throw new Error('Forum belongs to another project.');
        return { ok: true, forum: existing.snapshot() };
      }
      const data = store.load(project, id);
      if (!data) throw new Error('Forum not found.');
      if (!Array.isArray(data.seats) || data.seats.some((seat) => !validId(seat.sessionId))) throw new Error('Bad forum seat session id.');
      const overrides = overridesOf(data.settings || {});
      const forum = makeForum(data, overrides);
      watch(forum);
      try {
        forum.restore(data);
        forum.settings = settings(overrides);
        forum.budgetLimit = forum.settings.defaultBudget;
        forum.budget = Math.max(0, Math.min(forum.budget, forum.budgetLimit));
      } catch (error) { unwatch(forum); forum.dispose(); throw error; }
      return { ok: true, forum: forum.snapshot() };
    }));
    ipcMain.handle('forum:list', reply((project) => {
      project = projectPath(project);
      for (const forum of forums.values()) if (forum.project === project && timers.has(forum.id)) flush(forum.id);
      return { ok: true, forums: store.list(project) };
    }));
    ipcMain.handle('forum:delete', reply(({ project, id } = {}) => {
      project = projectPath(project); forumId(id);
      const forum = forums.get(id);
      if (forum) {
        if (forum.project !== project) throw new Error('Forum belongs to another project.');
        unwatch(forum); forum.dispose();
      }
      store.remove(project, id);
      return { ok: true };
    }));
    ipcMain.handle('forum:close', reply(({ id } = {}) => { closeForum(forumId(id)); return { ok: true }; }));
    ipcMain.handle('forum:rename', reply(({ id, title } = {}) => {
      const forum = live(id);
      forum.title = textValue(title);
      schedule(id);
      return { ok: true, forum: forum.snapshot() };
    }));
    ipcMain.handle('forum:post', reply(({ id, text } = {}) => {
      const forum = live(id);
      void forum.post(textValue(text)).catch((error) => forum.emitEvent('error', { error: String(error.message || error) }));
      return { ok: true };
    }));
    ipcMain.handle('forum:allow', reply(({ id, handId } = {}) => live(id).allow(handId) ? { ok: true } : { error: 'Hand not found.' }));
    ipcMain.handle('forum:dismiss', reply(({ id, handId } = {}) => live(id).dismiss(handId) ? { ok: true } : { error: 'Hand not found.' }));
    ipcMain.handle('forum:mute', reply(({ id, seatId, muted } = {}) => live(id).mute(seatId, muted) ? { ok: true } : { error: 'Seat not found.' }));
    ipcMain.handle('forum:stop', reply(({ id } = {}) => { live(id).stop(); return { ok: true }; }));
    ipcMain.handle('forum:setBudget', reply(({ id, n } = {}) => {
      const forum = live(id);
      forum.settingsOverrides.defaultBudget = clamp(n, LIMITS.defaultBudget);
      forum.settings.defaultBudget = forum.settingsOverrides.defaultBudget;
      forum.setBudget(forum.settingsOverrides.defaultBudget);
      return { ok: true, budget: forum.budget };
    }));
    ipcMain.handle('forum:setSettings', reply(({ id, settings: patch } = {}) => {
      const forum = live(id);
      const next = overridesOf(patch);
      forum.settingsOverrides = { ...forum.settingsOverrides, ...next };
      forum.settings = settings(forum.settingsOverrides);
      if (next.defaultBudget !== undefined) forum.setBudget(next.defaultBudget);
      schedule(id);
      return { ok: true, settings: forum.settings };
    }));
    ipcMain.handle('forum:attachDoc', reply(({ id, file } = {}) => {
      if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Document path must be absolute.');
      const forum = live(id);
      forum.attachDoc(file);
      return { ok: true, doc: forum.snapshot().doc };
    }));
    ipcMain.handle('forum:detachDoc', reply(({ id } = {}) => { live(id).detachDoc(); return { ok: true }; }));
    ipcMain.handle('forum:grantWrite', reply(({ id, seatId, instruction } = {}) =>
      live(id).grantWrite(seatId, textValue(instruction)) ? { ok: true } : { error: 'Write was not allowed.' }));
  }
  function disposeAll() {
    for (const id of [...forums.keys()]) closeForum(id);
  }
  return { register, disposeAll, forums };
}

module.exports = { createHost };
