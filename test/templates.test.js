const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const templates = require('../main/templates');

const opts = { name: 'Sample', description: 'A sample project.', author: 'Ada Lovelace', email: 'ada@example.org', license: 'mit', year: 2026 };
const filesFor = (type, extra = {}) => new Map(templates.build(type, { ...opts, ...extra }).files.map((file) => [file.path, file.content]));

test('every template has common files and safe unique relative POSIX paths', () => {
  assert.deepStrictEqual(templates.TYPES.map((type) => type.id), ['r-project', 'r-package', 'python-project', 'python-package', 'quarto', 'snakemake', 'empty']);
  for (const { id } of templates.TYPES) {
    const files = templates.build(id, opts).files;
    const paths = files.map((file) => file.path);
    assert.ok(paths.includes('README.md'), id);
    assert.ok(paths.includes('.gitignore'), id);
    assert.ok(paths.includes('LICENSE'), id);
    assert.strictEqual(new Set(paths).size, paths.length, id);
    for (const file of files) {
      assert.strictEqual(typeof file.content, 'string');
      assert.ok(!path.posix.isAbsolute(file.path) && !file.path.split('/').includes('..') && !file.path.includes('\\'), `${id}: ${file.path}`);
    }
  }
});

test('name validation rejects unsafe names and enforces package conventions', () => {
  assert.ok(templates.validateName('empty', ''));
  assert.ok(templates.validateName('empty', '   '));
  assert.ok(templates.validateName('empty', '../escape'));
  assert.ok(templates.validateName('empty', 'one/two'));
  assert.ok(templates.validateName('empty', 'one\\two'));
  assert.ok(templates.validateName('empty', '.hidden'));
  assert.ok(templates.validateName('empty', 'a'.repeat(101)));
  assert.ok(templates.validateName('missing', 'valid'));
  assert.strictEqual(templates.validateName('empty', 'Field study'), null);
  assert.strictEqual(templates.validateName('r-package', 'R3tools'), null);
  assert.ok(templates.validateName('r-package', '3tools'));
  assert.ok(templates.validateName('r-package', 'tools-3'));
  assert.ok(templates.validateName('r-package', 'tools.'));
  assert.strictEqual(templates.validateName('python-package', 'My.Package-3'), null);
  assert.strictEqual(templates.importName('My.Package-3'), 'my_package_3');
  assert.strictEqual(templates.importName('class'), 'class_');
  assert.ok(templates.validateName('python-package', '3tools'));
  assert.ok(templates.validateName('python-package', 'bad name'));
});

test('R templates contain the promised analysis and package layouts', () => {
  const project = filesFor('r-project');
  for (const file of ['Sample.Rproj', 'data/raw/.gitkeep', 'R/.gitkeep', 'output/.gitkeep']) assert.ok(project.has(file), file);
  const pkg = filesFor('r-package');
  for (const file of ['DESCRIPTION', 'NAMESPACE', 'R/hello.R', 'man/hello.Rd', 'tests/testthat.R', 'tests/testthat/test-hello.R', '.Rbuildignore', 'NEWS.md', 'README.Rmd', 'LICENSE.md']) assert.ok(pkg.has(file), file);
  assert.match(pkg.get('DESCRIPTION'), /License: MIT \+ file LICENSE/);
  assert.match(pkg.get('DESCRIPTION'), /Roxygen: list\(markdown = TRUE\)/);
  assert.match(pkg.get('DESCRIPTION'), /Authors@R: person\(/);
  assert.match(pkg.get('NAMESPACE'), /export\(hello\)/);
  assert.match(pkg.get('LICENSE'), /^YEAR: 2026\nCOPYRIGHT HOLDER: Ada Lovelace\n$/);
  assert.match(pkg.get('LICENSE.md'), /MIT License/);
  assert.match(pkg.get('NEWS.md'), /^# Sample \(development version\)/);
  assert.match(pkg.get('.gitignore'), /\.Rcheck\/\n\*\.tar\.gz/);
  const other = filesFor('r-package', { license: 'gpl-3', title: 'sample package', description: 'A package' });
  assert.match(other.get('.Rbuildignore'), /\^LICENSE\$/);
  assert.match(other.get('DESCRIPTION'), /Title: Sample Package/);
  assert.match(other.get('DESCRIPTION'), /Description: A package\./);
  const noLicense = filesFor('r-package', { license: 'none', author: '', email: '' });
  assert.doesNotMatch(noLicense.get('.Rbuildignore'), /\^LICENSE\$/);
  assert.match(noLicense.get('DESCRIPTION'), /given = "Sample", family = "owner"/);
  assert.doesNotMatch(noLicense.get('DESCRIPTION'), /email =/);
  assert.throws(() => templates.build('r-package', { ...opts, author: '' }), /author/);
});

test('Python templates contain data science and installable package layouts', () => {
  const project = filesFor('python-project', { name: 'Field Study' });
  for (const file of ['data/raw/.gitkeep', 'data/interim/.gitkeep', 'data/processed/.gitkeep', 'data/external/.gitkeep', 'notebooks/.gitkeep', 'src/field_study/__init__.py', 'reports/.gitkeep', 'environment.yml', 'pyproject.toml']) assert.ok(project.has(file), file);
  assert.match(project.get('pyproject.toml'), /name = "field-study"/);
  assert.match(project.get('pyproject.toml'), /requires = \["setuptools>=77"\]/);
  const pkg = filesFor('python-package', { name: 'My.Package-3' });
  for (const file of ['src/my_package_3/__init__.py', 'src/my_package_3/py.typed', 'pyproject.toml', 'tests/test_import.py', 'CHANGELOG.md']) assert.ok(pkg.has(file), file);
  assert.match(pkg.get('pyproject.toml'), /\[build-system\]\nrequires = \["hatchling>=1\.27"\]\nbuild-backend = "hatchling.build"/);
  assert.match(pkg.get('pyproject.toml'), /\[project\]\nname = "my-package-3"/);
  assert.match(pkg.get('pyproject.toml'), /license = "MIT"/);
  assert.match(pkg.get('CHANGELOG.md'), /Keep a Changelog/);
  assert.doesNotMatch(filesFor('python-package', { email: '' }).get('pyproject.toml'), /email =/);
});

test('Quarto and Snakemake scaffolds include their standard entry points', () => {
  assert.ok(filesFor('quarto').has('_quarto.yml'));
  assert.ok(filesFor('quarto').has('index.qmd'));
  assert.doesNotMatch(filesFor('quarto').get('_quarto.yml'), /title:/);
  const workflow = filesFor('snakemake');
  for (const file of ['workflow/Snakefile', 'workflow/rules/common.smk', 'workflow/envs/.gitkeep', 'workflow/scripts/.gitkeep', 'config/config.yaml', 'config/README.md', 'results/.gitkeep', 'resources/.gitkeep']) assert.ok(workflow.has(file), file);
});

test('license choices produce matching LICENSE content', () => {
  assert.deepStrictEqual(templates.LICENSES.map((license) => license.id), ['mit', 'gpl-3', 'apache-2', 'cc-by-4', 'none']);
  assert.match(filesFor('empty').get('LICENSE'), /MIT License\n\nCopyright \(c\) 2026 Ada Lovelace/);
  assert.match(filesFor('empty', { license: 'gpl-3' }).get('LICENSE'), /gnu.org\/licenses\/gpl-3.0.html/);
  assert.match(filesFor('empty', { license: 'apache-2' }).get('LICENSE'), /apache.org\/licenses\/LICENSE-2.0/);
  assert.match(filesFor('empty', { license: 'cc-by-4' }).get('LICENSE'), /Section 8 -- Interpretation/);
  assert.match(filesFor('empty', { license: 'none' }).get('LICENSE'), /No license is granted/);
  assert.throws(() => templates.build('empty', { ...opts, license: 'unknown' }), /Choose a license/);
});

function projectFixture(t, git = async () => ({ code: 0 })) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-project-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, git, create: (args) => templates.create({ base, fs, git, ...args }) };
}

