// Git & GitHub view for the open project folder: the changes to commit, the history and
// GitHub in stacked sections (see stack.js).
(function () {
  const h = App.h;
  const G = { st: null };
  App.views.git = G;
  let root, msg;
  // GitHub takes the lower third; the changes get more of the rest than the history.
  const SECTIONS = [{ id: 'changes', title: 'Changes', weight: 1.3 }, { id: 'history', title: 'History', weight: 0.7 }, { id: 'github', title: 'GitHub', weight: 1 }];
  const body = (id) => SECTIONS.find((s) => s.id === id).body;

  G.init = () => {
    root = document.querySelector('.view[data-view="git"]');
    root.classList.add('files-view');
    for (const s of SECTIONS) { s.dot = h('span.pane-count'); s.body = h('div.pane-scroll'); }
    G.stack = App.stack({ key: 'gitPanes', sections: SECTIONS });
    // Kept across refreshes, so a half-written message survives them.
    msg = h('textarea', { rows: 3, placeholder: 'Describe the change', 'aria-label': 'Commit message' });
    msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.metaKey) commit(); });
    App.listen('project', () => { msg.value = ''; G.refresh(); });
    App.listen('saved', (t) => { if (!t.remote && App.currentView === 'git') G.refresh(); });
    App.listen('view', (v) => { if (v === 'git') G.refresh(); });
    // Rail marker: uncommitted changes, kept current while the view is closed (agents edit files too).
    App.listen('project', () => G.checkDirty());
    App.listen('saved', (t) => { if (!t.remote) G.checkDirty(); });
    App.listen('chat-state', () => G.checkDirty());
    setInterval(() => { if (!document.hidden) G.checkDirty(); }, 10000);
    G.checkDirty();
  };

  let checking = false;
  G.checkDirty = async () => {
    if (checking) return;
    checking = true;
    try {
      const r = App.project ? await codeome.git.dirty(App.project) : null;
      paintRail(r && r.repo ? r.changes : 0);
    } catch { paintRail(0); } finally { checking = false; }
  };
  function paintRail(n) {
    const b = document.querySelector('#rail button[data-view="git"]');
    if (!b) return;
    b.classList.toggle('dirty', n > 0);
    b.title = 'Git & GitHub (⌘4)' + (n ? ` — ${n} uncommitted change${n > 1 ? 's' : ''}` : '');
  }

  G.refresh = async () => {
    if (!root) return;
    if (!App.project) { root.innerHTML = ''; root.append(head(), h('div.empty', 'Open a project folder to see its Git status.', h('br'), h('button.btn.small', { onclick: () => App.openProject() }, 'Open folder'))); return; }
    G.st = await codeome.git.status(App.project);
    paintRail(G.st.repo ? G.st.files.length : 0);
    render();
  };

  function head() { return h('div.side-head', h('h2', 'Git & GitHub'), App.iconBtn('refresh', 'Refresh', () => G.refresh())); }

  async function git(args, okMsg) {
    const r = await codeome.git.run(G.st.root, args);
    if (r.error) { App.err(r.error); return false; }
    if (okMsg) App.toast(okMsg);
    await G.refresh();
    return r;
  }
  async function gh(args, okMsg) {
    const r = await codeome.git.gh(G.st.root, args);
    if (r.error) { App.err(r.error); return false; }
    if (okMsg) App.toast(okMsg + (r.out && /https?:\/\//.test(r.out) ? '\n' + r.out.match(/https?:\/\/\S+/)[0] : ''));
    await G.refresh();
    return r;
  }

  function render() {
    for (const s of SECTIONS) s.top = s.body.scrollTop;
    root.innerHTML = '';
    root.append(head());
    const st = G.st;
    if (!st.repo) {
      root.append(h('div.empty', `${App.basename(App.project)} isn't a Git repository yet.`, h('br'),
        h('button.btn.small.primary', { onclick: async () => { const r = await codeome.git.run(App.project, ['init', '-b', 'main']); if (r.error) App.err(r.error); G.refresh(); } }, 'Initialize repository')));
      return;
    }
    const [branch, track] = st.head.split('...');
    root.append(h('div.branch', branch + (track ? '  ↔ ' + track.replace(/\s.*/, '') : '') + (/\[(.*)\]/.test(st.head) ? '  ' + st.head.match(/\[(.*)\]/)[1] : '')));

    const staged = st.files.filter((f) => f.x !== ' ' && f.x !== '?');
    const unstaged = st.files.filter((f) => f.y !== ' ' || f.x === '?');
    const ahead = /ahead (\d+)/.exec(st.head), behind = /behind (\d+)/.exec(st.head);
    for (const s of SECTIONS) s.body.innerHTML = '';
    const [changes, history, ghSec] = SECTIONS.map((s) => s.body);
    SECTIONS[0].dot.textContent = st.files.length ? String(st.files.length) : '';
    SECTIONS[1].dot.textContent = st.log.length ? String(st.log.length) : '';
    changes.append(h('div.pad.form', msg,
      h('div.row.wrap',
        h('button.btn.primary.small', { onclick: commit, title: '⌘↩' }, staged.length ? `Commit ${staged.length} staged` : (unstaged.length ? 'Commit all changes' : 'Commit')),
        h('button.btn.small', { onclick: () => git(['pull', '--rebase', '--autostash'], 'Pulled.') }, 'Pull' + (behind ? ' ' + behind[1] : '')),
        h('button.btn.small', { onclick: () => git(track ? ['push'] : ['push', '-u', 'origin', branch], 'Pushed.') , disabled: !st.remote }, 'Push' + (ahead ? ' ' + ahead[1] : '')))));

    if (staged.length) fileGroup('Staged', staged, true);
    if (unstaged.length) fileGroup('Changes', unstaged, false);
    if (!st.files.length) changes.append(h('div.empty', 'No changes since the last commit.'));

    if (!st.log.length) history.append(h('div.empty', 'No commits yet.'));
    for (const c of st.log) history.append(h('div.commit', { title: c.author }, h('span.h', c.hash), h('span.s', c.subject), h('span.w', c.when + ' · ' + c.author)));

    if (!App.env.tools.gh) ghSec.append(h('div.empty', 'Install the GitHub CLI (brew install gh) and run "gh auth login" to create repositories, pull requests and releases from here.'));
    else if (!st.gh) ghSec.append(h('div.empty', 'GitHub CLI is not signed in.', h('br'), h('button.btn.small', { onclick: () => App.views.terminals.task('gh login', 'gh auth login', st.root) }, 'Sign in')));
    else if (!st.remote) ghSec.append(h('div.pad.form', h('div.hint', 'This repository is not on GitHub yet.'),
      h('button.btn.small.primary', { onclick: publishRepo }, 'Publish to GitHub…')));
    else ghSec.append(h('div.pad.form',
      h('div.hint', st.remote.replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '')),
      h('div.row.wrap',
        h('button.btn.small', { onclick: () => gh(['browse']) }, 'Open on GitHub'),
        h('button.btn.small', { onclick: createPR, disabled: branch === 'main' || branch === 'master' }, 'Pull request…'),
        h('button.btn.small', { onclick: createRelease }, 'Release…')),
      h('div.hint', 'If the repository is linked in Zenodo’s GitHub settings, each release gets a DOI automatically.')));
    root.append(G.stack.el);
    for (const s of SECTIONS) s.body.scrollTop = s.top;
  }

  async function commit() {
    const st = G.st;
    if (!st || !st.repo) return;
    if (!msg.value.trim()) return App.toast('Write a commit message first.');
    if (!st.files.some((f) => f.x !== ' ' && f.x !== '?')) { if (!(await git(['add', '-A']))) return; }
    if (await git(['commit', '-m', msg.value.trim()], 'Committed.')) msg.value = '';
  }

  function fileGroup(label, files, staged) {
    const sec = h('div.git-group');
    sec.append(h('div.group-label', h('span', label), h('span', h('button.btn.ghost.small', { onclick: () => git(staged ? ['reset', '-q'] : ['add', '-A']) }, staged ? 'Unstage all' : 'Stage all'))));
    for (const f of files) {
      const code = staged ? f.x : (f.x === '?' ? 'U' : f.y);
      sec.append(h('div.gitfile', {
        onclick: () => openDiff(f, staged), title: f.path,
        oncontextmenu: (e) => { e.preventDefault(); App.menu(e.clientX, e.clientY, [
          { label: 'Open file', run: () => App.views.editor.openFile(App.join(G.st.root, f.path)) },
          { label: 'Show changes', run: () => openDiff(f, staged) },
          staged ? { label: 'Unstage', run: () => git(['reset', '-q', '--', f.path]) } : { label: 'Stage', run: () => git(['add', '--', f.path]) },
          !staged && f.x !== '?' ? { label: 'Discard changes…', danger: true, run: async () => { if (await App.confirm('Discard changes?', `${f.path} will go back to the last committed version.`, 'Discard', true)) git(['restore', '--', f.path]); } } : null
        ]); }
      }, h('span.st.' + code, code), h('span.p', f.path),
      h('button.icon-btn.small', { title: staged ? 'Unstage' : 'Stage', 'aria-label': staged ? 'Unstage' : 'Stage', html: staged ? '<svg viewBox="0 0 16 16"><path d="M3 8h10" stroke="currentColor" stroke-width="1.5"/></svg>' : App.icons.plus, onclick: (e) => { e.stopPropagation(); git(staged ? ['reset', '-q', '--', f.path] : ['add', '--', f.path]); } })));
    }
    body('changes').append(sec);
  }

  async function openDiff(f, staged) {
    const full = App.join(G.st.root, f.path);
    const orig = (await codeome.git.show({ root: G.st.root, file: f.path })).content;
    const cur = (await codeome.local.read(full)).content || '';
    App.views.editor.diff({ key: 'diff:' + full, title: App.basename(f.path), original: orig, modified: cur, lang: App.views.editor.lang(f.path) });
  }

  async function publishRepo() {
    const v = await App.modal({ title: 'Publish to GitHub', text: 'Creates the repository on your GitHub account and pushes this branch.', ok: 'Publish',
      fields: [{ key: 'name', label: 'Repository name', value: App.basename(G.st.root) }, { key: 'desc', label: 'Description', value: '' },
        { key: 'vis', label: 'Visibility', type: 'select', value: 'private', options: [{ value: 'private', label: 'Private' }, { value: 'public', label: 'Public' }] }] });
    if (!v) return;
    if (!G.st.log.length) { await codeome.git.run(G.st.root, ['add', '-A']); await codeome.git.run(G.st.root, ['commit', '-m', 'Initial commit']); }
    gh(['repo', 'create', v.name, '--' + v.vis, '--source', '.', '--push', ...(v.desc ? ['--description', v.desc] : [])], 'Published to GitHub.');
  }
  async function createPR() {
    const v = await App.modal({ title: 'Open a pull request', ok: 'Create pull request', fields: [{ key: 't', label: 'Title', value: G.st.log[0]?.subject || '' }, { key: 'b', label: 'Description', type: 'textarea', value: '' }, { key: 'draft', label: 'Draft', type: 'check', value: false }] });
    if (!v) return;
    await codeome.git.run(G.st.root, ['push', '-u', 'origin', G.st.head.split('...')[0]]);
    gh(['pr', 'create', '--title', v.t, '--body', v.b || ' ', ...(v.draft ? ['--draft'] : [])], 'Pull request created.');
  }
  async function createRelease() {
    const v = await App.modal({ title: 'Create a release', text: 'Tags the current commit and publishes a GitHub release.', ok: 'Create release',
      fields: [{ key: 'tag', label: 'Version tag', value: 'v0.1.0' }, { key: 't', label: 'Title', value: '' }, { key: 'notes', label: 'Release notes', type: 'textarea', value: '', placeholder: 'Leave empty to generate from commits' }] });
    if (!v) return;
    const args = ['release', 'create', v.tag, '--title', v.t || v.tag];
    if (v.notes.trim()) args.push('--notes', v.notes); else args.push('--generate-notes');
    gh(args, `Released ${v.tag}.`);
  }
})();
