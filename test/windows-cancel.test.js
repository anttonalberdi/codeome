const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('Windows cancel rejects project-controlled invalid pids and finalises stopped jobs', async () => {
  let record, kills = 0, saved;
  const source = fs.readFileSync(path.join(__dirname, '../main/jobs.js'), 'utf8');
  const sandbox = { module: { exports: {} }, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
    process: { kill: () => {} },
    require: name => name === './platform' ? { isWin: true, killTree: async () => { kills++; return true; } }
      : name === 'fs' ? { ...fs, lstatSync: () => ({ isDirectory: () => true, isFile: () => true, size: 1000 }),
        openSync: () => 1, fstatSync: () => ({ isFile: () => true, size: Buffer.byteLength(JSON.stringify(record)) }),
        readSync: (_fd, buffer) => buffer.write(JSON.stringify(record)), closeSync: () => {},
        writeFileSync: (_file, data) => { saved = JSON.parse(data); } }
      : name === './kit' || name === './jobview' ? {} : require(name)
  };
  vm.runInNewContext(source, sandbox);
  for (const pid of ['123', -1, 0, 4, 1.5]) {
    record = { engine: 'codex', status: 'running', pid };
    assert.match(sandbox.module.exports.cancel('/project', 'job').error, /Invalid job pid/);
  }
  assert.equal(kills, 0);
  record = { engine: 'codex', status: 'running', pid: 123 };
  assert.equal(sandbox.module.exports.cancel('/project', 'job').ok, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(kills, 1);
  assert.equal(saved.status, 'cancelled');
  assert.ok(saved.endedAt);
});