test('project:create rejects invalid and existing names before writing', async (t) => {
  const h = projectFixture(t);
  fs.mkdirSync(path.join(h.base, 'Sample'));
  assert.match((await h.create({ type: 'empty', name: '../escape' })).error, /path separators/);
  assert.match((await h.create({ type: 'unknown', name: 'Sample' })).error, /project type/);
  assert.match((await h.create({ type: 'empty', name: 'Sample' })).error, /already exists/);
  assert.deepStrictEqual(fs.readdirSync(h.base), ['Sample']);
});

test('project:create writes files and initializes Git unless disabled', async (t) => {
  const calls = [];
  const h = projectFixture(t, async (cwd, args) => { calls.push({ cwd, args }); return { code: 0 }; });
  const result = await h.create({ type: 'empty', name: 'New Project', opts: { ...opts, git: false } });
  assert.strictEqual(result.dir, path.join(h.base, 'New Project'));
  assert.ok(fs.readFileSync(path.join(result.dir, 'README.md'), 'utf8').startsWith('# New Project'));
  assert.strictEqual(calls.length, 0);
  const gitProject = await h.create({ type: 'python-package', name: 'my-pkg', opts });
  assert.strictEqual(gitProject.dir, path.join(h.base, 'my-pkg'));
  assert.deepStrictEqual(calls.map((call) => call.args.join(' ')), ['init -b main', 'add -A', 'commit -m Initial commit from Codeome template']);
});

test('project:create cleans a new directory when writing fails and handles null opts', async (t) => {
  const h = projectFixture(t);
  const nullResult = await h.create({ type: 'empty', name: 'Null Options', opts: null });
  assert.match(nullResult.error, /author/);
  assert.ok(!fs.existsSync(path.join(h.base, 'Null Options')));
  const failingFs = { ...fs, writeFileSync: () => { throw new Error('disk full'); } };
  const result = await templates.create({ base: h.base, type: 'empty', name: 'Write Failure', opts, fs: failingFs, git: h.git });
  assert.match(result.error, /disk full/);
  assert.ok(!fs.existsSync(path.join(h.base, 'Write Failure')));
});

test('project:create returns a warning and keeps files when Git fails', async (t) => {
  for (const phase of ['init', 'add', 'commit']) {
    const h = projectFixture(t, async (_cwd, args) => ({ code: args[0] === phase ? 1 : 0, stderr: `${phase} failed` }));
    const result = await h.create({ type: 'empty', name: 'No Identity', opts });
    assert.strictEqual(result.dir, path.join(h.base, 'No Identity'));
    assert.strictEqual(result.warning, `${phase} failed`);
    assert.ok(fs.existsSync(path.join(result.dir, 'README.md')));
  }
});
