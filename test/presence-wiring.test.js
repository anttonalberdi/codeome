const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const touched = require('../main/touched');
const { applyPresence, shouldRecord } = require('../main/presence');

function fixture(t, { record = true } = {}) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-presence-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const id = 'first';
  if (record) touched.start(project, id, { engine: 'claude', title: 'Initial', code: 'BCDF' });
  const chats = new Map([[id, { cwd: project, code: 'BCDF', getTitle: () => { throw new Error('title lookup'); } }]]);
  const payload = { id, project, state: 'working', jobs: ['One'], plan_title: 'Plan', first_request: 'Do this' };
  const statusFile = path.join(project, '.codeome', 'touched', `${id}.status.json`);
  return { project, id, chats, payload, statusFile };
}

test('presence updates the status sidecar for a live session', (t) => {
  const { chats, payload, statusFile } = fixture(t);
  assert.deepEqual(applyPresence(chats, payload, { touched }), { ok: true });
  const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  assert.equal(status.code, 'BCDF');
  assert.equal(status.status, 'working');
  assert.deepEqual(status.jobs, ['One']);
  assert.equal(status.plan_title, 'Plan');
  assert.equal(status.first_request, 'Do this');
  assert.equal(status.title, undefined);
});

test('presence rejects a different project and an unknown chat without writing', (t) => {
  const { chats, payload, statusFile } = fixture(t);
  const before = fs.readFileSync(statusFile);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-presence-other-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  assert.deepEqual(applyPresence(chats, { ...payload, project: other }, { touched }), { ok: false });
  assert.deepEqual(applyPresence(chats, { ...payload, id: 'absent' }, { touched }), { ok: false });
  assert.deepEqual(fs.readFileSync(statusFile), before);
  assert.equal(fs.existsSync(path.join(other, '.codeome')), false);
});

test('presence maps an unrecognised state to unknown and rejects malformed fields', (t) => {
  const { chats, payload, statusFile } = fixture(t);
  assert.deepEqual(applyPresence(chats, { ...payload, state: 'busy' }, { touched }), { ok: true });
  const before = fs.readFileSync(statusFile);
  assert.equal(JSON.parse(before).status, 'unknown');
  for (const bad of [{ ...payload, jobs: 'One' }, { ...payload, jobs: [7] },
    { ...payload, plan_title: null }, { ...payload, first_request: 42 }, null]) {
    assert.deepEqual(applyPresence(chats, bad, { touched }), { ok: false });
  }
  assert.deepEqual(fs.readFileSync(statusFile), before);
});

test('presence lets touched sanitise long strings and job names', (t) => {
  const { chats, payload, statusFile } = fixture(t);
  assert.deepEqual(applyPresence(chats, { ...payload, first_request: 'First\n\u0000' + 'a'.repeat(250),
    plan_title: 'Plan\u007f' + 'b'.repeat(250), jobs: ['Job\n\u0000one', ...Array(6).fill('j'.repeat(100))] }, { touched }), { ok: true });
  const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  assert.equal(status.first_request.length, 200);
  assert.equal(status.first_request.startsWith('First a'), true);
  assert.equal(status.plan_title.length, 200);
  assert.equal(status.plan_title.startsWith('Plan b'), true);
  assert.deepEqual(status.jobs, ['Job one', ...Array(4).fill('j'.repeat(80))]);
  assert.equal(status.title, undefined);
});

test('presence does not create a status sidecar without a main record', (t) => {
  const { chats, payload, statusFile } = fixture(t, { record: false });
  assert.deepEqual(applyPresence(chats, payload, { touched }), { ok: false });
  assert.equal(fs.existsSync(statusFile), false);
});

test('recording requires an existing kit directory for every project and skips forums', () => {
  assert.equal(shouldRecord({ forum: false, scratch: false, hasCodeomeDir: false }), false);
  assert.equal(shouldRecord({ forum: false, scratch: false, hasCodeomeDir: true }), true);
  assert.equal(shouldRecord({ forum: true, scratch: false, hasCodeomeDir: true }), false);
  assert.equal(shouldRecord({ forum: true, scratch: true, hasCodeomeDir: true }), false);
  assert.equal(shouldRecord({ forum: false, scratch: true, hasCodeomeDir: false }), false);
  assert.equal(shouldRecord({ forum: false, scratch: true, hasCodeomeDir: true }), true);
});

test('presence rejects oversized strings and too many jobs without writing', (t) => {
  const { chats, payload, statusFile } = fixture(t);
  const before = fs.readFileSync(statusFile);
  for (const bad of [{ ...payload, jobs: Array(21).fill('job') },
    { ...payload, jobs: ['x'.repeat(10241)] },
    { ...payload, id: 'x'.repeat(10241) },
    { ...payload, project: 'x'.repeat(10241) },
    { ...payload, plan_title: 'x'.repeat(10241) },
    { ...payload, first_request: 'x'.repeat(10241) }])
    assert.deepEqual(applyPresence(chats, bad, { touched }), { ok: false });
  assert.deepEqual(fs.readFileSync(statusFile), before);
});
