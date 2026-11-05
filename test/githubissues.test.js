const test = require('node:test');
const assert = require('node:assert/strict');
const issues = require('../main/githubissues');

const ROOT = '/project';
const TOKEN = 'secret token';
const ENABLED = '2026-11-01T00:00:00Z';
const NOW = Date.parse('2026-11-05T12:00:00Z');
const store = { accounts: [{ id: 'a', provider: 'github', host: 'github.com', login: 'octocat', status: 'valid' }],
  bindings: { [ROOT]: 'a' } };
const run = async (cmd, args, opts) => {
  assert.equal(cmd, 'git');
  assert.deepEqual(args, ['remote', 'get-url', 'origin']);
  assert.equal(opts.cwd, ROOT);
  return { code: 0, stdout: 'git@github.com:owner/repo.git\n' };
};
const getSecret = (key) => { assert.equal(key, 'github:a'); return TOKEN; };

function response(status, body = [], headers = {}) {
  return { status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, json: async () => body };
}

function issue(number, overrides = {}) {
  return { number, title: 'Issue ' + number, body: 'body', user: { login: 'human', type: 'User' },
    author_association: 'NONE', labels: [], html_url: `https://github.com/owner/repo/issues/${number}`,
    created_at: '2026-11-02T00:00:00Z', updated_at: '2026-11-04T00:00:00Z', state: 'open', ...overrides };
}

function options(overrides = {}) {
  return { store, root: ROOT, getSecret, run, fetch: async () => response(200), now: () => NOW,
    state: { enabledAt: ENABLED, seenNumbers: [], lastSeen: '2026-11-03T00:00:00Z' }, settings: {}, ...overrides };
}

test('parseRemote accepts HTTPS and scp remotes without returning credentials', async () => {
  assert.deepEqual(issues.parseRemote('https://user:password@github.com/owner/repo.git'),
    { host: 'github.com', owner: 'owner', repo: 'repo' });
  assert.deepEqual(issues.parseRemote('git@github.com:owner/repo'),
    { host: 'github.com', owner: 'owner', repo: 'repo' });
  assert.deepEqual(issues.parseRemote('git@ghe.example.com:team/code.git'),
    { host: 'ghe.example.com', owner: 'team', repo: 'code' });
  for (const value of ['https://github.com/owner', 'http://github.com/owner/repo',
    'https://github.com/owner/repo/extra', 'https://github.com/owner/repo?x=1',
    'git@github.com:owner/../repo', 'file:///owner/repo', '', null]) {
    assert.equal(issues.parseRemote(value), null, String(value));
  }
  assert.deepEqual(await issues.remoteFor(ROOT, run), { host: 'github.com', owner: 'owner', repo: 'repo' });
  assert.equal(await issues.remoteFor(ROOT, async () => ({ code: 128, stdout: '' })), null);
});

test('304 keeps the current ETag and sends conditional request to the account API', async () => {
  let call;
  const result = await issues.pollProject(options({ state: { etag: '"old"', enabledAt: ENABLED },
    fetch: async (...args) => { call = args; return response(304); } }));
  assert.deepEqual(result, { changed: false, etag: '"old"', new: [], updated: [] });
  assert.equal(call[0], 'https://api.github.com/repos/owner/repo/issues?state=open&sort=updated&direction=desc&per_page=50');
  assert.equal(call[1].headers.Authorization, 'Bearer ' + TOKEN);
  assert.equal(call[1].headers.Accept, 'application/vnd.github+json');
  assert.equal(call[1].headers['If-None-Match'], '"old"');
  assert.equal(call[1].redirect, 'error');
});

