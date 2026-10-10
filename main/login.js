// The shared HPC (and storage) connection, opened without a terminal. ssh runs on a
// hidden pty with -fN: once signed in it leaves the master connection running in the
// background and exits 0. Its prompts are read from the output and answered with the
// saved password, or passed to the window as dialogs (a password, a key's passphrase,
// a one-time code, a new host's fingerprint).
//
// Phases: starting → prompt ⇄ waiting → up, and stopped or failed when it ends.
const { clean, lastLine, reasonOf } = require('./vpn');

// What a prompt asks for: password | passphrase | hostkey | code (anything else, such
// as "Verification code:" or Duo's "Passcode or option (1-3):"). null when the line is
// not a prompt.
function classifyPrompt(line) {
  const s = String(line || '').trim();
  if (!s || s.length > 300) return null;
  if (/\(yes\/no(\/\[fingerprint\])?\)\?$/i.test(s)) return { kind: 'hostkey', label: 'Fingerprint' };
  if (!s.endsWith(':')) return null;
  const k = /^enter passphrase for(?: key)? '?(.+?)'?:$/i.exec(s);
  if (k) return { kind: 'passphrase', label: 'Passphrase', key: k[1] };
  if (/password:$/i.test(s) && !/one.time|otp|oath|second/i.test(s)) return { kind: 'password', label: 'Password' };
  const label = s.replace(/^\([^)]*\)\s*/, '').slice(0, -1).trim();
  return label ? { kind: 'code', label } : null;
}

const REJECTED = /permission denied|authentication failed|incorrect|invalid/i;
// Lines ssh prints on the way that are not why it stopped.
const NOISE = /^Warning: Permanently added|^\*\*|^@+$/;

function reason(log) {
  const lines = clean(log).split(/[\r\n]+/).filter((l) => !NOISE.test(l.trim())).join('\n');
  return reasonOf(lines, 'ssh stopped.');
}

// o: spawn() → { onData, onExit, write, kill }; verify() → Promise<bool> (the master
// answers); password (may be empty); emit(state) on every change; onUp() once it is up.
function start(o) {
  const st = { phase: 'starting', prompt: null, reason: '' };
  let buf = '', log = '', seq = 0, failed = false, sentPassword = false, stopping = false, timer = null, ended = false;
  const set = (patch) => { Object.assign(st, patch); o.emit({ ...st }); };
  const p = o.spawn();
  const write = (s) => { buf = ''; p.write(s + '\r'); };

  // A prompt is only acted on once the output pauses, so a line cut in two is not read as one.
  function look() {
    if (ended) return;
    const line = lastLine(buf);
    const pr = classifyPrompt(line);
    if (!pr) return;
    // Asked for the password again: the last one was wrong.
    if (pr.kind === 'password' && sentPassword) failed = true;
    if (pr.kind === 'password' && o.password && !sentPassword && !failed) { sentPassword = true; write(o.password); set({ phase: 'waiting', prompt: null }); return; }
    if (pr.kind === 'password') sentPassword = true;
    // The host key question comes after a few lines naming the host and its fingerprint.
    if (pr.kind === 'hostkey') { const t = clean(buf); pr.detail = t.slice(0, t.length - clean(line).length).trim(); }
    const error = failed ? (pr.kind === 'password' ? 'The password was not accepted.' : pr.kind === 'passphrase' ? 'The passphrase was not accepted.' : 'That was not accepted; try again.') : '';
    failed = false;
    set({ phase: 'prompt', prompt: { id: ++seq, ...pr, error, saved: !!o.password } });
  }

  p.onData((d) => {
    log = (log + d).slice(-20000);
    buf = (buf + d).slice(-2000);
    if (REJECTED.test(clean(d))) failed = true;
    clearTimeout(timer);
    timer = setTimeout(look, 250);
  });
  p.onExit(async ({ exitCode }) => {
    ended = true;
    clearTimeout(timer);
    if (stopping) return set({ phase: 'stopped', prompt: null });
    if (exitCode === 0 && await o.verify()) { set({ phase: 'up', prompt: null }); if (o.onUp) o.onUp(); return; }
    set({ phase: 'failed', prompt: null, reason: exitCode === 0 ? 'ssh signed in, but no shared connection was left open.' : reason(log) });
  });
  o.emit({ ...st });

  return {
    state: () => ({ ...st }),
    log: () => clean(log),
    // The answer to prompt id; after it ssh may wait, e.g. for an MFA approval.
    answer(id, value) {
      if (ended || st.phase !== 'prompt' || !st.prompt || st.prompt.id !== id) return false;
      write(String(value));
      set({ phase: 'waiting', prompt: null });
      return true;
    },
    stop() {
      if (ended) return;
      stopping = true;
      try { p.kill(); } catch {}
    },
    get ended() { return ended; }
  };
}

module.exports = { start, classifyPrompt, reason };
