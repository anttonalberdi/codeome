const path = require('path');

const POLICY_DEFAULTS = [
  {
    key: 'slurmSubmit', label: 'Slurm job submission',
    help: 'Matching is heuristic: a script that itself calls sbatch is not caught. Allow may still be refused by Claude\'s own safety checks.',
    type: 'tri', default: 'ask', options: [
      { value: 'ask', label: 'Ask' }, { value: 'allow', label: 'Allow (best effort)' }, { value: 'never', label: 'Never' }
    ]
  },
  {
    key: 'gitPublish', label: 'Git publishing', help: 'Agents running git commit, push, or tag.',
    type: 'enum', default: 'ask', options: [{ value: 'ask', label: 'Ask' }, { value: 'never', label: 'Never' }]
  },
  {
    key: 'hpcAccess', label: 'HPC access',
    help: 'Read-only denies mutating remote commands: rm, mv, cp, write redirects, scancel, sbatch, srun, and salloc.',
    type: 'enum', default: 'full', advisory: true,
    options: [{ value: 'full', label: 'Full' }, { value: 'readonly', label: 'Read-only' }]
  },
  {
    key: 'writeOutsideProject', label: 'Writes outside project', help: 'Agent file edits outside this project.',
    type: 'enum', default: 'ask', options: [{ value: 'ask', label: 'Ask' }, { value: 'never', label: 'Never' }]
  },
  {
    key: 'requirePlan', label: 'Require a plan', help: 'Ask the agent to make a plan before changing files (prompt only).',
    type: 'bool', default: 'off', advisory: true,
    options: [{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]
  }
];

function selected(policy, item) {
  const value = policy && policy[item.key];
  return item.options.some((option) => option.value === value) ? value : item.default;
}

function policyFor(cfg, cwd) {
  const stored = cfg && cfg.projectPolicy && cfg.projectPolicy[cwd];
  return Object.fromEntries(POLICY_DEFAULTS.map((item) => [item.key, selected(stored, item)]));
}

function shellTokens(command) {
  const words = [];
  let word = '', quote = '', started = false, start = 0;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\' && command[i + 1] === '\n') { i++; continue; }
    if (c === '\\' && quote !== "'" && i + 1 < command.length) { if (!started) start = i; word += command[++i]; started = true; continue; }
    if (c === quote && quote) { quote = ''; continue; }
    if (!quote && (c === "'" || c === '"')) { if (!started) start = i; quote = c; started = true; continue; }
    if (!quote && /\s/.test(c)) {
      if (started) words.push({ value: word, raw: command.slice(start, i) });
      word = ''; started = false;
      continue;
    }
    if (!started) start = i;
    word += c; started = true;
  }
  if (started) words.push({ value: word, raw: command.slice(start) });
  return words;
}

function shellWords(command) { return shellTokens(command).map((token) => token.value); }

