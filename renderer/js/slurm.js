// Slurm view: running, waiting and finished jobs in stacked sections (see stack.js), what the
// cluster has free, job logs, cancel and submit.
(function () {
  const h = App.h;
  const S = { queue: [], history: [], resources: null, timer: null, sel: null, lastError: '' };
  App.views.slurm = S;
  let root, stamp, emptyEl;

  const FAIL = ['FAILED', 'TIMEOUT', 'OUT_OF_MEMORY', 'NODE_FAIL', 'CANCELLED', 'PREEMPTED', 'BOOT_FAIL', 'DEADLINE'];
  // Ended because something went wrong (a job the user cancelled did not).
  const ERRORS = {
    FAILED: 'The job ended with an error. Check its error log.',
    TIMEOUT: 'The job hit its time limit before finishing.',
    OUT_OF_MEMORY: 'The job used more memory than it asked for.',
    NODE_FAIL: 'The node running the job failed.',
    BOOT_FAIL: 'The node could not start the job.',
    DEADLINE: 'The job could not finish before its deadline.',
    PREEMPTED: 'The job was stopped to make room for another one.'
  };
  const norm = (s) => (s || '').split(' ')[0].replace(/\+$/, '');
  const isLive = (j) => S.queue.some((x) => x.id === j.id);

  // The sections of the view, top to bottom. Each lists jobs, except the last.
  const SECTIONS = [
    { id: 'running', title: 'Running', none: 'No jobs running.', meta: (j) => [j.elapsed + ' / ' + j.limit, j.cpus + ' CPU', j.partition, j.reason] },
    { id: 'waiting', title: 'Waiting', none: 'No jobs waiting.', meta: (j) => [j.state === 'PENDING' ? 'Waiting: ' + j.reason.replace(/[()]/g, '') : j.state, j.partition, j.cpus + ' CPU'] },
    { id: 'finished', title: 'Finished', none: () => `No jobs finished in the last ${App.cfg.slurm.historyDays || 3} days.`,
      meta: (j) => [j.elapsed, j.exitcode !== '0:0' ? 'exit ' + j.exitcode : null, j.maxrss ? 'mem ' + j.maxrss : null, j.end ? App.fmtAgo(Date.parse(j.end)) : null] },
    { id: 'resources', title: 'Cluster resources', weight: 0.8 }
  ];

  S.init = () => {
    root = document.querySelector('.view[data-view="slurm"]');
    root.classList.add('files-view');
    stamp = h('span.hint');
    emptyEl = h('div.empty');
    for (const s of SECTIONS) { s.dot = h('span.pane-count'); s.body = s.list = h('div.pane-scroll' + (s.meta ? '.jobs' : '.res')); }
    S.stack = App.stack({ key: 'slurmPanes', sections: SECTIONS });
    root.append(
      h('div.side-head', h('h2', 'Slurm jobs'), App.iconBtn('plus', 'New job script', () => S.newScript()), App.iconBtn('refresh', 'Refresh now', () => S.refresh(true))),
      h('div.pad', { style: { paddingTop: 0 } }, stamp),
      emptyEl, S.stack.el);
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
      // sacct and the node list are heavier; poll them every third tick.
      if (force || histTick++ % 3 === 0) {
        const [r, res] = await Promise.all([codeome.slurm.history(), codeome.slurm.resources()]);
        if (!r.error) S.history = r.jobs;
        S.resources = res;
      }
      stamp.textContent = S.lastError ? S.lastError : 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const active = new Set(S.queue.map((j) => j.id));
      const recentFail = S.history.filter((j) => !active.has(j.id) && FAIL.includes(norm(j.state)) && j.end && Date.now() - Date.parse(j.end) < 86400000).length;
      App.emit('jobs', { running: S.queue.filter((j) => j.state === 'RUNNING').length, pending: S.queue.filter((j) => j.state === 'PENDING').length, failed: recentFail });
      render();
    } finally { busy = false; }
  };

  function render() {
    if (!root) return;
    emptyEl.hidden = App.hpcConnected; S.stack.el.hidden = !App.hpcConnected;
    if (!App.hpcConnected) {
      emptyEl.innerHTML = '';
      emptyEl.append(App.cfg.hpc.host ? 'Connect to the HPC to see your jobs.' : 'Add your cluster login in Settings to see your jobs.', h('br'),
        App.cfg.hpc.host ? h('button.btn.small.primary', { onclick: () => App.connectHpc() }, 'Connect') : h('button.btn.small', { onclick: () => App.views.settings.open() }, 'Open Settings'));
      return;
    }
    const active = new Set(S.queue.map((j) => j.id));
    const jobs = {
      running: S.queue.filter((j) => j.state === 'RUNNING'),
      waiting: S.queue.filter((j) => j.state !== 'RUNNING'),
      finished: S.history.filter((j) => !active.has(j.id) && !['RUNNING', 'PENDING'].includes(norm(j.state))).slice(0, 80)
    };
    for (const s of SECTIONS) if (s.meta) group(s, jobs[s.id]);
    renderResources(jobs);
  }

  function group(s, jobs) {
    const failed = jobs.filter((j) => ERRORS[norm(j.state)]).length;
    s.dot.innerHTML = '';
    s.dot.append(String(jobs.length), failed ? h('span.bad', failed + ' failed') : '');
    const top = s.list.scrollTop;
    s.list.innerHTML = '';
    if (!jobs.length) s.list.append(h('div.empty', typeof s.none === 'function' ? s.none() : s.none));
    for (const j of jobs) {
      const st = norm(j.state), err = ERRORS[st];
      s.list.append(h('div.job' + (S.sel === j.id ? '.sel' : '') + (err ? '.failed' : ''), {
        tabindex: '0', title: err || '', onclick: () => S.openJob(j), onkeydown: (e) => { if (e.key === 'Enter') S.openJob(j); },
        oncontextmenu: (e) => { e.preventDefault(); App.menu(e.clientX, e.clientY, jobMenu(j)); }
      },
      h('span.nm', j.name || '(no name)'), h('span.state.' + st, st.toLowerCase().replace(/_/g, ' ')),
      h('div.meta', h('span.id', j.id), ...s.meta(j).filter(Boolean).map((m) => h('span', m)))));
    }
    s.list.scrollTop = top;
  }

  // ---------- cluster resources ----------
  const fmtMem = (mb) => (mb >= 1024 * 1024 ? (mb / 1024 / 1024).toFixed(1) + ' TB' : Math.round(mb / 1024) + ' GB');
  const fmtN = (n) => n.toLocaleString();

  function meter(label, used, total, text) {
    const pct = total ? Math.min(100, Math.round(100 * used / total)) : 0;
    return h('div.res-meter', h('span.k', label),
      h('span.bar' + (pct >= 90 ? '.full' : ''), { role: 'meter', 'aria-label': label + ' in use', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, h('i', { style: { width: pct + '%' } })),
      h('span.v', text));
  }

  function renderResources(jobs) {
    const s = SECTIONS.find((x) => x.id === 'resources'), res = S.resources, el = s.list;
    const top = el.scrollTop;
    el.innerHTML = ''; s.dot.textContent = '';
    if (!res) { el.append(h('div.empty', 'Checking the cluster…')); return; }
    if (res.error) { el.append(h('div.empty', 'Could not read the cluster’s resources: ' + res.error)); return; }
    const t = res.total, free = t.cpus - t.cpusUsed;
    s.dot.textContent = t.cpus ? Math.round(100 * free / t.cpus) + '% free' : '';
    const mine = jobs.running.reduce((n, j) => n + (Number(j.cpus) || 0), 0);
    el.append(h('div.res-part',
      h('div.res-name', h('b', 'Whole cluster'), h('span', `${fmtN(t.nodes - t.offline)} nodes` + (t.offline ? ` · ${fmtN(t.offline)} offline` : ''))),
      meter('CPU', t.cpusUsed, t.cpus, `${fmtN(free)} of ${fmtN(t.cpus)} free`),
      meter('Mem', t.memUsed, t.mem, `${fmtMem(t.mem - t.memUsed)} of ${fmtMem(t.mem)} free`),
      t.gpus ? meter('GPU', t.gpusUsed, t.gpus, `${fmtN(t.gpus - t.gpusUsed)} of ${fmtN(t.gpus)} free`) : null,
      h('div.res-note', mine || jobs.waiting.length
        ? `Your jobs: ${fmtN(mine)} CPUs in ${jobs.running.length} running` + (jobs.waiting.length ? ` · ${jobs.waiting.length} waiting` : '')
        : 'You have no jobs in the queue.')));
    // Partitions your jobs are on come first, then the largest.
    const used = new Set(S.queue.flatMap((j) => (j.partition || '').split(',')));
    const parts = res.partitions.slice().sort((a, b) => used.has(b.name) - used.has(a.name) || b.cpus - a.cpus);
    for (const p of parts) {
      el.append(h('div.res-part',
        h('div.res-name', h('b', p.name), h('span', `${fmtN(p.nodes - p.offline)} nodes` + (p.offline ? ` · ${fmtN(p.offline)} offline` : ''))),
        meter('CPU', p.cpusUsed, p.cpus, `${fmtN(p.cpus - p.cpusUsed)} of ${fmtN(p.cpus)} free`),
        meter('Mem', p.memUsed, p.mem, `${fmtMem(p.mem - p.memUsed)} of ${fmtMem(p.mem)} free`),
        p.gpus ? meter('GPU', p.gpusUsed, p.gpus, `${fmtN(p.gpus - p.gpusUsed)} of ${fmtN(p.gpus)} free`) : null,
        h('div.res-note', p.pendingJobs ? `${fmtN(p.pendingJobs)} jobs waiting, asking for ${fmtN(p.pendingCpus)} CPUs` : 'No jobs waiting')));
    }
    el.scrollTop = top;
  }

  function jobMenu(j) {
    const live = isLive(j);
    return [
      { label: live ? 'Show job details' : 'Show output', run: () => S.openJob(j) },
      j.workdir ? { label: 'Open working folder', run: () => App.views.files.show('remote', j.workdir) } : null,
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
        // A job that hasn't finished opens on its details: its output is most likely still empty.
        if (isLive(j)) which.value = 'info';
        async function load() {
          const live = isLive(j);
          cancelBtn.hidden = !live;
          if (which.value === 'info') {
            if (live && pre.dataset.first === '1') { const now = await codeome.slurm.details(j.id); if (now.text) info = { ...info, ...now }; }
            pathEl.textContent = ''; pre.textContent = info.text || 'Slurm no longer has details for this job.'; pre.dataset.first = '1'; return;
          }
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
        tab.timer = setInterval(() => { if (App.views.editor.active === tab.id && follow.checked && isLive(j)) load(); }, 5000);
        tab.onClose = () => clearInterval(tab.timer);
      }
    });
  };
})();
