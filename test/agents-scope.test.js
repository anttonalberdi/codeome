const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const kit = require('../main/kit');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-agents-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = (name) => {
    const p = path.join(root, name);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };
  return { root, dir };
}

const read = (p) => fs.readFileSync(p, 'utf8');
const json = (p) => JSON.parse(read(p));
const digest = (s) => crypto.createHash('sha256').update(s).digest('hex');
const projectAgent = (project, name) => path.join(project, '.claude', 'agents', name + '.md');
const routing = (project) => path.join(project, '.claude', 'skills', 'orchestrate', 'routing.md');
const generalAgent = (home, name) => path.join(home, 'agents', name + '.md');
const create = (options) => kit.createAgent({ description: 'Checks data.', engine: 'claude', tools: 'edits', ...options });

test('createAgent writes general frontmatter, all tool presets, body and report footer', (t) => {
  const { dir } = fixture(t);
  const home = dir('codeome-home');
  const footer = read(path.join(__dirname, '..', 'kit', 'roles', '_report.md'));
  const cases = [
    ['read-only', 'Read, Grep, Glob, Bash', 'claude'],
    ['edits', 'Read, Edit, Write, Grep, Glob', 'codex'],
    ['shell', 'Read, Edit, Write, Bash, Grep, Glob', 'claude']
  ];
  for (const [preset, expectedTools, engine] of cases) {
    const name = `general-${preset}`;
    const result = create({ scope: 'general', home, name, description: '  Checks   data.  ', engine, tools: preset, body: 'Custom instructions.' });
    const file = generalAgent(home, name);
    assert.deepEqual(result, { path: file });
    const content = read(file);
    const { meta, body } = kit.parseFrontmatter(content);
    assert.deepEqual(meta, { name, description: 'Checks data.', tools: expectedTools, 'codeome-engine': engine });
    assert.ok(body.startsWith('\nCustom instructions.\n'));
    assert.ok(content.endsWith(footer));
  }
  assert.deepEqual(kit.generalAgents(home).map(({ name, engine, description }) => ({ name, engine, description })), [
    { name: 'general-edits', engine: 'codex', description: 'Checks data.' },
    { name: 'general-read-only', engine: 'claude', description: 'Checks data.' },
    { name: 'general-shell', engine: 'claude', description: 'Checks data.' }
  ]);
});

