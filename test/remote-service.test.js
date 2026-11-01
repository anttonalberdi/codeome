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
    fileExists: options.fileExists || ((file) => file === '/opt/homebrew/bin/tailscale'),
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
  assert.deepEqual(f.calls.map(({ settings }) => settings.timeout), [3000, 3000, 3000, 15000]);
  assert.ok(f.calls.every(({ args }) => !args.includes('--bg') && !args.includes('funnel')));
});

async function serveFixture(initial = {}, options = {}) {
  let serve = initial;
  const f = fixture({ execFile: (_file, args, callback) => {
    if (args[0] === 'status') return callback(null, JSON.stringify({ BackendState: options.backend || 'Running',
      Self: { DNSName: 'mac.tailnet.ts.net.' } }));
    if (args[0] === 'serve' && args[1] === 'status') return callback(null, JSON.stringify(serve));
    if (options.failure) return callback(options.failure.cause, options.failure.stdout || '', options.failure.stderr || '');
    if (args.includes('--bg')) {
      const httpsPort = args[2].split('=')[1];
      serve = { TCP: { ...serve.TCP, [httpsPort]: { HTTPS: true } },
        Web: { ...serve.Web, [`mac.tailnet.ts.net:${httpsPort}`]: { Handlers: { '/': { Proxy: args[3] } } } } };
    } else if (args.at(-1) === 'off') {
      const httpsPort = args[1].split('=')[1];
      const web = { ...serve.Web };
      delete web[`mac.tailnet.ts.net:${httpsPort}`];
      const tcp = { ...serve.TCP };
      delete tcp[httpsPort];
      serve = { TCP: tcp, Web: web };
    }
    callback(null, '');
  } });
  const writes = () => f.calls.filter(({ args }) => args[0] === 'serve' && args[1] !== 'status');
  f.config.remote.enabled = true;
  await f.service.sync();
  return { ...f, writes };
}

const own443 = { TCP: { 443: { HTTPS: true } }, Web: {
  'mac.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:47821' } } } } };
const busy443 = { TCP: { 443: { HTTPS: true } }, Web: {
  'other.tailnet.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } };

test('Serve setup and stop use exact fixed argv, and pairing uses the active HTTPS port', async () => {
  for (const [initial, httpsPort] of [[{}, 443], [busy443, 8443]]) {
    const f = await serveFixture(initial);
    const events = [];
    f.service.on('status-changed', (state) => events.push(state));
    const before = await f.service.tailscale();
    assert.equal(before.serve.httpsPort, httpsPort);
    assert.equal(before.command, `tailscale serve --bg --https=${httpsPort} http://127.0.0.1:47821`);
    assert.equal((await f.service.serveSetup()).ok, true);
    assert.deepEqual(f.writes()[0].args, ['serve', '--bg', `--https=${httpsPort}`, 'http://127.0.0.1:47821']);
    assert.equal(f.writes()[0].file, '/opt/homebrew/bin/tailscale');
    assert.equal(f.writes()[0].settings.timeout, 15000);
    const pair = await f.service.pair();
    assert.equal(pair.url, `https://mac.tailnet.ts.net${httpsPort === 443 ? '' : ':8443'}`);
    assert.equal(pair.payload, `${pair.url}/#pair=${pair.code}`);
    assert.equal((await f.service.serveStop()).stopped, true);
    assert.deepEqual(f.writes()[1].args, ['serve', `--https=${httpsPort}`, 'off']);
    assert.equal(f.writes()[1].file, '/opt/homebrew/bin/tailscale');
    assert.equal(f.writes()[1].settings.timeout, 15000);
    assert.ok(events.some((state) => state.tailscale.serve.state === 'active'));
    assert.ok(events.some((state) => state.tailscale.serve.state === 'off'));
    assert.ok(f.calls.every(({ args }) => !args.some((arg) => arg.includes('funnel'))));
    await f.service.stop();
  }
});

test('Serve setup is idempotent and does not replace occupied mappings', async () => {
  const own = await serveFixture(own443);
  assert.equal((await own.service.serveSetup()).serve.state, 'active');
  assert.equal(own.writes().length, 0);
  const both = await serveFixture({ TCP: { ...busy443.TCP, 8443: { HTTPS: true } }, Web: {
    ...busy443.Web, 'other.tailnet.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9998' } } } } });
  assert.equal((await both.service.tailscale()).serve.state, 'conflict');
  assert.equal((await both.service.serveSetup()).error, 'ports-busy');
  assert.equal(both.writes().length, 0);
  assert.equal((await both.service.serveStop()).stopped, false);
  assert.equal(both.writes().length, 0);
  const other = await serveFixture(busy443);
  assert.equal((await other.service.serveStop()).stopped, false);
  assert.equal(other.writes().length, 0);
});

