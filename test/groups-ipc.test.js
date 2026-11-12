const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyGroups } = require('../main/groups');

function fixture(t) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-groups-')));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.mkdirSync(path.join(project, '.codeome'));
  return { project, dir: path.join(project, '.codeome', 'groups') };
}

test('groups writes one private JSON file per code', (t) => {
  const { project, dir } = fixture(t);
  const groups = [
    { code: 'BCDF', name: 'Analysis', files: ['/tmp/a.R', 'hpc:/work/b.py'] },
    { code: 'GHJK', name: 'Review', files: [] }
  ];
  assert.deepEqual(applyGroups({ project, groups }), { ok: true });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['BCDF.json', 'GHJK.json']);
  for (const group of groups) {
    const file = path.join(dir, `${group.code}.json`);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual({ code: saved.code, name: saved.name, files: saved.files }, group);
    assert.equal(saved.kind, 'files');
    assert.equal(new Date(saved.at).toISOString(), saved.at);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600); // POSIX mode bits are unavailable on Windows.
  }
});

test('groups writes chat members with their codes and titles', (t) => {
  const { project, dir } = fixture(t);
  const chats = [{ code: 'GHJK', title: 'First chat' }, { code: 'MNPR', title: 'Second chat' }];
  assert.deepEqual(applyGroups({ project, kind: 'chats', groups: [
    { code: 'BCDF', name: 'Research', chats }
  ] }), { ok: true });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'BCDF.json'), 'utf8'));
  assert.deepEqual({ code: saved.code, name: saved.name, kind: saved.kind, chats: saved.chats },
    { code: 'BCDF', name: 'Research', kind: 'chats', chats });
});

test('groups deduplicates chat codes and keeps the first title', (t) => {
  const { project, dir } = fixture(t);
  assert.deepEqual(applyGroups({ project, kind: 'chats', groups: [{ code: 'BCDF', name: 'Chats', chats: [
    { code: 'GHJK', title: 'First' }, { code: 'GHJK', title: 'Later' },
    { code: 'MNPR', title: 'Other' }
  ] }] }), { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'BCDF.json'), 'utf8')).chats,
    [{ code: 'GHJK', title: 'First' }, { code: 'MNPR', title: 'Other' }]);
});

test('groups sweep only their own kind and keep unparseable records', (t) => {
  const { project, dir } = fixture(t);
  const files = { code: 'BCDF', name: 'Files', files: ['/a'] };
  const chats = { code: 'GHJK', name: 'Chats', chats: [{ code: 'MNPR', title: 'Chat' }] };
  assert.deepEqual(applyGroups({ project, groups: [files] }), { ok: true });
  assert.deepEqual(applyGroups({ project, kind: 'chats', groups: [chats] }), { ok: true });
  fs.writeFileSync(path.join(dir, 'STVW.json'), '{bad json');
  fs.writeFileSync(path.join(dir, 'VWXZ.json'), 'null');
  fs.writeFileSync(path.join(dir, 'DFGH.json'), JSON.stringify({ kind: 'future' }));
  fs.writeFileSync(path.join(dir, 'XZBC.json'), JSON.stringify({ code: 'XZBC', name: 'Legacy', files: [] }));
  assert.deepEqual(applyGroups({ project, kind: 'chats', groups: [chats] }), { ok: true });
  assert.equal(fs.existsSync(path.join(dir, 'XZBC.json')), true);
  assert.deepEqual(applyGroups({ project, groups: [] }), { ok: true });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['DFGH.json', 'GHJK.json', 'STVW.json', 'VWXZ.json']);
  assert.deepEqual(applyGroups({ project, groups: [files] }), { ok: true });
  assert.deepEqual(applyGroups({ project, kind: 'chats', groups: [] }), { ok: true });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['BCDF.json', 'DFGH.json', 'STVW.json', 'VWXZ.json']);
});

