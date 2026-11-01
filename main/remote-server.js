const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { fromSaved, redact } = require('./remote-items');

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";
const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP };
const ID = /^[A-Za-z0-9._-]{1,128}$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PHONE_BASH_ALLOW = ['ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'git status', 'git diff', 'git log', 'git show', 'git branch', 'npm test', 'npm run test', 'node --test', 'pytest', 'grep', 'rg', 'find', 'which', 'date'];
const regexCache = new Map();

function validateRemoteConfig(remote) {
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return 'Invalid remote settings';
  const rules = remote?.requireDesktopFor;
  if (rules !== undefined && !Array.isArray(rules)) return 'Invalid remote.requireDesktopFor';
  for (const rule of rules || []) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) ||
        (rule.tool !== undefined && typeof rule.tool !== 'string') ||
        (rule.role !== undefined && typeof rule.role !== 'string') ||
        (rule.outsideProject !== undefined && typeof rule.outsideProject !== 'boolean') ||
        (rule.pattern !== undefined && typeof rule.pattern !== 'string')) return 'Invalid remote.requireDesktopFor rule';
    if (rule.pattern !== undefined) {
      if (rule.pattern.length > 1000) return 'Remote rule pattern is too long';
      try { new RegExp(rule.pattern); } catch { return 'Invalid remote rule pattern'; }
    }
  }
  if (remote?.phoneBashAllow !== undefined && (!Array.isArray(remote.phoneBashAllow) ||
      remote.phoneBashAllow.some((value) => typeof value !== 'string' || !/^[a-z][a-z0-9 -]{0,40}$/.test(value))))
    return 'Invalid remote.phoneBashAllow';
  return null;
}
function compiled(pattern) {
  if (!regexCache.has(pattern)) {
    regexCache.set(pattern, new RegExp(pattern));
    if (regexCache.size > 200) regexCache.delete(regexCache.keys().next().value);
  }
  return regexCache.get(pattern);
}

