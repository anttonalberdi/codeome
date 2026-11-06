// Per-chat leading notification with one generic trailing notification per burst.
function createNotifyThrottle({ notify, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const chats = new Map();
  let closed = false;

  function push(chatId, minSeconds, payload) {
    if (closed) return;
    const interval = minSeconds * 1000;
    const time = now();
    let state = chats.get(chatId);
    if (!state) { state = { lastAt: -Infinity, timer: null, payload: null }; chats.set(chatId, state); }
    if (time < state.lastAt) state.lastAt = -Infinity;
    if (time - state.lastAt >= interval) {
      if (state.timer !== null) { clearTimer(state.timer); state.timer = null; state.payload = null; }
      state.lastAt = time;
      notify(chatId, payload, false);
      return;
    }
    state.payload = payload;
    if (state.timer !== null) return;
    // Keep the interval chosen when this burst began, even if settings change meanwhile.
    state.timer = setTimer(() => {
      state.timer = null;
      const latest = state.payload;
      state.payload = null;
      if (closed) return;
      state.lastAt = now();
      notify(chatId, latest, true);
    }, Math.max(0, interval - (time - state.lastAt)));
  }

  function forget(chatId) {
    const state = chats.get(chatId);
    if (state && state.timer !== null) clearTimer(state.timer);
    chats.delete(chatId);
  }

  function close() {
    closed = true;
    for (const state of chats.values()) if (state.timer !== null) clearTimer(state.timer);
    chats.clear();
  }
  return { push, forget, close };
}

module.exports = { createNotifyThrottle };
