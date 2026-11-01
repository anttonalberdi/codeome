const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createService } = require('../main/remote-service');
const { createAuth, createLimiter } = require('../main/remote-auth');

function fixture(options = {}) {
  const config = { remote: { enabled: false, mode: 'serve', port: 0, hosts: [] } };
  const servers = [];
  const secrets = new Map();
  let devices = [];
  const calls = [];
  let auth;
  const service = createService({ createAuth: (settings) => { auth = createAuth(settings); return auth; },
    createLimiter, remote: options.remote || {}, sessions: new Map(),
    loadChat() {}, listChats() { return []; }, getConfig: () => config,
    getSecret: (key) => secrets.get(key) || '', setSecret: (key, value) => secrets.set(key, value),
    fetch: options.fetch, retryMs: options.retryMs,
    getDevices: () => devices, saveDevices: (value) => { devices = value; }, staticDir: '/unused',
    networkInterfaces: () => options.networkInterfaces ? options.networkInterfaces() : options.interfaces || {},
    fileExists: options.fileExists || (() => false),
    createServer() {
      const server = new EventEmitter();
      server.listens = [];
      server.closed = 0;
      server.connected = [];
      server.revoked = [];
      server.revokeDevice = (id) => { server.revoked.push(id); };
      server.listen = async (port, host) => {
        server.listens.push({ port, host });
        if (options.listenError) throw Object.assign(new Error('bind failed'), { code: options.listenError });
      };
      server.close = async () => { server.closed++; server.connected = []; };
      server.clients = () => server.connected;
      servers.push(server);
      return server;
    },
    execFile(file, args, settings, callback) {
      calls.push({ file, args, settings });
      if (options.execFile) options.execFile(file, args, callback);
      else callback(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    }
  });
  return { service, config, servers, calls, auth, secrets };
}

test('ntfy starts with the service, exposes on-demand actions, and never enters pairing', async () => {
  const registry = new EventEmitter();
  const requests = [];
  const f = fixture({ remote: { registry, sessions: new Map() },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200 }; } });
  f.config.remote.enabled = true;
  f.config.remote.ntfy = { enabled: true, server: 'https://ntfy.sh' };
  await f.service.sync();
  assert.equal(registry.listenerCount('added'), 1);
  const info = f.service.ntfy('reveal');
  assert.deepEqual(info, { server: 'https://ntfy.sh', topic: f.secrets.get('remote:ntfy:topic') });
  const pair = await f.service.pair();
  assert.equal(JSON.stringify(pair).includes(info.topic), false);
  assert.deepEqual(await f.service.ntfy('test'), { ok: true });
  assert.equal(requests[0].options.headers.Click, f.service.status().url);
  assert.notEqual(f.service.ntfy('regenerate').topic, info.topic);
  f.config.remote.ntfy.enabled = false;
  await f.service.sync();
  assert.equal(registry.listenerCount('added'), 0);
  assert.ok(f.service.ntfy('reveal').error);
  await f.service.stop();
});

test('disabled never listens; serve starts on loopback, stays idempotent, and stops', async () => {
  const f = fixture();
  await f.service.sync();
  assert.equal(f.servers.length, 0);
  assert.equal(f.service.status().listening, false);
  f.config.remote.enabled = true;
  const events = [];
  f.service.on('status-changed', (state) => events.push(state));
  await f.service.sync();
  assert.deepEqual(f.servers[0].listens, [{ port: 47821, host: '127.0.0.1' }]);
  assert.equal(f.service.status().url, 'http://127.0.0.1:47821');
  await f.service.sync();
  assert.equal(f.servers.length, 1);
  await f.service.stop();
  assert.equal(f.servers[0].closed, 1);
  assert.equal(f.service.status().listening, false);
  assert.ok(events.some((state) => state.listening));
  assert.ok(events.some((state) => !state.listening));
});

test('tailnet mode picks the first 100.64.0.0/10 address and has no fallback', async () => {
  const f = fixture({ interfaces: { lo: [{ family: 'IPv4', address: '127.0.0.1' }],
    utun: [{ family: 'IPv4', address: '100.99.4.7' }, { family: 'IPv4', address: '100.100.2.3' }] } });
  f.config.remote.enabled = true;
  f.config.remote.mode = 'tailnet';
  await f.service.sync();
  assert.deepEqual(f.servers[0].listens, [{ port: 47821, host: '100.99.4.7' }]);
  await f.service.stop();
  const absent = fixture({ interfaces: { en0: [{ family: 'IPv4', address: '192.168.1.4' }] } });
  absent.config.remote.enabled = true;
  absent.config.remote.mode = 'tailnet';
  await absent.service.sync();
  assert.equal(absent.servers.length, 0);
  assert.equal(absent.service.status().error, 'no-tailnet-address');
  assert.equal(absent.service.status().host, null);
  await absent.service.stop();
});

