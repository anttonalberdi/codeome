const test = require('node:test');
const assert = require('node:assert/strict');
const { findPython } = require('../main/platform');

test('darwin keeps python3 without probing', () => {
  assert.deepEqual(findPython({ platform: 'darwin', probe: () => assert.fail('probe') }), { file: 'python3', args: [] });
});

test('Windows tries Python 3 candidates in order and rejects Store stubs and Python 2', () => {
  const calls = [];
  const python = findPython({ platform: 'win32', probe: (file, args) => {
    calls.push([file, args]);
    if (file === 'python3') return { status: 1, stdout: 'Python 3.12', stderr: 'Store stub' };
    if (file === 'python') return { status: 0, stdout: 'Python 2.7' };
    return { status: 0, stderr: 'Python 3.12.1\n' };
  } });
  assert.deepEqual(python, { file: 'py', args: ['-3'] });
  assert.deepEqual(calls, [['python3', ['--version']], ['python', ['--version']], ['py', ['-3', '--version']]]);
});

test('Windows stops at the first working interpreter', () => {
  for (const accepted of ['python3', 'python']) {
    const calls = [];
    assert.deepEqual(findPython({ platform: 'win32', probe: (file) => {
      calls.push(file);
      return { status: file === accepted ? 0 : 1, stdout: 'Python 3.13.0' };
    } }), { file: accepted, args: [] });
    assert.equal(calls.at(-1), accepted);
  }
});

test('Windows returns null for missing commands, errors and invalid output', () => {
  assert.equal(findPython({ platform: 'win32', probe: () => { throw new Error('missing'); } }), null);
  assert.equal(findPython({ platform: 'win32', probe: () => ({ status: 0, stdout: 'Store' }) }), null);
});