test('Serve treats malformed status as unavailable and uses the bundled CLI when needed', async () => {
  const malformed = await serveFixture({ Web: [] });
  assert.equal((await malformed.service.serveSetup()).error, 'status-unavailable');
  assert.equal(malformed.writes().length, 0);
  const app = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  let serve = {};
  const bundled = fixture({ fileExists: (file) => file === app, execFile: (file, args, callback) => {
    if (file === 'tailscale') return callback(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    if (args[0] === 'status') return callback(null, JSON.stringify({ BackendState: 'Running' }));
    if (args[1] === 'status') return callback(null, JSON.stringify(serve));
    serve = own443;
    callback(null, '');
  } });
  bundled.config.remote.enabled = true;
  await bundled.service.sync();
  assert.equal((await bundled.service.serveSetup()).ok, true);
  const write = bundled.calls.find(({ args }) => args.includes('--bg'));
  assert.equal(write.file, app);
  assert.deepEqual(write.args, ['serve', '--bg', '--https=443', 'http://127.0.0.1:47821']);
});

test('Serve refuses changes when Tailscale is not signed in or Funnel is enabled', async () => {
  const signedOut = await serveFixture({}, { backend: 'NeedsLogin' });
  assert.equal((await signedOut.service.serveSetup()).error, 'not-ready');
  assert.equal(signedOut.writes().length, 0);
  const funnel = await serveFixture({ AllowFunnel: { 'mac.tailnet.ts.net:443': true } });
  assert.equal((await funnel.service.serveSetup()).error, 'funnel-enabled');
  assert.match((await funnel.service.serveStop()).message, /Turn Tailscale Funnel off/);
  assert.equal(funnel.writes().length, 0);
  const activeFunnel = await serveFixture({ ...own443, AllowFunnel: { 'mac.tailnet.ts.net:443': true } });
  assert.equal((await activeFunnel.service.serveStop()).error, 'funnel-enabled');
  assert.equal(activeFunnel.writes().length, 0);
});

test('Serve failure handles certificate links, timeouts, and sanitized output', async () => {
  for (const [output, link] of [
    ['Serve is not enabled on your tailnet. https://evil-tailscale.com/ https://login.tailscale.com/a', 'https://login.tailscale.com/a'],
    ['Serve is not enabled on your tailnet. http://login.tailscale.com/a https://evil.example/a', null]
  ]) {
    const f = await serveFixture({}, { failure: { cause: Object.assign(new Error('failed'), { code: 1, killed: true }), stderr: output } });
    const result = await f.service.serveSetup();
    assert.equal(result.error, 'serve-not-enabled');
    assert.equal(result.link, link);
    assert.match(result.message, /HTTPS Certificates/);
  }
  const timeout = await serveFixture({}, { failure: { cause: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', killed: true }) } });
  assert.equal((await timeout.service.serveSetup()).error, 'timeout');
  const failed = await serveFixture({}, { failure: { cause: new Error('failed'), stderr: '\u001b[31mbad\nerror' } });
  assert.equal((await failed.service.serveSetup()).message, '[31mbad error');
});

test('Serve setup warns when Funnel appears after the write', async () => {
  let serve = {};
  const f = fixture({ execFile: (_file, args, callback) => {
    if (args[0] === 'status') return callback(null, JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.tailnet.ts.net.' } }));
    if (args[1] === 'status') return callback(null, JSON.stringify(serve));
    serve = { ...own443, AllowFunnel: { 'mac.tailnet.ts.net:443': true } };
    callback(null, '');
  } });
  f.config.remote.enabled = true;
  await f.service.sync();
  const result = await f.service.serveSetup();
  assert.equal(result.ok, true);
  assert.match(result.warning, /Funnel/);
});

test('Serve setup requires an enabled, listening Serve companion on the selected port', async () => {
  const disabled = fixture();
  assert.equal((await disabled.service.serveSetup()).error, 'not-listening');
  assert.equal(disabled.calls.length, 0);
  const tailnet = fixture({ interfaces: { utun: [{ family: 'IPv4', address: '100.99.4.7' }] } });
  tailnet.config.remote.enabled = true;
  tailnet.config.remote.mode = 'tailnet';
  await tailnet.service.sync();
  assert.equal((await tailnet.service.serveSetup()).error, 'not-listening');
  assert.equal(tailnet.calls.length, 0);
  const ready = await serveFixture();
  ready.config.remote.port = 50000;
  assert.deepEqual(await ready.service.serveSetup(), { error: 'not-listening',
    message: 'Turn on the phone companion in Serve mode first, then set up Tailscale Serve.' });
  assert.equal(ready.writes().length, 0);
});

test('Serve needs an absolute mutation CLI and checks the expected HTTPS port', async () => {
  const f = fixture({ fileExists: () => false, execFile: (_file, args, callback) => callback(null,
    args[0] === 'status' ? JSON.stringify({ BackendState: 'Running' }) : '{}') });
  f.config.remote.enabled = true;
  await f.service.sync();
  assert.equal((await f.service.serveSetup()).error, 'no-cli-path');
  assert.match((await f.service.serveSetup()).message, /standard location/);
  assert.equal(f.calls.filter(({ args }) => args.includes('--bg')).length, 0);
  const expected = await serveFixture(busy443);
  assert.equal((await expected.service.serveSetup(443)).error, 'changed');
  assert.equal((await expected.service.serveSetup('8443')).error, 'invalid-action');
  assert.equal(expected.writes().length, 0);
  assert.equal((await expected.service.serveSetup(8443)).ok, true);
});

test('Serve aborts when status changes between its decision and mutation', async () => {
  for (const [initial, changed, action] of [[{}, busy443, 'serveSetup'], [own443, {}, 'serveStop']]) {
    let reads = 0;
    const f = fixture({ execFile: (_file, args, callback) => {
      if (args[0] === 'status') return callback(null, JSON.stringify({ BackendState: 'Running' }));
      if (args[1] === 'status') return callback(null, JSON.stringify(++reads === 1 ? initial : changed));
      callback(null, '');
    } });
    f.config.remote.enabled = true;
    await f.service.sync();
    assert.equal((await f.service[action]()).error, 'changed');
    assert.equal(reads, 2);
    assert.equal(f.calls.filter(({ args }) => args.includes('--bg') || args.at(-1) === 'off').length, 0);
  }
});

test('a failed Serve status stays unknown while another Tailscale check waits', async () => {
  let reads = 0, release;
  const f = fixture({ execFile: (_file, args, callback) => {
    if (args[0] === 'status') return callback(null, JSON.stringify({ BackendState: 'Running' }));
    if (args[1] === 'status') {
      if (++reads === 1) { release = () => callback(new Error('status failed')); return; }
      return callback(null, '{}');
    }
    callback(null, '');
  } });
  f.config.remote.enabled = true;
  await f.service.sync();
  const setup = f.service.serveSetup();
  const check = f.service.tailscale();
  await new Promise(setImmediate);
  assert.equal(reads, 1);
  release();
  assert.equal((await setup).error, 'status-unavailable');
  assert.equal((await check).known, true);
  assert.equal(f.calls.filter(({ args }) => args.includes('--bg')).length, 0);
});

test('overlapping Serve setup and stop run in order', async () => {
  let serve = {}, releaseWrite, reads = 0;
  const writes = [];
  const f = fixture({ execFile: (_file, args, callback) => {
    if (args[0] === 'status') return callback(null, JSON.stringify({ BackendState: 'Running' }));
    if (args[1] === 'status') { reads++; return callback(null, JSON.stringify(serve)); }
    writes.push(args);
    if (args.includes('--bg')) { releaseWrite = () => { serve = own443; callback(null, ''); }; return; }
    serve = {};
    callback(null, '');
  } });
  f.config.remote.enabled = true;
  await f.service.sync();
  const setup = f.service.serveSetup();
  const stop = f.service.serveStop();
  await new Promise(setImmediate);
  assert.equal(reads, 2);
  assert.equal(writes.length, 1);
  releaseWrite();
  assert.equal((await setup).ok, true);
  assert.equal((await stop).stopped, true);
  assert.deepEqual(writes.map((args) => args.at(-1)), ['http://127.0.0.1:47821', 'off']);
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