test('createAgent makes a project routing file and records its engine on an empty project', (t) => {
  const { dir } = fixture(t);
  const project = dir('project'), home = dir('codeome-home');
  const name = 'ab'; // shortest accepted name
  const result = create({ scope: 'project', project, home, name, engine: 'codex', tools: 'read-only' });
  const file = projectAgent(project, name);
  assert.deepEqual(result, { path: file });
  const { meta, body } = kit.parseFrontmatter(read(file));
  assert.deepEqual(meta, { name, description: 'Checks data.', tools: 'Read, Grep, Glob, Bash' });
  assert.match(body, /You are the ab: Checks data\./);
  assert.match(body, /## Report/);
  assert.match(read(routing(project)), /\| `ab` \| Codex \| read-only \| Checks data\. \|/);
  assert.deepEqual(json(path.join(project, '.codeome', 'agents.json')).roles.ab, { engine: 'codex' });
  assert.equal(kit.agents(project).find((a) => a.name === name).engine, 'codex');
  assert.equal(fs.existsSync(generalAgent(home, name)), false);
});

test('createAgent quotes descriptions with YAML punctuation and reads them in lists and routing', (t) => {
  const { dir } = fixture(t);
  const project = dir('project'), home = dir('codeome-home');
  const description = 'Use when: logs say "bad\\path"\nthen retry';
  const expected = 'Use when: logs say "bad\\path" then retry';
  const result = create({ scope: 'project', project, home, name: 'log-aide', description, engine: 'codex' });
  assert.ok(result.path);
  assert.match(read(result.path), /^description: "Use when: logs say \\"bad\\\\path\\" then retry"$/m);
  assert.equal(kit.parseFrontmatter(read(result.path)).meta.description, expected);
  assert.equal(kit.agents(project).find((a) => a.name === 'log-aide').description, expected);
  assert.match(read(routing(project)), /\| `log-aide` \| Codex \| writes \| Use when: logs say "bad\\path" then retry \|/);
  const global = create({ scope: 'general', home, name: 'global-log', description });
  assert.equal(kit.generalAgents(home).find((a) => a.name === 'global-log').description, expected);
  assert.equal(kit.parseFrontmatter(read(global.path)).meta.description, expected);
});

test('createAgent rejects invalid and existing names without changing existing files', (t) => {
  const { dir } = fixture(t);
  const project = dir('project'), home = dir('codeome-home');
  kit.install(project);
  const existing = create({ scope: 'project', project, home, name: 'my-agent', engine: 'codex' });
  const general = create({ scope: 'general', home, name: 'general-agent' });
  assert.ok(existing.path && general.path);
  assert.ok(create({ scope: 'project', project, home, name: 'a'.repeat(41) }).path); // longest accepted name
  const tracked = [existing.path, general.path, projectAgent(project, 'explorer'), routing(project), path.join(project, '.codeome', 'agents.json')];
  const before = tracked.map((p) => fs.readFileSync(p));
  const base = { scope: 'project', project, home };
  for (const name of ['Uppercase', 'two words', '../x', '/', 'a/b', '..', 'a..b', 'a', 'a'.repeat(42), 'explorer', 'my-agent']) {
    const result = create({ ...base, name });
    assert.equal(typeof result.error, 'string', name);
  }
  for (const options of [
    { ...base, name: 'other-agent', scope: 'unknown' },
    { ...base, name: 'other-agent', engine: 'unknown' },
    { ...base, name: 'other-agent', tools: 'unknown' },
    { ...base, name: 'other-agent', project: path.join(project, 'missing') },
    { scope: 'general', home, name: 'general-agent' }
  ]) assert.equal(typeof create(options).error, 'string');
  tracked.forEach((p, i) => assert.deepEqual(fs.readFileSync(p), before[i], p));
  assert.equal(fs.existsSync(path.join(project, '.claude', 'x.md')), false);
  assert.equal(fs.existsSync(path.join(project, '.claude', 'agents', 'a', 'b.md')), false);
});

test('promoteAgent copies a Codex agent to general and projects while preserving an existing target', (t) => {
  const { dir } = fixture(t);
  const source = dir('source'), first = dir('first'), second = dir('second');
  const missing = path.join(dir('missing-parent'), 'absent');
  const home = dir('codeome-home'), account = dir('account-default');
  kit.install(source);
  kit.install(first);
  kit.install(second);
  assert.ok(create({ scope: 'project', project: source, home, name: 'data-aide', engine: 'codex', tools: 'shell' }).path);
  assert.ok(create({ scope: 'project', project: second, home, name: 'data-aide', description: 'Keep me.', engine: 'claude' }).path);
  const sourceFile = projectAgent(source, 'data-aide');
  const existingFile = projectAgent(second, 'data-aide');
  const sourceBefore = fs.readFileSync(sourceFile);
  const existingBefore = fs.readFileSync(existingFile);
  const existingRouting = fs.readFileSync(routing(second));
  const result = kit.promoteAgent({ project: source, name: 'data-aide', toGeneral: true, toProjects: [first, second, missing], home, accountDirs: [account] });
  assert.equal(result.general, 'created');
  assert.equal(result.projects[first], 'created');
  assert.equal(result.projects[second], 'exists');
  assert.match(result.projects[missing].error, /Project folder not found/);
  assert.deepEqual(fs.readFileSync(sourceFile), sourceBefore);
  assert.deepEqual(fs.readFileSync(projectAgent(first, 'data-aide')), sourceBefore);
  assert.deepEqual(fs.readFileSync(existingFile), existingBefore);
  assert.deepEqual(fs.readFileSync(routing(second)), existingRouting);
  assert.match(read(routing(first)), /\| `data-aide` \| Codex \| writes \| Checks data\. \|/);
  assert.equal(fs.existsSync(path.join(first, '.codeome', 'agents.json')), false);
  const general = generalAgent(home, 'data-aide');
  assert.equal(kit.parseFrontmatter(read(general)).meta['codeome-engine'], 'codex');
  assert.equal(read(path.join(account, 'agents', 'data-aide.md')), read(general));
  const promotedBefore = fs.readFileSync(general);
  const again = kit.promoteAgent({ project: source, name: 'data-aide', toGeneral: true, home, accountDirs: [account] });
  assert.equal(again.general, 'exists');
  assert.deepEqual(fs.readFileSync(general), promotedBefore);
});

test('promoteAgent reports bad names and missing sources without writing targets', (t) => {
  const { dir } = fixture(t);
  const source = dir('source'), target = dir('target'), home = dir('codeome-home'), account = dir('account');
  kit.install(source);
  kit.install(target);
  const before = fs.readFileSync(routing(target));
  for (const name of ['../outside', 'a/b', 'a\\b', 'missing-agent']) {
    const result = kit.promoteAgent({ project: source, name, toGeneral: true, toProjects: [target], home, accountDirs: [account] });
    assert.equal(typeof result.general.error, 'string', name);
    assert.equal(typeof result.projects[target].error, 'string', name);
  }
  assert.deepEqual(fs.readFileSync(routing(target)), before);
  assert.equal(fs.existsSync(path.join(home, 'agents')), false);
  assert.equal(fs.existsSync(path.join(account, 'agents')), false);
});

test('agents:promote accepts only listed destinations and excludes the source project', (t) => {
  const { dir } = fixture(t);
  const source = dir('source'), known = dir('known'), unknown = dir('unknown');
  create({ scope: 'project', project: source, name: 'source-aide' });
  const script = read(path.join(__dirname, '..', 'main', 'main.js'));
  const start = script.indexOf("ipcMain.handle('agents:promote'");
  const end = script.indexOf("ipcMain.handle('general:agents'", start);
  assert.ok(start >= 0 && end > start);
  const handlers = {};
  vm.runInNewContext(script.slice(start, end), {
    cfg: { openProjects: [source, known] }, kit, usage: { home: () => dir('home') }, claudeAccountDirs: () => [],
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } }
  });
  const result = handlers['agents:promote'](null, { project: source, name: 'source-aide', toProjects: [source, known, unknown] });
  assert.equal(result.projects[known], 'created');
  assert.equal(result.projects[source].error, 'Not a known project');
  assert.equal(result.projects[unknown].error, 'Not a known project');
  assert.equal(fs.existsSync(projectAgent(unknown, 'source-aide')), false);
});

