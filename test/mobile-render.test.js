const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Render = require('../renderer/mobile/render');
const MD = require('../renderer/mobile/md');

const mobile = path.join(__dirname, '..', 'renderer', 'mobile');
const attack = '<script>alert(1)</script><img onerror="alert(1)">';
function safe(html) {
  assert.doesNotMatch(html, /<script|<img\s+onerror\s*=|href="javascript:/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
}

test('escape-first markdown permits only safe phone links and plain file paths', () => {
  const html = MD.render(`${attack} [bad](javascript:alert) [good](https://example.test?q=1&x=2) [mail](mailto:a@example.test) [file](src/app.js) src/app.js`);
  safe(html);
  assert.match(html, /href="https:\/\/example\.test\?q=1&amp;x=2" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /href="mailto:a@example.test"/);
  assert.doesNotMatch(html, /data-path|href="#"|href="javascript:/);
});

test('all remote item shapes escape untrusted fields', () => {
  const items = [
    { t: 'user', id: attack, text: attack, files: [attack] },
    { t: 'text', id: attack, text: `${attack} [x](javascript:evil)` },
    { t: 'tool', id: attack, name: attack, input: { command: attack, path: 'javascript:evil' }, result: attack },
    { t: 'job', id: attack, title: attack, engine: attack, role: attack, status: attack },
    { t: 'progress', id: attack, title: attack, role: attack, status: attack },
    { t: 'note', id: attack, kind: attack, text: attack },
    { t: 'perm', id: attack, title: attack, tool: attack, reason: attack, input: { command: attack }, state: 'pending' },
    { t: 'ask', id: attack, questions: [{ header: attack, question: attack, options: [{ label: attack, description: attack }] }], state: 'pending' }
  ];
  for (const item of items) safe(Render.renderItem(item));
});

test('permission and question history state is explicit', () => {
  for (const state of ['pending', 'decided', 'cancelled', 'expired']) {
    assert.match(Render.renderItem({ t: 'perm', state, tool: attack, input: attack }), new RegExp(state));
    assert.match(Render.renderItem({ t: 'ask', state, questions: [{ question: attack, options: [{ label: attack }] }] }), new RegExp(state));
  }
  assert.equal(Render.stateOf({ expired: true }), 'expired');
  assert.equal(Render.stateOf({ decided: 'allow' }), 'decided');
});

test('projectLabels disambiguates repeated basenames without changing inputs', () => {
  const projects = [
    { key: 'a', path: '/home/alberdilab/analysis', name: 'analysis' },
    { key: 'b', path: '/home/other/analysis', name: 'analysis' },
    { key: 'c', path: '/else/alberdilab/analysis', name: 'analysis' },
    { key: 'd', path: '/work/unique', name: 'unique' }
  ];
  const before = structuredClone(projects);
  const labels = Render.projectLabels(projects);
  assert.deepEqual(projects, before);
  assert.equal(labels.get('a'), 'analysis · alberdilab · home');
  assert.equal(labels.get('b'), 'analysis · other');
  assert.equal(labels.get('c'), 'analysis · alberdilab · else');
  assert.equal(labels.get('d'), 'unique');
  assert.equal(Render.projectLabels(null).size, 0);
});

test('project cards escape text and only show nonzero count chips', () => {
  const project = { key: attack, name: attack, path: attack, updatedAt: 700000,
    counts: { waiting: 2, working: 1, ready: 3, error: 4, jobs: 5 } };
  const html = Render.renderProjectCard(project, attack, 1000000);
  safe(html);
  assert.match(html, /Last activity 5 min ago/);
  for (const label of ['2 waiting', '1 working', '3 ready', '4 error', '5 specialists'])
    assert.ok(html.includes(label), label);
  const empty = Render.renderProjectCard({ ...project, counts: { waiting: 0, working: 0, ready: 0, error: 0, jobs: 0 } }, attack);
  assert.doesNotMatch(empty, /marker-chip|marker-chips/);
  assert.match(Render.renderProjectCard({ ...project, issueCount: 2 }, attack), /2 issues/);
});

test('issue cards use textContent for hostile titles and offer no actions', () => {
  const elements = [];
  const doc = { createElement(tagName) {
    const element = { tagName, children: [], textContent: '',
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; } };
    elements.push(element);
    return element;
  } };
  const target = { ownerDocument: doc, replaceChildren(...children) { this.children = children; } };
  Render.renderIssues(target, [{ project: '/work/project', count: 4, items: [
    { number: 4, title: attack, action: 'reply', status: 'new' },
    { number: 3, title: 'Fix it', action: 'fix', status: 'new' },
    { number: 2, title: 'Plan it', action: 'plan', status: 'new' },
    { number: 1, title: 'Triage later', action: null, status: 'in-progress' }
  ] }], [{ path: '/work/project', name: 'project' }]);
  assert.equal(target.children.length, 1);
  assert.equal(elements.find((element) => element.className === 'issue-title').textContent, `#4 ${attack}`);
  assert.deepEqual(elements.filter((element) => element.className === 'issue-action').map((element) => element.textContent),
    ['Reply', 'Quick fix', 'Needs a plan', 'No action']);
  assert.equal(elements.find((element) => element.className === 'issue-hint').textContent, 'Open Codeome on the Mac to act');
  assert.equal(elements.some((element) => element.tagName === 'button' || element.tagName === 'script' || element.tagName === 'img'), false);
});

test('tab rows escape every field and render all seven desktop states', () => {
  const classes = ['waiting', 'working', 'ready', 'error', 'error-seen', 'idle', 'off'];
  const labels = ['Waiting for you', 'Working', 'Reply ready — not seen yet',
    'Stopped with an error — not seen yet', 'Last turn ended with an error',
    'Finished; session open', 'Session closed'];
  for (const [index, state] of classes.entries()) {
    const html = Render.renderTabRow({ id: attack, title: attack, state, jobs: 2,
      engine: attack, role: attack, active: true, updatedAt: 700000 }, 1000000);
    safe(html);
    assert.match(html, new RegExp(`class="state-dot ${state}"`));
    assert.ok(html.includes(labels[index]), state);
    assert.match(html, /aria-current="true"/);
    assert.match(html, /2 specialists/);
    assert.match(html, /5 min ago/);
  }
  safe(Render.renderTabRow({ id: 'a', title: attack, state: 'idle', label: attack, engine: attack, role: attack }));
  const noJob = Render.renderTabRow({ id: 'a', title: 'A', state: 'off', jobs: 0 });
  assert.doesNotMatch(noJob, /tab-badge|tab-chip/);
  safe(Render.renderEarlierRow({ id: attack, title: attack, updatedAt: 700000 }, 1000000));
});

test('relative time handles missing, recent, minute, hour, and day values', () => {
  assert.equal(Render.relativeTime(null, 1000000), '');
  assert.equal(Render.relativeTime(999999, 1000000), 'just now');
  assert.equal(Render.relativeTime(700000, 1000000), '5 min ago');
  assert.equal(Render.relativeTime(1000000 - 2 * 3600000, 1000000), '2 hr ago');
  assert.equal(Render.relativeTime(1000000 - 3 * 86400000, 1000000), '3 d ago');
});

test('phone seen state clears ready and error only through the seen timestamp', () => {
  const project = { counts: { waiting: 2, working: 1, ready: 9, error: 9, jobs: 4 }, tabs: [
    { id: 'ready', state: 'ready', label: 'New reply', updatedAt: 200 },
    { id: 'error', state: 'error', label: 'New error', updatedAt: 300 },
    { id: 'fresh', state: 'ready', updatedAt: 400 },
    { id: 'waiting', state: 'waiting', updatedAt: 100 }
  ] };
  const seen = { ready: 200, error: 350, fresh: 399, waiting: 500 };
  assert.equal(Render.displayedState(project.tabs[0], seen), 'idle');
  assert.equal(Render.displayedState(project.tabs[1], seen), 'error-seen');
  assert.equal(Render.displayedState(project.tabs[2], seen), 'ready');
  assert.equal(Render.displayedState(project.tabs[3], seen), 'waiting');
  const phone = Render.phoneProject(project, seen);
  assert.deepEqual(phone.tabs.map((tab) => tab.state), ['idle', 'error-seen', 'ready', 'waiting']);
  assert.deepEqual(phone.counts, { waiting: 2, working: 1, ready: 1, error: 0, jobs: 4 });
  assert.equal(phone.tabs[0].label, 'Finished; session open');
  assert.equal(project.tabs[0].state, 'ready');
});

test('an open chat records the updated tab timestamp after a reply and on exit', () => {
  const id = 'chat-1';
  const seen = {};
  let projects = [{ key: 'abcdef123456', tabs: [{ id, state: 'working', updatedAt: 100 }] }];
  seen[id] = Render.openChatSeenAt(projects, id);
  projects = Render.applyTabsEvent(projects, { key: 'abcdef123456', tabs: [
    { id, state: 'ready', updatedAt: 200 }
  ] });
  assert.equal(Render.displayedState(projects[0].tabs[0], seen), 'ready');
  seen[id] = Render.openChatSeenAt(projects, id); // The tabs event reaches the open chat.
  assert.equal(seen[id], 200);
  assert.equal(Render.displayedState(projects[0].tabs[0], seen), 'idle');
  seen[id] = Render.openChatSeenAt(projects, id); // Leaving the chat preserves the latest reply.
  assert.equal(Render.displayedState(projects[0].tabs[0], seen), 'idle');
  assert.equal(Render.openChatSeenAt(projects, 'missing'), 0);
});

test('hash routing validates project keys and chat ids and ignores pairing', () => {
  assert.deepEqual(Render.parseRoute('#/'), { type: 'home' });
  assert.deepEqual(Render.parseRoute('#/p/abcdef123456'), { type: 'project', key: 'abcdef123456' });
  assert.deepEqual(Render.parseRoute('#/c/part%3Aimage%3A42'), { type: 'chat', id: 'part:image:42' });
  assert.deepEqual(Render.parseRoute('#pair=secret'), { type: 'pair' });
  for (const hash of ['#/p/bad', '#/p/ABCDEF123456', '#/c/..', '#/c/%2F', '#/c/%zz',
    '#/c/x%3Fy', '#/c/x%23y', '#/c/x/other', '#/c/a?b', '#/unknown'])
    assert.deepEqual(Render.parseRoute(hash), { type: 'invalid' }, hash);
});

test('route resolution keeps valid chats beyond the listed tabs and rejects unknown projects', () => {
  const projects = [{ key: 'abcdef123456', tabs: [{ id: 'listed', title: 'Listed' }], earlier: [] }];
  assert.deepEqual(Render.resolveRoute('#/c/deep-link', projects), { type: 'chat', id: 'deep-link', entry: null });
  assert.equal(Render.resolveRoute('#/c/listed', projects).entry.chat.title, 'Listed');
  assert.deepEqual(Render.resolveRoute('#/p/000000000000', projects),
    { type: 'unknown-project', key: '000000000000' });
  assert.deepEqual(Render.resolveRoute('#/c/%2F', projects), { type: 'invalid' });
});

test('tabs removal validates keys, leaves other projects, and never inserts the removal event', () => {
  const projects = [{ key: 'abcdef123456', name: 'Remove' }, { key: '000000000000', name: 'Keep' }];
  const removed = Render.applyTabsEvent(projects, { key: 'abcdef123456', removed: true });
  assert.deepEqual(removed, [projects[1]]);
  assert.deepEqual(projects, [{ key: 'abcdef123456', name: 'Remove' }, { key: '000000000000', name: 'Keep' }]);
  assert.deepEqual(Render.applyTabsEvent(projects, { key: 'invalid', removed: true }), projects);
  assert.deepEqual(Render.applyTabsEvent(projects, { key: 'abcdef123456', removed: true, tabs: [] }), [projects[1]]);
});

test('pending cards use the computed project name and show its path separately', () => {
  const html = Render.renderPending({ chatId: 'chat', requestId: 'request', input: {} },
    { title: 'A chat', project: '/lab/analysis', projectName: 'analysis · lab' });
  assert.match(html, /<p class="eyebrow">analysis · lab<\/p>/);
  assert.match(html, /<p class="project-path">\/lab\/analysis<\/p>/);
});

test('approval context prefers escaped server fields over spoofed tab fields and falls back when absent', () => {
  const pending = { chatId: 'chat', requestId: 'request', input: {},
    project: '/trusted/<script>path</script>', projectName: '<script>project</script>',
    chatTitle: '<script>chat</script>' };
  const spoofed = { project: '/spoofed/path', projectName: 'Spoofed project', title: 'Spoofed chat' };
  const html = Render.renderPending(pending, spoofed);
  assert.doesNotMatch(html, /<script>|Spoofed/);
  assert.match(html, /&lt;script&gt;project&lt;\/script&gt;/);
  assert.match(html, /&lt;script&gt;chat&lt;\/script&gt;/);
  assert.match(html, /\/trusted\/&lt;script&gt;path&lt;\/script&gt;/);
  const fallback = Render.renderPending({ chatId: 'chat', requestId: 'request', input: {} }, spoofed);
  assert.match(fallback, /Spoofed project/);
  assert.match(fallback, /Spoofed chat/);
  assert.match(fallback, /\/spoofed\/path/);
  const emptyPath = Render.renderPending({ ...pending, project: '', projectName: '', chatTitle: '' }, spoofed);
  assert.doesNotMatch(emptyPath, /Spoofed|\/spoofed\/path/);
  const nameOnly = Render.renderPending({ chatId: 'chat', requestId: 'request', input: {}, projectName: '' }, spoofed);
  assert.match(nameOnly, /<p class="eyebrow">No project<\/p>/);
  assert.doesNotMatch(nameOnly, /<p class="eyebrow">Spoofed project<\/p>/);
});

test('a plain question shows its options without the raw JSON input', () => {
  const html = Render.renderPending({ chatId: 'chat', requestId: 'q1', toolName: 'AskUserQuestion',
    input: { questions: [{ question: 'Which file?', header: 'File', multiSelect: false,
      options: [{ label: 'a.txt', description: 'first' }, { label: 'b.txt' }] }] } });
  assert.match(html, /Which file\?/);
  assert.match(html, /data-option="0:1"/);
  assert.match(html, /Submit answers/);
  assert.match(html, /Question from the agent/);
  assert.doesNotMatch(html, /full-input|input-count|AskUserQuestion|&quot;questions&quot;/);
});

test('pending card shows full input, options, and disabled reasons', () => {
  const pending = { chatId: 'chat', requestId: 'r1', toolName: 'AskUserQuestion',
    title: attack, decisionReason: attack,
    input: { questions: [{ question: attack, header: attack, multiSelect: true,
      options: [{ label: attack, description: attack }] }], command: attack } };
  safe(Render.renderPending(pending, { title: attack, project: attack }));
  assert.match(Render.renderPending(pending), /data-option="0:0"/);
  assert.match(Render.renderPending(pending), /full-input/);
  assert.deepEqual(Render.describeDecision({ needsDesktop: true, reason: 'truncated' }),
    { allowDisabled: true, reason: 'Input was truncated. Allow this on the desktop.' });
  assert.match(Render.renderPending({ ...pending, needsDesktop: true, reason: 'needs-desktop' }), /data-decision="allow" disabled/);
  assert.match(Render.renderPending({ ...pending, needsDesktop: true, reason: 'truncated' }), /data-decision="deny">Deny/);
});

test('pending command shows its full length and has no scrolling clamp', () => {
  const command = `${'a'.repeat(400)}\n${'b'.repeat(500)}`;
  const html = Render.renderPending({ chatId: 'chat', requestId: 'r1', input: command });
  assert.match(html, /2 lines, 901 chars/);
  assert.match(html, new RegExp(`${'b'.repeat(500)}</pre>`));
  const css = fs.readFileSync(path.join(mobile, 'app.css'), 'utf8');
  assert.match(css, /\.full-input\{[^}]*max-height:none;[^}]*overflow:visible;[^}]*overflow-wrap:anywhere/);
  assert.doesNotMatch(css, /#chat-pending\{[^}]*max-height|#chat-pending\{[^}]*overflow:auto/);
});

