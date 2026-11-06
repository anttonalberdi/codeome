// Shared by the main process and renderer; the main process always resolves settings again.
const NotifySettings = (() => {
  const DEFAULTS = Object.freeze({
    enabled: true,
    events: Object.freeze({ finished: true, ask: true, approval: true, incoming: true }),
    onlyUnfocused: true,
    minSeconds: 30,
    sound: true,
    quietHours: Object.freeze({ enabled: false, start: '22:00', end: '08:00' })
  });
  const EVENTS = ['finished', 'ask', 'approval', 'incoming'];
  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
  const own = (value, key) => value != null && Object.hasOwn(value, key);
  const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const seconds = (value) => typeof value === 'number' && Number.isFinite(value) ? Math.max(5, Math.min(600, Math.round(value))) : null;
  const boolean = (value, fallback) => typeof value === 'boolean' ? value : fallback;

  function sanitize(value) {
    const input = object(value) ? value : {};
    const events = object(input.events) ? input.events : {};
    const quiet = object(input.quietHours) ? input.quietHours : {};
    const out = {
      enabled: boolean(input.enabled, DEFAULTS.enabled),
      events: {},
      onlyUnfocused: boolean(input.onlyUnfocused, DEFAULTS.onlyUnfocused),
      minSeconds: seconds(input.minSeconds) ?? DEFAULTS.minSeconds,
      sound: boolean(input.sound, DEFAULTS.sound),
      quietHours: {
        enabled: boolean(quiet.enabled, DEFAULTS.quietHours.enabled),
        start: own(quiet, 'start') && typeof quiet.start === 'string' && TIME.test(quiet.start) ? quiet.start : DEFAULTS.quietHours.start,
        end: own(quiet, 'end') && typeof quiet.end === 'string' && TIME.test(quiet.end) ? quiet.end : DEFAULTS.quietHours.end
      }
    };
    for (const key of EVENTS) out.events[key] = boolean(events[key], DEFAULTS.events[key]);
    return out;
  }

  function override(value) {
    if (!object(value)) return {};
    const out = {};
    for (const key of ['enabled', 'onlyUnfocused', 'sound'])
      if (own(value, key) && typeof value[key] === 'boolean') out[key] = value[key];
    if (own(value, 'minSeconds') && seconds(value.minSeconds) !== null) out.minSeconds = seconds(value.minSeconds);
    if (object(value.events)) {
      const events = {};
      for (const key of EVENTS) if (own(value.events, key) && typeof value.events[key] === 'boolean') events[key] = value.events[key];
      if (Object.keys(events).length) out.events = events;
    }
    if (object(value.quietHours)) {
      const quiet = {};
      if (own(value.quietHours, 'enabled') && typeof value.quietHours.enabled === 'boolean') quiet.enabled = value.quietHours.enabled;
      for (const key of ['start', 'end'])
        if (own(value.quietHours, key) && typeof value.quietHours[key] === 'string' && TIME.test(value.quietHours[key])) quiet[key] = value.quietHours[key];
      if (Object.keys(quiet).length) out.quietHours = quiet;
    }
    return out;
  }

  function sanitizeProject(value) {
    if (!object(value)) return {};
    const out = {};
    let count = 0;
    for (const [project, entry] of Object.entries(value)) {
      if (count >= 500) break;
      if (!project.startsWith('/') || project.length > 4096 || ['__proto__', 'constructor', 'prototype'].includes(project)) continue;
      const clean = override(entry);
      if (Object.keys(clean).length) { out[project] = clean; count++; }
    }
    return out;
  }

  function effective(cfg, cwd) {
    const base = sanitize(cfg && own(cfg, 'notifications') ? cfg.notifications : undefined);
    const projects = cfg && own(cfg, 'projectNotify') && object(cfg.projectNotify) ? cfg.projectNotify : {};
    const entry = typeof cwd === 'string' && cwd.length <= 4096 && own(projects, cwd) ? override(projects[cwd]) : {};
    return { ...base, ...entry, events: { ...base.events, ...entry.events },
      quietHours: { ...base.quietHours, ...entry.quietHours } };
  }

  function isQuiet(quietHours, date) {
    if (!quietHours || !quietHours.enabled) return false;
    if (typeof quietHours.start !== 'string' || typeof quietHours.end !== 'string' ||
        !TIME.test(quietHours.start) || !TIME.test(quietHours.end)) return false;
    const start = Number(quietHours.start.slice(0, 2)) * 60 + Number(quietHours.start.slice(3));
    const end = Number(quietHours.end.slice(0, 2)) * 60 + Number(quietHours.end.slice(3));
    if (start === end) return false;
    const now = date.getHours() * 60 + date.getMinutes();
    return start < end ? now >= start && now < end : now >= start || now < end;
  }

  const LABELS = { finished: 'agent finished', error: 'agent stopped with an error',
    ask: 'needs your input', approval: 'approval needed', incoming: 'new message' };
  const label = (kind) => Object.hasOwn(LABELS, kind) ? LABELS[kind] : '';
  function body(project, kind, merged = false) {
    const parts = typeof project === 'string' ? project.replace(/\/+$/, '').split('/') : [];
    const raw = (parts[parts.length - 1] || '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/gu, ' ').trim();
    const chars = Array.from(raw);
    const name = !raw || raw === '.' || raw === '..' ? 'Codeome project' : chars.length > 60 ? chars.slice(0, 59).join('') + '…' : raw;
    return `${name}: ${merged ? 'new activity' : label(kind)}`;
  }

  return { DEFAULTS, sanitize, sanitizeProject, effective, isQuiet, label, body };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = NotifySettings;
if (typeof App !== 'undefined') App.notifySettings = NotifySettings;
