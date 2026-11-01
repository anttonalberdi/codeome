// Tab names: a chat starts out titled with the first words of its first message. After
// a few exchanges a small model proposes two 1-3 word names instead, offered as buttons.
// Only the user's messages are sent, trimmed, so a call is cheap.
const { oneShot } = require('./oneshot');

const PER_MESSAGE = 300;
const MAX_MESSAGES = 6;
const MAX_WORDS = 3;
const COUNT = 2;

function prompt(messages) {
  const text = messages.slice(0, MAX_MESSAGES).map((m) => '- ' + String(m).replace(/\s+/g, ' ').trim().slice(0, PER_MESSAGE)).join('\n');
  return 'You name tabs in a chat app. Below are the first messages a user sent to a coding agent.\n'
    + `Reply with ONLY a JSON array of ${COUNT} different tab names, each 1 to ${MAX_WORDS} words that say what the chat is about: plain words, no punctuation, no trailing period.\n\n`
    + '--- messages ---\n' + text;
}

// A JSON array of names, each cleaned to at most MAX_WORDS plain words; unusable ones dropped.
function clean(raw) {
  const words = String(raw).replace(/[*_`"'“”‘’#.]+/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length || words.length > MAX_WORDS) return '';
  const name = words.join(' ');
  return name.length > 40 ? '' : name;
}

function parse(out) {
  const m = /\[[\s\S]*\]/.exec(String(out || ''));
  let list;
  try { list = m ? JSON.parse(m[0]) : []; } catch { list = []; }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.filter((x) => typeof x === 'string').map(clean).filter((n) => {
    const k = n.toLowerCase();
    if (!n || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, COUNT);
}

async function suggestTitle({ messages, dir, bin, env, run = oneShot } = {}) {
  if (!Array.isArray(messages) || !messages.length) return [];
  try {
    const r = await run('claude', { prompt: prompt(messages), model: 'haiku', dir, bin, env, timeoutMs: 25000 });
    return parse(r && r.text);
  } catch { return []; }
}

module.exports = { suggestTitle, prompt, parse };
