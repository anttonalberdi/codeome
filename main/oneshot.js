// One short-lived CLI call for a single prompt. Plain Node so callers can use it
// without starting Electron or keeping a chat session alive.
// Claude returns one JSON result; Codex emits JSON lines for a turn. Both formats
// carry the final answer and usage, which the parsers expose without process state.
// The account config folder is selected exactly as for usage checks: an empty dir
// removes the CLI's config variable so its own default account is used.
// Stdin is ignored because an open input pipe can hold either CLI after it answers.
// The child is reaped on normal exit, timeout, and cancellation; a resistant child
// gets SIGKILL two seconds after SIGTERM.
// Claude's optional strict MCP switch keeps ordinary calls isolated from connectors.
// Callers may disable that switch when a connector is needed for the prompt.
const fs = require('fs');
const { spawn } = require('child_process');
const { augmentedEnv, expandHome } = require('./util');
const { ENV_VAR, home } = require('./usage');

function errorMessage(value) {
  if (typeof value === 'string') return value;
  return value && (value.message || value.error && errorMessage(value.error)) || 'CLI reported an error';
}

function parseClaude(stdout) {
  const result = JSON.parse(stdout);
  if (result.is_error) throw new Error(errorMessage(result.result || result.error));
  return { text: result.result, usage: { ...(result.usage || {}), total_cost_usd: result.total_cost_usd } };
}

function parseCodex(stdout) {
  let text = '', usage = {};
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type === 'error' || event.type === 'turn.failed') throw new Error(errorMessage(event.error || event.message));
    if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message') text = event.item.text;
    if (event.type === 'turn.completed') usage = event.usage || {};
  }
  return { text, usage };
}

function abortError() {
  const error = new Error('one-shot aborted');
  error.name = 'AbortError';
  return error;
}

function oneShot(engine, { prompt, model, effort, bin, dir, cwd, timeoutMs = 60000, env, signal, strictMcp = true } = {}) {
  if (!ENV_VAR[engine]) return Promise.reject(new Error(`Unknown one-shot engine: ${engine}`));
  if (signal && signal.aborted) return Promise.reject(abortError());
  const childEnv = augmentedEnv(env);
  if (dir) childEnv[ENV_VAR[engine]] = expandHome(dir);
  else delete childEnv[ENV_VAR[engine]];
  const args = engine === 'claude'
    ? ['-p', prompt, '--model', model || 'haiku', '--no-session-persistence', '--permission-mode', 'plan',
      ...(strictMcp ? ['--strict-mcp-config'] : []), '--setting-sources', '', '--output-format', 'json']
    : ['exec', '-s', 'read-only', '--ephemeral', '--skip-git-repo-check', '--json',
      '-c', 'model_reasoning_effort=' + (effort || 'low'), ...(model ? ['-m', model] : []), prompt];
  const workDir = cwd || home();
  if (!cwd) fs.mkdirSync(workDir, { recursive: true });
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bin || engine, args, { cwd: workDir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true }); }
    catch (error) { reject(error); return; }
    let stdout = '', stderr = '', failure = null, killTimer = null, exitTimer = null, settled = false;
    const killGroup = (sig) => {
      try { if (child.pid) { process.kill(-child.pid, sig); return; } } catch {}
      try { child.kill(sig); } catch {}
    };
    const settle = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (exitTimer) clearTimeout(exitTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (failure) { killGroup('SIGKILL'); reject(failure); return; }
      if (code !== 0) { reject(new Error(`one-shot exited with code ${code}: ${stderr}`)); return; }
      try { resolve({ ...(engine === 'claude' ? parseClaude(stdout) : parseCodex(stdout)), ms: Date.now() - started }); }
      catch (error) { reject(error); }
    };
    const terminate = (error) => {
      if (failure) return;
      failure = error;
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), 2000);
    };
    const timer = setTimeout(() => terminate(new Error('one-shot timed out')), timeoutMs);
    const onAbort = () => terminate(abortError());
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (signal && signal.aborted) onAbort();
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-400); });
    child.on('error', terminate);
    child.on('exit', (code) => { exitTimer = setTimeout(() => { killGroup('SIGKILL'); settle(code); }, 500); });
    child.on('close', (code) => settle(code));
  });
}

module.exports = { oneShot, parseClaude, parseCodex };
