// Chat items for a remote reader. Shapes follow renderer/js/chat.js:
//   user {text, files?}, text {text, live?, msgId?, tok?},
//   tool {name, input, done, error?, result?}, job {engine, role, title,
//   status, result?}, perm {requestId, tool, input, decided?, expired?},
//   ask {requestId, questions, answers?, expired?}, note {kind, text}.
// Every item also has a stable id and integer i. Permission cards add state
// (pending, decided, cancelled). Embedded images appear as images[] references
// {kind:'image', itemId, mime, bytes}; getImage(itemId) serves their bytes.
// Redaction is best effort for obvious credentials in output, not a guarantee
// that arbitrary secrets in chat text are hidden.

const RESULT_LIMIT = 4000;
const REDACT_LIMIT = 8192;
const redactCache = new Map();

function redact(text) {
  if (typeof text !== 'string') return text;
  let limited = text.slice(0, REDACT_LIMIT);
  if (Buffer.byteLength(limited, 'utf8') > REDACT_LIMIT)
    limited = Buffer.from(limited, 'utf8').subarray(0, REDACT_LIMIT).toString('utf8');
  const marker = limited.length < text.length ? '…[TRUNCATED]' : '';
  if (redactCache.has(limited)) return redactCache.get(limited) + marker;
  const result = limited
    .replace(/-----BEGIN ([A-Z ]{0,40}PRIVATE KEY)-----[\s\S]{0,8192}?-----END \1-----/g, '[REDACTED]')
    .replace(/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,8192}/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]{1,8192}:[^\s/@]{1,8192}@/gi, '$1[REDACTED]@')
    .replace(/\bAuthorization[ \t]{0,20}:[ \t]{0,20}[^\r\n]{1,8192}/gi, 'Authorization: [REDACTED]')
    .replace(/\bBearer[ \t]+[^\s"'`,;]{1,8192}/gi, 'Bearer [REDACTED]')
    .replace(/(--(?:token|api[-_]?key|secret|password)(?:=|[ \t]+))(?:(?:"[^"\r\n]{0,8192}"|'[^'\r\n]{0,8192}'|[^\s,;&}]{1,8192}))/gi, '$1[REDACTED]')
    .replace(/(["']?(?:[A-Za-z_]\w{0,40}(?:KEY|SECRET|TOKEN|PASSWORD)\w{0,40}|KEY|SECRET|TOKEN|PASSWORD)["']?[ \t]{0,20}[=:][ \t]{0,20})(?:"[^"\r\n]{0,8192}"|'[^'\r\n]{0,8192}'|[^\s,;&}]{1,8192})/gi,
      '$1[REDACTED]')
    .replace(/\b([A-Za-z_]\w{0,40}(?:KEY|SECRET|TOKEN|PASSWORD)\w{0,40}|KEY|SECRET|TOKEN|PASSWORD)([ \t]+)[A-Za-z0-9+/=_-]{20,8192}/gi,
      '$1$2[REDACTED]')
    .replace(/\b(?:ghp_[A-Za-z0-9_]{1,8192}|github_pat_[A-Za-z0-9_]{1,8192}|sk-[A-Za-z0-9_-]{8,8192}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,8192}\.[A-Za-z0-9_-]{1,8192})\b/g, '[REDACTED]');
  redactCache.set(limited, result);
  if (redactCache.size > 512) redactCache.delete(redactCache.keys().next().value);
  return result + marker;
}

function safe(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, part] of Object.entries(value)) out[key] = safe(part);
    return out;
  }
  return value;
}

function slimInput(input) {
  const out = {};
  const keys = ['command', 'description', 'file_path', 'notebook_path', 'path', 'pattern', 'glob', 'url', 'query', 'skill', 'args', 'subject', 'plan'];
  let truncated = false;
  for (const [key, value] of Object.entries(input)) {
    if (!keys.includes(key) || typeof value !== 'string') { truncated = true; continue; }
    if (value.length > 600) truncated = true;
    out[key] = value.length > 600 ? value.slice(0, 600) + '…' : value;
  }
  return { input: out, truncated };
}

function imageOf(value) {
  if (!value || typeof value !== 'object') return null;
  const source = value.source && typeof value.source === 'object' ? value.source : value;
  const mime = source.media_type || source.mime || source.mimeType;
  const raw = source.data;
  if (!/^image\/[\w.+-]+$/.test(mime || '') || !(typeof raw === 'string' || Buffer.isBuffer(raw))) return null;
  return { mime, data: Buffer.isBuffer(raw) ? Buffer.from(raw) : Buffer.from(raw, 'base64') };
}