test('promoteAgent blocks symlink escapes and keeps Codex routing without routing.md', (t) => {
  const { dir } = fixture(t);
  const source = dir('source'), target = dir('target'), outside = dir('outside'), linked = dir('linked'), linkedAgents = dir('linked-agents');
  create({ scope: 'project', project: source, name: 'codex-aide', engine: 'codex' });
  fs.symlinkSync(outside, path.join(linked, '.claude'));
  fs.mkdirSync(path.join(linkedAgents, '.claude'));
  fs.symlinkSync(outside, path.join(linkedAgents, '.claude', 'agents'));
  const result = kit.promoteAgent({ project: source, name: 'codex-aide', toProjects: [target, linked, linkedAgents] });
  assert.equal(result.projects[target], 'created');
  assert.equal(typeof result.projects[linked].error, 'string');
  assert.equal(typeof result.projects[linkedAgents].error, 'string');
  assert.equal(fs.existsSync(path.join(outside, 'agents')), false);
  assert.equal(fs.existsSync(routing(target)), false);
  assert.deepEqual(json(path.join(target, '.codeome', 'agents.json')).roles['codex-aide'], { engine: 'codex' });
  assert.equal(kit.agents(target).find((a) => a.name === 'codex-aide').engine, 'codex');
});

test('mirrorGeneral tracks hashes, updates untouched copies, and preserves account edits', (t) => {
  const { dir } = fixture(t);
  const home = dir('codeome-home');
  const defaultAccount = dir('default-account');
  const userAccount = dir('user-account');
  const editedAccount = dir('edited-account');
  const accounts = [defaultAccount, { dir: userAccount }, editedAccount];
  const name = 'shared-agent';
  assert.ok(create({ scope: 'general', home, name, engine: 'codex' }).path);
  const source = generalAgent(home, name);
  const defaultFile = path.join(defaultAccount, 'agents', name + '.md');
  const userFile = path.join(userAccount, 'agents', name + '.md');
  const editedFile = path.join(editedAccount, 'agents', name + '.md');
  const record = path.join(home, 'agents-mirror.json');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, 'User-owned agent.\n');
  assert.deepEqual(kit.mirrorGeneral({ home, accountDirs: accounts }), {
    written: [defaultFile, editedFile], skipped: [userFile], removed: []
  });
  assert.equal(read(defaultFile), read(source));
  assert.equal(read(editedFile), read(source));
  assert.equal(json(record)[defaultFile], digest(read(source)));
  assert.equal(json(record)[editedFile], digest(read(source)));
  assert.equal(json(record)[userFile], undefined);
  assert.deepEqual(kit.mirrorGeneral({ home, accountDirs: accounts }), { written: [], skipped: [userFile], removed: [] });

  fs.appendFileSync(source, '\nSource revision one.\n');
  assert.deepEqual(kit.mirrorGeneral({ home, accountDirs: accounts }).written, [defaultFile, editedFile]);
  assert.equal(read(defaultFile), read(source));
  assert.equal(json(record)[defaultFile], digest(read(source)));
  fs.appendFileSync(editedFile, '\nAccount edit.\n');
  const editedBefore = fs.readFileSync(editedFile);
  fs.appendFileSync(source, '\nSource revision two.\n');
  const update = kit.mirrorGeneral({ home, accountDirs: accounts });
  assert.deepEqual(update.written, [defaultFile]);
  assert.deepEqual(update.skipped, [userFile, editedFile]);
  assert.deepEqual(fs.readFileSync(editedFile), editedBefore);
  assert.equal(read(defaultFile), read(source));
  assert.equal(json(record)[defaultFile], digest(read(source)));

  fs.unlinkSync(source);
  assert.deepEqual(kit.generalAgents(home), []);
  const removal = kit.mirrorGeneral({ home, accountDirs: accounts });
  assert.deepEqual(removal.removed, [defaultFile]);
  assert.equal(fs.existsSync(defaultFile), false);
  assert.deepEqual(fs.readFileSync(editedFile), editedBefore);
  assert.equal(read(userFile), 'User-owned agent.\n');
  assert.equal(json(record)[defaultFile], undefined);
  assert.equal(typeof json(record)[editedFile], 'string');
});