test('filters PRs, bots, collaborators and labels, then trims issue data', async () => {
  const items = [issue(1, { pull_request: {} }), issue(2, { user: { login: 'dependabot[bot]', type: 'User' } }),
    issue(3, { user: { login: 'helper', type: 'Bot' } }), issue(4),
    issue(5, { author_association: 'MEMBER', labels: [{ name: 'inbox' }], body: 'x'.repeat(8100) }),
    issue(6, { author_association: 'OWNER', labels: [{ name: 'other' }] })];
  const result = await issues.pollProject(options({ settings: { authors: 'collaborators', label: 'inbox' },
    fetch: async () => response(200, items, { etag: '"new"' }) }));
  assert.equal(result.changed, true);
  assert.equal(result.etag, '"new"');
  assert.deepEqual(result.new.map((item) => item.number), [5]);
  assert.deepEqual(result.updated, []);
  assert.deepEqual(result.new[0], { number: 5, title: 'Issue 5', body: 'x'.repeat(8000),
    author: 'human', authorAssociation: 'MEMBER', labels: ['inbox'],
    url: 'https://github.com/owner/repo/issues/5', createdAt: '2026-11-02T00:00:00Z',
    updatedAt: '2026-11-04T00:00:00Z', state: 'open' });
});

test('first enable ignores old issues and separates new from updated', async () => {
  const state = { enabledAt: ENABLED, seenNumbers: [2, 3],
    lastSeen: { 2: '2026-11-03T00:00:00Z', 3: '2026-11-04T00:00:00Z' } };
  const items = [issue(1, { created_at: '2026-10-31T00:00:00Z' }), issue(2), issue(3), issue(4)];
  const result = await issues.pollProject(options({ state, fetch: async () => response(200, items) }));
  assert.deepEqual(result.new.map((item) => item.number), [4]);
  assert.deepEqual(result.updated.map((item) => item.number), [2]);
  const first = await issues.pollProject(options({ state: {}, fetch: async () => response(200, items) }));
  assert.deepEqual(first.new, []);
  assert.deepEqual(first.updated, []);
});

test('pagination follows only the issue endpoint and stops after three pages', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push([url, init]);
    return response(200, [issue(calls.length)], { link: `<https://api.github.com/repos/owner/repo/issues?page=${calls.length + 1}>; rel="next"` });
  };
  const result = await issues.pollProject(options({ fetch, state: { etag: '"old"', enabledAt: ENABLED } }));
  assert.deepEqual(result.new.map((item) => item.number), [1, 2, 3]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0][1].headers['If-None-Match'], '"old"');
  assert.equal(calls[1][1].headers['If-None-Match'], undefined);
  assert.ok(calls.every(([, init]) => init.redirect === 'error'));
  for (const next of ['https://evil.example/repos/owner/repo/issues?page=2',
    'https://api.github.com/repos/owner/repo/other?page=2',
    'https://user@api.github.com/repos/owner/repo/issues?page=2',
    'https://user:pass@api.github.com/repos/owner/repo/issues?page=2']) {
    const blocked = [];
    await issues.pollProject(options({ fetch: async (url, init) => {
      blocked.push(url);
      assert.equal(init.redirect, 'error');
      return response(200, [issue(1)], { link: `<${next}>; rel="next"` });
    } }));
    assert.equal(blocked.length, 1, next);
  }
});

test('unbound or missing remote returns null; a different remote host is refused', async () => {
  assert.equal(await issues.pollProject(options({ store: { accounts: [], bindings: {} },
    getSecret: () => { throw new Error('secret must not be read'); } })), null);
  assert.equal(await issues.pollProject(options({ run: async () => ({ code: 128, stdout: '' }) })), null);
  const mismatch = await issues.pollProject(options({ run: async () => ({ code: 0, stdout: 'git@evil.example:owner/repo' }) }));
  assert.equal(mismatch.error.code, 'host_mismatch');
  assert.ok(!JSON.stringify(mismatch).includes(TOKEN));
});

