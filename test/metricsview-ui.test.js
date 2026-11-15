const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../renderer/js/metrics.js'), 'utf8');
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.hidden = true; this.classList = { add() {}, remove() {} }; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this[key] = value; }
  contains() { return false; }
  focus() {}
  get textContent() { return (this.text || '') + this.children.map(n => n.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.children = []; }
}
function setup(agents = async () => ({ error: 'offline' })) {
  const elements = Object.fromEntries(['app', 'metrics-btn', 'overlay', 'menu-pop'].map(id => [id, new Element('div')]));
  const listeners = {}, keys = [];
  let poll, cleared = 0;
  const App = { views: { settings: { close() {} }, editor: { layout() {} } }, listen: (name, fn) => { listeners[name] = fn; } };
  vm.runInNewContext(source, { App, window: { codeome: { metrics: { agents } } }, document: {
    createElement: tag => new Element(tag), getElementById: id => elements[id], addEventListener: (_, fn) => keys.push(fn)
  }, setInterval: (fn, ms) => { assert.equal(ms, 5000); poll = fn; return 1; }, clearInterval: () => { cleared++; } });
  return { M: App.views.metrics, elements, listeners, keys, poll: () => poll(), cleared: () => cleared };
}
const flush = () => new Promise(setImmediate);
test('resource formatters preserve multi-core CPU and format KB as MB or GB', () => {
  const { cpu, memory } = setup().M._fmt;
  assert.equal(cpu(12.5), '12.5%'); assert.equal(cpu(240), '240.0%');
  assert.equal(cpu(null), '–'); assert.equal(cpu(0), '0.0%');
  assert.equal(memory(812 * 1024), '812 MB'); assert.equal(memory(1.4 * 1024 * 1024), '1.4 GB');
  assert.equal(memory(1024 * 1024), '1.0 GB'); assert.equal(memory(0), '0 MB');
});
test('button precedes Settings and the view is loaded and wired', () => {
  const html = fs.readFileSync(require.resolve('../renderer/index.html'), 'utf8');
  assert.ok(html.indexOf('id="metrics-btn"') < html.indexOf('id="settings-btn"'));
  assert.match(html, /src="js\/metrics.js"/);
  const app = fs.readFileSync(require.resolve('../renderer/js/app.js'), 'utf8');
  assert.match(app, /App.views.metrics.init\(\)/);
  assert.match(app, /getElementById\('metrics-btn'\).onclick = \(\) => App.views.metrics.toggle\(\)/);
});
test('polling is open-only, skips overlapping calls, retains good data on errors and closes on navigation', async () => {
  let calls = 0, resolve;
  const s = setup(() => { calls++; return new Promise(r => { resolve = r; }); });
  s.M.init(); assert.equal(calls, 0);
  s.M.open(); s.poll(); assert.equal(calls, 1);
  resolve({ ts: Date.now(), ncpu: 8, projects: [{ project: '/a/demo', items: [{ label: '<script>hello</script>', kind: 'job', cpu: null, rssKb: 1024, nproc: 2 }], totals: { cpu: null, rssKb: 1024, nproc: 2 } }], app: { cpu: 1, rssKb: 1024 } });
  await flush();
  const page = s.elements.app.children[0];
  assert.match(page.textContent, /8 cores/); assert.match(page.textContent, /<script>hello<\/script>/);
  s.poll(); resolve({ error: 'offline' }); await flush();
  assert.match(page.textContent, /Could not load resource usage: offline/);
  assert.match(page.textContent, /Project total/);
  s.listeners.view(); s.poll(); assert.equal(calls, 2); assert.equal(s.M.isOpen, false);
  assert.ok(s.cleared() > 0);
});
test('closed requests cannot render and reopening samples after the prior request settles', async () => {
  let calls = 0, resolve;
  const s = setup(() => { calls++; return new Promise(r => { resolve = r; }); });
  s.M.open(); s.M.close(); s.M.open(); assert.equal(calls, 1);
  resolve({ error: 'stale' }); await flush(); assert.equal(calls, 2);
  resolve({ ts: Date.now(), ncpu: 2, projects: [], app: { cpu: 0, rssKb: 0 } }); await flush();
  assert.match(s.elements.app.textContent, /No agents running./);
  assert.doesNotMatch(s.elements.app.textContent, /stale/);
  let prevented = false;
  s.keys[0]({ key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(s.M.isOpen, false);
});
