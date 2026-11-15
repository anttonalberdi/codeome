const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePs, parseWindows, subtreeTotals, sample } = require('../main/procstats');

const fixture = `
  10 1 120.5 100
  11 10 12,5 200
  12 11 7.0 300
  90 999 50.0 400
  91 1 60.0 500
`;

test('ps parsing accepts whitespace and decimal commas and ignores malformed lines', () => {
  assert.deepEqual(parsePs('  42\t1  12,5   2048 \r\n'), [{ pid: 42, ppid: 1, cpu: 12.5, rssKb: 2048 }]);
  assert.deepEqual(parsePs('header\n1 2 nope 3\n1 2 3\n1 2 3 4 extra\n-1 2 3 4\n1 2 3 -4\n1x 2 3 4'), []);
});

test('totals include nested children and exclude orphans and unrelated processes', () => {
  assert.deepEqual(subtreeTotals([10], parsePs(fixture)), {
    10: { cpu: 140, rssKb: 600, nproc: 3, alive: true }
  });
});

test('dead roots stay empty even when an orphan names them as parent', () => {
  assert.deepEqual(subtreeTotals([999], parsePs(fixture)), {
    999: { cpu: 0, rssKb: 0, nproc: 0, alive: false }
  });
});

test('cycles and duplicate rows count each process once', () => {
  const rows = parsePs('1 3 1 10\n2 1 2 20\n3 2 3 30\n2 1 2 20');
  assert.deepEqual(subtreeTotals([1], rows), { 1: { cpu: 6, rssKb: 60, nproc: 3, alive: true } });
});

test('overlapping and duplicate roots report independent totals', () => {
  assert.deepEqual(subtreeTotals([10, 11, 10], parsePs(fixture)), {
    10: { cpu: 140, rssKb: 600, nproc: 3, alive: true },
    11: { cpu: 19.5, rssKb: 500, nproc: 2, alive: true }
  });
});

test('Windows parsing handles a bare object, arrays and null with unavailable CPU', () => {
  const parent = { ProcessId: 10, ParentProcessId: 1, WorkingSetSize: 2048 };
  const child = { ProcessId: 11, ParentProcessId: 10, WorkingSetSize: 512 };
  assert.deepEqual(parseWindows(JSON.stringify(parent)), [{ pid: 10, ppid: 1, cpu: null, rssKb: 2 }]);
  assert.deepEqual(subtreeTotals([10], parseWindows(JSON.stringify([parent, child]))), {
    10: { cpu: null, rssKb: 2.5, nproc: 2, alive: true }
  });
  assert.deepEqual(parseWindows('null'), []);
});

test('sample uses ps and forwards environment and timeout', async () => {
  const env = { LANG: 'test' };
  const totals = await sample([10], { platform: 'linux', env, timeout: 50, runner: async (cmd, args, opts) => {
    assert.equal(cmd, 'ps');
    assert.deepEqual(args, ['-A', '-o', 'pid=,ppid=,pcpu=,rss=']);
    assert.deepEqual(opts, { env, timeout: 50 });
    return { code: 0, stdout: fixture, stderr: '' };
  } });
  assert.equal(totals[10].nproc, 3);
});

test('sample uses PowerShell CIM JSON on Windows', async () => {
  const totals = await sample([10], { platform: 'win32', runner: async (cmd, args, opts) => {
    assert.equal(cmd, 'powershell');
    assert.deepEqual(args, ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress']);
    assert.equal(opts.timeout, 10000);
    return { code: 0, stdout: '{"ProcessId":10,"ParentProcessId":1,"WorkingSetSize":1024}', stderr: '' };
  } });
  assert.deepEqual(totals[10], { cpu: null, rssKb: 1, nproc: 1, alive: true });
});

test('sample resolves errors for command failure, runner rejection and invalid JSON', async () => {
  assert.deepEqual(await sample([10], { runner: async () => ({ code: 1, stderr: ' denied\n' }) }), { error: 'denied' });
  assert.deepEqual(await sample([10], { platform: 'linux', runner: async () => ({ code: null, stderr: '' }) }), { error: 'ps exited with code null' });
  assert.deepEqual(await sample([10], { runner: async () => { throw new Error('unavailable'); } }), { error: 'unavailable' });
  const result = await sample([10], { platform: 'win32', runner: async () => ({ code: 0, stdout: 'invalid', stderr: '' }) });
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0);
});


test('sample keeps platform defaults and explicit timeout overrides', async () => {
  for (const [platform, timeout, expected] of [['linux', undefined, 3000], ['win32', 50, 50]]) {
    const result = await sample([], { platform, timeout, runner: async (_cmd, _args, opts) => {
      assert.equal(opts.timeout, expected);
      return { code: 0, stdout: platform === 'win32' ? 'null' : '', stderr: '' };
    } });
    assert.deepEqual(result, {});
  }
});

test('subtree membership preserves process data without changing serialized totals', () => {
  const rows = parsePs(fixture);
  const totals = subtreeTotals([10, 11, 10], rows);
  assert.deepEqual(totals[10].members.map((row) => row.pid), [10, 11, 12]);
  assert.deepEqual(totals[11].members, rows.slice(1, 3));
  assert.equal(JSON.stringify(totals).includes('members'), false);
});
