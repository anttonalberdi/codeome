const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.listeners = {}; this.dataset = {}; }
  append(...children) { this.children.push(...children); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  set innerHTML(_value) { throw new Error('Issue content reached innerHTML'); }
}

function nodes(root) { return [root, ...root.children.flatMap(nodes)]; }

const source = fs.readFileSync(path.join(__dirname, '../renderer/js/issuescards.js'), 'utf8');
const moduleRef = {};
vm.runInNewContext(source, { document: { createElement: (tag) => new Element(tag) }, module: moduleRef, URL, Date });
const cards = moduleRef.exports;

test('issue HTML payloads render as text, never markup', () => {
  const payload = '<img src=x onerror=alert(1)>';
  const card = cards.render({ number: 42, title: payload, body: payload, author: payload,
    labels: [payload], status: 'new', url: 'https://github.com/org/repo/issues/42', createdAt: new Date().toISOString() },
  { host: 'github.com', onOpen() {}, onStatus() {}, onSnooze() {} });
  const all = nodes(card);
  assert.equal(all.filter((node) => node.tag === 'img').length, 0);
  for (const className of ['issue-title', 'issue-body', 'issue-label']) {
    assert.equal(all.find((node) => node.className === className).textContent, payload);
  }
  assert.equal(all.find((node) => node.className === 'issue-meta').children[0].textContent, payload);
});

test('external issue links require HTTPS and the bound account host', () => {
  assert.equal(cards.safeUrl('https://github.com/org/repo/issues/42', 'github.com'), 'https://github.com/org/repo/issues/42');
  for (const url of ['http://github.com/x', 'https://evil.example/x', 'https://github.com.evil.example/x',
    'https://user@github.com/x', 'https://github.com:444/x', 'javascript:alert(1)']) assert.equal(cards.safeUrl(url, 'github.com'), null);
});