test('approval fields expose format and control characters before escaping', () => {
  const chars = ['\u202e', '\u2066', '\u2067', '\u2068', '\u2069', '\u200b', '\u200c',
    '\u200d', '\u200e', '\u200f', '\ufeff', '\u0000', '\u2028', '\u2029'];
  const input = chars.join('');
  const pending = { chatId: 'chat', requestId: 'r1', toolName: 'AskUserQuestion',
    title: `title${chars[0]}`, decisionReason: `reason${chars[1]}`, warnings: [`warning${chars[2]}`, chars[11]],
    input: { command: input, questions: [{ header: `header${chars[3]}`,
      question: `question${chars[4]}`, options: [{ label: `label${chars[5]}`, description: `detail${chars[6]}` }] }] } };
  const html = Render.renderPending(pending, { title: `chat${chars[7]}`, project: `project${chars[8]}` });
  assert.match(html, /contains hidden characters/);
  for (const char of chars) {
    const marker = `⟦U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟧`;
    assert.ok(html.includes(marker), marker);
    assert.ok(!html.includes(char), `raw hidden character ${marker}`);
  }
  assert.equal(Render.visibleText('a\nb\tc'), 'a\nb\tc');
});

test('unknown item type cannot add CSS classes', () => {
  const html = Render.renderItem({ t: 'perm injected', id: 'r1' });
  assert.match(html, /class="item item-unknown"/);
  assert.doesNotMatch(html, /item-perm injected/);
});

