// Minimal Zenodo REST client: list, create, upload, update metadata, publish.
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

function base(sandbox) { return sandbox ? 'https://sandbox.zenodo.org/api' : 'https://zenodo.org/api'; }

async function call(token, sandbox, method, url, body, headers = {}) {
  const res = await fetch(url.startsWith('http') ? url : base(sandbox) + url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body && !(body instanceof Readable) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body instanceof Readable ? body : (body ? JSON.stringify(body) : undefined),
    ...(body instanceof Readable ? { duplex: 'half' } : {})
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const msg = (data && data.message) || res.statusText;
    const errs = data && data.errors ? ' — ' + data.errors.map((e) => `${e.field || ''} ${(e.messages || [e.message]).join(' ')}`).join('; ') : '';
    throw new Error(`Zenodo ${res.status}: ${msg}${errs}`);
  }
  return data;
}

function summary(d) {
  return {
    id: d.id, title: (d.metadata && d.metadata.title) || d.title || '(untitled)',
    state: d.state, submitted: d.submitted, doi: d.doi || (d.metadata && d.metadata.prereserve_doi && d.metadata.prereserve_doi.doi) || '',
    created: d.created, modified: d.modified, html: d.links && d.links.html, bucket: d.links && d.links.bucket,
    files: (d.files || []).map((f) => ({ name: f.filename || f.key, size: f.filesize || f.size })),
    metadata: d.metadata || {}
  };
}

async function list(token, sandbox) {
  const data = await call(token, sandbox, 'GET', '/deposit/depositions?size=50&sort=mostrecent');
  return data.map(summary);
}

async function get(token, sandbox, id) { return summary(await call(token, sandbox, 'GET', `/deposit/depositions/${id}`)); }

async function create(token, sandbox, metadata) {
  const d = await call(token, sandbox, 'POST', '/deposit/depositions', {});
  if (metadata) return update(token, sandbox, d.id, metadata);
  return summary(d);
}

async function update(token, sandbox, id, metadata) {
  return summary(await call(token, sandbox, 'PUT', `/deposit/depositions/${id}`, { metadata }));
}

async function upload(token, sandbox, id, filePath, onProgress) {
  const d = await get(token, sandbox, id);
  if (!d.bucket) throw new Error('Deposition has no upload bucket (is it already published? Create a new version first).');
  const size = fs.statSync(filePath).size;
  let sent = 0;
  const stream = fs.createReadStream(filePath);
  stream.on('data', (c) => { sent += c.length; if (onProgress) onProgress(sent / size); });
  await call(token, sandbox, 'PUT', `${d.bucket}/${encodeURIComponent(path.basename(filePath))}`, stream,
    { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) });
  return get(token, sandbox, id);
}

async function publish(token, sandbox, id) { return summary(await call(token, sandbox, 'POST', `/deposit/depositions/${id}/actions/publish`)); }
async function newVersion(token, sandbox, id) {
  const d = await call(token, sandbox, 'POST', `/deposit/depositions/${id}/actions/newversion`);
  const latest = d.links && d.links.latest_draft;
  return latest ? summary(await call(token, sandbox, 'GET', latest)) : summary(d);
}

module.exports = { list, get, create, update, upload, publish, newVersion };
