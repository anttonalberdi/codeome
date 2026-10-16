const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.hidden = false; this.checked = false; this.scrollTop = 0; this.clientHeight = 0; this.scrollHeight = 0; }
  append(...children) { this.children.push(...children.flat(Infinity).filter((child) => child instanceof Element || typeof child === 'string')); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  set textContent(text) { this.children = [String(text)]; }
  get textContent() { return this.children.map((child) => child instanceof Element ? child.textContent : child).join(''); }
  all(tag) { return [this, ...this.children.flatMap((child) => child instanceof Element ? child.all(tag) : [])].filter((child) => child.tag === tag || child.tag.startsWith(tag + '.')); }
}

test('job result and brief render escaped Markdown; log, raw, placeholders and errors stay plain', async () => {
  const responses = {
    result: { content: '# Result\n<script>alert(1)</script>' },
    brief: { content: '**Brief**' },
    log: { content: '# Log' },
    events: { items: [], missing: true }
  };
  const reads = [];
  let page, ready, poll;
  const App = {
    project: '/project', views: { editor: {
      active: 'job', openCustom(options) {
        page = new Element('root');
        ready = options.render(page, { id: 'job' });
      }
    } },
    h(tag, attrs, ...children) {
      if (!(attrs && typeof attrs === 'object' && !Array.isArray(attrs) && !(attrs instanceof Element))) { children.unshift(attrs); attrs = {}; }
      const el = new Element(tag);
      Object.assign(el, attrs);
      if (attrs.html !== undefined) el.innerHTML = attrs.html;
      el.append(...children);
      if (tag === 'select') el.value = 'result';
      return el;
    }
  };
  const codeome = { jobs: { async read(_project, _id, part) { reads.push(part); return responses[part]; } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../renderer/js/md.js'), 'utf8'), { App });
  const renderMarkdown = App.md, markdownInputs = [];
  App.md = (content) => { markdownInputs.push(content); return renderMarkdown(content); };
  vm.runInNewContext(fs.readFileSync(require.resolve('../renderer/js/agents.js'), 'utf8'), { App, codeome, setInterval: (fn, ms) => { assert.strictEqual(ms, 3000); poll = fn; return 1; } });
  const job = { id: 'j1', role: 'implementer', engine: 'codex', title: 'Test', status: 'done', startedAt: new Date().toISOString() };
  App.views.agents.jobs = [job];
  App.views.agents.openJob(job);
  await ready;
  const [which] = page.all('select');
  assert.ok(page.all('option').some((option) => option.value === 'activity' && option.textContent === 'Activity'));
  const [pre] = page.all('pre.logbox');
  const [md] = page.all('div.msg.md.job-markdown');
  const [, raw] = page.all('input');
  assert.strictEqual(pre.hidden, true);
  assert.match(md.innerHTML, /<h3>Result<\/h3>/);
  assert.match(md.innerHTML, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(md.innerHTML, /<script>/);

  which.value = 'brief'; which.onchange(); await new Promise(setImmediate);
  assert.match(md.innerHTML, /<strong>Brief<\/strong>/);
  raw.checked = true; raw.onchange(); await new Promise(setImmediate);
  assert.strictEqual(pre.textContent, '**Brief**');
  assert.strictEqual(md.hidden, true);

  raw.checked = false; which.value = 'log'; which.onchange(); await new Promise(setImmediate);
  assert.strictEqual(pre.textContent, '# Log');
  assert.strictEqual(pre.hidden, false);

  responses.brief = { missing: true };
  which.value = 'brief'; which.onchange(); await new Promise(setImmediate);
  assert.strictEqual(pre.textContent, '(none recorded)');
  responses.brief = { error: '<script>error</script>' };
  which.onchange(); await new Promise(setImmediate);
  assert.strictEqual(pre.textContent, '<script>error</script>');
  assert.strictEqual(md.hidden, true);
  assert.deepStrictEqual(reads, ['result', 'brief', 'brief', 'log', 'brief', 'brief']);
  assert.deepStrictEqual(markdownInputs, ['# Result\n<script>alert(1)</script>', '**Brief**']);

  const live = { ...job, id: 'j2', status: 'running' };
  App.views.agents.jobs = [live];
  App.views.agents.openJob(live);
  await ready;
  assert.strictEqual(page.all('select')[0].value, 'log');
  assert.strictEqual(page.all('pre.logbox')[0].textContent, '# Log');
  assert.deepStrictEqual(reads.slice(-2), ['events', 'log']);
  App.views.agents.jobs = [{ ...live, status: 'done' }];
  poll(); await new Promise(setImmediate);
  assert.strictEqual(page.all('select')[0].value, 'result');
  assert.match(page.all('div.msg.md.job-markdown')[0].innerHTML, /<h3>Result<\/h3>/);
});

test('conversation is available only for Claude transcripts and renders untrusted items safely', async () => {
  const responses = { transcript: { items: [
    { kind: 'user', text: '# Brief' },
    { kind: 'text', text: '<script>alert(1)</script>' },
    { kind: 'thinking', text: '<img src=x onerror=1>' },
    { kind: 'tool', id: 'tool-1', name: 'Read', summary: 'file.txt', input: { path: '<img src=x onerror=1>' },
      result: { text: '<img src=x onerror=1>', truncated: true, size: 9000, isError: true } }
  ], truncated: true }, result: { content: 'Done' }, log: { content: '' }, events: { items: [], missing: true } };
  let page, ready, poll;
  const App = {
    project: '/project', views: { editor: {
      active: 'job', openCustom(options) { page = new Element('root'); ready = options.render(page, { id: 'job' }); }
    } },
    h(tag, attrs, ...children) {
      if (!(attrs && typeof attrs === 'object' && !Array.isArray(attrs) && !(attrs instanceof Element))) { children.unshift(attrs); attrs = {}; }
      const el = new Element(tag);
      Object.assign(el, attrs);
      if (attrs.html !== undefined) el.innerHTML = attrs.html;
      el.append(...children);
      if (tag === 'select') el.value = 'result';
      return el;
    }
  };
  const codeome = { jobs: { async read(_project, _id, part) { return responses[part]; } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../renderer/js/md.js'), 'utf8'), { App });
  vm.runInNewContext(fs.readFileSync(require.resolve('../renderer/js/agents.js'), 'utf8'), { App, codeome, setInterval: (fn) => { poll = fn; return 1; } });
  const base = { id: 'j1', role: 'implementer', title: 'Test', status: 'running', startedAt: new Date().toISOString() };
  for (const job of [
    { ...base, engine: 'codex', transcript: '/tmp/job.jsonl' },
    { ...base, engine: 'claude' }
  ]) {
    App.views.agents.jobs = [job];
    App.views.agents.openJob(job);
    await ready;
    assert.ok(!page.all('option').some((option) => option.value === 'conversation'));
    assert.strictEqual(page.all('option').some((option) => option.value === 'activity'), job.engine === 'codex');
    if (job.engine === 'claude') {
      App.views.agents.jobs = [{ ...job, status: 'done', transcript: '/tmp/job.jsonl' }];
      poll(); await new Promise(setImmediate);
      assert.ok(page.all('option').some((option) => option.value === 'conversation'));
      assert.strictEqual(page.all('select')[0].value, 'result');
    }
  }

  const job = { ...base, engine: 'claude', transcript: '/tmp/job.jsonl' };
  App.views.agents.jobs = [job];
  App.views.agents.openJob(job);
  await ready;
  const [which] = page.all('select');
  assert.ok(page.all('option').some((option) => option.value === 'conversation'));
  assert.strictEqual(which.value, 'conversation');
  const conversation = page.all('div.job-conversation')[0];
  assert.strictEqual(conversation.hidden, false);
  assert.match(conversation.textContent, /Earlier messages are not shown/);
  const details = conversation.all('details');
  assert.strictEqual(details.length, 3);
  assert.ok(details.every((item) => !item.open));
  assert.match(details[2].all('summary')[0].textContent, /Read.*file\.txt.*error/);
  assert.strictEqual(details[2].all('pre')[1].textContent, '<img src=x onerror=1>');
  assert.match(details[2].textContent, /\(truncated, 9000 chars total\)/);
  assert.match(conversation.all('div.msg.md')[1].innerHTML, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.strictEqual(conversation.all('img').length, 0);
  assert.strictEqual(conversation.all('script').length, 0);

  details[2].open = true;
  conversation.scrollHeight = 500; conversation.clientHeight = 100; conversation.scrollTop = 400;
  responses.transcript.items.push({ kind: 'tool', id: 'tool-2', name: 'Bash', summary: 'pwd', input: { command: 'pwd' }, result: null });
  poll(); await new Promise(setImmediate);
  assert.strictEqual(page.all('div.job-conversation')[0].all('details')[2].open, true);
  assert.match(page.all('div.job-conversation')[0].all('details')[3].all('summary')[0].textContent, /running…/);
  assert.strictEqual(conversation.scrollTop, 500);
  conversation.scrollTop = 0; conversation.scrollHeight = 600;
  poll(); await new Promise(setImmediate);
  assert.strictEqual(conversation.scrollTop, 0);

  App.views.agents.jobs = [{ ...job, status: 'done' }];
  poll(); await new Promise(setImmediate);
  assert.strictEqual(which.value, 'result');
  App.views.agents.openJob({ ...job, status: 'done' });
  await ready;
  assert.strictEqual(page.all('select')[0].value, 'result');
});

test('live Codex activity renders events safely and old jobs fall back to Log', async () => {
  const responses = { events: { items: [
    { kind: 'event', type: 'thread.started' },
    { kind: 'event', type: 'turn.started' },
    { kind: 'text', text: '<script>alert(1)</script><img src=x onerror=1>' },
    { kind: 'thinking', text: '<script>thinking</script>' },
    { kind: 'tool', id: 'shell-1', name: 'shell', summary: '<script>command</script>',
      input: { command: '<img src=x onerror=1>' },
      result: { text: '<script>output</script>', truncated: false, isError: true, size: 23, exitCode: 1 } },
    { kind: 'tool', id: 'file-1', name: 'file_change', summary: '1 files',
      input: { changes: [{ path: '<img src=x onerror=1>' }] }, result: null },
    { kind: 'usage', usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 5, reasoning_output_tokens: 2 } },
    { kind: 'error', text: '<img src=x onerror=1>' },
    { kind: 'event', type: 'turn.other' }
  ] }, log: { content: 'legacy log' }, result: { content: 'Done' } };
  const reads = [];
  let page, ready, poll;
  const App = {
    project: '/project', views: { editor: {
      active: 'job', openCustom(options) { page = new Element('root'); ready = options.render(page, { id: 'job' }); }
    } },
    h(tag, attrs, ...children) {
      if (!(attrs && typeof attrs === 'object' && !Array.isArray(attrs) && !(attrs instanceof Element))) { children.unshift(attrs); attrs = {}; }
      const el = new Element(tag);
      Object.assign(el, attrs);
      if (attrs.html !== undefined) el.innerHTML = attrs.html;
      el.append(...children);
      if (tag === 'select') el.value = 'result';
      return el;
    }
  };
  const codeome = { jobs: { async read(_project, _id, part) { reads.push(part); return responses[part]; } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../renderer/js/md.js'), 'utf8'), { App });
  vm.runInNewContext(fs.readFileSync(require.resolve('../renderer/js/agents.js'), 'utf8'), { App, codeome, setInterval: (fn) => { poll = fn; return 1; } });
  const job = { id: 'j1', role: 'implementer', engine: 'codex', title: 'Test', status: 'running', startedAt: new Date().toISOString() };
  App.views.agents.jobs = [job];
  App.views.agents.openJob(job);
  await ready;

  const [which] = page.all('select');
  const activity = page.all('div.job-conversation')[0];
  assert.ok(page.all('option').some((option) => option.value === 'activity' && option.textContent === 'Activity'));
  assert.ok(page.all('option').some((option) => option.value === 'log' && option.textContent === 'Log'));
  assert.strictEqual(which.value, 'activity');
  assert.strictEqual(activity.hidden, false);
  assert.deepStrictEqual(reads, ['events']);
  assert.strictEqual(activity.all('details').length, 3);
  assert.match(activity.textContent, /tokens: in 12 \(cached 3\), out 5/);
  assert.match(activity.all('div.job-conversation-error')[0].textContent, /<img src=x onerror=1>/);
  assert.match(activity.textContent, /turn\.other/);
  assert.doesNotMatch(activity.textContent, /thread\.started|turn\.started/);
  assert.match(activity.all('div.msg.md.job-conversation-text')[0].innerHTML, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(activity.all('div.msg.md.job-conversation-text')[0].innerHTML, /&lt;img src=x onerror=1&gt;/);
  assert.strictEqual(activity.all('details')[1].all('summary')[0].textContent.includes('<script>command</script>'), true);
  assert.match(activity.all('details')[1].all('pre')[0].textContent, /<img src=x onerror=1>/);
  assert.strictEqual(activity.all('details')[1].all('pre')[1].textContent, '<script>output</script>');
  assert.strictEqual(activity.all('img').length, 0);
  assert.strictEqual(activity.all('script').length, 0);
  assert.ok(activity.all('details').every((detail) => detail.innerHTML === undefined));

  which.value = 'log'; which.onchange(); await new Promise(setImmediate);
  assert.strictEqual(page.all('pre.logbox')[0].textContent, 'legacy log');
  which.value = 'activity'; which.onchange(); await new Promise(setImmediate);
  assert.strictEqual(which.value, 'activity');
  responses.events = { items: [], missing: true };
  poll(); await new Promise(setImmediate);
  assert.strictEqual(which.value, 'log');
  assert.strictEqual(page.all('pre.logbox')[0].textContent, 'legacy log');

  App.views.agents.openJob(job);
  await ready;
  assert.strictEqual(page.all('select')[0].value, 'log');
  assert.strictEqual(page.all('pre.logbox')[0].textContent, 'legacy log');
});
