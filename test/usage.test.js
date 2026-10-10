const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const usage = require('../main/usage');

const SCRIPT = path.join(__dirname, '..', 'main', 'codeome-statusline');
const now = 1_800_000_000;
const acct = (name, fiveHour, weekly, extra = {}) => ({ name, asOf: now - 60, windows: { fiveHour: { pct: fiveHour, resetsAt: now + 3600 }, weekly: { pct: weekly, resetsAt: now + 86400 } }, ...extra });

test('Codex windows are told apart by length, whichever slot they come in', () => {
  // A plan with only a weekly window reports it as "primary".
  assert.deepStrictEqual(usage.codexWindows({ primary: { usedPercent: 77, windowDurationMins: 10080, resetsAt: 5 }, secondary: null }),
    { weekly: { pct: 77, resetsAt: 5, minutes: 10080 } });
  const both = usage.codexWindows({ primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 2 } });
  assert.strictEqual(both.fiveHour.pct, 12);
  assert.strictEqual(both.weekly.pct, 40);
});

test('Claude status line rate limits map to the same windows', () => {
  assert.deepStrictEqual(usage.claudeWindows({ five_hour: { used_percentage: 23.5, resets_at: 9 }, seven_day: { used_percentage: 41.2, resets_at: 10 } }),
    { fiveHour: { pct: 23.5, resetsAt: 9 }, weekly: { pct: 41.2, resetsAt: 10 } });
  assert.deepStrictEqual(usage.claudeWindows(undefined), {});
});

test('level is the busiest window, zero after a reset, unknown when stale', () => {
  assert.strictEqual(usage.level(acct('a', 30, 70), now), 70);
  assert.strictEqual(usage.level({ ...acct('a', 95, 10), windows: { fiveHour: { pct: 95, resetsAt: now - 1 } } }, now), 0);
  assert.strictEqual(usage.level({ ...acct('a', 50, 50), asOf: now - usage.STALE_S - 1 }, now), null);
  assert.strictEqual(usage.level(acct('a', 10, 10, { reached: true }), now), 100);
});

test('pick keeps the preferred account until it nears the limit, then moves to the most headroom', () => {
  const list = [acct('main', 50, 60), acct('work', 20, 30), acct('spare', 10, 80)];
  assert.strictEqual(usage.pick(list, 'main', 90, now).account.name, 'main');
  list[0] = acct('main', 92, 60);
  const p = usage.pick(list, 'main', 90, now);
  assert.strictEqual(p.account.name, 'work');
  assert.strictEqual(p.switched, true);
  assert.strictEqual(p.from.name, 'main');
  // Accounts with no reading are tried before giving up.
  assert.strictEqual(usage.pick([acct('main', 95, 0), { name: 'new', windows: {} }], 'main', 90, now).account.name, 'new');
  // Accounts that are not signed in are skipped, also as the preferred one.
  assert.strictEqual(usage.pick([acct('main', 95, 0), { name: 'new', windows: {}, signedOut: true }, acct('work', 40, 40)], 'main', 90, now).account.name, 'work');
  assert.strictEqual(usage.pick([{ name: 'main', windows: {}, signedOut: true }, acct('work', 40, 40)], 'main', 90, now).account.name, 'work');
  assert.strictEqual(usage.pick([{ name: 'main', windows: {}, signedOut: true }], 'main', 90, now).account.name, 'main');
  assert.strictEqual(usage.pick([acct('main', 95, 0), { name: 'new', windows: {}, signedOut: true }], 'main', 90, now).blocked, true);
  const blocked = usage.pick([acct('main', 95, 0), acct('work', 10, 91)], 'main', 90, now);
  assert.strictEqual(blocked.blocked, true);
  assert.strictEqual(blocked.account, null);
});

