// Short identifiers shared by the chat renderer and the main process.
const ChatCode = (() => {
  const ALPHABET = 'BCDFGHJKMNPRSTVWXZ';
  const BLOCKED = new Set(['BDSM', 'KKKK', 'XXXX']);
  const SIZE = ALPHABET.length ** 4;

  const isCode = (s) => typeof s === 'string' && s.length === 4 && [...s].every((c) => ALPHABET.includes(c));
  const normalise = (s) => {
    const code = typeof s === 'string' ? s.trim().toUpperCase() : '';
    return isCode(code) ? code : '';
  };

  function generate(taken, rand = Math.random) {
    const used = new Set(taken || []);
    for (let attempt = 0; attempt < 1000; attempt++) {
      const code = Array.from({ length: 4 }, () => ALPHABET[Math.floor(rand() * ALPHABET.length)]).join('');
      if (isCode(code) && !BLOCKED.has(code) && !used.has(code)) return code;
    }
    for (let n = 0; n < SIZE; n++) {
      let value = n, code = '';
      for (let i = 0; i < 4; i++) { code = ALPHABET[value % ALPHABET.length] + code; value = Math.floor(value / ALPHABET.length); }
      if (!BLOCKED.has(code) && !used.has(code)) return code;
    }
    throw new Error('No chat codes available.');
  }

  return { ALPHABET, isCode, generate, normalise };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ChatCode;
if (typeof App !== 'undefined') App.chatCode = ChatCode;