test('groups skip codes owned by another kind and write the rest', (t) => {
  const { project, dir } = fixture(t);
  const files = { code: 'BCDF', name: 'Files', files: ['/a'] };
  const chats = { code: 'GHJK', name: 'Chats', chats: [] };
  assert.deepEqual(applyGroups({ project, groups: [files] }), { ok: true });
  assert.deepEqual(applyGroups({ project, kind: 'chats', groups: [chats] }), { ok: true });
  const filesBefore = fs.readFileSync(path.join(dir, 'BCDF.json'), 'utf8');
  assert.deepEqual(applyGroups({ project, kind: 'chats', groups: [
    chats, { code: 'MNPR', name: 'New', chats: [] }, { code: 'BCDF', name: 'Collision', chats: [] }
  ] }), { ok: true, skipped: ['BCDF'] });
  assert.equal(fs.readFileSync(path.join(dir, 'BCDF.json'), 'utf8'), filesBefore);
  assert.equal(fs.existsSync(path.join(dir, 'MNPR.json')), true);
  const chatsBefore = fs.readFileSync(path.join(dir, 'GHJK.json'), 'utf8');
  assert.deepEqual(applyGroups({ project, groups: [
    { code: 'STVW', name: 'New', files: [] }, { code: 'GHJK', name: 'Collision', files: [] }
  ] }), { ok: true, skipped: ['GHJK'] });
  assert.equal(fs.readFileSync(path.join(dir, 'GHJK.json'), 'utf8'), chatsBefore);
  assert.equal(fs.existsSync(path.join(dir, 'STVW.json')), true);
  assert.equal(fs.existsSync(path.join(dir, 'BCDF.json')), false);
});

test('groups skip planted and oversized records without blocking other groups', (t) => {
  const { project, dir } = fixture(t);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'BCDF.json'), JSON.stringify({ kind: 'future' }));
  fs.writeFileSync(path.join(dir, 'GHJK.json'), 'x'.repeat(512 * 1024));
  assert.deepEqual(applyGroups({ project, groups: [
    { code: 'BCDF', name: 'Planted', files: [] },
    { code: 'GHJK', name: 'Oversized', files: [] },
    { code: 'MNPR', name: 'Good', files: ['/a'] }
  ] }), { ok: true, skipped: ['BCDF', 'GHJK'] });
  assert.equal(fs.readFileSync(path.join(dir, 'BCDF.json'), 'utf8'), '{"kind":"future"}');
  assert.equal(fs.statSync(path.join(dir, 'GHJK.json')).size, 512 * 1024);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'MNPR.json'), 'utf8')).files, ['/a']);
});

test('groups recheck targets before rename and discard a temp on collision', (t) => {
  const { project, dir } = fixture(t);
  fs.mkdirSync(dir);
  const original = fs.writeFileSync;
  let planted = false;
  fs.writeFileSync = (file, content, ...args) => {
    const result = original(file, content, ...args);
    if (typeof file === 'number' && !planted) {
      planted = true;
      original(path.join(dir, 'BCDF.json'), JSON.stringify({ kind: 'future' }));
    }
    return result;
  };
  t.after(() => { fs.writeFileSync = original; });
  assert.deepEqual(applyGroups({ project, groups: [
    { code: 'BCDF', name: 'Blocked', files: [] }, { code: 'GHJK', name: 'Good', files: [] }
  ] }), { ok: true, skipped: ['BCDF'] });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['BCDF.json', 'GHJK.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'BCDF.json'), 'utf8')).kind, 'future');
});

test('groups reject malformed chat payloads before writing', (t) => {
  const { project, dir } = fixture(t);
  const good = { code: 'BCDF', name: 'Chats', chats: [{ code: 'GHJK', title: 'Chat' }] };
  const payload = { project, kind: 'chats', groups: [good] };
  const invalid = [
    { ...payload, kind: 'other' },
    { ...payload, groups: [{ ...good, chats: 'bad' }] },
    { ...payload, groups: [{ ...good, chats: Array(51).fill(good.chats[0]) }] },
    { ...payload, groups: [{ ...good, chats: [null] }] },
    { ...payload, groups: [{ ...good, chats: [{ code: 'ABCD', title: 'Bad code' }] }] },
    { ...payload, groups: [{ ...good, chats: [{ code: 'GHJK', title: 42 }] }] },
    { ...payload, groups: [{ ...good, chats: [{ code: 'GHJK', title: 'x'.repeat(201) }] }] }
  ];
  for (const bad of invalid) {
    assert.deepEqual(applyGroups(bad), { ok: false });
    assert.equal(fs.existsSync(dir), false);
  }
});

test('groups removes stale JSON files when groups close', (t) => {
  const { project, dir } = fixture(t);
  const first = { code: 'BCDF', name: 'First', files: ['/a'] };
  const second = { code: 'GHJK', name: 'Second', files: ['/b'] };
  assert.deepEqual(applyGroups({ project, groups: [first, second] }), { ok: true });
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
  fs.writeFileSync(path.join(dir, 'notes.json'), 'keep');
  assert.deepEqual(applyGroups({ project, groups: [second] }), { ok: true });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['GHJK.json', 'keep.txt', 'notes.json']);
  assert.deepEqual(applyGroups({ project, groups: [] }), { ok: true });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['keep.txt', 'notes.json']);
});

