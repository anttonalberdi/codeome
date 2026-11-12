const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const platformTools = require('../main/platform');
const { unsupportedHpcPtySpec } = require('../main/spawn-spec');

function load(name, platform) {
  const filename = path.join(__dirname, '../main', name + '.js');
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  const noSpawn = () => assert.fail('Windows HPC must not spawn');
  const requireStub = (id) => {
    if (id === './platform') return { ...platformTools, hpcSupported: () => platformTools.hpcSupported(platform) };
    if (id === './util') return { ...nativeRequire(id), run: noSpawn };
    if (id === 'child_process') return { spawn: noSpawn, spawnSync: noSpawn };
    if (id === './ssh') return load('ssh', platform);
    return nativeRequire(id);
  };
  vm.runInThisContext('(function(require, module, exports) {' + fs.readFileSync(filename, 'utf8') + '\n})', { filename })(requireStub, module, module.exports);
  return module.exports;
}

const message = 'HPC connections are not yet supported on Windows.';
test('Windows SSH operations return unsupported without spawning', async () => {
  assert.equal(platformTools.HPC_UNSUPPORTED_MESSAGE, message);
  assert.equal(platformTools.hpcSupported('win32'), false);
  const ssh = load('ssh', 'win32');
  const expected = { code: -1, stdout: '', stderr: message, unsupported: true };
  assert.deepEqual(await ssh.exec('cluster', 'true'), expected);
  assert.deepEqual(await ssh.exec('', 'true'), expected);
  assert.deepEqual(await ssh.disconnect('cluster'), expected);
  assert.deepEqual(await ssh.testLogin('cluster'), expected);
  assert.deepEqual(await ssh.check('cluster'), { connected: false, reason: message, unsupported: true });
  assert.deepEqual(ssh.clearStaleSockets(), []);
  assert.deepEqual(await load('slurm', 'win32').queue('cluster'), { error: message });
});

test('Windows login, VPN, SFTP and setup do no background work', async () => {
  for (const name of ['login', 'vpn']) {
    let emitted;
    const session = load(name, 'win32').start({ spawn: () => assert.fail('must not spawn'), emit: (state) => { emitted = state; } });
    assert.equal(emitted.unsupported, true);
    assert.equal(session.state().reason, message);
    assert.equal(session.ended, true);
    assert.equal(session.answer(1, 'answer'), false);
    session.stop();
  }
  const sftp = load('sftp', 'win32');
  for (const result of [await sftp.list('cluster', '~'), await sftp.fetch('cluster', '/file'), await sftp.writeFile('cluster', '/file', 'text')]) assert.equal(result.error, message);
  const setup = load('setup', 'win32');
  for (const result of [await setup.status({}), await setup.testVpn({}), await setup.resolveHost('cluster')]) assert.equal(result.unsupported, true);
});

test('every HPC terminal kind prints the message through cmd on Windows', () => {
  for (const kind of ['hpc-login', 'storage-login', 'hpc-console', 'hpc-shell', 'agent-hpc', 'hpc-task', 'hpc-lane', 'hpc-copy-key']) {
    assert.deepEqual(unsupportedHpcPtySpec({ kind }, { platform: 'win32', env: {}, cwd: 'home' }), { file: 'cmd.exe', args: ['/d', '/c', 'echo ' + message], cwd: 'home' });
    for (const platform of ['darwin', 'linux']) assert.equal(unsupportedHpcPtySpec({ kind }, { platform }), null);
  }
  assert.equal(unsupportedHpcPtySpec({ kind: 'shell' }, { platform: 'win32' }), null);
});

test('macOS and Linux retain the existing master and shell argv', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.equal(platformTools.hpcSupported(platform), true);
    const ssh = load('ssh', platform);
    assert.deepEqual(ssh.masterArgs('cluster'), ['-o', `ControlPath=${ssh.CONTROL_PATH}`, '-o', 'ControlMaster=yes', '-o', 'ControlPersist=12h', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4', '-fN', 'cluster']);
    const shell = ['-o', `ControlPath=${ssh.CONTROL_PATH}`, '-o', 'ControlMaster=auto', '-o', 'ControlPersist=12h', '-t', 'cluster'];
    assert.deepEqual(ssh.shellArgs('cluster'), shell);
    assert.deepEqual(ssh.shellArgs('cluster', 'echo hello'), [...shell, 'echo hello']);
    ssh.setProxy('cluster', 'nc proxy');
    assert.deepEqual(ssh.masterArgs('cluster').slice(-4), ['-o', 'ProxyCommand=nc proxy', '-fN', 'cluster']);
  }
});

test('Windows IPC exposes unsupported status and rejects connections and remote transfers', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main/main.js'), 'utf8');
  const handlers = {};
  const context = {
    platformTools: { ...platformTools, hpcSupported: () => false },
    ssh: load('ssh', 'win32'), cfg: { hpc: { host: 'cluster' } }, sto: () => 'storage',
    ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
    transfers: new Map(), send: () => assert.fail('must not emit transfer progress')
  };
  for (const name of ['hpc:status', 'storage:status', 'login:state', 'setup:status']) {
    vm.runInNewContext(source.split('\n').find((line) => line.startsWith(`ipcMain.handle('${name}'`)), context);
  }
  for (const name of ['login:start', 'vpn:start', 'hpc:vpn', 'setup:testLogin', 'storage:hpcCommand', 'preview:fetchRemote', 'transfer:start']) {
    const start = source.indexOf(`ipcMain.handle('${name}'`);
    vm.runInNewContext(source.slice(start, source.indexOf('\n});', start) + 4), context);
  }
  for (const name of ['hpc:status', 'storage:status', 'login:state', 'setup:status']) {
    assert.equal((await handlers[name](null, 'hpc')).unsupported, true);
  }
  for (const name of ['login:start', 'vpn:start', 'hpc:vpn', 'setup:testLogin', 'storage:hpcCommand', 'preview:fetchRemote']) {
    assert.equal((await handlers[name](null, {})).error, message);
  }
  for (const [from, to] of [['local', 'remote'], ['remote', 'local'], ['local', 'storage'], ['storage', 'local'], ['remote', 'remote']]) {
    assert.equal(handlers['transfer:start'](null, { from, to }).error, message);
  }
});
