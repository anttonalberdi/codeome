const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createNotifier } = require('./remote-ntfy');
const { validateRemoteConfig } = require('./remote-server');

const DEFAULT_PORT = 47821;
const TAILSCALE_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

function tailnetAddress(interfaces) {
  for (const entries of Object.values(interfaces || {})) for (const entry of entries || []) {
    if (entry.family !== 'IPv4' && entry.family !== 4) continue;
    const parts = entry.address?.split('.').map(Number);
    if (parts?.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
        parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return entry.address;
  }
  return null;
}

function funnelEnabled(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, part]) =>
    /funnel/i.test(key) ? part === true || (part && typeof part === 'object' && Object.values(part).some(Boolean)) :
      funnelEnabled(part));
}

function createService({ createServer, createAuth, createLimiter, remote, sessions, loadChat, listChats,
  getConfig, saveDevices, getDevices, getSecret, setSecret, staticDir,
  networkInterfaces = os.networkInterfaces, execFile, send, fetch, logger, retryMs = 30000 }) {
  const service = new EventEmitter();
  const auth = createAuth({ store: { get: getDevices, set: saveDevices } });
  const limiter = createLimiter();
  let server = null;
  let binding = null;
  let listening = false;
  let error = null;
  let tailState = { available: false, dnsName: null, command: null, funnel: false, warning: null };
  let queue = Promise.resolve();
  let notifier = null;
  let retryTimer = null;

  function updateRetry() {
    if (config().enabled && error === 'no-tailnet-address') {
      if (!retryTimer) {
        retryTimer = setInterval(() => { void sync(); }, retryMs);
        retryTimer.unref?.();
      }
    } else if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
  }

  function emitStatus() { service.emit('status-changed', status()); }
  function config() { return getConfig()?.remote || {}; }
  function selectedPort() { return config().port || DEFAULT_PORT; }
  function url() {
    if (!listening) return null;
    if (binding.mode === 'serve' && tailState.dnsName) return `https://${tailState.dnsName}`;
    return `http://${binding.host}:${binding.port}`;
  }
  function status() {
    const connected = new Set(server?.clients?.().map((device) => device.id) || []);
    return { enabled: !!config().enabled, listening, mode: config().mode || 'serve',
      host: binding?.host || null, port: binding?.port || selectedPort(), url: url(), error: validateRemoteConfig(getConfig()?.remote) || error,
      devices: auth.listDevices().map(({ id, label, createdAt, lastSeen }) =>
        ({ id, label, createdAt, lastSeen, connected: connected.has(id) })),
      tailscale: { ...tailState } };
  }
  function syncNotifier() {
    if (!config().ntfy?.enabled) { notifier?.stop(); return; }
    if (!notifier) notifier = createNotifier({ fetch, getSecret, setSecret, getConfig,
      getProject: (chatId) => remote.sessions?.get(chatId)?.project || sessions.get(chatId)?.cwd,
      getUrl: url, isPhoneActive: () => {
        const recent = new Set(auth.listDevices().filter((device) => Date.now() - device.lastSeen < 120000)
          .map((device) => device.id));
        return !!server?.clients?.().some((device) => recent.has(device.id));
      }, logger });
    if (listening) notifier.start(remote.registry);
    else { notifier.stop(); notifier.getTopic(); }
  }
  async function close() {
    if (!server) return;
    const old = server;
    server = null;
    listening = false;
    binding = null;
    try { await old.close(); } finally { emitStatus(); }
  }
  function enqueue(action) {
    queue = queue.then(action, action);
    return queue;
  }
  function sync() { return enqueue(async () => {
    const settings = config();
    const configError = validateRemoteConfig(getConfig()?.remote);
    if (configError) { await close(); notifier?.stop(); error = configError; updateRetry(); emitStatus(); return status(); }
    if (!settings.enabled) {
      await close();
      syncNotifier();
      if (error) { error = null; emitStatus(); }
      updateRetry();
      return status();
    }
    const mode = settings.mode || 'serve';
    const port = selectedPort();
    const host = mode === 'serve' ? '127.0.0.1' : mode === 'tailnet' ? tailnetAddress(networkInterfaces()) : null;
    const hosts = JSON.stringify(settings.hosts || []);
    if (listening && binding.mode === mode && binding.port === port && binding.host === host && binding.hosts === hosts) {
      syncNotifier();
      updateRetry();
      return status();
    }
    await close();
    notifier?.stop();
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      error = !host ? mode === 'tailnet' ? 'no-tailnet-address' : 'invalid-mode' : 'invalid-port';
      syncNotifier();
      updateRetry();
      emitStatus();
      return status();
    }
    const next = { mode, host, port, hosts };
    let candidate;
    try {
      candidate = createServer({ auth, limiter, remote, sessions, loadChat, listChats, getConfig, staticDir, send,
        getTailnetDnsName: () => tailState.dnsName });
      candidate.on('device-connected', emitStatus);
      candidate.on('device-disconnected', emitStatus);
      await candidate.listen(port, host);
      server = candidate;
      binding = next;
      listening = true;
      error = null;
    } catch (cause) {
      error = cause?.code || cause?.message || String(cause);
      try { await candidate?.close(); } catch {}
    }
    syncNotifier();
    updateRetry();
    emitStatus();
    return status();
  }); }
  function stop() { return enqueue(async () => { clearInterval(retryTimer); retryTimer = null; notifier?.stop(); await close(); return status(); }); }
  function ntfy(action) {
    if (!config().ntfy?.enabled || !notifier) return { error: 'ntfy is disabled.' };
    if (action === 'reveal') return notifier.subscribeInfo();
    if (action === 'regenerate') { notifier.regenerateTopic(); return notifier.subscribeInfo(); }
    if (action === 'test') return notifier.test();
    return { error: 'Invalid ntfy action.' };
  }
  async function pair() {
    if (!listening) return { error: 'not-listening' };
    if (binding.mode === 'serve') {
      await tailscale();
      if (!tailState.dnsName) return { error: 'no-magicdns' };
    }
    const { code, expiresAt } = auth.createPairingCode();
    const base = url();
    return { code, expiresAt, url: base, payload: `${base}/#pair=${code}` };
  }
  function revoke(id) { const result = auth.revoke(id); if (result) { server?.revokeDevice?.(id); emitStatus(); } return result; }
  function revokeAll() { for (const device of auth.listDevices()) server?.revokeDevice?.(device.id); auth.revokeAll(); emitStatus(); }
  function rename(id, label) { const result = auth.rename(id, label); if (result) emitStatus(); return result; }
  function run(file, args) {
    return new Promise((resolve, reject) => execFile(file, args, { timeout: 3000, windowsHide: true },
      (cause, stdout) => cause ? reject(cause) : resolve(stdout)));
  }
  async function tailscale() {
    const port = selectedPort();
    const command = Number.isInteger(port) && port > 0 && port <= 65535 ?
      `tailscale serve --bg --https=443 http://127.0.0.1:${port}` : null;
    let cli = null, info = null;
    for (const file of ['tailscale', TAILSCALE_APP]) {
      try { info = JSON.parse(await run(file, ['status', '--json'])); cli = file; break; }
      catch { /* Try the bundled CLI when the PATH command is absent or fails. */ }
    }
    let serve = null;
    if (cli) try { serve = JSON.parse(await run(cli, ['serve', 'status', '--json'])); } catch {}
    const dnsName = typeof info?.Self?.DNSName === 'string' ? info.Self.DNSName.replace(/\.$/, '') : null;
    const funnel = funnelEnabled(serve);
    tailState = { available: !!cli, dnsName, command, funnel,
      warning: funnel ? 'Funnel is enabled; disable it to keep the companion private.' : null };
    emitStatus();
    return { ...tailState };
  }
  Object.assign(service, { sync, stop, status, pair, revoke, revokeAll, rename, tailscale, ntfy });
  return service;
}

module.exports = { createService };
