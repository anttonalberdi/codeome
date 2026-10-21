// Pure project scaffolds: build returns file contents without touching the filesystem.
const CC_BY_4 = require('./cc-by-4-license');
const path = require('node:path');

const TYPES = [
  { id: 'r-project', label: 'R project', description: 'An analysis project with RStudio and renv support.', standard: 'Good Enough Practices' },
  { id: 'r-package', label: 'R package', description: 'A package ready for devtools and testthat.', standard: 'usethis/devtools' },
  { id: 'python-project', label: 'Python project', description: 'A data science project with notebooks.', standard: 'Cookiecutter Data Science v2' },
  { id: 'python-package', label: 'Python package', description: 'An installable package with tests.', standard: 'PyPA src layout and PEP 621' },
  { id: 'quarto', label: 'Quarto', description: 'A Quarto report or website.', standard: 'Quarto project' },
  { id: 'snakemake', label: 'Snakemake', description: 'A reproducible workflow.', standard: 'Snakemake standardized usage' },
  { id: 'empty', label: 'Empty project', description: 'A README and license to start from.', standard: 'Minimal project' }
];

const LICENSES = [
  { id: 'mit', label: 'MIT' },
  { id: 'gpl-3', label: 'GPL-3.0' },
  { id: 'apache-2', label: 'Apache-2.0' },
  { id: 'cc-by-4', label: 'CC BY 4.0' },
  { id: 'none', label: 'No license' }
];

const R_IGNORE = '.Rproj.user/\n.Rhistory\n.RData\n.Ruserdata\nrenv/library/\nrenv/staging/\n';
const PY_IGNORE = '__pycache__/\n*.py[cod]\n.venv/\n.env\n.pytest_cache/\n.ruff_cache/\n*.egg-info/\ndist/\nbuild/\n.ipynb_checkpoints/\n';
const GENERAL_IGNORE = '.DS_Store\nThumbs.db\n*.swp\n';
const PY_KEYWORDS = new Set('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '));

function importName(name) {
  const value = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return PY_KEYWORDS.has(value) ? value + '_' : value;
}

function validateName(type, name) {
  if (!TYPES.some((item) => item.id === type)) return 'Choose a project type.';
  if (typeof name !== 'string' || !name.trim()) return 'Enter a project name.';
  if (name.length > 100) return 'Project names must be at most 100 characters.';
  if (name.startsWith('.') || /[\\/\x00-\x1f\x7f]/.test(name) || name !== name.trim()) return 'Use a name without path separators, leading dots or surrounding spaces.';
  if (type === 'r-package' && !/^[A-Za-z][A-Za-z0-9.]*[A-Za-z0-9]$/.test(name) && !/^[A-Za-z]$/.test(name)) {
    return 'R package names must start with a letter and contain only letters, digits or dots, without a trailing dot.';
  }
  if (type === 'python-package' && (!/^[A-Za-z][A-Za-z0-9._-]*[A-Za-z0-9]$/.test(name) && !/^[A-Za-z]$/.test(name) || !/^[a-z][a-z0-9_]*$/.test(importName(name)))) {
    return 'Python package names must start with a letter and contain only letters, digits, dots, hyphens or underscores.';
  }
  return null;
}

function licenseText(id, author, year) {
  const copyright = `Copyright (c) ${year} ${author}`;
  if (id === 'mit') return `MIT License\n\n${copyright}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n` +
    'of this software and associated documentation files (the "Software"), to deal\n' +
    'in the Software without restriction, including without limitation the rights\n' +
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\n' +
    'copies of the Software, and to permit persons to whom the Software is\n' +
    'furnished to do so, subject to the following conditions:\n\n' +
    'The above copyright notice and this permission notice shall be included in all\n' +
    'copies or substantial portions of the Software.\n\n' +
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\n' +
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\n' +
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\n' +
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\n' +
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\n' +
    'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\n' +
    'SOFTWARE.\n';
  // GPL and Apache use their standard notice plus the canonical full-license URL.
  if (id === 'gpl-3') return `${copyright}\n\nThis program is free software: you can redistribute it and/or modify\n` +
    'it under the terms of the GNU General Public License as published by\n' +
    'the Free Software Foundation, either version 3 of the License, or\n' +
    '(at your option) any later version.\n\n' +
    'This program is distributed in the hope that it will be useful,\n' +
    'but WITHOUT ANY WARRANTY; without even the implied warranty of\n' +
    'MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the\n' +
    'GNU General Public License for more details.\n\n' +
    'You should have received a copy of the GNU General Public License\n' +
    'along with this program. If not, see <https://www.gnu.org/licenses/gpl-3.0.html>.\n';
  if (id === 'apache-2') return `${copyright}\n\nLicensed under the Apache License, Version 2.0 (the "License");\n` +
    'you may not use this file except in compliance with the License.\n' +
    'You may obtain a copy of the License at\n\n' +
    '    https://www.apache.org/licenses/LICENSE-2.0\n\n' +
    'Unless required by applicable law or agreed to in writing, software\n' +
    'distributed under the License is distributed on an "AS IS" BASIS,\n' +
    'WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.\n' +
    'See the License for the specific language governing permissions and\n' +
    'limitations under the License.\n';
  if (id === 'cc-by-4') return CC_BY_4;
  return `${copyright}\n\nAll rights reserved. No license is granted for reuse.\n`;
}

