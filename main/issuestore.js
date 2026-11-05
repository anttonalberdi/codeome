// Issue text and per-project poll state live in a separate, private JSON file.
const defaultFs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ITEMS = 200;
const MAX_SEEN = 2000;
const STATUSES = new Set(['new', 'seen', 'dismissed', 'snoozed', 'done', 'in-progress']);
const EVICTION_ORDER = ['done', 'dismissed', 'seen', 'snoozed'];
const ACTIONS = new Set(['none', 'reply', 'fix', 'plan']);
const SIZES = new Set(['trivial', 'small', 'standard', 'large']);
const ISSUE_FIELDS = ['title', 'body', 'author', 'authorAssociation', 'url', 'createdAt', 'updatedAt', 'state'];

const validNumber = (number) => Number.isSafeInteger(number) && number > 0;
const emptyProject = () => ({ etag: null, enabledAt: null, lastSeen: {}, seenNumbers: [], items: [] });
const copy = (value) => JSON.parse(JSON.stringify(value));
const issueKey = (item) => String(item.updatedAt || '') + ':' + crypto.createHash('sha256')
  .update((item.title || '') + '\n' + (item.labels || []).join(',') + '\n' + (item.body || '')).digest('hex');
const oldest = (item) => Date.parse(item.createdAt) || Date.parse(item.updatedAt) || 0;
const newest = (item) => Date.parse(item.updatedAt) || Date.parse(item.createdAt) || 0;

function capItems(items) {
  if (items.length <= MAX_ITEMS) return items;
  const drops = items.filter((item) => EVICTION_ORDER.includes(item.status)).sort((a, b) =>
    EVICTION_ORDER.indexOf(a.status) - EVICTION_ORDER.indexOf(b.status) || oldest(a) - oldest(b));
  const removed = new Set(drops.slice(0, items.length - MAX_ITEMS));
  return items.filter((item) => !removed.has(item));
}