test('HTTP issue errors map clearly, including retry delays, without exposing tokens', async () => {
  const cases = [
    [401, 'unauthorized', {}, /token is invalid/i, undefined],
    [403, 'forbidden', { 'retry-after': '7' }, /denied issue access/i, 7000],
    [404, 'not_found', {}, /not found/i, undefined],
    [410, 'issues_disabled', {}, /issues are disabled/i, undefined],
    [429, 'rate_limited', { 'x-ratelimit-reset': String((NOW + 9000) / 1000) }, /rate limit/i, 9000]
  ];
  for (const [status, code, headers, pattern, delay] of cases) {
    const result = await issues.pollProject(options({ fetch: async () => response(status, [], headers) }));
    assert.equal(result.error.code, code);
    assert.match(result.error.message, pattern);
    assert.equal(result.error.retryAfterMs, delay);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    assert.ok(!JSON.stringify(result).includes(encodeURIComponent(TOKEN)));
  }
  const failed = await issues.pollProject(options({ fetch: async () => { throw new Error('Bearer ' + TOKEN); } }));
  assert.equal(failed.error.code, 'network');
  assert.ok(!JSON.stringify(failed).includes(TOKEN));
});

test('retry hints clamp giant Retry-After values and past reset timestamps', async () => {
  for (const [headers, expected] of [
    [{ 'retry-after': '1e12' }, 3600000],
    [{ 'x-ratelimit-reset': String((NOW - 1000) / 1000) }, 0]
  ]) {
    const result = await issues.pollProject(options({ fetch: async () => response(429, [], headers) }));
    assert.strictEqual(result.error.retryAfterMs, expected);
  }
});

test('token never appears in returned messages for poll or comment errors', async () => {
  for (const status of [401, 403, 404]) {
    const poll = await issues.pollProject(options({ fetch: async () => response(status) }));
    const comment = await issues.commentOnIssue(options({ number: 1, body: 'reply', fetch: async () => response(status) }));
    assert.ok(!poll.error.message.includes(TOKEN));
    assert.ok(!comment.error.message.includes(TOKEN));
  }
  const failure = async () => { throw new Error('Bearer ' + TOKEN); };
  const poll = await issues.pollProject(options({ fetch: failure }));
  const comment = await issues.commentOnIssue(options({ number: 1, body: 'reply', fetch: failure }));
  assert.ok(!poll.error.message.includes(TOKEN));
  assert.ok(!comment.error.message.includes(TOKEN));
});

test('comment posts body verbatim and validates input before I/O', async () => {
  const body = 'Hello\n\n`code` and \\"quotes\\"';
  let call;
  const result = await issues.commentOnIssue(options({ number: 5, body, fetch: async (...args) => {
    call = args;
    return response(201, { html_url: 'https://github.com/owner/repo/issues/5#issuecomment-1' });
  } }));
  assert.deepEqual(result, { url: 'https://github.com/owner/repo/issues/5#issuecomment-1' });
  assert.equal(call[0], 'https://api.github.com/repos/owner/repo/issues/5/comments');
  assert.equal(call[1].method, 'POST');
  assert.deepEqual(JSON.parse(call[1].body), { body });
  assert.equal(call[1].headers.Authorization, 'Bearer ' + TOKEN);
  assert.equal(call[1].redirect, 'error');
  for (const number of [0, -1, 1.2, '5', NaN]) {
    const bad = await issues.commentOnIssue(options({ number, body, fetch: () => { throw new Error('unexpected fetch'); } }));
    assert.equal(bad.error.code, 'invalid_number');
  }
  for (const invalid of ['', 'x'.repeat(65001), null]) {
    const bad = await issues.commentOnIssue(options({ number: 5, body: invalid, fetch: () => { throw new Error('unexpected fetch'); } }));
    assert.equal(bad.error.code, 'invalid_body');
  }
});

test('comment 403 identifies missing issue write access and hides the token', async () => {
  const result = await issues.commentOnIssue(options({ number: 3, body: 'reply', fetch: async () => response(403) }));
  assert.equal(result.error.code, 'forbidden');
  assert.match(result.error.message, /token lacks issue write access/i);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});