function build(type, opts = {}) {
  opts = opts && typeof opts === 'object' ? opts : {};
  const name = opts.name;
  const bad = validateName(type, name);
  if (bad) throw new Error(bad);
  const license = opts.license || 'mit';
  if (!LICENSES.some((item) => item.id === license)) throw new Error('Choose a license.');
  const author = String(opts.author || '').trim() || (license === 'none' ? `${name} owner` : '');
  if (!author) throw new Error('Enter an author for this license.');
  const email = String(opts.email || '').trim();
  const year = String(opts.year || new Date().getFullYear());
  const description = String(opts.description || 'Describe this project.').replace(/\s+/g, ' ').trim();
  const title = String(opts.title || name).replace(/\s+/g, ' ').trim();
  const rTitle = title.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  const rDescription = /\.$/.test(description) ? description : `${description}.`;
  const pkg = importName(name) || 'project';
  const files = [];
  const add = (file, content = '') => files.push({ path: file, content });
  const keep = (...dirs) => dirs.forEach((dir) => add(`${dir}/.gitkeep`));
  const readme = `# ${title}\n\n${description}\n`;
  add('README.md', readme);
  add('LICENSE', licenseText(license, author, year));

  if (type === 'r-project' || type === 'r-package') add('.gitignore', R_IGNORE + (type === 'r-package' ? '.Rcheck/\n*.tar.gz\n' : '') + GENERAL_IGNORE);
  else if (type === 'python-project' || type === 'python-package') add('.gitignore', PY_IGNORE + GENERAL_IGNORE);
  else if (type === 'quarto') add('.gitignore', '.quarto/\n_site/\n_freeze/\n' + GENERAL_IGNORE);
  else if (type === 'snakemake') add('.gitignore', 'results/*\n!results/.gitkeep\n.snakemake/\n' + GENERAL_IGNORE);
  else add('.gitignore', GENERAL_IGNORE);

  if (type === 'r-project') {
    add(`${name}.Rproj`, 'Version: 1.0\nRestoreWorkspace: No\nSaveWorkspace: No\nAlwaysSaveHistory: No\nEnableCodeIndexing: Yes\nUseSpacesForTab: Yes\nNumSpacesForTab: 2\nEncoding: UTF-8\n');
    keep('data/raw', 'R', 'output');
  } else if (type === 'r-package') {
    const parts = author.split(/\s+/);
    const family = parts.pop();
    const given = parts.join(' ') || family;
    const rLicense = { mit: 'MIT + file LICENSE', 'gpl-3': 'GPL (>= 3)', 'apache-2': 'Apache License (== 2.0)', 'cc-by-4': 'CC BY 4.0', none: 'file LICENSE' }[license];
    add('DESCRIPTION', `Package: ${name}\nTitle: ${rTitle}\nVersion: 0.0.0.9000\nAuthors@R: person(given = ${JSON.stringify(given)}, family = ${JSON.stringify(family)}${email ? `, email = ${JSON.stringify(email)}` : ''}, role = c("aut", "cre"))\nDescription: ${rDescription}\nLicense: ${rLicense}\nEncoding: UTF-8\nRoxygen: list(markdown = TRUE)\nRoxygenNote: 7.3.2\nSuggests: testthat (>= 3.0.0)\nConfig/testthat/edition: 3\n`);
    add('NAMESPACE', '# Generated by roxygen2: do not edit by hand\n\nexport(hello)\n');
    add('.Rbuildignore', '^.*\\.Rproj$\n^\\.Rproj\\.user$\n^README\\.Rmd$\n^LICENSE\\.md$\n' + (license === 'mit' || license === 'none' ? '' : '^LICENSE$\n'));
    add('NEWS.md', `# ${name} (development version)\n\n## ${name} 0.0.0.9000\n\n* Initial development version.\n`);
    add('README.Rmd', `---\noutput: github_document\n---\n\n# ${title}\n\n${description}\n`);
    add('tests/testthat.R', `library(testthat)\nlibrary(${name})\n\ntest_check("${name}")\n`);
    add('R/hello.R', "#' Return a greeting\n#'\n#' @return A greeting string.\n#' @export\nhello <- function() \"Hello, world!\"\n");
    add('man/hello.Rd', '\\name{hello}\n\\alias{hello}\n\\title{Return a greeting}\n\\usage{hello()}\n\\value{A greeting string.}\n\\description{Returns a greeting.}\n');
    add('tests/testthat/test-hello.R', 'test_that("hello returns a greeting", {\n  expect_equal(hello(), "Hello, world!")\n})\n');
    if (license === 'mit') {
      files.find((file) => file.path === 'LICENSE').content = `YEAR: ${year}\nCOPYRIGHT HOLDER: ${author}\n`;
      add('LICENSE.md', licenseText(license, author, year));
    } else if (license !== 'none') add('LICENSE.md', licenseText(license, author, year));
  } else if (type === 'python-project') {
    const module = /^[a-z]/.test(pkg) ? pkg : `project_${pkg}`;
    add('pyproject.toml', `[project]\nname = ${JSON.stringify(module.replace(/_/g, '-'))}\nversion = "0.1.0"\ndescription = ${JSON.stringify(description)}\nreadme = "README.md"\nrequires-python = ">=3.9"\n${license === 'none' ? '' : `license = "${{ mit: 'MIT', 'gpl-3': 'GPL-3.0-or-later', 'apache-2': 'Apache-2.0', 'cc-by-4': 'CC-BY-4.0' }[license]}"\n`}\n[build-system]\nrequires = ["setuptools>=77"]\nbuild-backend = "setuptools.build_meta"\n\n[tool.setuptools.packages.find]\nwhere = ["src"]\n`);
    add('environment.yml', `name: ${module}\nchannels:\n  - conda-forge\ndependencies:\n  - python>=3.9\n  - pip\n  - jupyterlab\n`);
    add(`src/${module}/__init__.py`, JSON.stringify(description) + '\n');
    keep('data/raw', 'data/interim', 'data/processed', 'data/external', 'notebooks', 'reports');
  } else if (type === 'python-package') {
    const dist = name.toLowerCase().replace(/[-_.]+/g, '-');
    add('pyproject.toml', `[build-system]\nrequires = ["hatchling>=1.27"]\nbuild-backend = "hatchling.build"\n\n[project]\nname = ${JSON.stringify(dist)}\nversion = "0.1.0"\ndescription = ${JSON.stringify(description)}\nreadme = "README.md"\nrequires-python = ">=3.9"\nauthors = [{ name = ${JSON.stringify(author)}${email ? `, email = ${JSON.stringify(email)}` : ''} }]\n${license === 'none' ? '' : `license = "${{ mit: 'MIT', 'gpl-3': 'GPL-3.0-or-later', 'apache-2': 'Apache-2.0', 'cc-by-4': 'CC-BY-4.0' }[license]}"\n`}\n[project.optional-dependencies]\ntest = ["pytest>=7"]\n\n[tool.hatch.build.targets.wheel]\npackages = ["src/${pkg}"]\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n`);
    add(`src/${pkg}/__init__.py`, JSON.stringify(description) + '\n');
    add(`src/${pkg}/py.typed`, '');
    add('tests/test_import.py', `import ${pkg}\n\n\ndef test_import():\n    assert ${pkg} is not None\n`);
    add('CHANGELOG.md', `# Changelog\n\nAll notable changes to this project will be documented in this file.\n\nThe format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),\nand this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).\n\n## [Unreleased]\n\n### Added\n\n- Initial project structure.\n`);
  } else if (type === 'quarto') {
    add('_quarto.yml', 'project:\n  type: default\n');
    add('index.qmd', `---\ntitle: ${JSON.stringify(title)}\n---\n\n${description}\n`);
  } else if (type === 'snakemake') {
    add('workflow/Snakefile', 'configfile: "config/config.yaml"\n\nrule all:\n    input:\n        []\n');
    add('workflow/rules/common.smk', '# Add shared workflow rules here.\n');
    add('config/config.yaml', '{}\n');
    add('config/README.md', '# Configuration\n\nSet workflow options in `config.yaml`.\n');
    keep('workflow/envs', 'workflow/scripts', 'results', 'resources');
  }
  return { files };
}

