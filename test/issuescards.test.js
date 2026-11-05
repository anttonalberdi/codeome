const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.listeners = {}; this.dataset = {}; this.attributes = {}; }
  append(...children) { this.children.push(...children); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
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

const options = { host: 'github.com', onOpen() {}, onStatus() {}, onSnooze() {}, onAssess() {} };

test('triage summary, plan and reply payloads stay text and details start collapsed', () => {
  const payload = '<img src=x onerror=alert(1)>';
  for (const [action, field, label] of [['fix', 'proposedPlan', 'Proposed plan'], ['reply', 'draftReply', 'Draft reply']]) {
    const card = cards.render({ number: 42, triage: { action, size: 'small', summary: payload, [field]: payload } }, options);
    const all = nodes(card);
    assert.equal(all.some((element) => element.tag === 'img'), false);
    assert.equal(all.find((element) => element.className === 'issue-triage-summary').textContent, payload);
    assert.equal(all.find((element) => element.className === 'issue-triage-text').textContent, payload);
    assert.equal(all.find((element) => element.tag === 'summary').textContent, label);
    assert.equal(all.find((element) => element.tag === 'details').open, undefined);
    assert.equal(all.find((element) => element.className === 'issue-triage-note').textContent, 'AI suggestion — unverified');
  }
});

test('each triage action has the expected chip and size', () => {
  for (const [action, label] of [['none', 'No action needed'], ['reply', 'Reply'], ['fix', 'Quick fix'], ['plan', 'Needs a plan']]) {
    const card = cards.render({ number: 1, triage: { action, size: 'standard', summary: 'Review this issue' } }, options);
    const all = nodes(card);
    assert.equal(all.find((element) => element.className === `issue-triage-chip ${action}`).textContent, label);
    assert.equal(all.find((element) => element.className === 'issue-triage-size').textContent, 'standard');
  }
});

test('untriaged issues offer Assess; triaging disables it and shows Assessing', () => {
  let assessed;
  const item = { number: 7 };
  const card = cards.render(item, { ...options, onAssess: (issue) => { assessed = issue; } });
  const assess = nodes(card).find((element) => element.className === 'btn small issue-assess');
  assert.equal(assess.textContent, 'Assess');
  assert.equal(assess.disabled, undefined);
  assess.listeners.click();
  assert.equal(assessed, item);

  for (const state of [{ ...item, triaging: true }, item]) {
    const pending = cards.render(state, { ...options, assessing: state === item });
    const button = nodes(pending).find((element) => element.className === 'btn small issue-assess');
    assert.equal(button.textContent, 'Assessing…');
    assert.equal(button.disabled, true);
  }
});

test('stale triage offers reassessment and does not show its old suggestion', () => {
  const card = cards.render({ number: 9, triageStale: true, triage: { action: 'fix', summary: 'Old summary' } }, options);
  const all = nodes(card);
  assert.equal(all.find((element) => element.className === 'issue-triage-stale').textContent, 'Suggestion out of date');
  assert.equal(all.find((element) => element.className === 'btn small issue-assess').textContent, 'Assess');
  assert.equal(all.some((element) => element.className === 'issue-triage-summary'), false);
});