test('markdown strips placeholder delimiters and exposes deceptive link destinations', () => {
  const forged = MD.render('\u00010\u0001 [link](https://safe.test)');
  assert.doesNotMatch(forged, /\u0001|undefined/);
  assert.match(forged, /0/);
  const deceptive = MD.render('[https://trusted.test/path](https://destination.test/else)');
  assert.match(deceptive, /<small class="link-destination">\(destination\.test\)<\/small>/);
  assert.doesNotMatch(MD.render('[trusted.test](https://trusted.test/path)'), /link-destination/);
});

test('mobile URL ids have a strict shape', () => {
  for (const id of ['chat-1', 'part:image:42', 'a.b_1']) assert.equal(Render.validId(id), true, id);
  for (const id of ['.', '..', '', 'a/b', '%2f', 'a?b', 'a#b', 'a'.repeat(129), null])
    assert.equal(Render.validId(id), false, String(id));
});

test('mobile shell is CSP compatible and every referenced asset is allowlisted', () => {
  const files = fs.readdirSync(mobile, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
  for (const file of files) {
    const source = fs.readFileSync(path.join(mobile, file), 'utf8');
    assert.doesNotMatch(source, /<script\b[^>]*>\s*[^\s<][\s\S]*?<\/script>/i, file);
    assert.doesNotMatch(source, /\bstyle\s*=/i, file);
    assert.doesNotMatch(source, /\beval\s*\(/, file);
    assert.doesNotMatch(source, /\binnerHTML\s*=/, file);
  }
  const html = fs.readFileSync(path.join(mobile, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(mobile, 'sw.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'main', 'remote-server.js'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((match) => match[1]);
  const shell = [...sw.matchAll(/'\/(?:[^']+)'/g)].map((match) => match[0].slice(2, -1));
  for (const asset of [...refs, ...shell]) {
    if (asset === '/') continue;
    assert.ok(fs.existsSync(path.join(mobile, asset)), `missing ${asset}`);
    assert.ok(asset.startsWith('icons/') ? server.includes('icons\\/') : server.includes(`'${asset}'`), `not allowlisted: ${asset}`);
  }
  assert.doesNotMatch(sw, /\/api\/|\/pair/);
  assert.match(sw, /event\.request\.method !== 'GET'/);
  assert.match(sw, /url\.origin !== self\.location\.origin \|\| !SHELL\.includes\(url\.pathname\)/);
  assert.ok(sw.indexOf('fetch(event.request)') < sw.indexOf('caches.match(url.pathname)'), 'shell uses network first');
  assert.match(sw, /const CACHE = `codeome-mobile-v\$\{VERSION\}`/);
});

test('user and agent messages show a time stamp, and live text is marked', () => {
  const at = new Date(2026, 10, 1, 9, 5).getTime();
  const user = Render.renderItem({ t: 'user', id: 'a', text: 'hi', at });
  const text = Render.renderItem({ t: 'text', id: 'b', text: 'hello', at, live: true });
  assert.match(user, /<span class="stamp"[^>]*>[^<]*\d/);
  assert.match(text, /class="item item-text live"/);
  assert.match(text, /<span class="stamp"/);
  assert.doesNotMatch(Render.renderItem({ t: 'user', id: 'c', text: 'no time' }), /class="stamp"/);
});