test('mirrorGeneral handles an empty general store', (t) => {
  const { dir } = fixture(t);
  const home = dir('codeome-home'), account = dir('account');
  assert.deepEqual(kit.mirrorGeneral({ home, accountDirs: [account] }), { written: [], skipped: [], removed: [] });
  assert.deepEqual(json(path.join(home, 'agents-mirror.json')), {});
  assert.equal(fs.existsSync(path.join(account, 'agents')), false);
});

test('mirrorGeneral skips symlinked files and agents directories during update and removal', (t) => {
  const { dir } = fixture(t);
  const home = dir('home'), account = dir('account'), other = dir('other');
  const source = create({ scope: 'general', home, name: 'mirror-aide' }).path;
  const target = path.join(account, 'agents', 'mirror-aide.md');
  kit.mirrorGeneral({ home, accountDirs: [account] });
  const foreign = path.join(other, 'foreign.md');
  fs.writeFileSync(foreign, read(target));
  fs.unlinkSync(target);
  fs.symlinkSync(foreign, target);
  fs.appendFileSync(source, 'Updated.\n');
  assert.deepEqual(kit.mirrorGeneral({ home, accountDirs: [account] }).skipped, [target]);
  assert.equal(read(foreign).includes('Updated.'), false);
  fs.unlinkSync(source);
  assert.deepEqual(kit.mirrorGeneral({ home, accountDirs: [account] }).skipped, [target]);
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  fs.unlinkSync(target);
  fs.writeFileSync(target, read(foreign));
  const agentDir = path.join(account, 'agents');
  fs.renameSync(agentDir, path.join(account, 'saved-agents'));
  fs.symlinkSync(path.join(account, 'saved-agents'), agentDir);
  assert.deepEqual(kit.mirrorGeneral({ home, accountDirs: [account] }).skipped, [target]);
  assert.equal(fs.existsSync(path.join(account, 'saved-agents', 'mirror-aide.md')), true);
  fs.writeFileSync(source, 'New source.\n');
  assert.deepEqual(kit.mirrorGeneral({ home, accountDirs: [account] }).skipped, [target]);
  assert.equal(read(path.join(account, 'saved-agents', 'mirror-aide.md')), read(foreign));
  fs.unlinkSync(agentDir);
  fs.mkdirSync(agentDir);
  fs.mkdirSync(target);
  assert.deepEqual(kit.mirrorGeneral({ home, accountDirs: [account] }).skipped, [target]);
  assert.equal(fs.statSync(target).isDirectory(), true);
});