test('missing tailnet address retries while enabled and stops retrying after disable or stop', async () => {
  let interfaces = {};
  const f = fixture({ retryMs: 20, interfaces });
  f.config.remote.enabled = true;
  f.config.remote.mode = 'tailnet';
  await f.service.sync();
  assert.equal(f.service.status().error, 'no-tailnet-address');
  interfaces.utun = [{ family: 'IPv4', address: '100.99.4.7' }];
  await new Promise((resolve) => setTimeout(resolve, 65));
  assert.equal(f.service.status().listening, true);
  assert.equal(f.servers.length, 1);
  await f.service.stop();

  const absent = fixture({ retryMs: 20 });
  absent.config.remote.enabled = true;
  absent.config.remote.mode = 'tailnet';
  await absent.service.sync();
  absent.config.remote.enabled = false;
  await absent.service.sync();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(absent.servers.length, 0);
  await absent.service.stop();

  let probes = 0;
  const stopped = fixture({ retryMs: 20, networkInterfaces: () => { probes++; return {}; } });
  stopped.config.remote.enabled = true;
  stopped.config.remote.mode = 'tailnet';
  await stopped.service.sync();
  await stopped.service.stop();
  const before = probes;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(probes, before);
});

test('port and hosts changes restart; listen errors become status', async () => {
  const f = fixture();
  f.config.remote.enabled = true;
  await f.service.sync();
  f.config.remote.port = 50000;
  await f.service.sync();
  assert.equal(f.servers[0].closed, 1);
  assert.deepEqual(f.servers[1].listens, [{ port: 50000, host: '127.0.0.1' }]);
  f.config.remote.hosts = ['phone.example.test'];
  await f.service.sync();
  assert.equal(f.servers[1].closed, 1);
  assert.equal(f.servers.length, 3);
  await f.service.stop();
  const failed = fixture({ listenError: 'EADDRINUSE' });
  failed.config.remote.enabled = true;
  await assert.doesNotReject(failed.service.sync());
  assert.equal(failed.service.status().error, 'EADDRINUSE');
  assert.equal(failed.service.status().listening, false);
  assert.equal(failed.servers[0].closed, 1);
});

test('pairing payload uses a fragment, with MagicDNS HTTPS when known', async () => {
  const f = fixture({ execFile: (_file, args, callback) => {
    callback(null, args[0] === 'status' ? JSON.stringify({ Self: { DNSName: 'mac.tailnet.ts.net.' } }) : '{}');
  } });
  f.config.remote.enabled = true;
  await f.service.sync();
  const pair = await f.service.pair();
  assert.equal(pair.url, 'https://mac.tailnet.ts.net');
  assert.equal(pair.payload, `${pair.url}/#pair=${pair.code}`);
  assert.equal(new URL(pair.payload).search, '');
  assert.equal(new URL(pair.payload).hash, `#pair=${pair.code}`);
  assert.ok(pair.expiresAt > Date.now());
  await f.service.stop();
});

test('Serve refuses pairing without MagicDNS; tailnet pairing still uses its address', async () => {
  const serve = fixture();
  serve.config.remote.enabled = true;
  await serve.service.sync();
  assert.deepEqual(await serve.service.pair(), { error: 'no-magicdns' });
  await serve.service.stop();
  const tailnet = fixture({ interfaces: { utun: [{ family: 'IPv4', address: '100.99.4.7' }] } });
  tailnet.config.remote.enabled = true;
  tailnet.config.remote.mode = 'tailnet';
  await tailnet.service.sync();
  assert.equal((await tailnet.service.pair()).url, 'http://100.99.4.7:47821');
  await tailnet.service.stop();
});

test('tailscale reports when neither PATH nor the app has a CLI', async () => {
  const f = fixture();
  const state = await f.service.tailscale();
  assert.equal(state.installed, false);
  assert.equal(state.available, false);
  assert.equal(state.running, false);
  assert.equal(state.loggedIn, false);
  assert.equal(state.cliPath, null);
  assert.equal(state.command, null);
  assert.deepEqual(f.calls.map(({ file, args }) => [file, args]),
    [['tailscale', ['status', '--json']], ['tailscale', ['version']]]);
});

