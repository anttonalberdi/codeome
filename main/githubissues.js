// GitHub issue REST calls. The caller supplies all I/O and keeps the poll state.
const github = require('./github');

const PART = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function parseRemote(value) {
  if (typeof value !== 'string') return null;
  const remote = value.trim();
  let host, path;
  try {
    if (remote.startsWith('https://')) {
      const url = new URL(remote);
      if (url.protocol !== 'https:' || url.port || url.search || url.hash) return null;
      host = url.hostname;
      path = url.pathname.replace(/^\//, '');
    } else {
      const match = /^(?:[^@/\s:]+@)?([A-Za-z0-9.-]+):([^\s?#]+)$/.exec(remote);
      if (!match) return null;
      [, host, path] = match;
    }
  } catch { return null; }
  if (path.endsWith('.git')) path = path.slice(0, -4);
  const parts = path.split('/');
  if (parts.length !== 2 || !parts.every((part) => PART.test(part)) || github.checkHost(host)) return null;
  return { host, owner: parts[0], repo: parts[1] };
}

async function remoteFor(root, run) {
  try {
    const result = await run('git', ['remote', 'get-url', 'origin'], { cwd: root, timeout: 10000 });
    return result?.code === 0 ? parseRemote(result.stdout) : null;
  } catch { return null; }
}

function error(code, message, token, retryAfterMs) {
  const result = { code, message: github.redact(message, [token]) };
  if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;
  return { error: result };
}

function retryAfter(headers, now) {
  const clamp = (ms) => Math.min(60 * 60000, Math.max(0, Math.ceil(ms)));
  const retry = headers.get('Retry-After');
  if (retry !== null) {
    const seconds = Number(retry);
    const at = Number.isFinite(seconds) ? now() + seconds * 1000 : Date.parse(retry);
    if (Number.isFinite(at)) return clamp(at - now());
  }
  const reset = Number(headers.get('X-RateLimit-Reset'));
  if (Number.isFinite(reset) && reset > 0) return clamp(reset * 1000 - now());
  return undefined;
}

function httpError(response, token, now, write = false) {
  const status = response.status;
  if (status === 401) return error('unauthorized', 'GitHub token is invalid. Revalidate the account.', token);
  if (status === 403) return error('forbidden', write
    ? 'GitHub token lacks issue write access.' : 'GitHub denied issue access or rate limited the request.',
  token, retryAfter(response.headers, now));
  if (status === 429) return error('rate_limited', 'GitHub rate limit exceeded.', token, retryAfter(response.headers, now));
  if (status === 404) return error('not_found', 'GitHub repository was not found or the account lacks access.', token);
  if (status === 410) return error('issues_disabled', 'GitHub issues are disabled for this repository.', token);
  return error('http', 'GitHub returned HTTP ' + Number(status) + '.', token);
}

async function projectContext({ store, root, getSecret, run }) {
  let ctx;
  try { ctx = github.contextFor(store, root, getSecret); }
  catch { return error('account', 'Could not use the GitHub account for this project.'); }
  if (!ctx) return null;
  const token = ctx.env.CODEOME_GIT_TOKEN;
  const remote = await remoteFor(root, run);
  if (!remote) return null;
  if (remote.host !== ctx.account.host) return error('host_mismatch', 'The origin remote host differs from the bound GitHub account.', token);
  try {
    const base = github.provider(ctx.account.provider).apiBase(ctx.account.host);
    const path = '/repos/' + encodeURIComponent(remote.owner) + '/' + encodeURIComponent(remote.repo) + '/issues';
    return { base, path, token };
  } catch { return error('account', 'Could not use the GitHub account for this project.', token); }
}

function nextPage(link, current, endpoint) {
  if (typeof link !== 'string') return null;
  for (const part of link.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="?next"?(?:\s*;.*)?\s*$/.exec(part);
    if (!match) continue;
    try {
      const url = new URL(match[1], current);
      if (url.origin === endpoint.origin && url.pathname === endpoint.pathname &&
          !url.username && !url.password && !url.hash) return url.toString();
    } catch {}
  }
  return null;
}

function trimIssue(item) {
  return {
    number: item.number,
    title: typeof item.title === 'string' ? item.title : '',
    body: typeof item.body === 'string' ? item.body.slice(0, 8000) : '',
    author: item.user.login,
    authorAssociation: item.author_association || '',
    labels: Array.isArray(item.labels) ? item.labels.map((label) => label?.name).filter((name) => typeof name === 'string') : [],
    url: typeof item.html_url === 'string' ? item.html_url : '',
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    state: item.state
  };
}

function previousUpdate(state, number) {
  const last = state.lastSeen;
  if (typeof last === 'string') return Date.parse(last);
  if (last && typeof last === 'object') return Date.parse(last[number]);
  return NaN;
}

async function pollProject({ store, root, getSecret, fetch, now = Date.now, run, state = {}, settings = {} }) {
  const ctx = await projectContext({ store, root, getSecret, run });
  if (!ctx || ctx.error) return ctx;
  const { base, path, token } = ctx;
  const endpoint = new URL(base + path);
  endpoint.search = 'state=open&sort=updated&direction=desc&per_page=50';
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'Codeome' };
  if (state.etag) headers['If-None-Match'] = state.etag;
  const pageHeaders = { Authorization: headers.Authorization, Accept: headers.Accept, 'User-Agent': headers['User-Agent'] };
  const seen = new Set(state.seenNumbers || []);
  const enabledAt = Number.isFinite(Date.parse(state.enabledAt)) ? Date.parse(state.enabledAt) : now();
  const fresh = [], updated = [];
  const visited = new Set();
  let url = endpoint.toString(), etag = state.etag || null;
  for (let page = 0; page < 3 && url && !visited.has(url); page++) {
    visited.add(url);
    let response, items;
    try {
      response = await fetch(url, { method: 'GET', headers: page === 0 ? headers : pageHeaders,
        redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (response.status === 304 && page === 0) return { changed: false, etag, new: [], updated: [] };
      if (response.status !== 200) return httpError(response, token, now);
      if (page === 0) etag = response.headers.get('ETag') || etag;
      items = await response.json();
      if (!Array.isArray(items)) return error('invalid_response', 'GitHub returned an invalid issues response.', token);
    } catch {
      return error('network', 'Could not fetch GitHub issues.', token);
    }
    for (const item of items) {
      if (!item || item.pull_request || !Number.isSafeInteger(item.number) || item.number <= 0 ||
          typeof item.user?.login !== 'string' || item.user.type === 'Bot' || /\[bot\]$/i.test(item.user.login) ||
          settings.authors === 'collaborators' && !ASSOCIATIONS.has(item.author_association)) continue;
      const issue = trimIssue(item);
      if (settings.label && !issue.labels.includes(settings.label)) continue;
      const created = Date.parse(issue.createdAt), modified = Date.parse(issue.updatedAt);
      if (!Number.isFinite(created) || !Number.isFinite(modified) || created <= enabledAt) continue;
      if (!seen.has(issue.number)) fresh.push(issue);
      else if (modified > previousUpdate(state, issue.number)) updated.push(issue);
    }
    url = nextPage(response.headers.get('Link'), url, endpoint);
  }
  return { changed: true, etag, new: fresh, updated };
}

async function commentOnIssue({ store, root, getSecret, fetch, run, number, body }) {
  if (!Number.isSafeInteger(number) || number <= 0) return error('invalid_number', 'Issue number must be a positive integer.');
  if (typeof body !== 'string' || !body.length || body.length > 65000)
    return error('invalid_body', 'Comment body must contain 1 to 65000 characters.');
  const ctx = await projectContext({ store, root, getSecret, run });
  if (!ctx || ctx.error) return ctx;
  const { base, path, token } = ctx;
  try {
    const response = await fetch(base + path + '/' + number + '/comments', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json', 'User-Agent': 'Codeome' },
      body: JSON.stringify({ body }), redirect: 'error', signal: AbortSignal.timeout(10000)
    });
    if (response.status !== 201) return httpError(response, token, Date.now, true);
    const comment = await response.json();
    if (typeof comment?.html_url !== 'string') return error('invalid_response', 'GitHub returned an invalid comment response.', token);
    return { url: comment.html_url };
  } catch { return error('network', 'Could not post a GitHub issue comment.', token); }
}

module.exports = { parseRemote, remoteFor, pollProject, commentOnIssue };
