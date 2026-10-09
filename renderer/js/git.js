// Git & GitHub view for the open project folder.
(function () {
  const h = App.h;
  const G = { st: null };
  App.views.git = G;
  let root;

  G.init = () => {
    root = document.querySelector('.view[data-view="git"]');
    App.listen('project', () => G.refresh());
    App.listen('saved', (t) => { if (!t.remote && App.currentView === 'git') G.refresh(); });
    App.listen('view', (v) => { if (v === 'git') G.refresh(); });
  };

  G.refresh = async () => {
    if (!root) return;
    if (!App.project) { root.innerHTML = ''; root.append(head(), h('div.empty', 'Open a project folder to see its Git status.', h('br'), h('button.btn.small', { onclick: () => App.openProject() }, 'Open folder'))); return; }
    G.st = await codeome.git.status(App.project);
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
    const msg = h('textarea', { rows: 3, placeholder: 'Describe the change', 'aria-label': 'Commit message' });
    msg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.metaKey) commit(); });
    async function commit() {
      if (!msg.value.trim()) return App.toast('Write a commit message first.');
      if (!staged.length) { if (!(await git(['add', '-A']))) return; }
      if (await git(['commit', '-m', msg.value.trim()], 'Committed.')) msg.value = '';
    }
    const ahead = /ahead (\d+)/.exec(st.head), behind = /behind (\d+)/.exec(st.head);
    root.append(h('div.side-section', h('div.pad.form', msg,
      h('div.row.wrap',
        h('button.btn.primary.small', { onclick: commit, title: '⌘↩' }, staged.length ? `Commit ${staged.length} staged` : (unstaged.length ? 'Commit all changes' : 'Commit')),
        h('button.btn.small', { onclick: () => git(['pull', '--rebase', '--autostash'], 'Pulled.') }, 'Pull' + (behind ? ' ' + behind[1] : '')),
        h('button.btn.small', { onclick: () => git(track ? ['push'] : ['push', '-u', 'origin', branch], 'Pushed.') , disabled: !st.remote }, 'Push' + (ahead ? ' ' + ahead[1] : ''))))));

    if (staged.length) fileGroup('Staged', staged, true);
    if (unstaged.length) fileGroup('Changes', unstaged, false);
    if (!st.files.length) root.append(h('div.empty', 'No changes since the last commit.'));

    // GitHub
    const ghSec = h('div.side-section', h('div.side-head', h('h2', 'GitHub')));
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
    root.append(ghSec);

    if (st.log.length) {
      const logSec = h('div.side-section', h('div.side-head', h('h2', 'History')));
      for (const c of st.log) logSec.append(h('div.commit', { title: c.author }, h('span.h', c.hash), h('span.s', c.subject), h('span.w', c.when + ' · ' + c.author)));
      root.append(logSec);
    }
  }

  function fileGroup(label, files, staged) {
    const sec = h('div.side-section');
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
    root.append(sec);
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