test('groups rejects malformed payloads before writing', (t) => {
  const { project, dir } = fixture(t);
  const good = { code: 'BCDF', name: 'First', files: ['/a'] };
  const payload = { project, groups: [good] };
  const invalid = [null, {}, { ...payload, project: 'relative' },
    { ...payload, project: project + 'x' },
    { ...payload, project: 'x'.repeat(10241) },
    { ...payload, groups: 'bad' },
    { ...payload, groups: Array(51).fill(good) },
    { ...payload, groups: [good, good] },
    { ...payload, groups: [{ ...good, code: 'ABCD' }] },
    { ...payload, groups: [{ ...good, code: '../x' }] },
    { ...payload, groups: [{ ...good, name: null }] },
    { ...payload, groups: [{ ...good, name: 'x'.repeat(201) }] },
    { ...payload, groups: [{ ...good, files: 'bad' }] },
    { ...payload, groups: [{ ...good, files: Array(501).fill('/a') }] },
    { ...payload, groups: [{ ...good, files: [42] }] },
    { ...payload, groups: [{ ...good, files: ['x'.repeat(4097)] }] },
    { ...payload, groups: [{ ...good, files: Array(130).fill('x'.repeat(4096)) }] },
    { ...payload, groups: ['BCDF', 'GHJK', 'MNPR', 'STVW', 'XZBC', 'DFGH',
      'JKMN', 'PRST', 'VWXZ', 'BCGH', 'DFJK'].map((code) =>
      ({ code, name: 'Large', files: Array(101).fill('x'.repeat(4096)) })) }
  ];
  for (const bad of invalid) {
    assert.deepEqual(applyGroups(bad), { ok: false });
    assert.equal(fs.existsSync(dir), false);
  }
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-groups-missing-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  assert.deepEqual(applyGroups({ project: other, groups: [good] }), { ok: false });
  assert.equal(fs.existsSync(path.join(other, '.codeome')), false);
});

test('groups validates the real project against known projects', (t) => {
  const { project, dir } = fixture(t);
  const alias = project + '-alias';
  fs.symlinkSync(project, alias);
  t.after(() => fs.unlinkSync(alias));
  const payload = { project: alias, groups: [] };
  assert.deepEqual(applyGroups(payload, { isKnownProject: (real) => real === '/unknown' }), { ok: false });
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(applyGroups(payload, { isKnownProject: (real) => real === project }), { ok: true });
});

test('groups sweeps old temp files but keeps recent ones', (t) => {
  const { project, dir } = fixture(t);
  fs.mkdirSync(dir);
  const old = path.join(dir, 'orphan.tmp');
  const fresh = path.join(dir, 'recent.tmp');
  fs.writeFileSync(old, 'old');
  fs.writeFileSync(fresh, 'new');
  const past = new Date(Date.now() - 61000);
  fs.utimesSync(old, past, past);
  assert.deepEqual(applyGroups({ project, groups: [] }), { ok: true });
  assert.deepEqual(fs.readdirSync(dir), ['recent.tmp']);
});

test('groups stages every temp before renaming and does not sweep after rename failure', (t) => {
  const { project, dir } = fixture(t);
  fs.mkdirSync(dir);
  const stale = path.join(dir, 'GHJK.json');
  fs.writeFileSync(stale, 'old');
  const original = fs.renameSync;
  let staged = [];
  fs.renameSync = () => {
    staged = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
    throw new Error('rename failed');
  };
  t.after(() => { fs.renameSync = original; });
  const groups = [{ code: 'BCDF', name: 'One', files: [] },
    { code: 'MNPR', name: 'Two', files: [] }];
  assert.deepEqual(applyGroups({ project, groups }), { ok: false });
  assert.equal(staged.length, 2);
  assert.deepEqual(fs.readdirSync(dir), ['GHJK.json']);
});

test('groups refuses a linked groups directory', (t) => {
  const { project, dir } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-groups-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, dir);
  assert.deepEqual(applyGroups({ project, groups: [{ code: 'BCDF', name: 'First', files: [] }] }), { ok: false });
  assert.deepEqual(fs.readdirSync(outside), []);
});
