const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const { buildOverview } = require('../renderer/js/overview-model');

class Element {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.listeners = {}; this.parent = null; }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key]; }
  set textContent(value) { this.value = value; }
  append(...children) { for (let child of children) { if (!(child instanceof Element)) { const value = child; child = new Element('#text'); child.textContent = String(value); } child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(event, fn) { this.listeners[event] = fn; }
  closest(selector) { return selector === '[data-job-id]' && this.attrs['data-job-id'] ? this : this.parent && this.parent.closest(selector); }
  all(predicate) { return [this, ...this.children.flatMap((child) => child.all(predicate))].filter(predicate); }
}

test('overview opens once, draws branches, refreshes live items, and opens a clicked job', () => {
  const tabs = new Map();
  let opened;
  const App = {
    h: (selector, ...children) => { const el = new Element(selector); el.append(...children); return el; },
    fmtTokens: (n) => n == null ? '–' : String(n),
    fmtUsd: (n) => '$' + n.toFixed(2),
    views: {
      chat: { openJob: (job) => { opened = job; } },
      editor: { openCustom(options) {
        if (tabs.has(options.key)) { options = tabs.get(options.key); options.onActivate(); return options; }
        tabs.set(options.key, options);
        options.el = new Element('root');
        options.render(options.el);
        return options;
      } }
    }
  };
  const document = { createElementNS: (_ns, tag) => new Element(tag) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../renderer/js/overview.js'), 'utf8'), { App, document, window: { OverviewModel: { buildOverview } } });
  const job = { t: 'job', id: 'j1', engine: 'codex', title: 'Inspect logs', startedAt: 10, endedAt: 20, status: 'done' };
  const chat = { id: 'c1', title: 'Investigate', items: [
    { t: 'user', text: 'Find issue', at: 0 }, job,
    { t: 'text', text: 'Found it', at: 30, tok: { in: 10, out: 5, cr: 2, cw: 1 } }
  ] };
  App.views.overview.open(chat);
  const tab = tabs.get('chat-overview:c1');
  assert.strictEqual(tab.title, 'Overview: Investigate');
  assert.strictEqual(tab.badge, 'Agent');
  const page = tab.el;
  assert.strictEqual(page.all((el) => el.tag === 'div.ov-head')[0].children[2].children[0].value, '18 tokens');
  const svg = page.all((el) => el.tag === 'svg')[0];
  assert.strictEqual(svg.all((el) => el.attrs.class === 'ov-fork').length, 1);
  assert.strictEqual(svg.all((el) => el.attrs.class === 'ov-merge').length, 1);
  assert.strictEqual(svg.all((el) => el.attrs.class === 'ov-dot').length, 3);
  const scroll = page.all((el) => el.tag === 'div.ov-scroll')[0];
  const jobDot = svg.all((el) => el.attrs['data-job-id'] === 'j1')[0].children[0];
  scroll.listeners.click({ target: jobDot });
  assert.strictEqual(opened, job);
  chat.items.push({ t: 'user', text: 'Next', at: 40 });
  App.views.overview.open(chat);
  assert.strictEqual(tabs.size, 1);
  assert.strictEqual(scroll.all((el) => el.attrs.class === 'ov-dot').length, 4);
  chat.items.push(
    { t: 'perm', tool: 'ExitPlanMode', decided: 'allow', input: { plan: '# Check the result' } },
    { t: 'text', text: 'Checking', at: 400000 },
    { t: 'job', id: 'failed', engine: 'claude', title: 'Failed check', startedAt: 400001, endedAt: 400002, status: 'failed' },
    { t: 'job', id: 'running', engine: 'codex', title: 'Running check', startedAt: 400003, status: 'running' }
  );
  tab.onActivate();
  assert.strictEqual(scroll.all((el) => el.attrs.class === 'ov-box').length, 1);
  assert.strictEqual(scroll.all((el) => el.attrs.class === 'ov-gap').length, 1);
  assert.strictEqual(scroll.all((el) => el.attrs.class === 'ov-x').length, 1);
  assert.strictEqual(scroll.all((el) => el.attrs.class === 'ov-live-end').length, 1);
  assert.strictEqual(Object.keys(scroll.listeners).length, 1);
  chat.items.push(...Array.from({ length: 500 }, (_, i) => ({ t: 'text', text: `Reply ${i}`, at: 400004 + i })));
  tab.onActivate();
  assert.strictEqual(scroll.all((el) => el.attrs.class === 'ov-dot').length, 507);
  assert.strictEqual(Object.keys(scroll.listeners).length, 1);
});