function safeIssueUrl(raw) {
  if (typeof raw !== 'string') return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function issueData(issue) {
  const item = { number: issue.number };
  for (const field of ISSUE_FIELDS) item[field] = typeof issue[field] === 'string' ? issue[field] : '';
  item.url = safeIssueUrl(item.url);
  item.labels = Array.isArray(issue.labels) ? issue.labels.filter((label) => typeof label === 'string') : [];
  return item;
}

function storedItem(item) {
  const clean = { ...issueData(item), status: STATUSES.has(item.status) ? item.status : 'new' };
  if (clean.status === 'snoozed') {
    if (Number.isFinite(item.until) && item.until > 0) clean.until = item.until;
    else clean.status = 'new';
  }
  if (clean.status === 'in-progress' && typeof item.chat === 'string') clean.chat = item.chat;
  if (item.triage && typeof item.triage === 'object' && !Array.isArray(item.triage)) clean.triage = item.triage;
  if (typeof item.triageKey === 'string') clean.triageKey = item.triageKey;
  if (item.autoTriaged === true) clean.autoTriaged = true;
  return clean;
}

function createIssueStore({ file, now = Date.now, fs = defaultFs }) {
  if (typeof file !== 'string' || !file) throw new TypeError('Issue store file is required.');
  let projects = Object.create(null);
  let triageRuns = [];

  function load() {
    projects = Object.create(null);
    triageRuns = [];
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) throw new Error('Issue store is too large.');
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!saved || typeof saved !== 'object' || Array.isArray(saved) ||
          !saved.projects || typeof saved.projects !== 'object' || Array.isArray(saved.projects)) throw new Error('Invalid issue store.');
      triageRuns = Array.isArray(saved.triageRuns) ? saved.triageRuns.filter((at) =>
        Number.isFinite(at) && at > now() - 86400000 && at <= now()).slice(-500) : [];
      for (const [project, record] of Object.entries(saved.projects)) {
        if (['__proto__', 'constructor', 'hasOwnProperty'].includes(project)) continue;
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid project state.');
        const state = emptyProject();
        state.etag = typeof record.etag === 'string' ? record.etag : null;
        state.enabledAt = typeof record.enabledAt === 'string' ? record.enabledAt : null;
        state.seenNumbers = Array.isArray(record.seenNumbers) ? [...new Set(record.seenNumbers.filter(validNumber))].slice(-MAX_SEEN) : [];
        state.lastSeen = record.lastSeen && typeof record.lastSeen === 'object' && !Array.isArray(record.lastSeen) ? record.lastSeen : {};
        state.items = Array.isArray(record.items) ? capItems(record.items.filter((item) => item && validNumber(item.number)).map(storedItem)) : [];
        projects[project] = state;
      }
    } catch (error) {
      projects = Object.create(null);
      triageRuns = [];
      if (error.code !== 'ENOENT') {
        try { fs.renameSync(file, file + '.bak'); fs.chmodSync(file + '.bak', 0o600); } catch {}
      }
    }
    expireSnoozes();
    return copy({ projects });
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ projects, triageRuns }), { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  }

  function requireProject(project) {
    if (typeof project !== 'string' || !project || ['__proto__', 'constructor', 'hasOwnProperty'].includes(project))
      throw new TypeError('Project path is required.');
    return projects[project];
  }

  function requireItem(project, number) {
    if (!validNumber(number)) throw new TypeError('Issue number must be a positive integer.');
    const item = requireProject(project)?.items.find((entry) => entry.number === number);
    if (!item) throw new Error('Issue not found.');
    return item;
  }

  function expireSnoozes() {
    let changed = false;
    for (const state of Object.values(projects)) for (const item of state.items) {
      if (item.status === 'snoozed' && item.until <= now()) {
        item.status = 'new';
        delete item.until;
        changed = true;
      }
    }
    if (changed) { try { save(); } catch {} }
  }

  function pollState(project) {
    const state = requireProject(project) || emptyProject();
    return copy({ etag: state.etag, enabledAt: state.enabledAt, lastSeen: state.lastSeen,
      seenNumbers: state.seenNumbers });
  }

  function enable(project) {
    requireProject(project);
    projects[project] = { ...emptyProject(), enabledAt: new Date(now()).toISOString() };
    save();
  }

  function disable(project) {
    requireProject(project);
    if (Object.hasOwn(projects, project)) { delete projects[project]; save(); }
  }

  function applyPoll(project, result) {
    const state = requireProject(project);
    const added = [], reopened = [];
    if (!state?.enabledAt || !result || result.error) return { added, reopened };
    if (typeof result.etag === 'string') state.etag = result.etag;
    const seen = new Set(state.seenNumbers);
    const incoming = new Map();
    for (const issue of [...(Array.isArray(result.new) ? result.new : []),
      ...(Array.isArray(result.updated) ? result.updated : [])]) {
      if (issue && validNumber(issue.number)) incoming.set(issue.number, issueData(issue));
    }
    for (const [number, data] of incoming) {
      let item = state.items.find((entry) => entry.number === number);
      if (!item && !seen.has(number)) {
        state.items = capItems(state.items);
        if (state.items.length >= MAX_ITEMS && !state.items.some((entry) => EVICTION_ORDER.includes(entry.status))) continue;
        item = { ...data, status: 'new' };
        state.items.push(item);
        state.items = capItems(state.items);
        added.push(number);
      } else if (item) {
        const changed = item.title !== data.title || item.body !== data.body || item.state !== data.state ||
          JSON.stringify(item.labels) !== JSON.stringify(data.labels);
        Object.assign(item, data);
        if (changed && ['dismissed', 'done', 'snoozed'].includes(item.status)) {
          item.status = 'new';
          delete item.until;
          reopened.push(number);
        }
      }
      if (!seen.has(number)) { seen.add(number); state.seenNumbers.push(number); }
      if (data.updatedAt) state.lastSeen[number] = data.updatedAt;
    }
    while (state.seenNumbers.length > MAX_SEEN) {
      const removed = state.seenNumbers.shift();
      delete state.lastSeen[removed];
    }
    state.items = capItems(state.items);
    save();
    const retained = new Set(state.items.map((item) => item.number));
    return { added: added.filter((number) => retained.has(number)), reopened: reopened.filter((number) => retained.has(number)) };
  }

  function setStatus(project, number, status, extra = {}) {
    if (!STATUSES.has(status)) throw new TypeError('Invalid issue status.');
    const item = requireItem(project, number);
    if (status === 'snoozed' && (!Number.isFinite(extra?.until) || extra.until <= 0))
      throw new TypeError('Snooze requires an until timestamp.');
    item.status = status;
    delete item.until;
    delete item.chat;
    if (status === 'snoozed') item.until = extra.until;
    if (status === 'in-progress' && typeof extra?.chat === 'string' && extra.chat) item.chat = extra.chat;
    save();
    return copy(item);
  }

  function setTriage(project, number, triage) {
    const item = requireItem(project, number);
    if (!triage || typeof triage !== 'object' || Array.isArray(triage)) throw new TypeError('Invalid triage.');
    const key = issueKey(item);
    const clean = { action: ACTIONS.has(triage.action) ? triage.action : 'none', at: now(), key };
    if (SIZES.has(triage.size)) clean.size = triage.size;
    for (const [field, limit] of Object.entries({ summary: 600, proposedPlan: 6000, draftReply: 4000 })) {
      if (typeof triage[field] === 'string') clean[field] = triage[field].slice(0, limit);
    }
    item.triage = clean;
    item.triageKey = key;
    save();
    return copy(clean);
  }

  function needsTriage(project, number) {
    const item = requireItem(project, number);
    return !item.triage || item.triageKey !== issueKey(item);
  }

  function markAutoTriaged(project, number) {
    const item = requireItem(project, number);
    item.autoTriaged = true;
    save();
  }

  function triageRunCount() {
    const length = triageRuns.length;
    triageRuns = triageRuns.filter((at) => at > now() - 86400000);
    if (triageRuns.length !== length) save();
    return triageRuns.length;
  }

  function recordTriageRun(cap) {
    if (triageRunCount() >= cap) return false;
    triageRuns.push(now());
    save();
    return true;
  }

  function list(project) {
    expireSnoozes();
    return copy((requireProject(project)?.items || []).slice().sort((a, b) => newest(b) - newest(a) || b.number - a.number));
  }

  function listAll() {
    expireSnoozes();
    return copy(Object.entries(projects).flatMap(([project, state]) =>
      state.items.map((item) => ({ ...item, project }))).sort((a, b) => newest(b) - newest(a) || b.number - a.number));
  }

  function unseenCount(project) { return list(project).filter((item) => item.status === 'new').length; }

  function markSeen(project, numbers) {
    if (!Array.isArray(numbers) || !numbers.every(validNumber)) throw new TypeError('Invalid issue numbers.');
    const state = requireProject(project);
    let changed = false;
    for (const item of state?.items || []) if (numbers.includes(item.number) && item.status === 'new') {
      item.status = 'seen';
      changed = true;
    }
    if (changed) save();
  }

  load();
  return { load, pollState, enable, disable, applyPoll, setStatus, setTriage, needsTriage,
    markAutoTriaged, triageRunCount, recordTriageRun,
    list, listAll, unseenCount, markSeen, tick: expireSnoozes };
}

module.exports = { createIssueStore };
