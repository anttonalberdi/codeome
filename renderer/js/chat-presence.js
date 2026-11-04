// Small, bounded status snapshots for the session record in the main process.
const ChatPresence = (() => {
  const clean = (value, limit) => (typeof value === 'string' ? value : '')
    .slice(0, 10240).replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\u{e0000}-\u{e007f}]/gu, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, limit);

  function planTitle(items) {
    const plan = [...items].reverse().find((it) => it.t === 'perm' && it.tool === 'ExitPlanMode' && typeof it.input?.plan === 'string');
    if (!plan) return '';
    const lines = plan.input.plan.slice(0, 10240).split(/\r?\n/);
    const heading = lines.find((line) => /^\s{0,3}#{1,6}\s+\S/.test(line));
    return clean(heading ? heading.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\s+#+\s*$/, '') : lines.find((line) => line.trim()), 200);
  }

  function presenceOf(chat, deps) {
    const jobs = deps.runningJobs(chat);
    const first = chat.items.find((it) => it.t === 'user');
    return {
      id: chat.id, project: chat.project,
      state: deps.waiting(chat) ? 'waiting' : chat.busy || jobs.length ? 'working' : 'idle',
      jobs: jobs.slice(0, 5).map((job) => clean(job.title, 80)),
      plan_title: planTitle(chat.items),
      first_request: clean(first?.text, 200)
    };
  }

  function createScheduler({ getPayload, push, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    delayMs = 500, refreshMs = 120000 }) {
    const entries = new Map();
    const entryFor = (chat) => {
      if (!entries.has(chat)) entries.set(chat, { timer: null, refreshTimer: null, serial: null, sentAt: 0 });
      return entries.get(chat);
    };
    function armRefresh(chat, entry) {
      clearTimer(entry.refreshTimer);
      entry.refreshTimer = setTimer(() => {
        entry.refreshTimer = null;
        clearTimer(entry.timer);
        entry.timer = null;
        if (chat.running === false) { cancel(chat); return; }
        send(chat, true);
      }, refreshMs);
    }
    function send(chat, force, payload, serial) {
      const entry = entries.get(chat);
      if (!entry) return;
      try {
        payload ||= getPayload(chat);
        serial ||= JSON.stringify(payload);
        if (force || entry.serial !== serial || now() - entry.sentAt >= refreshMs) {
          entry.serial = serial;
          entry.sentAt = now();
          const result = push(payload);
          Promise.resolve(result).then((reply) => {
            if ((reply?.error || reply?.ok === false) && entry.serial === serial) {
              entry.serial = null;
              if (chat.running === false) cancel(chat);
            }
          }).catch(() => { if (entry.serial === serial) entry.serial = null; if (chat.running === false) cancel(chat); });
        }
      } catch { entry.serial = null; }
      armRefresh(chat, entry);
    }
    function schedule(chat, force = false) {
      try {
        const entry = entryFor(chat);
        const pendingForce = entry.pendingForce || force;
        clearTimer(entry.timer);
        entry.timer = null;
        entry.pendingForce = pendingForce;
        entry.timer = setTimer(() => {
          entry.timer = null;
          const forced = entry.pendingForce;
          entry.pendingForce = false;
          send(chat, forced);
        }, delayMs);
      } catch { /* Presence is best effort. */ }
    }
    function cancel(chat) {
      const entry = entries.get(chat);
      if (!entry) return;
      clearTimer(entry.timer);
      clearTimer(entry.refreshTimer);
      entries.delete(chat);
    }
    return { schedule, cancel };
  }

  return { presenceOf, createScheduler };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ChatPresence;
if (typeof App !== 'undefined') App.chatPresence = ChatPresence;
