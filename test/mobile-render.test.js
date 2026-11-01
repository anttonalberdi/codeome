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