async function create({ base, type, name, opts, fs, git }) {
  opts = opts && typeof opts === 'object' ? opts : {};
  const bad = validateName(type, name);
  if (bad) return { error: bad };
  const dir = path.join(base, name);
  const relative = path.relative(base, dir);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return { error: 'Project path must stay inside the projects folder.' };
  if (fs.existsSync(dir)) return { error: `${dir} already exists. Open it as a folder instead, or remove it first.` };
  let created = false;
  try {
    const { files } = build(type, { ...opts, name });
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(dir);
    created = true;
    for (const file of files) {
      const dest = path.resolve(dir, file.path);
      const rel = path.relative(dir, dest);
      if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Template contains an invalid file path.');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, file.content, { flag: 'wx' });
    }
  } catch (e) {
    if (created) {
      try { fs.rmSync(dir, { recursive: true, force: true }); }
      catch (cleanupError) { return { error: `${String(e.message || e)}; cleanup failed: ${String(cleanupError.message || cleanupError)}` }; }
    }
    return { error: String(e.message || e) };
  }
  if (opts.git !== false) {
    try {
      for (const args of [['init', '-b', 'main'], ['add', '-A'], ['commit', '-m', 'Initial commit from Codeome template']]) {
        const result = await git(dir, args);
        if (result.code !== 0) return { dir, warning: (result.stderr || `git ${args[0]} failed`).trim() };
      }
    } catch (e) { return { dir, warning: String(e.message || e) }; }
  }
  return { dir };
}

module.exports = { TYPES, LICENSES, importName, validateName, build, create };