function commandIndex(words) {
  let i = 0;
  while (i < words.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || ['{', '(', '!', 'then', 'do', 'else', 'elif', 'if', 'while', 'until'].includes(words[i])) { i++; continue; }
    const prefix = words[i];
    if (prefix === 'env') {
      i++;
      while (words[i]) {
        if (['-i', '-0', '--ignore-environment'].includes(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
        else if (words[i] === '-u' || words[i] === '--unset') i += 2;
        else break;
      }
      continue;
    }
    if (prefix === 'sudo') {
      i++;
      while (words[i] && words[i].startsWith('-')) {
        const option = words[i++];
        if (['-u', '-g', '-h', '-p', '-C', '-r', '-t'].includes(option)) i++;
      }
      continue;
    }
    if (prefix === 'command' && ['-v', '-V'].includes(words[i + 1])) break;
    if (['time', 'nohup', 'command', 'exec', 'setsid', 'nice', 'timeout', 'stdbuf', 'xargs'].includes(prefix)) {
      i++;
      while (words[i] && words[i].startsWith('-')) {
        const option = words[i++];
        if ((prefix === 'nice' && option === '-n') || (prefix === 'timeout' && ['-s', '--signal', '-k', '--kill-after'].includes(option)) ||
            (prefix === 'stdbuf' && ['-i', '-o', '-e'].includes(option)) || (prefix === 'xargs' && ['-a', '-d', '-E', '-I', '-L', '-n', '-P', '-s'].includes(option))) i++;
      }
      if (prefix === 'timeout' && words[i]) i++;
      if (prefix === 'nice' && /^[+-]?\d+$/.test(words[i] || '')) i++;
      continue;
    }
    break;
  }
  return i;
}

function commandName(word) { return path.posix.basename(word || ''); }

function remoteStart(words, index) {
  let i = index + 1;
  const takesValue = new Set(['-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-R', '-S', '-W', '-w']);
  while (words[i] && words[i].startsWith('-')) {
    const option = words[i++];
    if (takesValue.has(option)) i++;
  }
  return i + 1; // skip the host
}

function safeRemoteStart(words) {
  let i = 1;
  while (words[i] && words[i].startsWith('-')) {
    const option = words[i++];
    if (option === '-o' || option.startsWith('-o')) {
      const setting = option === '-o' ? words[i++] : option.slice(2);
      if (!/^(ControlPath|ControlMaster|ControlPersist|BatchMode)=/.test(setting || '')) return -1;
    } else if (['-S', '-p', '-i', '-l'].includes(option)) {
      if (!words[i++]) return -1;
    } else if (!/^-[46qTtnNv]+$/.test(option)) return -1;
  }
  return words[i] ? i + 1 : -1;
}

function writeRedirect(command) {
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\' && quote !== "'") { i++; continue; }
    if (c === quote && quote) { quote = ''; continue; }
    if (!quote && (c === "'" || c === '"')) { quote = c; continue; }
    if (!quote && c === '>' && command[i + 1] !== '&') {
      const target = command.slice(i + 1).replace(/^>\s*/, '').trimStart().match(/^(?:["']?)([^\s"']+)/);
      if (target && target[1] === '/dev/null') continue;
      return true;
    }
  }
  return false;
}

function beforeLocalRedirect(command) {
  let quote = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\' && quote !== "'") { i++; continue; }
    if (c === quote && quote) { quote = ''; continue; }
    if (!quote && (c === "'" || c === '"')) { quote = c; continue; }
    if (!quote && (c === '>' || c === '<')) return command.slice(0, i);
  }
  return command;
}

function substitutions(command) {
  const segments = [], nested = [];
  let segment = '', quote = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\' && command[i + 1] === '\n') { i++; continue; }
    if (c === '\\' && quote !== "'" && i + 1 < command.length) { segment += c + command[++i]; continue; }
    if (c === quote && quote) { quote = ''; segment += c; continue; }
    if (!quote && (c === "'" || c === '"')) { quote = c; segment += c; continue; }
    if (quote !== "'" && c === '$' && command[i + 1] === '(') {
      let depth = 1, inner = '', innerQuote = '';
      i++;
      while (++i < command.length && depth) {
        const x = command[i];
        if (x === '\\' && innerQuote !== "'" && i + 1 < command.length) { inner += x + command[++i]; continue; }
        if (x === innerQuote && innerQuote) { innerQuote = ''; inner += x; continue; }
        if (!innerQuote && (x === "'" || x === '"')) { innerQuote = x; inner += x; continue; }
        if (!innerQuote && x === '(') depth++;
        if (!innerQuote && x === ')') depth--;
        if (depth) inner += x;
      }
      nested.push(inner); segment += ' ';
      i--;
      continue;
    }
    if (quote !== "'" && c === '`') {
      let inner = '';
      while (++i < command.length && command[i] !== '`') inner += command[i];
      nested.push(inner); segment += ' ';
      continue;
    }
    if (!quote && (c === ';' || c === '\n' || c === '|' || (c === '&' && command[i - 1] !== '>'))) {
      if (segment.trim()) segments.push(segment.trim());
      segment = '';
      if ((c === '|' || c === '&') && command[i + 1] === c) i++;
      if (c === '|' && command[i + 1] === '&') i++;
      continue;
    }
    segment += c;
  }
  if (segment.trim()) segments.push(segment.trim());
  return { segments, nested };
}

function heredocs(command) {
  const lines = command.split('\n'), kept = [], scripts = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    kept.push(line);
    const match = line.match(/(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (!match) continue;
    const end = lines.findIndex((candidate, at) => at > i && candidate.trim() === match[2]);
    if (end < 0) continue;
    scripts.push({ owner: line, body: lines.slice(i + 1, end).join('\n'), unquoted: !match[1] });
    i = end;
  }
  return { command: kept.join('\n'), scripts };
}

function walk(command, visit, remote = false, depth = 0) {
  if (typeof command !== 'string' || depth > 12) return;
  const extracted = heredocs(command);
  const parsed = substitutions(extracted.command);
  for (const segment of parsed.segments) {
    const words = shellWords(segment.replace(/^\s*[({]+\s*/, '')), index = commandIndex(words);
    const name = commandName(words[index]);
    visit({ name, words, index, segment, remote });
    if (name === 'ssh') {
      const remoteTokens = shellTokens(beforeLocalRedirect(segment));
      const remoteWords = remoteTokens.map((token) => token.value);
      const start = remoteStart(remoteWords, commandIndex(remoteWords));
      if (start < remoteTokens.length) {
        const command = remoteTokens.length === start + 1 ? remoteTokens[start].value : remoteTokens.slice(start).map((token) => token.raw).join(' ');
        walk(command, visit, true, depth + 1);
      }
    } else if (name === 'bash' || name === 'sh') {
      const flag = words.findIndex((word, at) => at > index && /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
      if (flag >= 0 && words[flag + 1]) walk(words[flag + 1], visit, remote, depth + 1);
    } else if (name === 'eval') {
      const script = words.slice(index + 1);
      if (script.length) walk(script.join(' '), visit, remote, depth + 1);
    }
  }
  for (const nested of parsed.nested) walk(nested, visit, remote, depth + 1);
  for (const script of extracted.scripts) {
    if (script.unquoted) {
      for (const nested of substitutions(script.body).nested) walk(nested, visit, remote, depth + 1);
    }
    const owner = substitutions(script.owner).segments.at(-1) || '';
    const words = shellWords(owner), index = commandIndex(words), name = commandName(words[index]);
    if (name === 'ssh') {
      const remote = words.slice(remoteStart(words, index)).filter((word) => !word.startsWith('<<')).join(' ');
      const remoteWords = shellWords(remote), remoteName = commandName(remoteWords[commandIndex(remoteWords)]);
      if (!remote || remoteName === 'bash' || remoteName === 'sh') walk(script.body, visit, true, depth + 1);
    } else if ((name === 'bash' || name === 'sh') && !words.some((word) => /^-[A-Za-z]*c[A-Za-z]*$/.test(word))) {
      walk(script.body, visit, remote, depth + 1);
    }
  }
}

function anyCommand(command, predicate) {
  let found = false;
  walk(command, (part) => { if (predicate(part)) found = true; });
  return found;
}

function isSlurmSubmit(command) {
  return anyCommand(command, ({ name }) => ['sbatch', 'srun', 'salloc'].includes(name));
}

function isGitPublish(command) {
  return anyCommand(command, ({ name, words, index }) => {
    if (name !== 'git') return false;
    let i = index + 1;
    while (words[i] && words[i].startsWith('-')) {
      const option = words[i++];
      if (option === '-C' || option === '-c' || option === '--git-dir' || option === '--work-tree') i++;
    }
    const action = words[i++];
    if (action === 'tag') return !!words[i] && !['-l', '--list', '-n'].includes(words[i]) && !/^-n\d+$/.test(words[i]);
    return ['commit', 'push', 'merge', 'cherry-pick', 'revert', 'rebase', 'am', 'commit-tree'].includes(action);
  });
}

function isMutatingRemote(command) {
  return anyCommand(command, ({ name, words, segment, remote }) => {
    if (name === 'scp' || name === 'rsync') return remote || /^[^/:\s]+:.+/.test(words.at(-1) || '');
    if (!remote) return false;
    if (['rm', 'mv', 'cp', 'scancel', 'sbatch', 'srun', 'salloc', 'touch', 'tee', 'mkdir', 'chmod', 'chown', 'ln', 'truncate'].includes(name)) return true;
    if (name === 'sed' && words.some((word) => word === '-i' || word.startsWith('-i') || word === '--in-place' || word.startsWith('--in-place='))) return true;
    return writeRedirect(segment);
  });
}

function simpleSlurm(command, depth = 0) {
  if (typeof command !== 'string' || /[;&|$`<>\n(){}#\\]/.test(command)) return false;
  const tokens = shellTokens(command.trim()), words = tokens.map((token) => token.value);
  const name = commandName(words[0]);
  if (['sbatch', 'srun', 'salloc'].includes(name)) return true;
  if (depth) return false;
  if (name === 'ssh') {
    const start = safeRemoteStart(words);
    if (start < 0 || start >= words.length) return false;
    const remote = tokens.length === start + 1 ? tokens[start].value : tokens.slice(start).map((token) => token.raw).join(' ');
    return simpleSlurm(remote, depth + 1);
  }
  if ((name === 'bash' || name === 'sh') && words[1] === '-c' && words.length === 3) return simpleSlurm(words[2], depth + 1);
  return false;
}

function outsideProject(cwd, file) {
  if (typeof cwd !== 'string' || typeof file !== 'string') return false;
  const relative = path.relative(path.resolve(cwd), path.resolve(cwd, file));
  return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
}

function deny(thing) {
  return { behavior: 'deny', message: `${thing} is disabled for this project in Project settings; ask the user.` };
}

// Policy runs only on permission requests. Claude bypassPermissions has only --settings
// deny rules; Codex commands that never escalate do not reach this check.
function decide(policy, req) {
  const values = Object.fromEntries(POLICY_DEFAULTS.map((item) => [item.key, selected(policy, item)]));
  if (req && req.tool_name === 'Bash' && typeof req.input?.command === 'string') {
    const command = req.input.command;
    if (values.slurmSubmit === 'never' && isSlurmSubmit(command)) return deny('Slurm job submission');
    if (values.gitPublish === 'never' && isGitPublish(command)) return deny('Git publishing');
    if (values.hpcAccess === 'readonly' && isMutatingRemote(command)) return deny('Mutating remote commands');
    if (values.slurmSubmit === 'allow' && simpleSlurm(command)) return { behavior: 'allow' };
  }
  if (req && ['Write', 'Edit', 'NotebookEdit'].includes(req.tool_name) && values.writeOutsideProject === 'never') {
    const input = req.input || {};
    const files = [...(Array.isArray(input.files) ? input.files : []), input.grantRoot, input.file_path, input.notebook_path, input.path];
    if (files.some((file) => outsideProject(req.cwd, file))) return deny('Writing outside the project');
  }
}

function policyPrompt(policy) {
  const lines = [];
  for (const item of POLICY_DEFAULTS) {
    const value = selected(policy, item);
    if (value === item.default) continue;
    let rule;
    if (item.key === 'slurmSubmit') {
      rule = value === 'allow' ? 'The project owner has authorised submitting Slurm jobs for this project.'
        : value === 'never' ? 'Do not submit Slurm jobs; prepare scripts and tell the user the exact command.'
          : 'Prepare and dry-run with `sbatch --test-only`, then ask the user to approve.';
    } else if (item.key === 'gitPublish') rule = 'Do not run git commit, push, or tag; ask the user.';
    else if (item.key === 'hpcAccess') rule = 'Use read-only commands over SSH; do not mutate files or submit or cancel jobs remotely.';
    else if (item.key === 'writeOutsideProject') rule = 'Do not write outside this project; ask the user.';
    else rule = 'Present a plan before making changes.';
    lines.push(`- ${item.label}: ${rule}`);
  }
  if (!lines.length) return '';
  return `## Project rules (set by the user in Project settings)\n${lines.join('\n')}\n\nThis section takes precedence over role instructions suggesting otherwise.\n`;
}

function policySettings(policy) {
  const slurm = selected(policy, POLICY_DEFAULTS[0]);
  const git = selected(policy, POLICY_DEFAULTS[1]);
  const deny = [];
  if (slurm === 'never') deny.push('Bash(sbatch *)', 'Bash(srun *)', 'Bash(salloc *)', 'Bash(ssh * sbatch *)', 'Bash(ssh * srun *)', 'Bash(ssh * salloc *)');
  if (git === 'never') for (const action of ['commit', 'push', 'tag', 'merge', 'cherry-pick', 'revert', 'rebase', 'am', 'commit-tree']) deny.push(`Bash(git ${action} *)`);
  return deny.length ? { permissions: { deny, allow: [] } } : {};
}

module.exports = { POLICY_DEFAULTS, policyFor, isSlurmSubmit, isGitPublish, isMutatingRemote, decide, policyPrompt, policySettings };
