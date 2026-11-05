const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ins = require('../main/instructions');
const { TYPES } = require('../main/templates');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ins-'));

test('ensure creates AGENTS.md and a CLAUDE.md that imports it', () => {
  const d = tmp();
  const s = ins.ensure(d);
  assert.ok(s.hasAgents && s.hasClaude && s.claudeImports);
  assert.strictEqual(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
});

test('ensure moves an existing CLAUDE.md into AGENTS.md', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'Use tabs.\n');
  ins.ensure(d);
  assert.strictEqual(fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8'), 'Use tabs.\n');
  assert.strictEqual(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
});

test('ensure keeps both files when both exist, and appends the import', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'AGENTS.md'), 'A\n');
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'C\n');
  ins.ensure(d);
  assert.strictEqual(fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8'), 'A\n');
  assert.strictEqual(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8'), 'C\n\n@AGENTS.md\n');
  ins.ensure(d);
  assert.strictEqual(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8'), 'C\n\n@AGENTS.md\n');
});

test('blank answers render the stock template', () => {
  assert.strictEqual(ins.render({}, 'My project'), ins.TEMPLATE('My project'));
  assert.strictEqual(ins.render({ purpose: '  ', hpc: false, autonomy: '' }, 'My project'), ins.TEMPLATE('My project'));
});

test('full answers render populated sections in order', () => {
  const text = ins.render({
    purpose: 'Analyze samples.', tools: 'R and Quarto', test: 'Rscript test.R', build: 'quarto render', run: 'Rscript main.R',
    rawDataPath: 'data/raw', protectRawData: true, noCommitData: true, hpc: true,
    autonomy: 'plan', noAutoCommit: true, noCoAuthor: true, neverDo: 'Delete source files.'
  }, 'Study');
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.deepStrictEqual(headings, ['What this project is', 'Tools and commands', 'Data rules', 'HPC', 'How to work', 'Commits', 'Do not']);
  for (const value of ['Analyze samples.', 'R and Quarto', 'Rscript test.R', 'quarto render', 'Rscript main.R', 'data/raw',
    'Never modify raw data', 'Never commit data', 'open Codeome connection', 'Never submit jobs unless asked',
    'multiple files', 'Never commit unless asked', 'Co-Authored-By', 'Delete source files.']) assert.ok(text.includes(value), value);
});

test('free text cannot inject headings or control characters', () => {
  const text = ins.render({ purpose: '# Evil\n## Heading\n\x00' + 'x'.repeat(2100) }, 'Study');
  assert.deepStrictEqual([...text.matchAll(/^# (.+)$/gm)].map((match) => match[1]), ['Study']);
  assert.deepStrictEqual([...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]), ['What this project is']);
  assert.ok(text.includes('\\# Evil\n\\## Heading'));
  assert.ok(!text.includes('\x00'));
  assert.strictEqual((text.match(/x/g) || []).length, 1980);
});

test('multi-line answers cannot make rules, fences or Claude imports', () => {
  const text = ins.render({ purpose: 'Intro\n===\n---\n```js\n~~~\n@~/.ssh/config\nSee @AGENTS.md',
    neverDo: 'Stop\n- - -\n@other' }, 'Study');
  for (const value of ['\\===', '\\---', '\\```js', '\\~~~', '\\@~/.ssh/config', '\\@AGENTS.md', '\\- - -', '\\@other']) {
    assert.ok(text.includes(value), value);
  }
  assert.ok(!/^\s*(?:===|---|```|~~~|@~\/\.ssh\/config)$/m.test(text));
});

test('single-line answers collapse newlines before rendering command bullets', () => {
  const text = ins.render({ tools: 'R\n- Test: fake', test: 'pytest\n- Build: fake',
    build: 'make\n- Test: fake', run: 'python main.py\n- Test: fake', rawDataPath: 'data/raw\n- Test: fake' }, 'Study');
  assert.strictEqual([...text.matchAll(/^- Test:/gm)].length, 1);
  assert.strictEqual([...text.matchAll(/^- Build:/gm)].length, 1);
  assert.strictEqual([...text.matchAll(/^- Run:/gm)].length, 1);
  assert.ok(text.includes('- Test: pytest - Build: fake'));
  assert.ok(text.includes('Raw data lives at data/raw - Test: fake.'));
});

test('text strips invisible direction characters and caps escaped emoji text by code point', () => {
  const text = ins.render({ purpose: '# ' + '😀'.repeat(2500) + '\u2028\u2029\u202e\u2067\u200b\u200d\ufeff' }, 'Study');
  const body = text.split('\n\n')[2].trim();
  assert.strictEqual(body, '\\# ' + '😀'.repeat(1997));
  assert.strictEqual(Array.from(body).length, 2000);
  assert.ok(!/[\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]/.test(text));
});

test('createFromAnswers keeps existing AGENTS.md and imports it from CLAUDE.md', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'AGENTS.md'), 'Keep me.\n');
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'Existing Claude instructions.\n');
  const s = ins.createFromAnswers(d, { purpose: 'New text.' }, 'Study');
  assert.strictEqual(s.kept, true);
  assert.ok(s.hasAgents && s.hasClaude && s.claudeImports);
  assert.strictEqual(fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8'), 'Keep me.\n');
  assert.strictEqual(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8'), 'Existing Claude instructions.\n\n@AGENTS.md\n');
});

test('createFromAnswers writes rendered AGENTS.md and creates the CLAUDE.md import', () => {
  const d = tmp();
  const s = ins.createFromAnswers(d, { purpose: 'Analyze samples.' }, 'Study');
  assert.ok(s.hasAgents && s.hasClaude && s.claudeImports);
  assert.ok(fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8').includes('Analyze samples.'));
  assert.strictEqual(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8'), ins.IMPORT);
});

test('createFromAnswers preserves an existing CLAUDE.md when AGENTS.md is newly rendered', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'Existing Claude instructions.\n');
  const s = ins.createFromAnswers(d, { purpose: 'New project.' }, 'Study');
  assert.ok(s.hasAgents && s.claudeImports);
  assert.strictEqual(s.kept, undefined);
  assert.ok(fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8').includes('New project.'));
  assert.strictEqual(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8'), 'Existing Claude instructions.\n\n@AGENTS.md\n');
});

for (const file of ['AGENTS.md', 'CLAUDE.md']) {
  for (const targetKind of ['real', 'dangling']) {
    test(`ensure and createFromAnswers refuse a ${targetKind} ${file} symlink`, () => {
      const d = tmp();
      const target = path.join(d, 'target.txt');
      if (targetKind === 'real') fs.writeFileSync(target, 'Target stays untouched.\n');
      fs.symlinkSync(target, path.join(d, file));
      assert.throws(() => ins.ensure(d), /symlink/);
      assert.throws(() => ins.createFromAnswers(d, { purpose: 'New text.' }, 'Study'), /symlink/);
      assert.ok(fs.lstatSync(path.join(d, file)).isSymbolicLink());
      assert.strictEqual(fs.existsSync(path.join(d, file === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md')), false);
      if (targetKind === 'real') assert.strictEqual(fs.readFileSync(target, 'utf8'), 'Target stays untouched.\n');
      else assert.strictEqual(fs.existsSync(target), false);
    });
  }
}

test('createFromAnswers retry keeps AGENTS.md after CLAUDE.md blocks ensure', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'CLAUDE.md'));
  assert.throws(() => ins.createFromAnswers(d, { purpose: 'First answer.' }, 'Study'), /regular file/);
  const created = fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8');
  fs.renameSync(path.join(d, 'CLAUDE.md'), path.join(d, 'old-claude-dir'));
  const s = ins.createFromAnswers(d, { purpose: 'Second answer.' }, 'Study');
  assert.strictEqual(s.kept, true);
  assert.strictEqual(fs.readFileSync(path.join(d, 'AGENTS.md'), 'utf8'), created);
  assert.strictEqual(fs.readFileSync(path.join(d, 'CLAUDE.md'), 'utf8'), ins.IMPORT);
});

test('every project type has default answers or uses the general fallback', () => {
  const general = ins.DEFAULTS_BY_TYPE.general;
  for (const { id } of TYPES) {
    const defaults = ins.answerDefaults(id, 'A project.');
    assert.deepStrictEqual(Object.keys(defaults), ['purpose', 'tools', 'test', 'build', 'run', 'rawDataPath',
      'protectRawData', 'noCommitData', 'hpc', 'autonomy', 'noAutoCommit', 'noCoAuthor', 'neverDo']);
    assert.strictEqual(defaults.purpose, 'A project.');
    assert.strictEqual(defaults.tools, (ins.DEFAULTS_BY_TYPE[id] || general).tools);
    assert.strictEqual(defaults.protectRawData, true);
    assert.strictEqual(defaults.noCommitData, true);
    assert.strictEqual(defaults.autonomy, 'plan');
  }
  assert.strictEqual(ins.answerDefaults('unknown', '').tools, general.tools);
  assert.strictEqual(ins.answerDefaults('constructor', '').tools, general.tools);
});