function tailnet(ip) {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}
function loopback(ip) { return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'; }
function clean(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, part] of Object.entries(value)) {
      if (/^(?:env|config|secrets?|hash|tokenHash)$/i.test(key)) { out[key] = '[REDACTED]'; continue; }
      out[key] = /(?:secret|token|password|api[_-]?key)/i.test(key) ? '[REDACTED]' : clean(part);
    }
    return out;
  }
  return value;
}
function staticName(raw) {
  if (raw === '/') return 'index.html';
  let name;
  try { name = decodeURIComponent(raw).slice(1); } catch { return null; }
  if (name.includes('\\') || name.includes('\0') || name.split('/').some((part) => part === '..' || part === '.')) return null;
  if (['index.html', 'app.js', 'app.css', 'render.js', 'md.js', 'manifest.webmanifest', 'sw.js'].includes(name)) return name;
  if (/^icons\/[A-Za-z0-9._-]+$/.test(name) && !name.startsWith('icons/.')) return name;
  return null;
}
function hostName(header) {
  if (typeof header !== 'string' || !header || header.includes(',') || header.includes('@')) return null;
  try {
    const url = new URL(`http://${header}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch { return null; }
}
function validOrigin(header, allowed, host) {
  try {
    const url = new URL(header);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
      url.pathname === '/' && !url.search && !url.hash && allowed.has(url.hostname.toLowerCase().replace(/\.$/, '')) &&
      (!new URL(`http://${host}`).port || !url.port || new URL(`http://${host}`).port === url.port);
  } catch { return false; }
}
function validImageId(value) {
  return ID.test(value) || /^([A-Za-z0-9._-]{1,128}):image:\d+$/.test(value);
}

function createServer({ auth, limiter, remote, sessions, loadChat, listChats, getConfig, staticDir, getTailnetDnsName = () => null, now = Date.now, heartbeatMs = 20000 }) {
  const emitter = new EventEmitter();
  const streams = new Set();
  const ring = [];
  const batchTimers = new Map();
  const listeners = [];
  let boundHost = null;
  let mode = null;
  let sequence = 0;
  let chatsCache = null;

  function json(res, status, body) {
    res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
  function error(res, status, code) { json(res, status, { error: code }); }
  function publish(type, data) {
    chatsCache = null;
    if (!streams.size) return;
    const event = { id: ++sequence, type, data: clean(data) };
    ring.push(event);
    if (ring.length > 200) ring.shift();
    for (const stream of streams) writeEvent(stream.res, event);
  }
  function writeEvent(res, event) {
    if (!res.destroyed && !res.writableEnded && res.writableLength < 1024 * 1024)
      res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
    else if (res.writableLength >= 1024 * 1024) res.destroy();
  }
  function on(source, event, handler) { source.on(event, handler); listeners.push([source, event, handler]); }
  on(remote.registry, 'added', (record) => publish('added', pendingItem(record)));
  on(remote.registry, 'decided', (event) => {
    publish('decided', event);
    if (event.source === 'phone') emitter.emit('decided-by-phone', clean(event));
  });
  on(remote.registry, 'cancelled', (event) => publish('cancelled', { chatId: event.chatId, requestId: event.requestId }));
  if (remote.events) {
    on(remote.events, 'chat-started', (chatId) => publish('chat-started', { chatId }));
    on(remote.events, 'chat-exit', (chatId) => publish('chat-exit', { chatId }));
    on(remote.events, 'message', (chatId) => {
      if (batchTimers.has(chatId)) return;
      batchTimers.set(chatId, setTimeout(() => {
        batchTimers.delete(chatId);
        const buffer = remote.buffers.get(chatId);
        if (buffer) publish('message-batch', { chatId, items: buffer.tail(100).items });
      }, 150));
    });
  }

  function chatInfo(chatId) { return remote.sessions?.get(chatId) || {}; }
  function projectOf(chatId) { return chatInfo(chatId).project || sessions.get(chatId)?.cwd || null; }
  function roleOf(chatId) { return chatInfo(chatId).role || sessions.get(chatId)?.role || ''; }
  function outsidePath(file, project) {
    if (typeof file !== 'string' || !file || file.includes('\0') || file.startsWith('~') || !project) return true;
    let root, target;
    try {
      root = fs.realpathSync(project);
      if (!fs.statSync(root).isDirectory()) return true;
      target = path.resolve(root, file);
      let ancestor = target;
      while (true) {
        try { fs.lstatSync(ancestor); break; }
        catch (cause) {
          if (cause.code !== 'ENOENT') return true;
          const parent = path.dirname(ancestor);
          if (parent === ancestor) return true;
          ancestor = parent;
        }
      }
      target = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, target));
    } catch { return true; }
    const relative = path.relative(root, target);
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  }
  function outsideProject(record) {
    const project = projectOf(record.chatId);
    if (!project) return true;
    const visit = (input) => {
      if (!input || typeof input !== 'object') return false;
      if (Array.isArray(input)) return input.some(visit);
      return Object.entries(input).some(([key, value]) => {
        if (['file_path', 'path', 'notebook_path', 'notebook', 'file', 'files'].includes(key))
          return Array.isArray(value) ? value.some((entry) => outsidePath(entry, project)) : outsidePath(value, project);
        return visit(value);
      });
    };
    return visit(record.input);
  }
  function hasPath(input) {
    if (!input || typeof input !== 'object') return false;
    if (Array.isArray(input)) return input.some(hasPath);
    return Object.entries(input).some(([key, value]) =>
      ['file_path', 'path', 'notebook_path', 'notebook', 'file', 'files'].includes(key) || hasPath(value));
  }
  function safeBash(command, allow, project) {
    if (typeof command !== 'string' || !command.trim() || /[\x00-\x1f;|&$()<>`'"\\]/.test(command)) return false;
    const args = command.trim().split(/ +/);
    if (args.some((arg) => arg === '..' || arg.includes('../') || /^-[A-Za-z]+\//.test(arg) ||
        arg.split('=').slice(1).some((part) => part.startsWith('~') || outsidePath(part, project)) ||
        (!arg.startsWith('-') && outsidePath(arg, project)))) return false;
    if (args[0] === 'find' && args.some((arg) => /^-(?:exec|ok|delete|fprint|fls)/.test(arg))) return false;
    if (args[0] === 'rg' && args.some((arg) => arg === '--pre' || arg.startsWith('--pre='))) return false;
    if (args[0] === 'date' && args.some((arg) => arg === '-s' || arg === '--set' || arg.startsWith('--set='))) return false;
    if (args[0] === 'git') {
      if (args.some((arg) => ['--ext-diff', '--output', '--output-indicator-new', '--output-indicator-old', '--output-indicator-context', '--textconv'].includes(arg) || arg.startsWith('--output=') || arg.startsWith('--ext-diff='))) return false;
      if (args[1] === 'branch' && args.slice(2).some((arg) => !['-a', '-r', '-v', '-vv', '--all', '--remotes', '--list', '--show-current'].includes(arg))) return false;
    }
    for (const entry of allow) {
      const words = entry.split(' ');
      if (words.every((word, index) => args[index] === word) &&
          (args.length === words.length || !['npm test', 'npm run test', 'pwd', 'date'].includes(entry))) return true;
    }
    return false;
  }
  function risk(record) {
    const settings = getConfig()?.remote;
    if (validateRemoteConfig(settings)) return 'needs-desktop';
    if (typeof record.toolName !== 'string' || !record.input || typeof record.input !== 'object' || Array.isArray(record.input)) return 'needs-desktop';
    let inputText;
    try { inputText = JSON.stringify(record.input); } catch { return 'needs-desktop'; }
    if (Buffer.byteLength(inputText, 'utf8') > 8192) return 'needs-desktop';
    if (inputText !== JSON.stringify(clean(record.input))) return 'redacted';
    const project = projectOf(record.chatId);
    if (outsideProject(record)) return 'needs-desktop';
    if (record.toolName === 'Bash') {
      if (!project || !safeBash(record.input.command, settings.phoneBashAllow || PHONE_BASH_ALLOW, project)) return 'needs-desktop';
    } else if (['Read', 'Glob', 'Grep', 'LS', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(record.toolName)) {
      if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(record.toolName) && !hasPath(record.input)) return 'needs-desktop';
    } else if (record.toolName !== 'AskUserQuestion') return 'needs-desktop';
    const rules = settings.requireDesktopFor || [];
    for (const rule of rules) {
      if (rule.tool && rule.tool !== record.toolName) continue;
      if (rule.role && rule.role !== roleOf(record.chatId)) continue;
      if (rule.outsideProject && !outsideProject(record)) continue;
      if (rule.pattern) {
        try { if (!compiled(rule.pattern).test(inputText)) continue; }
        catch { return 'needs-desktop'; }
      }
      return 'needs-desktop';
    }
    return null;
  }
  function truncated(record) {
    const buffer = remote.buffers.get(record.chatId);
    const item = buffer?.tail(2000).items.find((entry) => entry.requestId === record.requestId);
    return !item || !!item.truncated;
  }
  function pendingItem(record) {
    const reason = risk(record) || (truncated(record) ? 'truncated' : null);
    return { chatId: record.chatId, requestId: record.requestId, toolName: record.toolName,
      input: clean(record.input), title: clean(record.title || null),
      decisionReason: clean(record.decisionReason || null), createdAt: record.createdAt,
      needsDesktop: !!reason, reason };
  }
  function allChats() {
    if (chatsCache && now() - chatsCache.at < 3000) return chatsCache.value;
    const projects = new Set((getConfig()?.openProjects || []).filter((p) => typeof p === 'string'));
    for (const [id] of sessions) { const project = projectOf(id); if (project) projects.add(project); }
    const root = path.join(process.env.CODEOME_HOME || path.join(os.homedir(), '.codeome'), 'chats');
    try {
      for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const folder = path.join(root, dir.name);
        const files = fs.readdirSync(folder).filter((name) => name.endsWith('.json'));
        for (const file of files) {
          try {
            const saved = JSON.parse(fs.readFileSync(path.join(folder, file), 'utf8'));
            if (typeof saved.project === 'string') { projects.add(saved.project); break; }
          } catch {}
        }
      }
    } catch {}
    const byId = new Map();
    for (const project of projects) {
      let chats;
      try { chats = listChats(project) || []; } catch { continue; }
      for (const chat of chats) if (ID.test(chat.id) && (!byId.has(chat.id) || chat.updatedAt > byId.get(chat.id).updatedAt))
        byId.set(chat.id, { id: chat.id, title: chat.title || 'Untitled chat', project,
          engine: chat.engine || '', role: chat.role || '', running: false, pending: 0, updatedAt: chat.updatedAt || 0 });
    }
    for (const [id, session] of sessions) {
      if (!ID.test(id)) continue;
      const entry = chatInfo(id);
      const saved = byId.get(id);
      byId.set(id, { id, title: saved?.title || 'Untitled chat', project: projectOf(id) || '',
        engine: entry.engine || saved?.engine || '', role: entry.role || saved?.role || '', running: true,
        pending: remote.registry.list(id).length, updatedAt: now() });
    }
    const value = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100);
    chatsCache = { at: now(), value };
    return value;
  }
  function findSaved(id) {
    const chat = allChats().find((entry) => entry.id === id);
    if (!chat || !chat.project) return null;
    try { return loadChat(chat.project, id); } catch { return null; }
  }
  function bufferFor(id) {
    if (remote.buffers.has(id)) return remote.buffers.get(id);
    const saved = findSaved(id);
    return saved ? fromSaved(saved) : null;
  }
  async function body(req) {
    return new Promise((resolve, reject) => {
      let size = 0, chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024) { reject(413); req.resume(); return; }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reject(400);
          resolve(parsed);
        } catch { reject(400); }
      });
      req.on('error', () => reject(400));
      req.on('timeout', () => reject(408));
    });
  }
  function allowedHosts() {
    const allowed = new Set(['localhost', '127.0.0.1']);
    if (boundHost) allowed.add(boundHost.toLowerCase());
    const dnsName = getTailnetDnsName();
    if (typeof dnsName === 'string' && /^[A-Za-z0-9.-]+$/.test(dnsName)) allowed.add(dnsName.toLowerCase().replace(/\.$/, ''));
    const extras = getConfig()?.remote?.hosts;
    for (const host of Array.isArray(extras) ? extras : []) {
      if (typeof host === 'string' && /^[A-Za-z0-9.-]+$/.test(host)) allowed.add(host.toLowerCase().replace(/\.$/, ''));
    }
    return allowed;
  }
  function clientList() {
    const devices = new Map();
    for (const stream of streams) {
      const entry = devices.get(stream.device.id) || { id: stream.device.id, label: stream.device.label, connections: 0 };
      entry.connections++;
      devices.set(entry.id, entry);
    }
    return [...devices.values()];
  }
  function endStream(stream) {
    if (!streams.delete(stream)) return;
    clearInterval(stream.timer);
    if (!stream.res.destroyed && !stream.res.writableEnded) stream.res.end();
    if (!clientList().some((entry) => entry.id === stream.device.id)) emitter.emit('device-disconnected', stream.device);
  }
  function events(req, res, device, token) {
    if (streams.size >= 20 || [...streams].filter((stream) => stream.device.id === device.id).length >= 10) {
      error(res, 429, 'too-many-streams'); return;
    }
    req.setTimeout(0);
    res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    const lastId = Number(req.headers['last-event-id']);
    if (Number.isSafeInteger(lastId) && lastId >= 0) {
      for (const event of ring) if (event.id > lastId) writeEvent(res, event);
    }
    const stream = { res, device, token, timer: null };
    const first = !clientList().some((entry) => entry.id === device.id);
    streams.add(stream);
    if (first) emitter.emit('device-connected', device);
    stream.timer = setInterval(() => {
      if (!auth.verify(token).ok) { endStream(stream); return; }
      if (!res.destroyed) res.write(': heartbeat\n\n');
    }, heartbeatMs);
    res.on('close', () => endStream(stream));
  }
  async function handle(req, res) {
    req.setTimeout(15 * 1000);
    const ip = req.socket.remoteAddress || '';
    if (mode === 'serve' ? !loopback(ip) : !tailnet(ip)) { req.socket.destroy(); return; }
    const allowed = allowedHosts();
    if (!allowed.has(hostName(req.headers.host)) ||
        (req.headers.origin !== undefined && !validOrigin(req.headers.origin, allowed, req.headers.host))) {
      error(res, 403, 'forbidden'); return;
    }
    const rawPath = (req.url || '').split('?')[0];
    let decodedPath;
    try { decodedPath = decodeURIComponent(rawPath); } catch { error(res, 404, 'not-found'); return; }
    if (!rawPath.startsWith('/') || /%(?:2f|5c|00)/i.test(rawPath) || rawPath.includes('\\') ||
        decodedPath.split('/').some((part) => part === '..' || part === '.')) { error(res, 404, 'not-found'); return; }
    const asset = req.method === 'GET' ? staticName(rawPath) : null;
    if (asset) {
      const root = path.resolve(staticDir);
      const file = path.resolve(root, asset);
      if (!file.startsWith(`${root}${path.sep}`)) { error(res, 404, 'not-found'); return; }
      let real;
      try { real = fs.realpathSync(file); } catch { error(res, 404, 'not-found'); return; }
      if (!real.startsWith(`${fs.realpathSync(root)}${path.sep}`)) { error(res, 404, 'not-found'); return; }
      try {
        const data = fs.readFileSync(real);
        res.writeHead(200, { ...HEADERS, 'Content-Type': MIME[path.extname(real)] || 'application/octet-stream' });
        res.end(data);
      } catch { error(res, 404, 'not-found'); }
      return;
    }
    if (req.method === 'POST' && rawPath === '/pair') {
      if (!auth.pairingActive()) { error(res, 410, 'pairing-expired'); return; }
      const keys = ['pair', `pair-ip:${ip}`];
      if (keys.some((key) => !limiter.check(key).allowed)) { error(res, 429, 'rate-limited'); return; }
      let input;
      try { input = await body(req); } catch (status) { error(res, status, status === 413 ? 'too-large' : 'invalid'); return; }
      const result = auth.redeem(input.code, input.label, { ip });
      if (!result.ok) { keys.forEach((key) => limiter.fail(key)); error(res, 401, 'unauthorized'); return; }
      keys.forEach((key) => limiter.success(key));
      json(res, 200, { token: result.token, deviceId: result.deviceId }); return;
    }
    const presented = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    const token = presented && /^[A-Za-z0-9_-]+$/.test(presented) ? presented : null;
    const key = 'token-fail';
    const verified = auth.verify(token);
    if (!verified.ok) {
      if (!limiter.check(key).allowed) { error(res, 429, 'rate-limited'); return; }
      limiter.fail(key); error(res, 401, 'unauthorized'); return;
    }
    const device = verified.device;
    if (req.method === 'GET' && rawPath === '/api/events') { events(req, res, device, token); return; }
    if (req.method === 'GET' && rawPath === '/api/state') {
      json(res, 200, { chats: clean(allChats()), pending: remote.registry.list().map(pendingItem), now: now() }); return;
    }
    if (req.method === 'GET' && rawPath === '/api/devices') { json(res, 200, [{ id: device.id, label: device.label }]); return; }
    const revoke = /^\/api\/devices\/([^/]+)\/revoke$/.exec(rawPath);
    if (req.method === 'POST' && revoke) {
      if (!ID.test(revoke[1])) { error(res, 400, 'invalid'); return; }
      if (revoke[1] !== device.id) { error(res, 403, 'forbidden'); return; }
      auth.revoke(device.id);
      emitter.revokeDevice(device.id);
      json(res, 200, { ok: true }); return;
    }
    if (req.method === 'POST' && ['/api/decide', '/api/send', '/api/interrupt'].includes(rawPath)) {
      let input;
      try { input = await body(req); } catch (status) { error(res, status, status === 413 ? 'too-large' : 'invalid'); return; }
      if (!ID.test(input.chatId)) { error(res, 400, 'invalid'); return; }
      if (rawPath === '/api/decide') {
        if (!ID.test(input.requestId) || !['allow', 'deny'].includes(input.decision) ||
            input.updatedPermissions !== undefined || (input.message !== undefined && typeof input.message !== 'string') ||
            (input.answers !== undefined && (!input.answers || typeof input.answers !== 'object' || Array.isArray(input.answers)))) {
          error(res, 400, 'invalid'); return;
        }
        const record = remote.registry.list(input.chatId).find((entry) => entry.requestId === input.requestId);
        if (!record) {
          const status = remote.registry.wasDecided(input.chatId, input.requestId) ? 409 : 404;
          error(res, status, status === 409 ? 'already-decided' : 'not-found'); return;
        }
        if (input.decision === 'allow') {
          const reason = risk(record);
          if (reason) { error(res, 403, 'needs-desktop'); return; }
          if (truncated(record)) { error(res, 403, 'truncated'); return; }
        }
        const answer = input.decision === 'deny' ? { deny: true, message: input.message } :
          input.answers !== undefined ? { answers: input.answers } : { allow: true };
        const result = remote.registry.answer(input.chatId, input.requestId, answer, 'phone');
        if (!result.ok) {
          const status = result.reason === 'already-decided' ? 409 : result.reason === 'unknown' || result.reason === 'chat-mismatch' ? 404 : 400;
          error(res, status, status === 409 ? 'already-decided' : status === 404 ? 'not-found' : 'invalid'); return;
        }
        json(res, 200, { ok: true }); return;
      }
      const session = sessions.get(input.chatId);
      if (!session) { error(res, 404, 'not-found'); return; }
      if (rawPath === '/api/send') {
        if (['auto', 'bypassPermissions', 'acceptEdits'].includes(session.permissionMode)) { error(res, 403, 'needs-desktop-mode'); return; }
        if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 20000) { error(res, 400, 'invalid'); return; }
        try { session.user(input.text); remote.buffers.get(input.chatId)?.addUser(input.text, 'phone'); }
        catch { error(res, 500, 'failed'); return; }
        publish('message-batch', { chatId: input.chatId, items: remote.buffers.get(input.chatId)?.tail(1).items || [] });
        json(res, 200, { ok: true }); return;
      }
      try {
        const result = await session.control({ subtype: 'interrupt' });
        if (result?.error) { error(res, 500, 'failed'); return; }
      } catch { error(res, 500, 'failed'); return; }
      json(res, 200, { ok: true }); return;
    }
    const log = /^\/api\/chats\/([^/]+)\/log$/.exec(rawPath);
    const tool = /^\/api\/chats\/([^/]+)\/tool\/([^/]+)$/.exec(rawPath);
    const image = /^\/api\/chats\/([^/]+)\/image\/([^/]+)$/.exec(rawPath);
    if (req.method === 'GET' && (log || tool || image)) {
      let chatId, itemId;
      try { chatId = decodeURIComponent((log || tool || image)[1]);
        if (tool || image) itemId = decodeURIComponent((tool || image)[2]); }
      catch { error(res, 400, 'invalid'); return; }
      if (!ID.test(chatId) || (itemId && !(image ? validImageId(itemId) : ID.test(itemId)))) {
        error(res, 400, 'invalid'); return;
      }
      const buffer = bufferFor(chatId);
      if (!buffer) { error(res, 404, 'not-found'); return; }
      if (log) {
        const query = new URL(req.url, 'http://localhost').searchParams;
        const limitRaw = query.get('limit');
        const beforeRaw = query.get('before');
        const limit = limitRaw === null ? 40 : Number(limitRaw);
        const before = beforeRaw === null ? null : Number(beforeRaw);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
            (before !== null && (!Number.isSafeInteger(before) || before < 0))) { error(res, 400, 'invalid'); return; }
        json(res, 200, before === null ? buffer.tail(limit) : buffer.before(before, limit)); return;
      }
      if (tool) {
        const item = buffer.get(itemId);
        if (!item || !['tool', 'job', 'progress'].includes(item.t)) { error(res, 404, 'not-found'); return; }
        json(res, 200, { itemId, result: typeof item.result === 'string' ? item.result.slice(0, 4000) : '',
          size: item.size || 0, truncated: !!item.truncated }); return;
      }
      const stored = buffer.getImage(itemId);
      if (!stored || !IMAGE_MIME.has(stored.mime)) { error(res, 404, 'not-found'); return; }
      res.writeHead(200, { ...HEADERS, 'Content-Type': stored.mime });
      res.end(stored.data); return;
    }
    error(res, 404, 'not-found');
  }
  const server = http.createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch(() => { if (!res.headersSent) error(res, 500, 'failed'); else res.end(); });
  });
  server.requestTimeout = 15 * 1000;
  server.headersTimeout = 10 * 1000;
  server.maxConnections = 50;
  emitter.revokeDevice = (id) => { for (const stream of [...streams]) if (stream.device.id === id) endStream(stream); };
  emitter.risk = risk;
  emitter.listen = (port, host) => {
    const selectedMode = getConfig()?.remote?.mode || 'serve';
    if (!((selectedMode === 'serve' && host === '127.0.0.1') ||
          (selectedMode === 'tailnet' && tailnet(host)))) return Promise.reject(new Error('Invalid bind host'));
    mode = selectedMode;
    boundHost = host;
    return new Promise((resolve, reject) => {
      const failed = (err) => { server.off('listening', ready); reject(err); };
      const ready = () => { server.off('error', failed); resolve(server.address()); };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen(port, host);
    });
  };
  emitter.close = () => new Promise((resolve) => {
    for (const stream of [...streams]) endStream(stream);
    for (const timer of batchTimers.values()) clearTimeout(timer);
    batchTimers.clear();
    for (const [source, event, handler] of listeners) source.off(event, handler);
    if (!server.listening) { resolve(); return; }
    server.close(resolve);
  });
  emitter.address = () => server.address();
  emitter.clients = clientList;
  return emitter;
}

module.exports = { createServer, validateRemoteConfig, PHONE_BASH_ALLOW };