test('the default folder is stored as empty so the variable is never set for it', () => {
  assert.strictEqual(usage.normDir('claude', '~/.claude/'), '');
  assert.strictEqual(usage.normDir('claude', path.join(os.homedir(), '.claude')), '');
  assert.strictEqual(usage.normDir('codex', '~/.codex-work'), '~/.codex-work');
  const def = usage.launch('claude', '', 'claude --model opus', '/x/claude settings.json');
  assert.deepStrictEqual(def.unset, ['CLAUDE_CONFIG_DIR']);
  assert.strictEqual(def.command, "claude --settings '/x/claude settings.json' --model opus");
  const work = usage.launch('codex', '~/.codex-work', 'codex', null);
  assert.deepStrictEqual(work.env, { CODEX_HOME: path.join(os.homedir(), '.codex-work') });
  assert.strictEqual(work.command, 'codex');
});

test('the status line records rate limits under the account key Codeome reads, then shows a line', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-usage-'));
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-claude-'));
  const input = { model: { display_name: 'Opus' }, context_window: { used_percentage: 12 }, workspace: { project_dir: home },
    rate_limits: { five_hour: { used_percentage: 23.5, resets_at: now }, seven_day: { used_percentage: 41.2, resets_at: now + 1 } } };
  const run = (env) => spawnSync('python3', [SCRIPT], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CODEOME_HOME: home, ...env } });
  const r = run({ CLAUDE_CONFIG_DIR: cfgDir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'Opus · ctx 12% · 5h 23% · wk 41%');
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'usage', `claude-${usage.accountKey(cfgDir)}.json`), 'utf8'));
  assert.strictEqual(saved.rate_limits.five_hour.used_percentage, 23.5);
  process.env.CODEOME_HOME = home;
  try { assert.strictEqual(usage.readClaude(cfgDir).windows.weekly.pct, 41.2); } finally { delete process.env.CODEOME_HOME; }

  // Your own status line (here from the account's settings) still runs.
  fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo mine' } }));
  assert.strictEqual(run({ CLAUDE_CONFIG_DIR: cfgDir }).stdout.trim(), 'mine');
});

test('an account is an email address: its folder is derived, and only a matching sign-in counts', () => {
  assert.ok(usage.isEmail('Alex.Example+lab@example.org'));
  for (const bad of ['Work', 'me@uni', 'me @example.org', 'me@example.org; rm -rf ~', '']) assert.ok(!usage.isEmail(bad), bad);
  assert.strictEqual(usage.folderFor('claude', 'Alex.Example@example.org'), '~/.claude-alex-example-example-org');
  assert.strictEqual(usage.folderFor('codex', 'lab@example.org'), '~/.codex-lab-example-org');

  assert.deepStrictEqual(usage.signInState('me@example.org', true, 'Me@Example.org'), { signedIn: true, mismatch: false, signedOut: false });
  // Signed in as someone else: not used until it is signed in as itself.
  assert.deepStrictEqual(usage.signInState('me@example.org', true, 'lab@example.org'), { signedIn: true, mismatch: true, signedOut: true });
  assert.deepStrictEqual(usage.signInState('me@example.org', false, null), { signedIn: false, mismatch: false, signedOut: true });
  assert.deepStrictEqual(usage.signInState('me@example.org', null, null), { signedIn: null, mismatch: false, signedOut: false });
  // No address to compare with (an API key, or an account that has no email yet).
  assert.strictEqual(usage.signInState('me@example.org', true, null).signedOut, false);
  assert.strictEqual(usage.signInState('Default', true, 'me@example.org').mismatch, false);
});

test('config folders that are no account yet are found by what their CLI leaves in them', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'codeome-home-'));
  for (const [d, f] of [['.claude-lab', '.claude.json'], ['.claude-work', 'settings.json'], ['.claude-empty', 'notes.txt'], ['.codex-lab', 'auth.json'], ['.claude', '.claude.json']]) {
    fs.mkdirSync(path.join(h, d));
    fs.writeFileSync(path.join(h, d, f), '{}');
  }
  assert.deepStrictEqual(usage.findFolders('claude', ['', path.join(h, '.claude-work')], h).map((d) => path.basename(d)), ['.claude-lab']);
  assert.deepStrictEqual(usage.findFolders('codex', [], h).map((d) => path.basename(d)), ['.codex-lab']);
});
