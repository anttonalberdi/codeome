const { MODES, ENGINES } = require('./chat');

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const MODEL_RE = /^(?!-)[\w.:/[\]-]{1,80}$/;

function projectChat(cfg, project) {
  const app = (cfg && cfg.chat) || {};
  const override = (cfg && cfg.projectChat && cfg.projectChat[project]) || {};
  const valid = (key, value) => {
    if (typeof value !== 'string') return false;
    if (key === 'mode') return !value || MODES.includes(value);
    if (key === 'engine') return !value || ENGINES.includes(value);
    if (key === 'effort') return !value || EFFORTS.includes(value);
    if (key === 'codexEffort') return !value || CODEX_EFFORTS.includes(value);
    return !value || MODEL_RE.test(value);
  };
  return Object.fromEntries(['model', 'effort', 'codexModel', 'codexEffort', 'mode', 'engine'].map((key) => [key,
    valid(key, override[key]) && override[key] ? override[key] : valid(key, app[key]) ? app[key] : '']));
}

module.exports = projectChat;