test('tailscale reports an installed CLI that needs sign-in', async () => {
  const f = fixture({ execFile: (_file, args, callback) => callback(null,
    args[0] === 'status' ? JSON.stringify({ BackendState: 'NeedsLogin' }) : '{}') });
  const state = await f.service.tailscale();
  assert.equal(state.installed, true);
  assert.equal(state.available, true);
  assert.equal(state.running, false);
  assert.equal(state.loggedIn, false);
  assert.equal(state.cliPath, 'tailscale');
  assert.equal(state.command, 'tailscale serve --bg --https=443 http://127.0.0.1:47821');
});

test('tailscale uses the PATH CLI when it is running', async () => {
  const f = fixture({ execFile: (_file, args, callback) => callback(null,
    args[0] === 'status' ? JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.tailnet.ts.net.' } }) : '{}') });
  const state = await f.service.tailscale();
  assert.equal(state.installed, true);
  assert.equal(state.running, true);
  assert.equal(state.loggedIn, true);
  assert.equal(state.cliPath, 'tailscale');
  assert.equal(state.dnsName, 'mac.tailnet.ts.net');
  assert.equal(state.command, 'tailscale serve --bg --https=443 http://127.0.0.1:47821');
});

test('tailscale uses the quoted app CLI and only fixed read commands', async () => {
  const app = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  const f = fixture({ fileExists: (file) => file === app, execFile: (file, args, callback) => {
    if (file === 'tailscale') return callback(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    callback(null, args[0] === 'status' ? JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.tailnet.ts.net.' } }) :
      JSON.stringify({ AllowFunnel: { 'mac.tailnet.ts.net:443': true } }));
  } });
  const state = await f.service.tailscale();
  assert.equal(state.installed, true);
  assert.equal(state.available, true);
  assert.equal(state.running, true);
  assert.equal(state.loggedIn, true);
  assert.equal(state.cliPath, app);
  assert.equal(state.dnsName, 'mac.tailnet.ts.net');
  assert.equal(state.funnel, true);
  assert.match(state.warning, /Funnel/);
  assert.equal(state.command, `"${app}" serve --bg --https=443 http://127.0.0.1:47821`);
  assert.deepEqual(f.calls.map(({ args }) => args), [['status', '--json'], ['version'], ['status', '--json'], ['serve', 'status', '--json']]);
  assert.ok(f.calls.every(({ settings }) => settings.timeout <= 3000));
  assert.ok(f.calls.every(({ args }) => !args.includes('--bg') && !args.includes('funnel')));
});

test('device connection changes emit status; rename and revoke update the public list', async () => {
  const f = fixture({ interfaces: { utun: [{ family: 'IPv4', address: '100.99.4.7' }] } });
  f.config.remote.enabled = true;
  f.config.remote.mode = 'tailnet';
  await f.service.sync();
  const { code } = await f.service.pair();
  const { deviceId } = f.auth.redeem(code, 'Phone');
  const events = [];
  f.service.on('status-changed', (state) => events.push(state));
  f.servers[0].connected = [{ id: deviceId, label: 'Phone' }];
  f.servers[0].emit('device-connected');
  assert.equal(events.at(-1).devices[0].connected, true);
  assert.equal(f.service.rename(deviceId, 'Tablet'), true);
  assert.equal(events.at(-1).devices[0].label, 'Tablet');
  f.servers[0].connected = [];
  f.servers[0].emit('device-disconnected');
  assert.equal(events.at(-1).devices[0].connected, false);
  assert.equal(f.service.revoke(deviceId), true);
  assert.deepEqual(f.servers[0].revoked, [deviceId]);
  assert.deepEqual(events.at(-1).devices, []);
  await f.service.stop();
});

test('invalid remote rules surface in status and stop listening', async () => {
  const registry = new EventEmitter();
  const f = fixture({ remote: { registry, sessions: new Map() } });
  f.config.remote.enabled = true;
  f.config.remote.ntfy = { enabled: true, server: 'https://ntfy.sh' };
  await f.service.sync();
  assert.equal(registry.listenerCount('added'), 1);
  f.config.remote.requireDesktopFor = [{ tool: 'Bash', pattern: '[' }];
  await f.service.sync();
  assert.match(f.service.status().error, /Invalid remote rule pattern/);
  assert.equal(f.service.status().listening, false);
  assert.equal(registry.listenerCount('added'), 0);
  await f.service.stop();
});

test('revokeAll ends each device stream through the service', async () => {
  const f = fixture();
  f.config.remote.enabled = true;
  await f.service.sync();
  const first = f.auth.createPairingCode();
  const a = f.auth.redeem(first.code, 'A');
  const second = f.auth.createPairingCode();
  const b = f.auth.redeem(second.code, 'B');
  f.service.revokeAll();
  assert.deepEqual(f.servers[0].revoked, [a.deviceId, b.deviceId]);
  assert.deepEqual(f.auth.listDevices(), []);
  await f.service.stop();
});
