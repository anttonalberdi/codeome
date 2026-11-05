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

test('issue work opens a chat with the prompt unchanged and ask-before-changes mode', () => {
  const prompt = '/orchestrate\n<<<ISSUE-DATA>>>\nUntrusted text';
  assert.deepEqual(JSON.parse(JSON.stringify(cards.issueChatOptions(prompt))), { send: prompt, mode: 'default' });
  const git = fs.readFileSync(path.join(__dirname, '../renderer/js/git.js'), 'utf8');
  assert.match(git, /newChat\(IssueCards\.issueChatOptions\(result\.data\.prompt\)\)/);
});

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

const options = { host: 'github.com', onOpen() {}, onStatus() {}, onSnooze() {}, onAssess() {},
  onStartWork() {}, onPostReply() {}, onDraft() {}, onDiscardDraft() {}, onOpenChat() {} };

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
  assert.equal(all.find((element) => element.className === 'issue-triage-stale').textContent, 'Issue changed since assessment');
  assert.equal(all.find((element) => element.className === 'btn small issue-assess').textContent, 'Re-assess');
  assert.equal(all.some((element) => element.className === 'issue-triage-summary'), false);
});

test('work controls match assessment and status states', () => {
  const cases = [
    [{ triage: { action: 'fix' } }, ['Start work']],
    [{ triage: { action: 'plan' } }, ['Start work']],
    [{ triage: { action: 'none' } }, ['Mark done']],
    [{ triage: { action: 'reply', draftReply: 'draft' } }, ['Post reply', 'Discard draft', 'Done']],
    [{ triage: { action: 'fix' }, triageStale: true }, ['Re-assess', 'Done']],
    [{ triage: { action: 'unexpected' } }, ['Assess', 'Done']],
    [{}, ['Assess', 'Start work anyway', 'Done']],
    [{ triaging: true }, ['Assessing…', 'Done']],
    [{ status: 'in-progress', chat: 'chat-1', triage: { action: 'fix' } }, ['Open chat', 'Done']],
    [{ status: 'in-progress', triage: { action: 'fix' } }, ['Done']],
    [{ status: 'done', triage: { action: 'fix' } }, []]
  ];
  for (const [state, labels] of cases) {
    const card = cards.render({ number: 7, status: 'seen', ...state }, options);
    const all = nodes(card);
    const buttons = all.filter((element) => element.tag === 'button').map((element) => element.textContent);
    for (const label of labels) assert.ok(buttons.includes(label), `${JSON.stringify(state)} should include ${label}`);
    for (const label of ['Start work', 'Start work anyway', 'Post reply', 'Mark done', 'Re-assess', 'Open chat']) {
      if (!labels.includes(label)) assert.equal(buttons.includes(label), false, `${JSON.stringify(state)} should omit ${label}`);
    }
    if (state.status === 'in-progress') assert.equal(all.find((element) => element.className === 'issue-in-progress').textContent, 'In progress');
  }
});

test('hostile reply draft stays in textarea value; edit, validation, and discard are safe', () => {
  const payload = '<img src=x onerror=alert(1)>';
  let body, changed, discarded = false;
  const card = cards.render({ number: 42, triage: { action: 'reply', draftReply: payload } },
    { ...options, onPostReply: (_item, value) => { body = value; }, onDraft: (_item, value) => { changed = value; },
      onDiscardDraft: () => { discarded = true; } });
  const all = nodes(card), draft = all.find((element) => element.tag === 'textarea');
  assert.equal(draft.value, payload);
  assert.equal(all.some((element) => element.tag === 'img'), false);
  const post = all.find((element) => element.textContent === 'Post reply');
  draft.value = '  ';
  post.listeners.click();
  assert.equal(body, undefined);
  assert.equal(all.find((element) => element.className === 'issue-reply-error').textContent, 'Write a reply before posting.');
  draft.value = 'Edited public reply';
  draft.listeners.input();
  post.listeners.click();
  assert.equal(changed, 'Edited public reply');
  assert.equal(body, 'Edited public reply');
  all.find((element) => element.textContent === 'Discard draft').listeners.click();
  assert.equal(draft.value, payload);
  assert.equal(discarded, true);
});

test('start and posted controls disable in flight and links stay on the bound host', () => {
  let force;
  const start = cards.render({ number: 1 }, { ...options, starting: true, onStartWork: (_item, value) => { force = value; } });
  const startButton = nodes(start).find((element) => element.className === 'btn small issue-start');
  assert.equal(startButton.disabled, true);
  assert.match(startButton.title, /waits for your approval/);
  startButton.listeners.click();
  assert.equal(force, true);
  const posted = cards.render({ number: 1, status: 'done' }, { ...options, posted: 'https://github.com/org/repo/issues/1#issuecomment-1' });
  assert.equal(nodes(posted).find((element) => element.className === 'issue-posted-link').href,
    'https://github.com/org/repo/issues/1#issuecomment-1');
  const unsafe = cards.render({ number: 1, status: 'done' }, { ...options, posted: 'https://evil.example/comment' });
  assert.equal(nodes(unsafe).some((element) => element.className === 'issue-posted-link'), false);
});
