// Suggested replies: when the agent's message ends in a question that carries no
// options of its own, a small model proposes a few short answers to click.
// Only the final message is sent, never the conversation, so a call is cheap.
const { oneShot } = require('./oneshot');

const TAIL = 1500;
const MAX = 4;
// A list item: "- x", "* x", "1. x", "2) x", "A. x", "(b) x".
const ITEM = /^\s*(?:[-*•]|\d{1,2}[.)]|\(?[A-Da-d][.)])\s+\S/;

function lines(text) { return String(text || '').replace(/```[\s\S]*?```/g, '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim()); }

// The message's last line is a question (markdown emphasis and closing quotes ignored).
function endsWithQuestion(text) {
  const last = lines(text).pop() || '';
  return /\?[\s*_`"')\]]*$/.test(last);
}

// The message already offers answers: a list of two or more items near its end.
function offersOptions(text) {
  const tail = lines(text).slice(-12);
  return tail.filter((l) => ITEM.test(l)).length >= 2;
}

function wanted(text) { return endsWithQuestion(text) && !offersOptions(text); }

function prompt(text) {
  const t = String(text).trim();
  return 'You write quick-reply buttons for a chat with a coding agent. Below is the agent\'s last message, which ends with a question.\n'
    + `Reply with ONLY a JSON array of 2 to ${MAX} strings: the most likely answers the user would click, each written in the user's voice, at most 8 words, no quotes inside.\n`
    + 'If the message already lists its own answer options, or the question is open-ended with no short answer, reply with [].\n\n'
    + '--- message ---\n' + (t.length > TAIL ? '…' + t.slice(-TAIL) : t);
}

function parse(out) {
  const m = /\[[\s\S]*\]/.exec(String(out || ''));
  if (!m) return [];
  let list;
  try { list = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.filter((s) => typeof s === 'string').map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => {
    const k = s.toLowerCase();
    if (!s || s.length > 80 || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, MAX);
}

async function suggest({ text, dir, bin, env, run = oneShot } = {}) {
  if (!wanted(text)) return [];
  try {
    const r = await run('claude', { prompt: prompt(text), model: 'haiku', dir, bin, env, timeoutMs: 25000 });
    const list = parse(r && r.text);
    return list.length >= 2 ? list : [];
  } catch { return []; }
}

module.exports = { suggest, wanted, endsWithQuestion, offersOptions, prompt, parse };
