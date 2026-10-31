// Keeps the Mac from idle-sleeping while an agent is working or waiting for a decision.
// A session counts as working from the moment a message is sent until its turn ends ('result'),
// it exits, or it is dropped. The display may still sleep: only 'prevent-app-suspension' is used.
function createAwake({ blocker, enabled = () => true, onChange = () => {} }) {
  const working = new Set();
  let lock = null;

  function sync() {
    const want = enabled() && working.size > 0;
    if (want && lock === null) { lock = blocker.start('prevent-app-suspension'); onChange(true); }
    else if (!want && lock !== null) { try { blocker.stop(lock); } catch {} lock = null; onChange(false); }
  }

  const begin = (id) => { working.add(id); sync(); };
  const end = (id) => { working.delete(id); sync(); };

  return {
    begin, end, sync,
    held: () => lock !== null,
    // Follows a chat.Session or CodexSession: user() starts a turn, 'result' ends it.
    track(id, session) {
      const user = session.user.bind(session);
      session.user = (...a) => { begin(id); return user(...a); };
      session.on('message', (m) => { if (m && m.type === 'result') end(id); });
      session.on('exit', () => end(id));
    },
    dispose() { working.clear(); sync(); }
  };
}

module.exports = { createAwake };