function createBuffer({ max = 2000, maxImageBytes = 20 * 1024 * 1024, seed = [] } = {}) {
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError('max must be a positive integer');
  if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes < 0) throw new RangeError('maxImageBytes must be a nonnegative integer');
  const items = [], byId = new Map(), images = new Map(), tools = new Map(), requests = new Map(), stream = new Map();
  let nextIndex = 0, imageBytes = 0;

  // Keep buffers after exit for reading, but cap retained image data per chat.
  function removeImage(itemId) {
    const image = images.get(itemId);
    if (!image) return;
    images.delete(itemId);
    imageBytes -= image.data.length;
    image.item.images = image.item.images.filter((ref) => ref.itemId !== itemId);
  }

  function append(item, preserve = false) {
    const i = preserve && Number.isSafeInteger(item.i) && item.i >= nextIndex ? item.i : nextIndex;
    nextIndex = i + 1;
    let id = item.id && !byId.has(item.id) ? item.id : `remote-${i}`;
    while (byId.has(id)) id += '-';
    const stored = { ...item, i, id };
    if ((stored.t === 'perm' || stored.t === 'ask') && !stored.state)
      stored.state = stored.decided || stored.answers ? 'decided' : stored.expired ? 'cancelled' : 'pending';
    items.push(stored);
    byId.set(id, stored);
    if (stored.t === 'tool' || stored.t === 'job' || stored.t === 'progress') tools.set(id, stored);
    if ((stored.t === 'perm' || stored.t === 'ask') && stored.requestId && !stored.decided && !stored.expired) requests.set(stored.requestId, stored);
    while (items.length > max) {
      const old = items.shift();
      byId.delete(old.id);
      if (tools.get(old.id) === old) tools.delete(old.id);
      if (requests.get(old.requestId) === old) requests.delete(old.requestId);
      for (const ref of old.images || []) removeImage(ref.itemId);
      for (const [key, value] of stream) if (value === old) stream.delete(key);
    }
    return stored;
  }

  function addImages(item, blocks) {
    for (const block of blocks || []) {
      const image = imageOf(block);
      if (!image || image.data.length > maxImageBytes) continue;
      const itemId = `${item.id}:image:${(item.images || []).length}`;
      const ref = { kind: 'image', itemId, mime: image.mime, bytes: image.data.length };
      (item.images ||= []).push(ref);
      images.set(itemId, { ...image, item });
      imageBytes += image.data.length;
      while (imageBytes > maxImageBytes) removeImage(images.keys().next().value);
    }
  }

  function embeddedImages(item, value) {
    return value.replace(/data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/]+={0,2})/gi, (_whole, mime, data) => {
      addImages(item, [{ mime, data }]);
      return '[image]';
    });
  }

  function output(item) { return safe(item); }
  function page(selected) {
    const firstIndex = items.length ? items[0].i : nextIndex;
    return { items: selected.map(output), total: items.length,
      hasMore: !!selected.length && selected[0].i > firstIndex, firstIndex };
  }
  function count(n) { return Number.isSafeInteger(n) && n >= 0 ? Math.min(n, max) : 50; }
  function tail(n = 50) { const size = count(n); return page(size ? items.slice(-size) : []); }
  function before(index, n = 50) {
    const end = items.findIndex((item) => item.i >= index);
    const size = count(n);
    return page(size ? items.slice(0, end < 0 ? items.length : end).slice(-size) : []);
  }

  function addUser(text, source) {
    const item = append({ t: 'user', text: '', ...(typeof source === 'string' ? { source } : {}) });
    item.text = embeddedImages(item, String(text || ''));
    if (source && typeof source === 'object') {
      if (typeof source.source === 'string') item.source = source.source;
      if (Array.isArray(source.files)) item.files = source.files.filter((x) => typeof x === 'string');
      addImages(item, Array.isArray(source) ? source : Array.isArray(source.images) ? source.images
        : Array.isArray(source.attachments) ? source.attachments : [source]);
    }
    stream.clear();
    return output(item);
  }

  function resultText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter((part) => part && part.type === 'text').map((part) => part.text || '').join('\n');
  }

  function jobFrom(block) {
    const input = block.input || {};
    if (block.name === 'Agent' || block.name === 'Task') return {
      engine: 'claude', role: input.subagent_type || 'general-purpose',
      title: input.description || input.subagent_type || 'Subagent'
    };
    if (block.name === 'Bash' && /codeome-agent["']?\s+codex\b/.test(input.command || '')) {
      const command = input.command;
      const arg = (key) => {
        const match = command.match(new RegExp('--' + key + '\\s+(?:"([^"]*)"|\'([^\']*)\'|(\\S+))'));
        return match ? match[1] || match[2] || match[3] : null;
      };
      return { engine: 'codex', role: arg('role') || 'codex', title: arg('title') || arg('role') || 'Codex job',
        resume: arg('resume'), background: !!input.run_in_background };
    }
    return null;
  }

  function attachResult(block) {
    const item = tools.get(block.tool_use_id);
    if (!item) return;
    const text = resultText(block.content);
    item.done = true;
    item.error = !!block.is_error;
    if (item.t === 'job') item.status = block.is_error ? 'failed' : 'done';
    item.result = embeddedImages(item, text).slice(0, RESULT_LIMIT);
    item.size = text.length;
    item.truncated = text.length > RESULT_LIMIT;
    addImages(item, Array.isArray(block.content) ? block.content : [block.content]);
  }

  function push(message) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'text_delta': {
        const key = `${message.msgId}:${message.index}`;
        let item = stream.get(key);
        if (!item) { item = append({ t: 'text', text: '', live: true, msgId: message.msgId }); stream.set(key, item); }
        item.text += message.text || '';
        return output(item);
      }
      case 'assistant': {
        const msg = message.message || {};
        for (const block of msg.content || []) {
          if (block.type === 'text' && block.text && !message.parent_tool_use_id) {
            const key = [...stream.keys()].find((k) => stream.get(k).msgId === msg.id);
            if (key) { const item = stream.get(key); stream.delete(key); item.text = block.text; item.live = false; }
            else append({ t: 'text', text: block.text });
          } else if (block.type === 'tool_use' && !message.parent_tool_use_id) {
            if (block.name === 'AskUserQuestion' || block.name === 'ExitPlanMode') continue;
            const job = jobFrom(block);
            append(job ? { t: 'job', id: block.id, ...job, status: 'running', startedAt: Date.now() }
              : { t: 'tool', id: block.id, name: block.name, input: slimInput(block.input || {}).input, done: false });
          }
        }
        return;
      }
      case 'user':
        if (!Array.isArray(message.message && message.message.content)) return;
        for (const block of message.message.content) if (block.type === 'tool_result') attachResult(block);
        return;
      case 'control_request': {
        const request = message.request || {};
        if (request.subtype !== 'can_use_tool') return;
        const slim = slimInput(request.input || {});
        const item = request.tool_name === 'AskUserQuestion'
          ? { t: 'ask', requestId: message.request_id, questions: (request.input || {}).questions || [], state: 'pending' }
          : { t: 'perm', requestId: message.request_id, tool: request.tool_name, title: request.title || null,
            reason: request.decision_reason || null, input: slim.input, truncated: slim.truncated,
            suggestions: request.permission_suggestions || null, state: 'pending' };
        // Slice 2 must evaluate requireDesktopFor against the full registry record.input
        // and refuse phone Allow when the shown command is truncated.
        const existing = requests.get(message.request_id);
        if (existing) { Object.assign(existing, item); return output(existing); }
        return output(append(item));
      }
      case 'control_cancel_request': return cancel(message.request_id);
      case 'system':
        if (message.subtype === 'compact_boundary') append({ t: 'note', kind: 'info', text: 'Earlier messages were summarised to free up context.' });
        if (message.subtype === 'task_notification') {
          const item = tools.get(message.tool_use_id);
          if (item) { item.done = true; if (item.t === 'job') item.status = message.status === 'completed' ? 'done' : 'failed'; }
        }
        return;
      case 'turn_usage': {
        const item = [...items].reverse().find((x) => x.t === 'text');
        if (item && !item.tok) item.tok = { in: message.input || 0, out: message.output || 0, cr: message.cacheRead || 0, cw: message.cacheWrite || 0 };
        return;
      }
      case 'result':
        stream.clear();
        for (const item of items) if (item.t === 'text') item.live = false;
        if ((message.subtype && message.subtype !== 'success') || (message.is_error && message.result))
          append({ t: 'note', kind: 'error', text: message.result || 'The agent stopped with an error.' });
        return;
    }
  }

  function markDecided(requestId, decision, source, answers) {
    const item = requests.get(requestId);
    if (!item) return null;
    requests.delete(requestId);
    item.state = 'decided';
    if (item.t === 'ask') { item.decided = decision; if (answers) item.answers = answers; }
    else item.decided = decision;
    if (source) item.source = source;
    return output(item);
  }

  function cancel(requestId) {
    const item = requests.get(requestId);
    if (!item) return null;
    requests.delete(requestId);
    item.state = 'cancelled'; item.expired = true;
    return output(item);
  }

  for (const item of seed) {
    if (!item || typeof item !== 'object') continue;
    const copy = { ...item };
    if (copy.t === 'text') copy.live = false;
    if ((copy.t === 'perm' || copy.t === 'ask') && !copy.decided && !copy.answers) {
      copy.state = 'cancelled'; copy.expired = true;
    }
    if (typeof copy.result === 'string') {
      copy.size = copy.size || copy.result.length;
      copy.truncated = !!copy.truncated || copy.result.length > RESULT_LIMIT;
    }
    const stored = append(copy, true);
    if (typeof stored.result === 'string') stored.result = embeddedImages(stored, stored.result).slice(0, RESULT_LIMIT);
    if (typeof stored.text === 'string') stored.text = embeddedImages(stored, stored.text);
  }
  return { push, addUser, markDecided, cancel, tail, before,
    get: (itemId) => { const item = byId.get(itemId); return item ? output(item) : null; },
    getImage: (itemId) => { const image = images.get(itemId); return image ? { mime: image.mime, data: Buffer.from(image.data) } : null; } };
}

function fromSaved(chatJson) { return createBuffer({ seed: chatJson && Array.isArray(chatJson.items) ? chatJson.items : [] }); }

module.exports = { createBuffer, fromSaved, redact };
