// A project's main agent instructions live in AGENTS.md (read by Codex, and by most other tools).
// Claude Code reads only CLAUDE.md, so that file is a one-line import of AGENTS.md.
const fs = require('fs');
const path = require('path');

const IMPORT = '@AGENTS.md\n';
const TEMPLATE = (name) => `# ${name}

Instructions for the AI agents working in this project. Claude and Codex both read this file.

## What this project is

## Conventions

## Commands (build, test, run)

## Do not
`;

const DEFAULTS_BY_TYPE = {
  'r-project': { tools: 'R, RStudio, renv', test: '', build: '', run: '' },
  'r-package': { tools: 'R, devtools, testthat', test: "Rscript -e 'devtools::test()'", build: 'R CMD build .', run: '' },
  'python-project': { tools: 'Python, JupyterLab, conda', test: 'pytest', build: '', run: '' },
  'python-package': { tools: 'Python, pytest, hatchling', test: 'pytest', build: 'python -m build', run: '' },
  quarto: { tools: 'Quarto', test: '', build: 'quarto render', run: 'quarto preview' },
  snakemake: { tools: 'Snakemake', test: 'snakemake -n', build: '', run: 'snakemake --cores 1' },
  general: { tools: '', test: '', build: '', run: '' }
};

function clean(value, singleLine = false) {
  if (typeof value !== 'string') return '';
  let text = value.replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]/g, '').trim();
  if (singleLine) text = text.replace(/[ \t]*\n+[ \t]*/g, ' ');
  else {
    text = text.split('\n').map((line) => {
      const indent = /^ {0,3}/.exec(line)[0];
      const rest = line.slice(indent.length);
      if (/^#(?=#|\s|$)/.test(rest) || /^(`{3,}|~{3,})/.test(rest) ||
          /^(?:=+|-+)[ \t]*$/.test(rest) || /^(?:[-*_][ \t]*){3,}$/.test(rest)) return indent + '\\' + rest;
      return line;
    }).join('\n').replace(/(^|[^A-Za-z0-9_\\])@/gm, '$1\\@');
  }
  return Array.from(text).slice(0, 2000).join('').trim();
}

function answerDefaults(type, description) {
  const commands = Object.hasOwn(DEFAULTS_BY_TYPE, type) ? DEFAULTS_BY_TYPE[type] : DEFAULTS_BY_TYPE.general;
  return {
    purpose: clean(description), ...commands,
    rawDataPath: type === 'r-project' || type === 'python-project' ? 'data/raw' : '',
    protectRawData: true, noCommitData: true, hpc: false, autonomy: 'plan',
    noAutoCommit: true, noCoAuthor: true, neverDo: ''
  };
}

function render(answers, name) {
  const a = answers && typeof answers === 'object' ? answers : {};
  const title = clean(name).replace(/\n/g, ' ') || 'Project';
  const purpose = clean(a.purpose);
  const tools = clean(a.tools, true);
  const test = clean(a.test, true);
  const build = clean(a.build, true);
  const run = clean(a.run, true);
  const rawDataPath = clean(a.rawDataPath, true);
  const neverDo = clean(a.neverDo);
  const sections = [];
  if (purpose) sections.push(`## What this project is\n\n${purpose}`);
  const commands = [];
  if (tools) commands.push(`Main languages and tools: ${tools}`);
  if (test) commands.push(`- Test: ${test}`);
  if (build) commands.push(`- Build: ${build}`);
  if (run) commands.push(`- Run: ${run}`);
  if (commands.length) sections.push(`## Tools and commands\n\n${commands.join('\n')}`);
  const data = [];
  if (rawDataPath) data.push(`Raw data lives at ${rawDataPath}.`);
  if (a.protectRawData === true) data.push('Never modify raw data.');
  if (a.noCommitData === true) data.push('Never commit data.');
  if (data.length) sections.push(`## Data rules\n\n${data.join('\n')}`);
  if (a.hpc === true) sections.push('## HPC\n\nUse the open Codeome connection for HPC work. Never submit jobs unless asked.');
  const autonomyText = {
    ask: 'Ask before making big changes.',
    small: 'Make small changes freely. Ask before larger changes.',
    plan: 'Plan first for any change that touches multiple files.'
  };
  const autonomy = Object.hasOwn(autonomyText, a.autonomy) ? autonomyText[a.autonomy] : '';
  if (autonomy) sections.push(`## How to work\n\n${autonomy}`);
  const commits = [];
  if (a.noAutoCommit === true) commits.push('Never commit unless asked.');
  if (a.noCoAuthor === true) commits.push('Never add a Co-Authored-By trailer.');
  if (commits.length) sections.push(`## Commits\n\n${commits.join('\n')}`);
  if (neverDo) sections.push(`## Do not\n\n${neverDo}`);
  return sections.length ? `# ${title}\n\n${sections.join('\n\n')}\n` : TEMPLATE(title);
}

function checkedFile(file) {
  let info;
  try { info = fs.lstatSync(file); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (info.isSymbolicLink()) throw new Error(`${path.basename(file)} is a symlink; refusing to use it.`);
  return info;
}

function readRegular(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${path.basename(file)} must be a regular file.`);
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}

function writeRegular(file, text) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${path.basename(file)} must be a regular file.`);
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, text);
  } finally { fs.closeSync(fd); }
}

function status(project) {
  const agents = path.join(project, 'AGENTS.md');
  const claude = path.join(project, 'CLAUDE.md');
  const agentsInfo = checkedFile(agents);
  const claudeInfo = checkedFile(claude);
  let claudeImports = false;
  if (claudeInfo && claudeInfo.isFile()) {
    try { claudeImports = /^\s*@AGENTS\.md\s*$/m.test(readRegular(claude)); } catch {}
  }
  return { agentsPath: agents, claudePath: claude, hasAgents: !!agentsInfo, hasClaude: !!claudeInfo, claudeImports };
}

// Creates AGENTS.md when missing, and makes CLAUDE.md load it. An existing CLAUDE.md is never overwritten:
// it moves into a new AGENTS.md (when there is none), or gets the import line appended.
function ensure(project) {
  const s = status(project);
  if (!s.hasAgents) {
    let text = TEMPLATE(path.basename(project));
    if (s.hasClaude && !s.claudeImports) text = readRegular(s.claudePath);
    fs.writeFileSync(s.agentsPath, text, { flag: 'wx' });
  }
  if (!s.hasClaude) fs.writeFileSync(s.claudePath, IMPORT, { flag: 'wx' });
  else if (!s.claudeImports) {
    const cur = readRegular(s.claudePath);
    const moved = !s.hasAgents; // content was copied into AGENTS.md above
    writeRegular(s.claudePath, moved ? IMPORT : cur.replace(/\n*$/, '\n\n') + IMPORT);
  }
  return status(project);
}

function createFromAnswers(project, answers, name) {
  checkedFile(path.join(project, 'AGENTS.md'));
  checkedFile(path.join(project, 'CLAUDE.md'));
  let kept = false;
  try { fs.writeFileSync(path.join(project, 'AGENTS.md'), render(answers, name), { flag: 'wx' }); }
  catch (e) { if (e.code === 'EEXIST') kept = true; else throw e; }
  const s = ensure(project);
  return kept ? { ...s, kept: true } : s;
}

module.exports = { status, ensure, IMPORT, TEMPLATE, DEFAULTS_BY_TYPE, answerDefaults, render, createFromAnswers };
