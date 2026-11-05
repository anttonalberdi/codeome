const crypto = require('node:crypto');
const net = require('node:net');
const path = require('node:path');

const TOPIC_KEY = 'remote:ntfy:topic';
const COLLAPSE_MS = 5000;
const DEBOUNCE_MS = 30000;

function serverUrl(value, allowPrivate) {
  if (typeof value !== 'string') return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      url.search || url.hash) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!allowPrivate) {
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return null;
    const ip = net.isIP(host);
    if (ip === 4) {
      const [a, b] = host.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || a === 169 && b === 254 ||
          a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 ||
          host === '100.100.100.200') return null;
    } else if (ip === 6) {
      const lower = host.toLowerCase();
      if (lower === '::' || lower === '::1' || /^(?:fc|fd)[0-9a-f]{2}:/i.test(lower) ||
          /^fe[89ab][0-9a-f]:/i.test(lower)) return null;
      if (lower.startsWith('::ffff:')) return null;
    }
  }
  return url;
}

function projectName(value) {
  const folder = typeof value === 'string' ? path.basename(value) : '';
  return [...folder.replace(/[\x00-\x1f\x7f-\x9f]/g, '')].slice(0, 60).join('') || 'Project';
}

function issueNotificationText(project, count) {
  return `${count} new GitHub issue${count === 1 ? '' : 's'} in ${projectName(project)}`;
}

function createNotifier({ fetch: request = globalThis.fetch, getSecret, setSecret, now = Date.now,
  getConfig, isPhoneActive = () => false, getProject = () => '', getUrl = () => null,
  logger = console, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let registry = null;
  let timer = null;
  const waiting = new Map();
  const lastByChat = new Map();
  const issuesWaiting = new Map();
  const issueTimers = new Map();

  function settings() { return getConfig()?.remote || {}; }
  function getTopic() {
    let topic = getSecret(TOPIC_KEY);
    if (!topic) { topic = crypto.randomBytes(16).toString('base64url'); setSecret(TOPIC_KEY, topic); }
    return topic;
  }
  function regenerateTopic() {
    const topic = crypto.randomBytes(16).toString('base64url');
    setSecret(TOPIC_KEY, topic);
    return topic;
  }
  function subscribeInfo() { return { server: settings().ntfy?.server || 'https://ntfy.sh', topic: getTopic() }; }
  function logFailure(host) { try { logger.warn('ntfy notification failed', { host }); } catch {} }
  async function publish(body) {
    let host = 'invalid-server';
    try {
      const remote = settings();
      const server = remote.ntfy?.server || 'https://ntfy.sh';
      try { host = new URL(server).hostname || host; } catch {}
      const url = serverUrl(server, remote.ntfy?.allowPrivate === true);
      if (!url) { logFailure(host); return { ok: false, error: 'Invalid ntfy server.' }; }
      host = url.hostname;
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/${getTopic()}`;
      const click = getUrl();
      const headers = { Title: 'Codeome', Priority: 'default', Tags: 'bell' };
      if (typeof click === 'string' && /^https?:\/\//.test(click)) headers.Click = click;
      const response = await request(url.toString(), { method: 'POST', headers, body,
        signal: AbortSignal.timeout(5000), redirect: 'manual' });
      if (!response.ok || response.status >= 300) { logFailure(host); return { ok: false, error: 'ntfy request failed.' }; }
      return { ok: true };
    } catch {
      logFailure(host);
      return { ok: false, error: 'ntfy request failed.' };
    }
  }
  function flush() {
    timer = null;
    if (!waiting.size) return;
    const items = [...waiting];
    waiting.clear();
    try {
      if (settings().notifyOnlyWhenAway && isPhoneActive()) {
        for (const [chatId] of items) lastByChat.delete(chatId);
        return;
      }
      const body = items.length === 1 ? `${items[0][1]} needs a decision` : `${items.length} decisions are waiting`;
      void publish(body);
    } catch { logFailure('unknown'); }
  }
  function added(record) {
    try {
      if (!record || typeof record.chatId !== 'string') return;
      if (settings().notifyOnlyWhenAway && isPhoneActive()) return;
      const at = now();
      for (const [id, last] of lastByChat) if (at - last >= DEBOUNCE_MS) lastByChat.delete(id);
      if (lastByChat.has(record.chatId)) return;
      lastByChat.set(record.chatId, at);
      waiting.set(record.chatId, projectName(getProject(record.chatId)));
      if (!timer) timer = setTimer(flush, COLLAPSE_MS);
    } catch { logFailure('unknown'); }
  }
  function notifyIssues({ project, count } = {}) {
    try {
      if (typeof project !== 'string' || !project || !Number.isSafeInteger(count) || count <= 0 ||
          !settings().ntfy?.enabled || settings().notifyOnlyWhenAway && isPhoneActive()) return;
      issuesWaiting.set(project, (issuesWaiting.get(project) || 0) + count);
      if (!issueTimers.has(project)) issueTimers.set(project, setTimer(() => {
        issueTimers.delete(project);
        const total = issuesWaiting.get(project);
        issuesWaiting.delete(project);
        try {
          if (total && settings().ntfy?.enabled &&
              !(settings().notifyOnlyWhenAway && isPhoneActive())) void publish(issueNotificationText(project, total));
        } catch { logFailure('unknown'); }
      }, COLLAPSE_MS));
    } catch { logFailure('unknown'); }
  }
  function start(source) {
    if (registry === source) return;
    stop();
    getTopic();
    registry = source;
    registry.on('added', added);
  }
  function stop() {
    if (registry) registry.off('added', added);
    registry = null;
    if (timer) clearTimer(timer);
    timer = null;
    waiting.clear();
    lastByChat.clear();
    for (const id of issueTimers.values()) clearTimer(id);
    issueTimers.clear();
    issuesWaiting.clear();
  }
  function test() { return publish('Codeome test notification'); }
  return { start, stop, getTopic, regenerateTopic, subscribeInfo, test, notifyIssues };
}

module.exports = { createNotifier, issueNotificationText };