test('agent names with traversal components never write outside temp agent stores', (t) => {
  const { root, dir } = fixture(t);
  const project = dir('project'), target = dir('target'), home = dir('codeome-home'), account = dir('account');
  const sentinel = path.join(root, 'outside.md');
  fs.writeFileSync(sentinel, 'Keep this.\n');
  for (const name of ['../../outside', '../outside', '..', 'a..b', 'a/b', 'a\\b']) {
    assert.equal(typeof create({ scope: 'project', project, home, name }).error, 'string', name);
    assert.equal(typeof create({ scope: 'general', home, name }).error, 'string', name);
    const promoted = kit.promoteAgent({ project, name, toGeneral: true, toProjects: [target], home, accountDirs: [account] });
    assert.equal(typeof promoted.general.error, 'string', name);
    assert.equal(typeof promoted.projects[target].error, 'string', name);
  }
  assert.equal(read(sentinel), 'Keep this.\n');
  assert.equal(fs.existsSync(path.join(home, 'agents')), false);
  assert.equal(fs.existsSync(path.join(target, '.claude')), false);
  assert.equal(fs.existsSync(path.join(account, 'agents')), false);
});

test('codeome-agent chooses the project role over a general role of the same name', (t) => {
  const { dir } = fixture(t);
  const project = dir('project'), home = dir('codeome-home');
  kit.install(project);
  assert.ok(create({ scope: 'general', home, name: 'note-aide', body: 'GENERAL ROLE MARKER' }).path);
  assert.ok(create({ scope: 'project', project, home, name: 'note-aide', body: 'PROJECT ROLE MARKER' }).path);
  const promptPath = path.join(project, 'captured-prompt.txt');
  const fake = path.join(project, 'fake-codex');
  fs.writeFileSync(fake, '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "-o" ]; then shift; output=$1; break; fi\n  shift\ndone\ncat > "$CODEOME_PROMPT_CAPTURE"\nprintf "## Status\\ndone\\n" > "$output"\n');
  fs.chmodSync(fake, 0o755);
  const result = spawnSync('python3', [path.join(project, '.codeome', 'bin', 'codeome-agent'), 'codex', '--role', 'note-aide'], {
    cwd: project, input: 'Use the chosen role.', encoding: 'utf8',
    env: { ...process.env, CODEOME_HOME: home, CODEOME_CODEX: fake, CODEOME_PROMPT_CAPTURE: promptPath }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(read(promptPath), /PROJECT ROLE MARKER/);
  assert.doesNotMatch(read(promptPath), /GENERAL ROLE MARKER/);
});
