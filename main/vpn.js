// Codeome's VPN tunnel, signed in without a terminal. openconnect runs on a hidden
// pty; its prompts are read from the output and answered with the saved username
// and password, or passed to the window as dialogs (a missing username or password,
// the group, a second-factor code). After the password it may wait for a push to be
// approved on the person's MFA device; the tunnel is up once ocproxy's port answers.
//
// Phases: starting → prompt ⇄ waiting → up, and stopped or failed when it ends.

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
const clean = (s) => String(s).replace(ANSI, '');

// The line openconnect is waiting at: the text after the last line break.
function lastLine(text) {
  const t = clean(text);
  return t.slice(Math.max(t.lastIndexOf('\n'), t.lastIndexOf('\r')) + 1);
}

// What a prompt asks for: username | password | group | code (anything else, such as
// "Second Password:" or "Answer:"). null when the line is not a prompt.
function classifyPrompt(line) {
  const s = String(line || '').trim();
  if (!s.endsWith(':') || s.length > 160) return null;
  const label = s.slice(0, -1).trim();
  if (!label) return null;
  const g = /^group:\s*\[(.+)\]$/i.exec(label);
  if (g) return { kind: 'group', label: 'Group', options: g[1].split('|').map((x) => x.trim()).filter(Boolean) };
  if (/^user ?name$/i.test(label)) return { kind: 'username', label: 'Username' };
  if (/^password$/i.test(label)) return { kind: 'password', label: 'Password' };
  return { kind: 'code', label };
}

const FAILED = /login failed|authentication failed|invalid (user|pass)|incorrect/i;

// Why openconnect (or ssh) stopped, in one line from the end of its log.
function reasonOf(log, fallback = 'openconnect stopped.') {
  const lines = clean(log).split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  const bad = lines.filter((l) => /fail|error|unable|denied|refused|not supported|unknown|invalid|cannot/i.test(l));
  return (bad.length ? bad[bad.length - 1] : lines[lines.length - 1]) || fallback;
}

// o: spawn() → { onData, onExit, write, kill }; portOpen() → Promise<bool>;
// user and password (may be empty); emit(state) on every change; onUp() once it is up.
function start(o) {
  const st = { phase: 'starting', prompt: null, reason: '' };
  let buf = '', log = '', seq = 0, failed = false, stopping = false, timer = null, poll = null, ended = false;
  const auto = { username: false, password: false };
  const set = (patch) => { Object.assign(st, patch); o.emit({ ...st }); };
  const p = o.spawn();
  const write = (s) => { buf = ''; p.write(s + '\r'); };

  // A prompt is only acted on once the output pauses, so a line cut in two is not read as one.
  function look() {
    if (ended || st.phase === 'up') return;
    const pr = classifyPrompt(lastLine(buf));
    if (!pr) return;
    if (pr.kind === 'username' && o.user && !auto.username) { auto.username = true; write(o.user); return; }
    if (pr.kind === 'password' && o.password && !auto.password && !failed) { auto.password = true; write(o.password); set({ phase: 'waiting', prompt: null }); return; }
    const error = failed ? (pr.kind === 'password' ? 'The password was not accepted.' : 'Signing in failed; try again.') : '';
    failed = false;
    set({ phase: 'prompt', prompt: { id: ++seq, ...pr, error, saved: !!o.password } });
  }

  p.onData((d) => {
    log = (log + d).slice(-20000);
    buf = (buf + d).slice(-2000);
    if (FAILED.test(clean(d))) failed = true;
    clearTimeout(timer);
    timer = setTimeout(look, 250);
  });
  p.onExit(() => {
    ended = true;
    clearTimeout(timer); clearInterval(poll);
    if (stopping) set({ phase: 'stopped', prompt: null });
    else set({ phase: 'failed', prompt: null, reason: st.phase === 'up' ? 'The VPN tunnel closed: ' + reasonOf(log) : reasonOf(log) });
  });
  poll = setInterval(async () => {
    if (ended || st.phase === 'up' || !(await o.portOpen())) return;
    clearInterval(poll);
    set({ phase: 'up', prompt: null });
    if (o.onUp) o.onUp();
  }, 1000);
  o.emit({ ...st });

  return {
    state: () => ({ ...st }),
    log: () => clean(log),
    // The answer to prompt id; a code or password may be followed by an MFA wait.
    answer(id, value) {
      if (ended || st.phase !== 'prompt' || !st.prompt || st.prompt.id !== id) return false;
      const kind = st.prompt.kind;
      write(String(value));
      set({ phase: kind === 'password' || kind === 'code' ? 'waiting' : 'starting', prompt: null });
      return true;
    },
    // Ctrl-C lets openconnect sign the session off; it is killed if it does not stop.
    stop() {
      if (ended) return;
      stopping = true;
      try { p.write('\x03'); } catch {}
      setTimeout(() => { if (!ended) try { p.kill(); } catch {} }, 4000);
    },
    get ended() { return ended; }
  };
}

module.exports = { start, classifyPrompt, clean, lastLine, reasonOf };
