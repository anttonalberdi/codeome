const os = require('node:os');
const fs = require('node:fs');
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

function serveArgs(port, httpsPort) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || ![443, 8443].includes(httpsPort)) return null;
  return ['serve', '--bg', `--https=${httpsPort}`, `http://127.0.0.1:${port}`];
}

function serveState(value, port, dnsName) {
  const target = `http://127.0.0.1:${port}`;
  const web = value?.Web && typeof value.Web === 'object' ? value.Web : {};
  const tcp = value?.TCP && typeof value.TCP === 'object' ? value.TCP : {};
  const entries = (httpsPort) => Object.entries(web).filter(([host]) => host.endsWith(`:${httpsPort}`));
  const used = (httpsPort) => Object.hasOwn(tcp, String(httpsPort)) || entries(httpsPort).length > 0;
  const ours = (httpsPort) => {
    const matches = entries(httpsPort);
    if (matches.length !== 1) return false;
    const handlers = matches[0][1]?.Handlers;
    return handlers && Object.keys(handlers).length === 1 && handlers['/']?.Proxy === target;
  };
  const others = [443, 8443].filter((httpsPort) => used(httpsPort) && !ours(httpsPort));
  const httpsPort = ours(443) ? 443 : ours(8443) ? 8443 : !used(443) ? 443 : !used(8443) ? 8443 : null;
  const state = httpsPort === null ? 'conflict' : ours(httpsPort) ? 'active' : 'off';
  return { state, httpsPort, url: state === 'active' && dnsName ?
    `https://${dnsName}${httpsPort === 443 ? '' : `:${httpsPort}`}` : null, others };
}

function serveFailure(cause) {
  const output = String(cause?.output || cause?.message || 'Tailscale Serve failed.');
  if (/serve is not enabled on your tailnet|https certificates?.*(?:not enabled|disabled|enable)|enable.*https certificates?/i.test(output)) {
    const link = (output.match(/https:\/\/[^\s<>"']+/g) || []).map((candidate) => {
      try {
        const url = new URL(candidate.replace(/[),.;]+$/, ''));
        return url.protocol === 'https:' && !url.username && !url.password &&
          (url.hostname === 'tailscale.com' || url.hostname.endsWith('.tailscale.com')) ? url.href : null;
      } catch { return null; }
    }).find(Boolean) || null;
    return { error: 'serve-not-enabled', link,
      message: 'Enable HTTPS Certificates in Tailscale, then press Set up Tailscale Serve again.' };
  }
  if (cause?.killed || cause?.code === 'ETIMEDOUT') return { error: 'timeout', message: 'Tailscale Serve timed out. Try again.' };
  return { error: 'failed', message: output.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim().slice(0, 200) };
}

