// Slurm view: live queue, recent history, job logs, cancel and submit.
(function () {
  const h = App.h;
  const S = { queue: [], history: [], timer: null, sel: null, lastError: '' };
  App.views.slurm = S;
  let root, listEl, stamp;

  const FAIL = ['FAILED', 'TIMEOUT', 'OUT_OF_MEMORY', 'NODE_FAIL', 'CANCELLED', 'PREEMPTED', 'BOOT_FAIL', 'DEADLINE'];
  const norm = (s) => (s || '').split(' ')[0].replace(/\+$/, '');

  S.init = () => {
    root = document.querySelector('.view[data-view="slurm"]');
    stamp = h('span.hint');
    listEl = h('div.jobs');
    root.append(
      h('div.side-head', h('h2', 'Slurm jobs'), App.iconBtn('plus', 'New job script', () => S.newScript()), App.iconBtn('refresh', 'Refresh now', () => S.refresh(true))),
      h('div.pad', { style: { paddingTop: 0 } }, stamp),
      listEl);
    App.listen('hpc', (c) => { if (c) S.start(); else S.stop(); render(); });
    render();
  };

  S.start = () => {
    S.stop();
    S.refresh();
    S.timer = setInterval(() => { if (!document.hidden) S.refresh(); }, Math.max(5, App.cfg.slurm.refreshSeconds || 20) * 1000);
  };
  S.stop = () => { if (S.timer) clearInterval(S.timer); S.timer = null; };
  S.render = () => render();

  let busy = false, histTick = 0;
  S.refresh = async (force) => {
    if (busy || !App.hpcConnected) return;
    busy = true;
    try {
      const q = await codeome.slurm.queue();
      if (q.error) { S.lastError = q.error; } else { S.queue = q.jobs; S.lastError = ''; }
      // sacct is heavier; poll it every third tick.
      if (force || histTick++ % 3 === 0) { const r = await codeome.slurm.history(); if (!r.error) S.history = r.jobs; }
      stamp.textContent = S.lastError ? S.lastError : 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const active = new Set(S.queue.map((j) => j.id));
      const recentFail = S.history.filter((j) => !active.has(j.id) && FAIL.includes(norm(j.state)) && j.end && Date.now() - Date.parse(j.end) < 86400000).length;
      App.emit('jobs', { running: S.queue.filter((j) => j.state === 'RUNNING').length, pending: S.queue.filter((j) => j.state === 'PENDING').length, failed: recentFail });
      render();
    } finally { busy = false; }
  };

  function render() {
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!App.hpcConnected) {
      listEl.append(h('div.empty', App.cfg.hpc.host ? 'Connect to the HPC to see your jobs.' : 'Add your cluster login in Settings to see your jobs.', h('br'),
        App.cfg.hpc.host ? h('button.btn.small.primary', { onclick: () => App.connectHpc() }, 'Connect') : h('button.btn.small', { onclick: () => App.views.settings.open() }, 'Open Settings')));
      return;
    }
    const active = new Set(S.queue.map((j) => j.id));
    const running = S.queue.filter((j) => j.state === 'RUNNING');
    const other = S.queue.filter((j) => j.state !== 'RUNNING');
    const done = S.history.filter((j) => !active.has(j.id) && !['RUNNING', 'PENDING'].includes(norm(j.state)));
    group('Running', running, (j) => [j.elapsed + ' / ' + j.limit, j.cpus + ' CPU', j.partition, j.reason]);
    group('Waiting', other, (j) => [j.state === 'PENDING' ? 'Waiting: ' + j.reason.replace(/[()]/g, '') : j.state, j.partition, j.cpus + ' CPU']);
    group('Finished · last ' + (App.cfg.slurm.historyDays || 3) + ' days', done.slice(0, 80), (j) => [j.elapsed, j.exitcode !== '0:0' ? 'exit ' + j.exitcode : null, j.maxrss ? 'mem ' + j.maxrss : null, j.end ? App.fmtAgo(Date.parse(j.end)) : null]);
    if (!S.queue.length && !done.length) listEl.append(h('div.empty', 'No jobs in the queue or the recent history.', h('br'), h('button.btn.small', { onclick: () => S.newScript() }, 'Write a job script')));
  }

  function group(label, jobs, meta) {
    if (!jobs.length) return;
    listEl.append(h('div.group-label', h('span', label), h('span', String(jobs.length))));
    for (const j of jobs) {
      const st = norm(j.state);
      listEl.append(h('div.job' + (S.sel === j.id ? '.sel' : ''), {
        tabindex: '0', onclick: () => S.openJob(j), onkeydown: (e) => { if (e.key === 'Enter') S.openJob(j); },
        oncontextmenu: (e) => { e.preventDefault(); App.menu(e.clientX, e.clientY, jobMenu(j)); }
      },
      h('span.nm', j.name || '(no name)'), h('span.state.' + st, st.toLowerCase()),
      h('div.meta', h('span.id', j.id), ...meta(j).filter(Boolean).map((m) => h('span', m)))));
    }
  }

  function jobMenu(j) {
    const live = ['RUNNING', 'PENDING'].includes(norm(j.state));
    return [
      { label: 'Show output', run: () => S.openJob(j) },
      j.workdir ? { label: 'Open working folder', run: () => { App.setView('files'); App.views.files.go('remote', j.workdir); } } : null,
      { label: 'Copy job ID', run: () => navigator.clipboard.writeText(j.id) },
      live ? '-' : null,
      live ? { label: 'Cancel job…', danger: true, run: () => S.cancel(j) } : null
    ];
  }

  S.cancel = async (j) => {
    if (!(await App.confirm(`Cancel job ${j.id}?`, `"${j.name}" will be stopped with scancel.`, 'Cancel job', true))) return;
    const r = await codeome.slurm.cancel(j.id);
    if (r.error) return App.err(r.error);
    App.toast(`Cancelled job ${j.id}.`); S.refresh(true);
  };

  S.submit = async (path) => {
    if (!App.requireHpc()) return;
    const t = App.views.editor.tabs.find((x) => x.remote && x.path === path && x.dirty);
    if (t) await App.views.editor.save(t);
    const r = await codeome.slurm.submit(path);
    if (r.error) return App.err('sbatch: ' + r.error);
    App.toast(r.message || 'Submitted.');
    setTimeout(() => S.refresh(true), 1200);
  };

  S.newScript = async () => {
    if (!App.requireHpc()) return;
    const v = await App.modal({
      title: 'New job script', text: `Created in ${App.remoteDir || '~'} and opened in the editor.`, ok: 'Create',
      fields: [
        { key: 'name', label: 'Job name', value: 'analysis' },
        { key: 'partition', label: 'Partition', value: '', placeholder: 'leave empty for the default' },
        { key: 'time', label: 'Time limit', value: '04:00:00' },
        { key: 'cpus', label: 'CPUs', value: '8' },
        { key: 'mem', label: 'Memory', value: '32G' },
        { key: 'array', label: 'Array', value: '', placeholder: 'e.g. 1-20 (optional)' },
        { key: 'modules', label: 'Modules / setup', type: 'textarea', rows: 2, value: 'module load R' }
      ]
    });
    if (!v) return;
    const out = v.array ? '%x_%A_%a' : '%x_%j';
    const lines = ['#!/bin/bash', `#SBATCH --job-name=${v.name}`, v.partition ? `#SBATCH --partition=${v.partition}` : null,
      `#SBATCH --time=${v.time}`, '#SBATCH --nodes=1', '#SBATCH --ntasks=1', `#SBATCH --cpus-per-task=${v.cpus}`, `#SBATCH --mem=${v.mem}`,
      v.array ? `#SBATCH --array=${v.array}` : null, `#SBATCH --output=logs/${out}.out`, `#SBATCH --error=logs/${out}.err`, '',
      'set -euo pipefail', 'mkdir -p logs', '', v.modules, '', 'echo "Started on $(hostname) at $(date)"', '', '# your commands here', 'Rscript analysis.R', '', 'echo "Finished at $(date)"', ''];
    const path = App.join(App.remoteDir || '~', App.safeName(v.name) + '.sh');
    await codeome.remote.mkdir(App.join(App.remoteDir || '~', 'logs'));
    const r = await codeome.remote.write(path, lines.filter((l) => l !== null).join('\n'));
    if (r.error) return App.err(r.error);
    App.emit('remote-changed');
    App.views.editor.openFile(path, { remote: true });
    App.toast('Right-click in the editor and choose "Submit to Slurm" when ready.');
  };

  // ---------- job log tab ----------
  S.openJob = (j) => {
    S.sel = j.id; render();
    App.views.editor.openCustom({
      key: 'job:' + j.id, title: `${j.name || 'job'} · ${j.id}`, badge: 'Job',
      render: async (el, tab) => {
        const pre = h('pre.logbox', 'Loading…');
        const which = h('select', { style: { width: 'auto' }, 'aria-label': 'Log stream' }, h('option', { value: 'stdout' }, 'Output'), h('option', { value: 'stderr' }, 'Errors'), h('option', { value: 'info' }, 'Job details'));
        const follow = h('input', { type: 'checkbox', checked: true });
        const pathEl = h('span.path');
        const cancelBtn = h('button.btn.small.danger', { onclick: () => S.cancel(j) }, 'Cancel job');
        el.append(h('div.toolbar', which, pathEl, h('label.check', follow, 'Follow'), h('button.btn.small', { onclick: () => load() }, 'Refresh'), cancelBtn), pre);
        let info = await codeome.slurm.details(j.id);
        // Finished jobs drop out of scontrol; fall back to the default slurm-<id>.out in the work dir.
        if (!info.stdout && j.workdir) info.stdout = App.join(j.workdir, `slurm-${j.id}.out`);
        async function load() {
          const live = S.queue.some((x) => x.id === j.id);
          cancelBtn.hidden = !live;
          if (which.value === 'info') { pathEl.textContent = ''; pre.textContent = info.text || 'Slurm no longer has details for this job.'; return; }
          const f = which.value === 'stderr' ? (info.stderr || info.stdout) : info.stdout;
          pathEl.textContent = f || '';
          if (!f) { pre.textContent = 'No log file known for this job.'; return; }
          const r = await codeome.slurm.tail(f, 600);
          const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
          pre.textContent = r.error ? r.error : (r.content || '(empty so far)');
          if (follow.checked && (atBottom || pre.dataset.first !== '1')) pre.scrollTop = pre.scrollHeight;
          pre.dataset.first = '1';
        }
        which.onchange = load;
        await load();
        tab.timer = setInterval(() => { if (App.views.editor.active === tab.id && follow.checked && S.queue.some((x) => x.id === j.id)) load(); }, 5000);
        tab.onClose = () => clearInterval(tab.timer);
      }
    });
  };
})();