function createService({ createServer, createAuth, createLimiter, remote, sessions, loadChat, listChats,
  getConfig, saveDevices, getDevices, getSecret, setSecret, staticDir,
  networkInterfaces = os.networkInterfaces, fileExists = fs.existsSync, execFile, send, fetch, logger, retryMs = 30000 }) {
  const service = new EventEmitter();
  const auth = createAuth({ store: { get: getDevices, set: saveDevices } });
  const limiter = createLimiter();
  let server = null;
  let binding = null;
  let listening = false;
  let error = null;
  let tailState = { installed: false, running: false, loggedIn: false, available: false, cliPath: null,
    dnsName: null, command: null, funnel: false, warning: null, known: false,
    serve: { state: 'off', httpsPort: 443, url: null, others: [] } };
  let queue = Promise.resolve();
  let tailQueue = Promise.resolve();
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
    if (binding.mode === 'serve' && tailState.dnsName) return `https://${tailState.dnsName}${tailState.serve.state === 'active' && tailState.serve.httpsPort !== 443 ? `:${tailState.serve.httpsPort}` : ''}`;
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
  function enqueueTail(action) {
    const result = tailQueue.then(action, action);
    tailQueue = result.then(() => {}, () => {});
    return result;
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
  // The Tailscale app binary only acts as a CLI in a terminal or with TAILSCALE_BE_CLI; a packaged app has neither.
  function run(file, args, timeout = 3000) {
    return new Promise((resolve, reject) => execFile(file, args, { timeout, windowsHide: true, env: { ...process.env, TAILSCALE_BE_CLI: '1' } },
      (cause, stdout, stderr) => {
        if (cause) { cause.output = `${stdout || ''}\n${stderr || ''}`; reject(cause); }
        else resolve(stdout);
      }));
  }
  async function readServeStatus(cliPath) {
    try {
      const value = JSON.parse(await run(cliPath, ['serve', 'status', '--json'], 15000));
      const known = !!value && typeof value === 'object' && !Array.isArray(value) &&
        ['Web', 'TCP'].every((key) => value[key] === undefined ||
          (value[key] !== null && typeof value[key] === 'object' && !Array.isArray(value[key])));
      return { value, known };
    } catch { return { value: null, known: false }; }
  }
  function mutationCliPath() {
    return ['/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', TAILSCALE_APP].find(fileExists) || null;
  }
  async function tailscaleRead() {
    const port = selectedPort();
    const appExists = fileExists(TAILSCALE_APP);
    let cliPath = null, info = null;
    for (const file of ['tailscale', ...(appExists ? [TAILSCALE_APP] : [])]) {
      try { info = JSON.parse(await run(file, ['status', '--json'])); cliPath = file; break; }
      catch {
        try { await run(file, ['version']); cliPath = file; break; }
        catch { /* Try the bundled CLI when the PATH command is absent or fails. */ }
      }
    }
    const { value: serve, known } = cliPath ? await readServeStatus(cliPath) : { value: null, known: false };
    const dnsName = typeof info?.Self?.DNSName === 'string' ? info.Self.DNSName.replace(/\.$/, '') : null;
    const funnel = funnelEnabled(serve);
    const installed = !!cliPath || appExists;
    const running = info?.BackendState === 'Running';
    const loggedIn = !!info && info.BackendState !== 'NeedsLogin';
    const serveInfo = serveState(serve, port, dnsName);
    const args = serveArgs(port, serveInfo.httpsPort);
    const command = cliPath && args ?
      `${cliPath === 'tailscale' ? 'tailscale' : '"' + cliPath + '"'} ${args.join(' ')}` : null;
    tailState = { installed, running, loggedIn, available: installed, cliPath, dnsName, command, funnel, known,
      warning: funnel ? 'Funnel is enabled; disable it to keep the companion private.' : null, serve: serveInfo };
    emitStatus();
    return { state: { ...tailState }, serveStatus: serve };
  }
  function tailscale() { return enqueueTail(async () => (await tailscaleRead()).state); }
  async function changedServe(state, original, port, cliPath) {
    if (selectedPort() !== port) return true;
    const current = await readServeStatus(cliPath);
    if (!current.known || JSON.stringify(current.value) !== JSON.stringify(original)) return true;
    const next = serveState(current.value, port, state.dnsName);
    return funnelEnabled(current.value) || next.state !== state.serve.state || next.httpsPort !== state.serve.httpsPort;
  }
  function serveSetup(expectedHttpsPort) { return enqueueTail(async () => {
    if (expectedHttpsPort !== undefined && ![443, 8443].includes(expectedHttpsPort)) return { error: 'invalid-action' };
    const port = selectedPort();
    if (!config().enabled || config().mode !== 'serve' || !listening ||
        binding?.mode !== 'serve' || binding.port !== port)
      return { error: 'not-listening', message: 'Turn on the phone companion in Serve mode first, then set up Tailscale Serve.' };
    const { state, serveStatus } = await tailscaleRead();
    if (!state.installed || !state.running || !state.loggedIn) return { error: 'not-ready', message: 'Open Tailscale and sign in on this Mac, then try again.' };
    if (!state.known) return { error: 'status-unavailable', message: 'Could not check Tailscale Serve status. Try again.' };
    if (state.funnel) return { error: 'funnel-enabled', message: 'Turn Tailscale Funnel off before changing Serve.' };
    if (!Number.isInteger(selectedPort()) || selectedPort() < 1 || selectedPort() > 65535)
      return { error: 'invalid-port', message: 'Enter a phone companion port from 1 to 65535.' };
    if (expectedHttpsPort !== undefined && expectedHttpsPort !== state.serve.httpsPort) return { error: 'changed' };
    if (state.serve.state === 'active') return { ok: true, serve: state.serve };
    if (state.serve.state === 'conflict') return { error: 'ports-busy', message: 'HTTPS ports 443 and 8443 already serve something else. Stop one of those mappings before trying again.' };
    const cliPath = mutationCliPath();
    if (!cliPath) return { error: 'no-cli-path', message: "Tailscale's command line tool was not found in a standard location. Install the Tailscale app or run the command yourself." };
    if (await changedServe(state, serveStatus, port, cliPath) || !config().enabled || config().mode !== 'serve' || !listening || binding?.port !== port)
      return { error: 'changed' };
    try { await run(cliPath, serveArgs(port, state.serve.httpsPort), 15000); }
    catch (cause) { return serveFailure(cause); }
    const checked = (await tailscaleRead()).state;
    if (!checked.known || checked.serve.state !== 'active' || checked.serve.httpsPort !== state.serve.httpsPort)
      return { error: 'failed', message: 'Tailscale did not confirm the new Serve mapping.' };
    return { ok: true, serve: checked.serve, warning: checked.warning };
  }); }
  function serveStop() { return enqueueTail(async () => {
    const port = selectedPort();
    const { state, serveStatus } = await tailscaleRead();
    if (!state.installed || !state.running || !state.loggedIn) return { error: 'not-ready', message: 'Open Tailscale and sign in on this Mac, then try again.' };
    if (!state.known) return { error: 'status-unavailable', message: 'Could not check Tailscale Serve status. Try again.' };
    if (state.funnel) return { error: 'funnel-enabled', message: 'Turn Tailscale Funnel off before changing Serve.' };
    if (state.serve.state !== 'active') return { ok: true, stopped: false, serve: state.serve };
    const cliPath = mutationCliPath();
    if (!cliPath) return { error: 'no-cli-path', message: "Tailscale's command line tool was not found in a standard location. Install the Tailscale app or run the command yourself." };
    if (await changedServe(state, serveStatus, port, cliPath)) return { error: 'changed' };
    try { await run(cliPath, ['serve', `--https=${state.serve.httpsPort}`, 'off'], 15000); }
    catch (cause) { return serveFailure(cause); }
    const checked = (await tailscaleRead()).state;
    if (!checked.known || checked.serve.state === 'active') return { error: 'failed', message: 'Tailscale did not confirm that sharing stopped.' };
    return { ok: true, stopped: true, serve: checked.serve };
  }); }
  Object.assign(service, { sync, stop, status, pair, revoke, revokeAll, rename, tailscale, serveSetup, serveStop, ntfy });
  return service;
}

module.exports = { createService };
